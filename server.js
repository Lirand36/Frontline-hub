import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bus } from './src/bus.js';
import { getLog, clearLog } from './src/connectors/http.js';
import * as hubspot from './src/connectors/hubspot.js';
import * as jira from './src/connectors/jira.js';
import * as intercom from './src/connectors/intercom.js';
import * as slack from './src/connectors/slack.js';
import * as snowflake from './src/connectors/snowflake.js';
import * as claude from './src/connectors/claude.js';
import * as google from './src/connectors/google.js';
import { CLOSE_REASONS, CONFIG, DEAL_STAGES, FR_STATUSES, MOVE_BACK_REASONS, ONBOARDING_STEPS, PEOPLE, SILENT_DAYS, STAGE_GATES, USERS, db, reset } from './src/store.js';
import { dealView, fieldValue, isOpen } from './src/deals.js';
import { csView } from './src/cs.js';
import { HEALTH_WEIGHTS, anomalyText, computeHealth } from './src/health.js';
import * as svc from './src/services.js';
import { goodMorning } from './src/home.js';
import { opsView, runJob } from './src/ops.js';
import { ROLES, areaOf, can, deniedMessage } from './src/access.js';
import { CLASSIFICATIONS, classificationLabel, suggestedCloseReason } from './src/classify.js';
import { withActivity, announce, getActivities, clearActivities, setActor } from './src/activity.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

async function readRaw(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new svc.HttpError(413, 'Payload too large');
  }
  return raw;
}

function parseJson(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new svc.HttpError(400, 'Invalid JSON'); }
}

const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// https://api.slack.com/authentication/verifying-requests-from-slack
function verifySlack(req, raw) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return; // mock mode
  const ts = req.headers['x-slack-request-timestamp'];
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new svc.HttpError(401, 'Stale Slack request');
  const expected = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
  if (!safeEqual(expected, String(req.headers['x-slack-signature'] || ''))) throw new svc.HttpError(401, 'Bad Slack signature');
}

// https://developers.intercom.com/docs/webhooks/setting-up-webhooks (X-Hub-Signature = sha1 HMAC with client secret)
function verifyIntercom(req, raw) {
  const secret = process.env.INTERCOM_CLIENT_SECRET;
  if (!secret) return;
  const expected = 'sha1=' + createHmac('sha1', secret).update(raw).digest('hex');
  if (!safeEqual(expected, String(req.headers['x-hub-signature'] || ''))) throw new svc.HttpError(401, 'Bad Intercom signature');
}

// Demo auth: the UI sends the selected demo user. Replace with SSO (Google / Okta) in production.
function actorOf(req) {
  const id = String(req.headers['x-user'] || '');
  return USERS.find((u) => u.id === id) ?? USERS[0];
}

const summary = (a) => ({
  id: a.id, name: a.name, domain: a.domain, status: a.status, segment: a.segment, properties: a.properties,
  region: a.region, owner: a.owner, csm: a.csm, contact: a.contact, health: a.health, platformErp: a.platform?.erp ?? null,
  deal: a.deal, usage: a.usage,
  onboarding: a.onboarding && {
    done: ONBOARDING_STEPS.filter((s) => a.onboarding.steps[s.id].done).length,
    total: ONBOARDING_STEPS.length, startedAt: a.onboarding.startedAt, completedAt: a.onboarding.completedAt,
  },
  openTickets: a.tickets.filter((t) => t.status !== 'Done').length,
  openConversations: a.conversations.filter((c) => c.state === 'open').length,
  pendingApproval: db.approvals.some((p) => p.accountId === a.id && p.status === 'pending'),
  moveBackRequest: db.moveRequests.find((r) => r.accountId === a.id && r.status === 'pending') ?? null,
  ...healthView(a),
  ...csView(a),
});

function healthView(a) {
  const h = computeHealth(a, db.anomalies);
  const openConvs = a.conversations.filter((c) => c.state === 'open');
  return {
    healthLevel: h.level, healthReasons: h.reasons, healthParts: h.parts, usageTrendPct: h.trend == null ? null : Math.round(h.trend * 100),
    renewalDate: a.renewalDate ?? null, renewalDays: h.renewalDays ?? null,
    support: {
      open: openConvs.length,
      escalated: a.conversations.filter((c) => c.escalatedTo && c.state === 'open').length,
      overdue: openConvs.filter((c) => c.slaDueAt && new Date(c.slaDueAt) < new Date()).length,
      byType: openConvs.map((c) => classificationLabel(c.classification)),
    },
    anomalies: db.anomalies.filter((x) => x.accountId === a.id && x.status === 'new').map((x) => ({ ...x, text: anomalyText(x) })),
    featureRequests: {
      open: db.featureRequests.filter((f) => !['shipped', 'declined'].includes(f.status) && f.accounts.some((r) => r.accountId === a.id)).length,
      toTell: db.featureRequests.filter((f) => f.status === 'shipped' && f.accounts.some((r) => r.accountId === a.id && !r.notified)).length,
    },
  };
}

const frView = (f) => ({
  ...f,
  accounts: f.accounts.map((r) => { const a = db.accounts.find((x) => x.id === r.accountId); return { ...r, name: a?.name, csm: a?.csm, segment: a?.segment, arr: a?.deal.amount ?? 0 }; }),
  arr: f.accounts.reduce((s, r) => s + (db.accounts.find((x) => x.id === r.accountId)?.deal.amount ?? 0), 0),
  next: svc.nextFeatureStatus(f),
});

const integrations = () => [
  { id: 'hubspot', name: 'HubSpot', role: 'CRM: deals, notes', live: hubspot.isLive(), env: ['HUBSPOT_TOKEN'] },
  { id: 'intercom', name: 'Intercom', role: 'Support conversations', live: intercom.isLive(), env: ['INTERCOM_TOKEN', 'INTERCOM_ADMIN_ID', 'INTERCOM_CLIENT_SECRET'] },
  { id: 'jira', name: 'Jira', role: 'Escalations & onboarding epics', live: jira.isLive(), env: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'] },
  { id: 'slack', name: 'Slack', role: 'Alerts, approvals, onboarding channels', live: slack.isLive(), env: ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_DM_USER_ID', 'SLACK_APPROVER_IDS', 'SLACK_CHANNEL_*'], testable: true,
    notes: slack.isLive() ? [slack.dmRedirect() ? `Every DM goes to ${slack.dmRedirect()}, labelled with who it was for.` : 'Add SLACK_DM_USER_ID so DMs come to you; the sample team has made-up Slack IDs.'] : [] },
  { id: 'snowflake', name: 'Snowflake', role: 'Product usage in, hub events out', live: snowflake.isLive(), env: ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_TOKEN', 'SNOWFLAKE_WAREHOUSE'] },
  { id: 'google', name: 'Google Calendar & Meet', role: 'Meeting invites and video calls', live: google.isLive(), env: ['GOOGLE_SERVICE_ACCOUNT_JSON'] },
  { id: 'claude', name: 'Claude', role: 'AI assist: summaries & draft replies', live: claude.isLive(), env: ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL'] },
];

// One real, harmless call per system to prove the keys work. Slack only for now.
async function testConnection(id) {
  if (id !== 'slack') throw new svc.HttpError(404, 'No connection test for this system yet');
  if (!slack.isLive()) return { ok: false, message: "The hub doesn't see SLACK_BOT_TOKEN. Add it in Render → Environment; if it's already there (or in a linked environment group), redeploy: Manual Deploy → Deploy latest commit. Variables load when the hub starts." };
  const r = await slack.authTest();
  if (!r.ok) return { ok: false, message: `Slack said: ${r.response?.error ?? `status ${r.status}`}. Check the bot token.` };
  return { ok: true, message: `Connected to the ${r.response.team} workspace as @${r.response.user}.${slack.dmRedirect() ? ` DMs go to ${slack.dmRedirect()}.` : ' Add SLACK_DM_USER_ID so DMs come to you.'}` };
}

// Who may call what (roles in src/access.js). The first matching rule wins; no rule means everyone.
// The UI hides what a role can't use, but this is what actually enforces it.
const GUARDS = [
  ['GET', /^\/api\/pipeline$/, 'pipeline.view'],
  ['GET', /^\/api\/(inbox|support\/reasons)$/, 'inbox.work'],
  ['GET', /^\/api\/feature-requests$/, 'fr.view'],
  ['GET', /^\/api\/approvals$/, 'approvals.view'],
  ['GET', /^\/api\/(log|activity)$/, 'log.view'],
  ['GET', /^\/api\/ops$/, 'ops.view'],
  ['POST', /^\/api\/connections\//, 'connections.view'], // admin only
  ['POST', /^\/api\/accounts\/[\w-]+\/(deal-stage|deal-fields|follow-up|ask-colleague|discount|move-back)$/, 'deal.edit'],
  ['POST', /^\/api\/move-requests\//, 'deal.moveback'], // admin only (no other role has this)
  ['POST', /^\/api\/accounts\/[\w-]+\/notes$/, 'accounts.note'],
  ['POST', /^\/api\/accounts\/[\w-]+\/meetings$/, 'meetings.create'],
  ['POST', /^\/api\/accounts\/[\w-]+\/tickets$/, 'tickets.create'],
  ['POST', /^\/api\/(accounts\/[\w-]+\/(sync-usage|steps\/\w+)|onboarding\/sync)$/, 'onboarding.edit'],
  ['POST', /^\/api\/anomalies\//, 'anomalies.edit'],
  ['POST', /^\/api\/accounts\/[\w-]+\/save-plan$/, 'portfolio.edit'],
  ['POST', /^\/api\/feature-requests\//, 'fr.edit'],
  ['POST', /^\/api\/conversations\//, 'inbox.work'],
  ['POST', /^\/api\/approvals\//, 'approvals.decide'],
];
function guard(req, method, pathname) {
  const rule = GUARDS.find(([m, re]) => m === method && re.test(pathname));
  if (!rule) return null;
  const user = actorOf(req), cap = rule[2];
  if (!can(user, cap)) throw new svc.HttpError(403, deniedMessage(cap));
  // AEs work their own deals; managers and admins work the team's
  if (cap === 'deal.edit' && !can(user, 'pipeline.team')) {
    const a = db.accounts.find((x) => x.id === pathname.split('/')[3]);
    if (a && a.owner !== user.name) throw new svc.HttpError(403, `This is ${a.owner}'s deal. Only they or the Sales Manager can change it.`);
  }
  return cap;
}

const routes = [
  ['GET', /^\/api\/meta$/, () => ({
    stages: DEAL_STAGES, users: USERS, people: PEOPLE, classifications: CLASSIFICATIONS, frStatuses: FR_STATUSES, healthWeights: HEALTH_WEIGHTS, config: CONFIG, integrations: integrations(), closeReasons: CLOSE_REASONS,
    steps: ONBOARDING_STEPS.map(({ id, label, auto, hint }) => ({ id, label, auto: Boolean(auto), hint })),
    stageGates: STAGE_GATES, silentDays: SILENT_DAYS, roles: ROLES, moveBackReasons: MOVE_BACK_REASONS,
  })],
  // Open deals with what each one needs next (see src/deals.js)
  ['GET', /^\/api\/pipeline$/, (req) => db.accounts.filter((a) => isOpen(a) && (can(actorOf(req), 'pipeline.team') || a.owner === actorOf(req).name)).map((a) => ({
    ...summary(a), contact: a.contact, ...dealView(a),
    gateValues: Object.fromEntries(Object.values(STAGE_GATES).flatMap((g) => g.fields).map((f) => [f.id, fieldValue(a, f.id)])),
  }))],
  ['GET', /^\/api\/home$/, (req) => goodMorning(actorOf(req))],
  ['GET', /^\/api\/accounts$/, () => db.accounts.map(summary)],
  ['GET', /^\/api\/accounts\/([\w-]+)$/, (req, [id]) => {
    const a = db.accounts.find((x) => x.id === id);
    if (!a) throw new svc.HttpError(404, 'Account not found');
    return {
      ...a, ...healthView(a), ...csView(a),
      approvals: db.approvals.filter((p) => p.accountId === id),
      allAnomalies: db.anomalies.filter((x) => x.accountId === id).map((x) => ({ ...x, text: anomalyText(x) })),
      featureRequestList: db.featureRequests.filter((f) => f.accounts.some((r) => r.accountId === id)).map(frView),
      conversationsView: a.conversations.map((c) => ({ ...c, classificationLabel: classificationLabel(c.classification) })),
    };
  }],
  ['GET', /^\/api\/inbox$/, () =>
    db.accounts.flatMap((a) => a.conversations.map((c) => ({ ...c, account: summary(a), classificationLabel: classificationLabel(c.classification), suggestedCloseReason: c.ai?.category ?? suggestedCloseReason(c.classification) })))
      .sort((x, y) => (y.state === 'open') - (x.state === 'open') || y.updatedAt.localeCompare(x.updatedAt))],
  ['GET', /^\/api\/feature-requests$/, () => db.featureRequests.map(frView)],
  ['GET', /^\/api\/approvals$/, (req) => db.approvals.filter((p) => can(actorOf(req), 'approvals.team') || p.requestedBy === actorOf(req).name).map((p) => ({ ...p, account: summary(db.accounts.find((a) => a.id === p.accountId)) }))],
  ['GET', /^\/api\/log$/, () => getLog()],
  // Activity log: one row per user action, with the plain-language steps it caused
  // "Test connection" on the Connections page (admin)
  ['POST', /^\/api\/connections\/(\w+)\/test$/, (req, [id]) => testConnection(id)],
  // Ops center: what needs fixing right now (src/ops.js)
  ['GET', /^\/api\/ops$/, () => opsView(integrations())],
  ['GET', /^\/api\/activity$/, () => {
    const steps = getLog();
    return getActivities().map((a) => ({ ...a, steps: steps.filter((e) => e.activityId === a.id).reverse() }));
  }],
  // Why customers contact support: close reasons across all conversations (Snowflake-backed in production)
  ['GET', /^\/api\/support\/reasons$/, () => {
    const counts = Object.fromEntries(CLOSE_REASONS.map((r) => [r.id, 0]));
    for (const a of db.accounts) for (const c of a.conversations) if (c.closeReason) counts[c.closeReason]++;
    return CLOSE_REASONS.map((r) => ({ ...r, count: counts[r.id] }));
  }],

  ['POST', /^\/api\/accounts\/([\w-]+)\/deal-stage$/, (req, [id], b) => svc.changeDealStage(id, b.stage, actorOf(req).name, b.fields, b.tz, b)],
  ['POST', /^\/api\/accounts\/([\w-]+)\/deal-fields$/, (req, [id], b) => svc.updateDealFields(id, b.fields, actorOf(req).name, b.tz, b)],
  ['POST', /^\/api\/accounts\/([\w-]+)\/move-back$/, (req, [id], b) => svc.requestMoveBack(id, b, actorOf(req).name)],
  ['POST', /^\/api\/move-requests\/([\w-]+)$/, (req, [id], b) => svc.decideMoveBack(id, b.decision, actorOf(req).name)],
  ['POST', /^\/api\/accounts\/([\w-]+)\/follow-up$/, (req, [id], b) => svc.sendFollowUp(id, b, actorOf(req).name)],
  ['POST', /^\/api\/accounts\/([\w-]+)\/ask-colleague$/, (req, [id], b) => svc.askColleague(id, b.wonId, actorOf(req).name)],
  ['POST', /^\/api\/accounts\/([\w-]+)\/discount$/, (req, [id], b) => svc.requestDiscount(id, b, actorOf(req).name)],
  ['POST', /^\/api\/accounts\/([\w-]+)\/notes$/, (req, [id], b) => svc.addNote(id, b.text, actorOf(req).name)],
  ['POST', /^\/api\/accounts\/([\w-]+)\/tickets$/, (req, [id], b) => svc.openTicket(id, b, actorOf(req).name)],
  ['POST', /^\/api\/accounts\/([\w-]+)\/sync-usage$/, (req, [id]) => svc.syncUsage(id, actorOf(req).name)],
  ['POST', /^\/api\/anomalies\/scan$/, (req) => svc.detectAnomalies(actorOf(req).name)],
  ['POST', /^\/api\/anomalies\/([\w-]+)\/ack$/, (req, [id], b) => svc.acknowledgeAnomaly(id, actorOf(req).name, b?.note)],
  ['POST', /^\/api\/accounts\/([\w-]+)\/meetings$/, (req, [id], b) => svc.scheduleMeeting(id, b, actorOf(req).name)],
  ['POST', /^\/api\/conversations\/([\w-]+)\/call$/, (req, [id], b) => svc.quickCall(id, b?.text, actorOf(req).name)],
  ['POST', /^\/api\/accounts\/([\w-]+)\/save-plan$/, (req, [id], b) => svc.startSavePlan(id, b.text, actorOf(req).name)],
  ['POST', /^\/api\/feature-requests\/([\w-]+)\/tell$/, (req, [id], b) => svc.tellCustomer(id, b.accountId, actorOf(req).name)],
  // Demo: behaves exactly like the Jira webhook moving the issue one status forward
  ['POST', /^\/api\/feature-requests\/([\w-]+)\/advance$/, (req, [id]) => {
    const f = db.featureRequests.find((x) => x.id === id);
    if (!f) throw new svc.HttpError(404, 'Feature request not found');
    const next = svc.nextFeatureStatus(f);
    if (!next) throw new svc.HttpError(400, 'Nothing to advance');
    setActor('Jira');
    return svc.setFeatureStatus(f.jiraKey, next, 'Jira');
  }],
  ['POST', /^\/api\/onboarding\/sync$/, async (req) => {
    const ids = db.accounts.filter((a) => a.status === 'Onboarding').map((a) => a.id);
    const results = [];
    for (const id of ids) results.push(await svc.syncUsage(id, actorOf(req).name));
    const ticked = results.flatMap((r) => r.ticked.map((t) => `${r.account.name}: ${t}`));
    announce(ticked.length ? `Usage synced. Completed automatically: ${ticked.join('; ')}.` : 'Usage synced. No new onboarding milestones yet.', { icon: ticked.length ? 'i-done' : 'i-reset', tone: ticked.length ? 'good' : 'info' });
    return { ticked };
  }],
  ['POST', /^\/api\/accounts\/([\w-]+)\/steps\/(\w+)$/, (req, [id, step]) => svc.toggleStep(id, step, actorOf(req).name)],
  ['POST', /^\/api\/conversations\/([\w-]+)\/reply$/, (req, [id], b) => svc.reply(id, b.text, actorOf(req).name, { close: Boolean(b.close), reason: b.reason })],
  ['POST', /^\/api\/conversations\/([\w-]+)\/close$/, (req, [id], b) => svc.close(id, b.reason, actorOf(req).name)],
  ['POST', /^\/api\/conversations\/([\w-]+)\/assign$/, (req, [id], b) => svc.assign(id, b.assignee ?? null, actorOf(req).name)],
  ['POST', /^\/api\/conversations\/([\w-]+)\/snooze$/, (req, [id], b) => svc.snooze(id, b.until ?? null, actorOf(req).name)],
  ['POST', /^\/api\/conversations\/([\w-]+)\/classify$/, (req, [id], b) => svc.reclassify(id, b.id, b.tool, actorOf(req).name)],
  ['POST', /^\/api\/conversations\/([\w-]+)\/ai$/, (req, [id]) => svc.aiAssist(id, actorOf(req).name)],
  ['POST', /^\/api\/conversations\/([\w-]+)\/escalate$/, (req, [id]) => svc.escalate(id, actorOf(req).name)],
  ['POST', /^\/api\/approvals\/([\w-]+)$/, (req, [id], b) => svc.decideApproval(id, b.decision, actorOf(req).name, 'hub')],
  ['POST', /^\/api\/reset$/, () => {
    reset();
    clearLog();
    clearActivities();
    bus.emit('changed', { reset: true });
    announce('Demo data reset. Everything is back to the starting point.', { icon: 'i-reset', tone: 'info' });
    return { ok: true };
  }],
];

// Inbound webhooks need the raw body for signature checks, so they are handled separately.
async function handleWebhook(req, res, source) {
  const raw = await readRaw(req);
  if (source === 'intercom') {
    verifyIntercom(req, raw);
    return json(res, 200, await svc.ingestIntercom(parseJson(raw)));
  }
  if (source === 'slack') {
    verifySlack(req, raw);
    // Slack interactivity posts application/x-www-form-urlencoded with a `payload` JSON field
    const payload = JSON.parse(new URLSearchParams(raw).get('payload') || '{}');
    const action = payload.actions?.[0];
    if (!action) return json(res, 400, { error: 'No action' });
    // Only listed Slack users may approve (comma-separated Slack user IDs). Unset = demo mode.
    const allowed = (process.env.SLACK_APPROVER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(payload.user?.id)) throw new svc.HttpError(403, 'Not an approver');
    // Move-back requests go to the admin; a click in Slack acts as the hub's admin
    if (action.action_id?.startsWith('moveback_')) {
      const admin = USERS.find((u) => u.access === 'admin').name;
      setActor(`${admin} (in Slack)`);
      const decision = action.action_id === 'moveback_approve' ? 'approved' : 'declined';
      try {
        const result = await svc.decideMoveBack(action.value, decision, admin, 'slack');
        return json(res, 200, { ok: true, status: result.request.status });
      } catch (err) {
        // Already decided, or the deal moved on: Slack gets a 200 so it doesn't show a failure; the message was updated
        if (err.status && err.status < 500) return json(res, 200, { ok: false, error: err.message });
        throw err;
      }
    }
    const who = payload.user?.name || USERS.find((u) => u.approver).name;
    setActor(`${who} (in Slack)`);
    const decision = action.action_id === 'discount_approve' ? 'approved' : 'rejected';
    const result = await svc.decideApproval(action.value, decision, who, 'slack');
    return json(res, 200, { ok: true, status: result.approval.status });
  }
  if (source === 'jira') {
    // jira:issue_updated → map Jira workflow status names to ours
    const payload = parseJson(raw);
    const key = payload.issue?.key;
    const name = String(payload.issue?.fields?.status?.name ?? '').toLowerCase();
    const map = { submitted: 'submitted', 'to do': 'submitted', 'under review': 'under_review', planned: 'planned', 'in progress': 'in_progress', done: 'shipped', shipped: 'shipped', "won't do": 'declined', declined: 'declined' };
    if (!key || !map[name]) return json(res, 200, { ignored: true });
    setActor('Jira');
    return json(res, 200, await svc.setFeatureStatus(key, map[name], 'Jira'));
  }
  json(res, 404, { error: 'Unknown webhook source' });
}

function sse(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  const handlers = Object.fromEntries(['integration', 'inbound', 'changed', 'activity'].map((type) => [type, (data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)]));
  for (const [t, h] of Object.entries(handlers)) bus.on(t, h);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    for (const [t, h] of Object.entries(handlers)) bus.off(t, h);
  });
}

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)));
  if (rel.startsWith('..')) return json(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(join(PUBLIC_DIR, rel));
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/events') return sse(req, res);
    if (pathname === '/healthz') return json(res, 200, { ok: true });
    const hook = pathname.match(/^\/webhooks\/(\w+)/);
    if (hook && req.method === 'POST') return await withActivity({ slack: 'Slack', jira: 'Jira' }[hook[1]] ?? 'Intercom', () => handleWebhook(req, res, hook[1]), { slack: 'sales', jira: 'cs' }[hook[1]] ?? 'support');

    for (const [method, pattern, handler] of routes) {
      const m = pathname.match(pattern);
      if (!m || req.method !== method) continue;
      const cap = guard(req, method, pathname);
      const body = method === 'POST' ? parseJson(await readRaw(req)) : undefined;
      const run = () => handler(req, m.slice(1), body);
      return json(res, 200, await (method === 'POST' ? withActivity(actorOf(req).name, run, cap ? areaOf(cap) : 'system') : run()));
    }
    if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(pathname, res);
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    json(res, status, { error: err.message, ...(err.extra ?? {}) });
  }
});

// Background jobs report each run to the Ops center, so one that fails or stops shows up there
setInterval(() => runJob('sla', () => svc.checkSla()).catch((e) => console.error('SLA check failed', e)), 30_000);
setInterval(() => runJob('anomalies', () => withActivity('Snowflake monitor', () => svc.detectAnomalies('Snowflake monitor'), 'cs')).catch((e) => console.error('Anomaly check failed', e)), 30 * 60_000);

server.listen(PORT, () => {
  console.log(`Frontline Hub → http://localhost:${PORT}`);
  console.log(integrations().map((i) => `${i.name}: ${i.live ? 'live' : 'mock'}`).join(' · '));
});
