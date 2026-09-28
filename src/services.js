// Business actions. Each is one click for a rep; behind it we fan out to the right systems.
// Every action is also written to Snowflake (GTM.HUB_EVENTS) for reporting.

import * as hubspot from './connectors/hubspot.js';
import * as jira from './connectors/jira.js';
import * as intercom from './connectors/intercom.js';
import * as slack from './connectors/slack.js';
import * as snowflake from './connectors/snowflake.js';
import * as claude from './connectors/claude.js';
import * as google from './connectors/google.js';
import { bus } from './bus.js';
import { announce, withActivity } from './activity.js';
import { CLASSIFICATIONS, classify, classificationLabel, fromCloseReason } from './classify.js';
import { CLOSE_REASONS, CONFIG, DEAL_STAGES, MOVE_BACK_REASONS, FR_STATUSES, ONBOARDING_STEPS, PEOPLE, STAGE_GATES, USERS, db, findAccount, findAccountByEmail, findConversation } from './store.js';
import { gatesBetween, missingFields } from './deals.js';
import { anomalyText, computeHealth } from './health.js';

export class HttpError extends Error {
  // extra: { field } points the UI at the input to fix; { code, ... } drives special pop-ups (confirm, stale, needs-admin)
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const now = () => new Date().toISOString();
const money = (n) => '$' + Number(n).toLocaleString('en-US');
const need = (cond, status, msg, extra) => { if (!cond) throw new HttpError(status, msg, extra); };
const hubUrl = (path) => `${process.env.PUBLIC_URL || 'http://localhost:3000'}/#${path}`;

function getAccount(id) {
  const a = findAccount(id);
  need(a, 404, 'Account not found');
  return a;
}

const SYSTEM_NAMES = { hubspot: 'HubSpot', jira: 'Jira', intercom: 'Intercom', slack: 'Slack', snowflake: 'Snowflake', claude: 'Claude', google: 'Google Calendar' };
const first = (name) => String(name).split(' ')[0];
const stageLabel = (id) => DEAL_STAGES.find((x) => x.id === id)?.label ?? id;

// A failed call stops the action. When the system gave a reason (e.g. Slack's "channel_not_found"), show it,
// so the fix is obvious; otherwise it most likely didn't answer at all.
const HINTS = {
  channel_not_found: 'the channel or member ID doesn\'t exist in this workspace (check SLACK_DM_USER_ID and the channel names)',
  not_in_channel: 'the app isn\'t in that channel (add chat:write.public, or invite the app)',
  missing_scope: 'the app is missing a permission (see Connections → Slack → How to connect)',
  invalid_auth: 'the token isn\'t valid (check SLACK_BOT_TOKEN)',
  not_authed: 'no token was sent (check SLACK_BOT_TOKEN)',
};
function failIfRejected(entry) {
  if (entry.ok) return;
  const name = SYSTEM_NAMES[entry.system] ?? entry.system;
  const reason = entry.status && entry.response && typeof entry.response === 'object' ? (entry.response.error ?? entry.response.message) : null;
  throw new HttpError(502, reason
    ? `${name} said “${reason}”${HINTS[reason] ? `: ${HINTS[reason]}` : ''}. Nothing was changed.`
    : `${name} didn't respond, so nothing was changed. Please try again in a minute.`);
}

// Any change can move an account's health, so recompute before telling the UI.
function changed(accountId) {
  const a = accountId && findAccount(accountId);
  if (a) a.health = computeHealth(a, db.anomalies).score;
  bus.emit('changed', { accountId });
}
const csmOf = (a) => USERS.find((u) => u.name === a.csm);
const track = (event, accountId, actor, props) => snowflake.trackEvent(event, accountId, actor, props);

// ---------------------------------------------------------------- sales

const GATE_FIELDS = Object.fromEntries(Object.values(STAGE_GATES).flatMap((g) => g.fields.map((f) => [f.id, f])));

// Keeps only known gate fields, with the right types.
function cleanFields(fields = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    const f = GATE_FIELDS[k];
    if (!f) continue;
    if (f.type === 'number') out[k] = v === '' || v == null ? '' : Number(v);
    else if (f.type === 'multi') out[k] = (Array.isArray(v) ? v : [v]).filter((x) => f.options.includes(x));
    else if (f.type === 'select') out[k] = f.options.includes(v) ? v : '';
    else out[k] = String(v ?? '').trim();
  }
  return out;
}
const hsProps = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [GATE_FIELDS[k].hs, k === 'closeDate' ? v : Array.isArray(v) ? v.join(';') : String(v)]));
function applyFields(a, fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'closeDate') a.deal.closeDate = v ? new Date(`${v}T12:00:00Z`).toISOString() : null;
    else a.deal.fields[k] = v;
  }
}
const seOf = (name) => PEOPLE.solutionsEngineers.find((p) => p.name === name);

// ---- data integrity: every rule the forms show is enforced here too, with one clear message per problem
const dayIn = (tz) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); } };
const fmtDay = (ymd) => new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const MAX_LEN = { textarea: 2000, text: 200 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Throws on anything impossible; returns soft warnings (things that are unusual but can be right).
function checkDealFields(a, incoming, tz = 'UTC') {
  const bad = (field, msg) => { throw new HttpError(400, msg, { field }); };
  const warnings = [];
  for (const [k, v] of Object.entries(incoming)) {
    const f = GATE_FIELDS[k];
    if (typeof v === 'string' && MAX_LEN[f.type] && v.length > MAX_LEN[f.type]) bad(k, `${f.label} is too long. Please keep it under ${MAX_LEN[f.type]} characters.`);
  }
  // Only values the user changed are checked against today (a demo that already happened can stay on record)
  const stored = { closeDate: a.deal.closeDate?.slice(0, 10) ?? '', demoDate: a.deal.fields.demoDate ?? '' };
  const changedNow = (k) => k in incoming && incoming[k] !== stored[k];
  if (changedNow('closeDate') && incoming.closeDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(incoming.closeDate) || Number.isNaN(+new Date(incoming.closeDate))) bad('closeDate', 'Please pick a valid close date.');
    if (incoming.closeDate < dayIn(tz)) bad('closeDate', `The close date (${fmtDay(incoming.closeDate)}) is in the past. Please pick today or a later date.`);
  }
  if (changedNow('demoDate') && incoming.demoDate) {
    const at = new Date(`${incoming.demoDate}:00Z`);
    if (Number.isNaN(+at)) bad('demoDate', 'Please pick a valid demo date and time.');
    if (+at < Date.now() - 10 * 60_000) bad('demoDate', 'The demo date is in the past. Please pick an upcoming date and time.');
  }
  // The demo has to happen before the deal can close
  const demo = 'demoDate' in incoming ? incoming.demoDate : a.deal.fields.demoDate;
  const close = 'closeDate' in incoming ? incoming.closeDate : a.deal.closeDate?.slice(0, 10);
  if (demo && close && demo.slice(0, 10) > close && (changedNow('demoDate') || changedNow('closeDate'))) {
    if (changedNow('demoDate')) bad('demoDate', `The demo date (${fmtDay(demo)}) is after the close date (${fmtDay(close)}). Please set a correct one.`);
    bad('closeDate', `The close date (${fmtDay(close)}) is before the demo (${fmtDay(demo)}). Please set a correct one.`);
  }
  if ('properties' in incoming && incoming.properties !== '') {
    const n = incoming.properties;
    if (!Number.isInteger(n) || n < 1) bad('properties', 'Properties in scope should be a whole number, at least 1.');
    if (a.properties && n > a.properties) bad('properties', `Properties in scope (${n}) is more than the ${a.properties} properties ${a.name} has. Please check the number.`);
  }
  if ('businessValue' in incoming && incoming.businessValue !== '') {
    const v = incoming.businessValue;
    if (!(v > 0)) bad('businessValue', 'Business value should be more than $0.');
    if (v > 100_000_000) bad('businessValue', "That business value looks too high. Please check the number (it's $ per year).");
    if (v < a.deal.amount) warnings.push({ field: 'businessValue', message: `The business value (${money(v)}) is under the deal's ARR (${money(a.deal.amount)}). Customers rarely buy when the value is below the price.` });
  }
  if (incoming.legalContact && incoming.legalContact.includes('@') && !EMAIL.test(incoming.legalContact)) bad('legalContact', "That legal contact email doesn't look right. Please check it.");
  for (const k of ['signer', 'champion', 'decisionMaker']) if (incoming[k] && incoming[k].length < 2) bad(k, `Please enter the ${GATE_FIELDS[k].label.toLowerCase()}'s name.`);
  return warnings;
}
// Unusual but possible: the user confirms once, then we save.
const confirmOrThrow = (warnings, confirmed) => {
  if (warnings.length && !confirmed) throw new HttpError(409, warnings.map((w) => w.message).join(' '), { code: 'confirm', warnings, field: warnings[0].field });
};

// Someone else changed this deal after you opened the form: say who, when and what, instead of overwriting.
function checkFresh(a, baseVersion, actor, force) {
  if (baseVersion == null || force || Number(baseVersion) === a.deal.version || a.deal.editedBy === actor) return;
  throw new HttpError(409, `${a.deal.editedBy} changed this deal while you were editing.`, { code: 'stale', by: a.deal.editedBy, at: a.deal.editedAt, what: a.deal.lastChange });
}
function touchDeal(a, actor, what) {
  a.deal.version = (a.deal.version ?? 1) + 1;
  Object.assign(a.deal, { editedBy: actor, editedAt: now(), lastChange: what });
}

// Deals only move forward. Back (or out of Closed won/lost) is admin-only.
const OPEN_ORDER = DEAL_STAGES.map((s) => s.id).filter((id) => !['closedwon', 'closedlost'].includes(id));
const isClosedStage = (id) => id === 'closedwon' || id === 'closedlost';
export function isBackward(from, to) {
  if (from === to) return false;
  if (isClosedStage(from)) return true;
  return !isClosedStage(to) && OPEN_ORDER.indexOf(to) < OPEN_ORDER.indexOf(from);
}
const isAdminName = (name) => USERS.find((u) => u.name === name)?.access === 'admin';
const admins = () => USERS.filter((u) => u.access === 'admin');
const reasonText = (reason, note) => `${reason}${note ? `: ${note}` : ''}`;
function checkReason(reason, note) {
  need(MOVE_BACK_REASONS.includes(reason), 400, 'Pick a reason for moving the deal back.', { field: 'reason' });
  need(reason !== 'Other' || note?.trim(), 400, 'Tell the admin a bit more in the note.', { field: 'note' });
  need(!note || note.length <= 500, 400, 'Please keep the note under 500 characters.', { field: 'note' });
}

// The demo invite: prospect + SE + AE, with a Meet link, from the fields the Demo pop-up asked for.
async function bookDemo(a, actor, tz) {
  const f = a.deal.fields;
  const at = f.demoDate ? new Date(`${f.demoDate}:00Z`) : null;
  if (!at || +at < Date.now()) return null; // no date, or already in the past: nothing to invite to
  const { meeting } = await scheduleMeeting(a.id, {
    title: `Frontline demo: ${a.name}`, start: at.toISOString(), minutes: 45, tz, confirmed: true,
    team: [f.se, a.owner].filter(Boolean), withContact: true,
    agenda: `What we'll show: ${(f.useCases ?? []).join(', ') || 'to be agreed'}\nAttendees: ${f.attendees || 'to be confirmed'}\nERP: ${f.erp || 'n/a'} · ${a.properties} properties`,
  }, actor);
  return meeting;
}
const fmtDemo = (v, tz) => (v ? fmtWhen(new Date(`${v}:00Z`).toISOString(), tz) : 'date to be set');

// Automation: a demo is set, so the Solutions Engineer gets everything they need in Slack.
async function loopInSe(a, actor, tz = 'UTC') {
  const f = a.deal.fields;
  const se = seOf(f.se);
  if (!se) return null;
  await slack.dm(se.slackId, se.name, `Demo: ${a.name} on ${fmtDemo(f.demoDate, tz)}`, [
    slack.section(`:tv: *You're on the ${a.name} demo* with ${actor}\n*When:* ${fmtDemo(f.demoDate, tz)}\n*Show:* ${(f.useCases ?? []).join(', ') || 'to be agreed'}\n*Attendees:* ${f.attendees || 'to be confirmed'}`),
    slack.section(`*Pain:* ${f.pain || 'n/a'}\n*ERP:* ${f.erp || 'n/a'} · ${a.properties} properties · ${money(a.deal.amount)} ARR`),
    slack.context(`<${hubUrl(`/accounts/${a.id}`)}|Open in Frontline Hub>`),
  ]);
  return se;
}

export async function changeDealStage(accountId, stage, actor, fields = {}, tz = 'UTC', { reason, note, baseVersion, force, confirmed } = {}) {
  const a = getAccount(accountId);
  need(DEAL_STAGES.some((s) => s.id === stage), 400, 'Invalid stage');
  if (stage === a.deal.stage) return { account: a };
  checkFresh(a, baseVersion, actor, force);
  const back = isBackward(a.deal.stage, stage);
  if (back) {
    need(isAdminName(actor), 403, `Deals only move forward. To move ${a.name} back to ${stageLabel(stage)}, send the admin a request with the reason.`, { code: 'needs-admin' });
    checkReason(reason, note);
  }
  const pending = db.approvals.find((p) => p.accountId === a.id && p.status === 'pending');
  need(!(stage === 'closedwon' && pending), 409, 'A discount approval is still pending for this deal');
  const incoming = cleanFields(fields);
  const missing = missingFields(a, gatesBetween(a.deal.stage, stage), incoming);
  need(!missing.length, 400, `Please fill in: ${missing.map((f) => f.label.toLowerCase()).join(', ')}.`, { field: missing[0]?.id });
  confirmOrThrow(checkDealFields(a, incoming, tz), confirmed);

  const seBefore = a.deal.fields.se;
  failIfRejected(await hubspot.updateDeal(a.deal.id, { dealstage: stage, ...hsProps(incoming) }, 'Update deal stage',
    `Moved the deal to “${stageLabel(stage)}”${Object.keys(incoming).length ? ' and saved the deal details' : ''}`));
  const from = a.deal.stage;
  a.deal.stage = stage;
  a.deal.stageEnteredAt = now();
  applyFields(a, incoming);
  touchDeal(a, actor, `moved it to ${stageLabel(stage)}`);
  await track('deal.stage_changed', a.id, actor, { from, to: stage, ...(back ? { movedBack: true, reason: reasonText(reason, note) } : {}), ...(stage === 'closedlost' ? { reason: a.deal.fields.lostReason, competitor: a.deal.fields.competitor || null } : {}) });

  if (back) {
    await hubspot.createNote(a.hubspotCompanyId, `Deal moved back from ${stageLabel(from)} to ${stageLabel(stage)} by ${actor}. Reason: ${reasonText(reason, note)}`);
    announce(`${a.name} moved back from ${stageLabel(from)} to ${stageLabel(stage)}. The reason is noted in HubSpot.${from === 'closedwon' ? ' Onboarding stays as it is.' : ''}`, { icon: 'i-arrow', accountId: a.id });
  } else if (stage === 'closedwon' && a.onboarding) {
    // Won again after a reopen: onboarding already exists, so nothing is created twice
    announce(`${a.name} is back to Closed won. Onboarding was already set up, so nothing was created twice.`, { icon: 'i-rocket', accountId: a.id });
  } else if (stage === 'closedwon') {
    await kickOffOnboarding(a, actor);
  } else if (stage === 'closedlost') {
    announce(`${a.name} marked as lost (${a.deal.fields.lostReason}${a.deal.fields.competitor ? `: ${a.deal.fields.competitor}` : ''}). The reason is in HubSpot for the win/loss report.`, { icon: 'i-x', accountId: a.id });
  } else if (stage === 'presentationscheduled' || (a.deal.fields.se && a.deal.fields.se !== seBefore)) {
    const se = await loopInSe(a, actor, tz);
    const invite = stage === 'presentationscheduled' && fields.sendInvite !== false && fields.sendInvite !== 'false' ? await bookDemo(a, actor, tz) : null;
    announce(`${a.name} moved to ${stageLabel(stage)}.${invite ? ` ${a.contact.name}${se ? ` and ${se.name}` : ''} got the calendar invite with a Google Meet link.` : ''}${se ? ` ${se.name} (${se.title}) has the demo details in Slack.` : ''}`, { icon: invite ? 'i-video' : 'i-arrow', accountId: a.id });
  } else {
    announce(`${a.name} moved to ${stageLabel(stage)}.${Object.keys(incoming).length ? ' Deal details saved to HubSpot.' : ''}`, { icon: 'i-arrow', accountId: a.id });
  }
  changed(a.id);
  return { account: a };
}

// Fill in deal details without changing the stage (e.g. a missing SE or a new close date).
export async function updateDealFields(accountId, fields, actor, tz = 'UTC', { baseVersion, force, confirmed } = {}) {
  const a = getAccount(accountId);
  const incoming = cleanFields(fields);
  need(Object.keys(incoming).length, 400, 'Nothing to save');
  checkFresh(a, baseVersion, actor, force);
  const missing = Object.keys(incoming).filter((k) => !GATE_FIELDS[k].requiredIf && (incoming[k] === '' || (Array.isArray(incoming[k]) && !incoming[k].length)));
  need(!missing.length, 400, `Please fill in: ${missing.map((k) => GATE_FIELDS[k].label.toLowerCase()).join(', ')}.`, { field: missing[0] });
  confirmOrThrow(checkDealFields(a, incoming, tz), confirmed);
  const seBefore = a.deal.fields.se;
  failIfRejected(await hubspot.updateDeal(a.deal.id, hsProps(incoming), 'Update deal details', 'Saved the deal details'));
  applyFields(a, incoming);
  touchDeal(a, actor, incoming.closeDate && Object.keys(incoming).length === 1 ? `moved the close date to ${fmtDay(incoming.closeDate)}` : 'updated the deal details');
  await track('deal.fields_updated', a.id, actor, { fields: Object.keys(incoming) });
  const se = a.deal.fields.se && a.deal.fields.se !== seBefore ? await loopInSe(a, actor, tz) : null;
  const what = Object.keys(incoming).length === 1 && incoming.closeDate
    ? `Close date for ${a.name} moved to ${new Date(a.deal.closeDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`
    : `${a.name}'s deal details saved to HubSpot.`;
  announce(`${what}${se ? ` ${se.name} (${se.title}) got the demo details in Slack.` : ''}`, { icon: 'i-pen', accountId: a.id });
  changed(a.id);
  return { account: a };
}

// ---- moving a deal back: the rep asks with a reason, an admin decides (Slack + Good morning)
export async function requestMoveBack(accountId, { to, reason, note }, actor) {
  const a = getAccount(accountId);
  need(DEAL_STAGES.some((s) => s.id === to), 400, 'Invalid stage');
  need(isBackward(a.deal.stage, to), 400, `${stageLabel(to)} comes after ${stageLabel(a.deal.stage)}, so you can move the deal there yourself.`);
  note = String(note ?? '').trim();
  checkReason(reason, note);
  const open = db.moveRequests.find((r) => r.accountId === a.id && r.status === 'pending');
  need(!open, 409, `${open?.by} already asked to move ${a.name} back to ${stageLabel(open?.to)}. The admin will decide soon.`);
  const r = { id: `mv_${Date.now()}`, accountId: a.id, from: a.deal.stage, to, reason, note, by: actor, at: now(), status: 'pending' };
  // The admin can decide right in Slack (buttons post back to /webhooks/slack) or in the hub
  for (const ad of admins()) {
    const msg = await slack.dm(ad.slackId, ad.name, `Move-back request: ${a.name}`, moveBackBlocks(a, r));
    failIfRejected(msg);
    r.slack ??= { channel: msg.response.channel, ts: msg.response.ts };
  }
  db.moveRequests.unshift(r);
  await track('deal.move_back_requested', a.id, actor, { from: r.from, to, reason });
  announce(`Request sent to ${admins().map((x) => x.name).join(' and ')} (Admin) in Slack. ${a.name} stays in ${stageLabel(r.from)} until they decide.`, { icon: 'i-clock', tone: 'info', accountId: a.id });
  changed(a.id);
  return { request: r };
}

function moveBackBlocks(a, r) {
  return [
    slack.section(`:leftwards_arrow_with_hook: *${r.by} asks to move ${a.name} back* from ${stageLabel(r.from)} to *${stageLabel(r.to)}*\n*Reason:* ${reasonText(r.reason, r.note)}`),
    slack.buttons([
      { text: `Move it back to ${stageLabel(r.to)}`, actionId: 'moveback_approve', value: r.id, style: 'primary' },
      { text: 'Decline', actionId: 'moveback_decline', value: r.id },
    ]),
    slack.context(`<${hubUrl('/home')}|Or decide in Frontline Hub>`),
  ];
}
// Replace the buttons with the outcome, so the Slack message shows what was decided (from Slack or the hub)
async function closeMoveBackMessage(a, r, text, via) {
  if (!r.slack) return;
  await slack.updateMessage(r.slack.channel, r.slack.ts, `Move-back ${r.status}: ${a.name}`, [
    slack.section(text),
    slack.context(`Requested by ${r.by} · decided ${via === 'slack' ? 'in Slack' : 'in Frontline Hub'}`),
  ]);
}

export async function decideMoveBack(id, decision, actor, via = 'hub') {
  const r = db.moveRequests.find((x) => x.id === id);
  need(r, 404, 'Request not found');
  need(r.status === 'pending', 409, `Already ${r.status}`);
  need(['approved', 'declined'].includes(decision), 400, 'Invalid decision');
  need(isAdminName(actor), 403, 'Only an admin can move a deal back.');
  const a = getAccount(r.accountId);
  if (decision === 'approved') {
    if (a.deal.stage !== r.from) {
      r.status = 'outdated';
      await closeMoveBackMessage(a, r, `:information_source: ${a.name} is in ${stageLabel(a.deal.stage)} now, so this request no longer applies.`, via);
      changed(a.id);
      throw new HttpError(409, `${a.name} is in ${stageLabel(a.deal.stage)} now, not ${stageLabel(r.from)}, so this request no longer applies.`);
    }
    await changeDealStage(a.id, r.to, actor, {}, 'UTC', { reason: r.reason, note: [r.note, `requested by ${r.by}`].filter(Boolean).join(' · ') });
  }
  Object.assign(r, { status: decision, decidedBy: actor, decidedAt: now(), via });
  await closeMoveBackMessage(a, r, decision === 'approved'
    ? `:white_check_mark: *${a.name}* moved back to ${stageLabel(r.to)} by ${actor}.`
    : `:x: ${actor} kept *${a.name}* in ${stageLabel(r.from)}.`, via);
  const rep = USERS.find((u) => u.name === r.by);
  if (rep?.slackId) await slack.dm(rep.slackId, rep.name, `Move-back ${decision}: ${a.name}`, [
    slack.section(decision === 'approved' ? `:white_check_mark: ${actor} moved *${a.name}* back to ${stageLabel(r.to)}.` : `:x: ${actor} kept *${a.name}* in ${stageLabel(r.from)}. Reach out to them if you think it should move back.`),
  ]);
  await track(`deal.move_back_${decision}`, a.id, actor, { requestId: r.id });
  if (decision === 'declined') announce(`${a.name} stays in ${stageLabel(r.from)}. ${r.by} was told in Slack.`, { icon: 'i-x', accountId: a.id });
  changed(a.id);
  return { request: r };
}

export async function sendFollowUp(accountId, { subject, body }, actor) {
  const a = getAccount(accountId);
  need(subject?.trim() && body?.trim(), 400, 'Subject and message are required');
  failIfRejected(await hubspot.logEmail(a.deal.id, { to: a.contact.email, subject: subject.trim(), body: body.trim() }));
  a.deal.activities.unshift({ type: 'email', dir: 'out', at: now(), subject: subject.trim() });
  a.deal.followedUpAt = now();
  await track('deal.follow_up_sent', a.id, actor, {});
  announce(`Follow-up sent to ${a.contact.name} at ${a.name} and logged on the deal in HubSpot.`, { icon: 'i-mail', accountId: a.id });
  changed(a.id);
  return { account: a };
}

// "A colleague won something similar": DM them in Slack with the context, so the rep gets the playbook.
export async function askColleague(accountId, wonId, actor) {
  const a = getAccount(accountId);
  const w = db.wonDeals.find((x) => x.id === wonId);
  need(w, 404, 'Deal not found');
  const colleague = USERS.find((u) => u.name === w.owner);
  need(colleague?.slackId, 400, `${w.owner} isn't on Slack`);
  failIfRejected(await slack.dm(colleague.slackId, colleague.name, `${actor} would like to learn from your ${w.account} win`, [
    slack.section(`:bulb: *${actor} is working ${a.name}*, which looks a lot like your *${w.account}* win.\n${a.segment} · ${a.properties} properties · ${a.deal.fields.erp || 'ERP n/a'} · ${money(a.deal.amount)} ARR · now in ${stageLabel(a.deal.stage)}`),
    slack.section(`*${w.account}:* ${w.value}.\n_What worked:_ ${w.how}.\nCould you share what made it click? 15 minutes would help.`),
    slack.context(`<${hubUrl(`/accounts/${a.id}`)}|Open ${a.name} in Frontline Hub>`),
  ]));
  a.deal.askedColleague = { wonId, at: now() };
  await track('deal.asked_colleague', a.id, actor, { wonId, colleague: colleague.name });
  announce(`Asked ${colleague.name} in Slack how they won ${w.account}, for ${a.name}.`, { icon: 'i-users', accountId: a.id });
  changed(a.id);
  return { account: a };
}

// Automation: closing a deal starts onboarding without anyone leaving the hub.
async function kickOffOnboarding(a, actor) {
  const ch = slack.channels();
  await slack.postMessage(ch.deals, `Closed won: ${a.name} (${money(a.deal.amount)} ARR)`, [
    slack.section(`:tada: *Closed won: ${a.name}*\n${money(a.deal.amount)} ARR · ${a.properties} properties · ${a.segment}`),
    slack.context(`AE: ${actor} · CSM: ${a.csm} · <${hubUrl(`/accounts/${a.id}`)}|Open in Frontline Hub>`),
  ], 'Announce win');

  const epic = await jira.createIssue({
    project: 'onboarding', type: 'Epic', priority: 'High', labels: ['onboarding', 'auto'],
    summary: `Onboarding: ${a.name} (${a.properties} properties)`,
    description: `Closed by ${actor}. ARR ${money(a.deal.amount)}. Contact: ${a.contact.name} (${a.contact.email}). CSM: ${a.csm}`,
  });

  const channelName = `onb-${a.id}`.slice(0, 80);
  const created = await slack.createChannel(channelName);
  const channelId = created.response?.channel?.id ?? `#${channelName}`;
  await slack.postMessage(channelId, `Onboarding kickoff for ${a.name}`, [
    slack.section(`:rocket: *Onboarding kickoff: ${a.name}*\nCSM *${a.csm}* · Jira epic *${epic.response?.key ?? 'n/a'}*`),
    slack.section(ONBOARDING_STEPS.map((s) => `☐ ${s.label}`).join('\n')),
    slack.context(`Steps marked auto are ticked from Snowflake usage. <${hubUrl(`/accounts/${a.id}`)}|Track in Frontline Hub>`),
  ], 'Kickoff checklist', `#${channelName}`);

  a.status = 'Onboarding';
  a.health = 70;
  a.usage ??= { propertiesLive: 0, activeUsers: 0, pos30d: 0, invoicesAi30d: 0, spend30d: 0, vendorsConnected: 0, lastActive: now() };
  a.onboarding = {
    startedAt: now(),
    slackChannel: `#${channelName}`,
    jiraEpic: epic.response?.key,
    steps: Object.fromEntries(ONBOARDING_STEPS.map((s) => [s.id, { done: false }])),
  };
  if (epic.ok) a.tickets.unshift({ key: epic.response.key, summary: `Onboarding: ${a.name}`, status: 'To Do', priority: 'High', createdAt: now() });
  await track('onboarding.started', a.id, actor, { jiraEpic: epic.response?.key, slackChannel: channelName });
  announce(`${a.name} is a customer! The team was told in #deals, and ${a.csm} has an onboarding plan and a #${channelName} channel ready.`, { icon: 'i-rocket', accountId: a.id });
}

export async function requestDiscount(accountId, { pct, reason }, actor) {
  const a = getAccount(accountId);
  pct = Number(pct);
  need(pct > 0 && pct <= 50, 400, 'Discount must be between 1% and 50%');
  need(!db.approvals.some((p) => p.accountId === a.id && p.status === 'pending'), 409, 'There is already a pending request for this deal');

  if (pct <= CONFIG.discountApprovalThreshold) {
    failIfRejected(await hubspot.updateDeal(a.deal.id, { discount_pct: String(pct) }, 'Apply discount', `Saved the ${pct}% discount on the deal`));
    a.deal.discountPct = pct;
    await track('discount.applied', a.id, actor, { pct });
    announce(`${pct}% discount applied to ${a.name}'s deal.`, { icon: 'i-tag', accountId: a.id });
    changed(a.id);
    return { account: a, approvalNeeded: false };
  }

  const approval = { id: `apr_${Date.now()}`, accountId: a.id, dealId: a.deal.id, pct, reason: reason || '', requestedBy: actor, requestedAt: now(), status: 'pending' };
  const msg = await slack.postMessage(slack.channels().dealDesk, `Discount approval needed: ${a.name} ${pct}%`, approvalBlocks(a, approval), 'Request approval');
  failIfRejected(msg);
  approval.slack = { channel: msg.response.channel, ts: msg.response.ts };
  db.approvals.unshift(approval);
  await track('discount.requested', a.id, actor, { pct, approvalId: approval.id });
  const approver = USERS.find((u) => u.approver);
  announce(`Discount request sent. ${approver.name} (${approver.role}) will approve or reject ${pct}% off for ${a.name}.`, { icon: 'i-clock', tone: 'info', accountId: a.id });
  changed(a.id);
  return { account: a, approvalNeeded: true, approval };
}

function approvalBlocks(a, p) {
  const net = Math.round(a.deal.amount * (1 - p.pct / 100));
  return [
    slack.section(`:money_with_wings: *Discount approval: ${a.name}*\n*${p.pct}%* off ${money(a.deal.amount)} → *${money(net)}* ARR (threshold ${CONFIG.discountApprovalThreshold}%)`),
    slack.section(`> ${p.reason || 'No reason given'}\nRequested by ${p.requestedBy}`),
    slack.buttons([
      { text: 'Approve', actionId: 'discount_approve', value: p.id, style: 'primary' },
      { text: 'Reject', actionId: 'discount_reject', value: p.id, style: 'danger' },
    ]),
  ];
}

// Called from the hub UI or from Slack's interactivity webhook (the manager clicked a button).
export async function decideApproval(approvalId, decision, actor, via = 'hub') {
  const p = db.approvals.find((x) => x.id === approvalId);
  need(p, 404, 'Approval not found');
  need(p.status === 'pending', 409, `Already ${p.status}`);
  need(['approved', 'rejected'].includes(decision), 400, 'Invalid decision');
  const a = getAccount(p.accountId);

  if (decision === 'approved') {
    failIfRejected(await hubspot.updateDeal(a.deal.id, { discount_pct: String(p.pct) }, 'Apply approved discount', `Saved the approved ${p.pct}% discount on the deal`));
    a.deal.discountPct = p.pct;
  }
  Object.assign(p, { status: decision, decidedBy: actor, decidedAt: now(), via });

  const icon = decision === 'approved' ? ':white_check_mark:' : ':x:';
  await slack.updateMessage(p.slack.channel, p.slack.ts, `Discount ${decision}: ${a.name} ${p.pct}%`, [
    slack.section(`${icon} *${a.name}: ${p.pct}% discount ${decision}* by ${actor}`),
    slack.context(`Requested by ${p.requestedBy} · decided ${via === 'slack' ? 'in Slack' : 'in Frontline Hub'}`),
  ]);
  await track(`discount.${decision}`, a.id, actor, { pct: p.pct, approvalId: p.id, via });
  announce(decision === 'approved'
    ? `Approved: ${a.name} gets ${p.pct}% off. ${p.requestedBy} can close the deal.`
    : `Rejected: no ${p.pct}% discount for ${a.name}. ${p.requestedBy} was told.`, { icon: decision === 'approved' ? 'i-done' : 'i-x', tone: decision === 'approved' ? 'good' : '', accountId: a.id });
  changed(a.id);
  return { approval: p };
}

export async function addNote(accountId, text, actor) {
  const a = getAccount(accountId);
  need(text?.trim(), 400, 'Note is empty');
  failIfRejected(await hubspot.createNote(a.hubspotCompanyId, `${text.trim()}\n— ${actor}`));
  a.notes.unshift({ text: text.trim(), author: actor, at: now() });
  await track('note.added', a.id, actor, {});
  announce(`Note saved to ${a.name}.`, { icon: 'i-pen', accountId: a.id });
  changed(a.id);
  return { account: a };
}

// ---------------------------------------------------------------- support

export async function openTicket(accountId, { summary, description, priority }, actor) {
  const a = getAccount(accountId);
  need(summary?.trim(), 400, 'Summary is required');
  const entry = await jira.createIssue({
    summary: `[${a.name}] ${summary.trim()}`,
    description: `${description || ''}\n\nOpened by ${actor} from Frontline Hub. Account: ${a.domain}, ${a.segment}, ${a.properties} properties.`,
    priority: priority || 'Medium',
    labels: ['customer-reported'],
  });
  failIfRejected(entry);
  a.tickets.unshift({ key: entry.response.key, summary: summary.trim(), status: 'To Do', priority: priority || 'Medium', createdAt: now() });
  await track('ticket.created', a.id, actor, { key: entry.response.key });
  announce(`New Jira ticket ${entry.response.key} opened for ${a.name}.`, { icon: 'i-clipboard', accountId: a.id });
  changed(a.id);
  return { account: a, key: entry.response.key };
}

function getConversation(id) {
  const found = findConversation(id);
  need(found, 404, 'Conversation not found');
  return found;
}

const reasonLabel = (id) => CLOSE_REASONS.find((r) => r.id === id)?.label;

// Closing always carries a reason: tagged in Intercom, logged to Snowflake for "why do customers contact us".
async function closeWithReason(a, c, reason, actor) {
  need(reasonLabel(reason), 400, 'Pick a close reason');
  await intercom.tag(c.id, reason, reasonLabel(reason));
  failIfRejected(await intercom.close(c.id));
  Object.assign(c, { state: 'closed', closeReason: reason, closedAt: now(), closedBy: actor, snoozedUntil: null, slaDueAt: null });
  await track('conversation.closed', a.id, actor, { conversationId: c.id, reason });
  announce(`Conversation with ${first(customerOf(c))} at ${a.name} closed as “${reasonLabel(reason)}”.`, { icon: 'i-done', accountId: a.id });
  if (reason === 'feature_request') await logFeatureRequest(a, c, actor);
}

const customerOf = (c) => c.messages.find((m) => m.from === 'customer')?.author ?? 'the customer';

export async function reply(conversationId, text, actor, { close = false, reason } = {}) {
  const { account: a, conversation: c } = getConversation(conversationId);
  need(text?.trim(), 400, 'Message is empty');
  if (close) need(reasonLabel(reason), 400, 'Pick a close reason');
  failIfRejected(await intercom.reply(c.id, text.trim()));
  c.messages.push({ from: 'agent', author: actor, text: text.trim(), at: now() });
  c.updatedAt = now();
  c.slaDueAt = null; // answered
  if (!c.assignee) await assign(c.id, actor, actor, { quiet: true }); // replying takes ownership
  if (close) {
    await closeWithReason(a, c, reason, actor);
    announce(`Reply sent to ${first(customerOf(c))}, and the conversation was closed as “${reasonLabel(reason)}”.`, { icon: 'i-mail', accountId: a.id });
  } else {
    await track('conversation.replied', a.id, actor, { conversationId: c.id });
    announce(`Reply sent to ${first(customerOf(c))} at ${a.name}.`, { icon: 'i-mail', accountId: a.id });
  }
  changed(a.id);
  return { conversation: c };
}

export async function close(conversationId, reason, actor) {
  const { account: a, conversation: c } = getConversation(conversationId);
  need(c.state !== 'closed', 409, 'Already closed');
  await closeWithReason(a, c, reason, actor);
  changed(a.id);
  return { conversation: c };
}

export async function assign(conversationId, assigneeName, actor, { quiet = false } = {}) {
  const { account: a, conversation: c } = getConversation(conversationId);
  const u = assigneeName ? USERS.find((x) => x.name === assigneeName && x.team === 'support') : null;
  need(!assigneeName || u, 400, 'Can only assign to a support agent');
  failIfRejected(await intercom.assign(c.id, u?.intercomAdminId ?? null, u?.name));
  c.assignee = u?.name ?? null;
  await track(u ? 'conversation.assigned' : 'conversation.unassigned', a.id, actor, { conversationId: c.id, assignee: c.assignee });
  if (!quiet) {
    announce(!u ? `${first(customerOf(c))}'s conversation is back in the unassigned queue.`
      : u.name === actor ? `${first(customerOf(c))} at ${a.name} is now yours.`
      : `${u.name} now owns ${first(customerOf(c))}'s conversation.`, { icon: 'i-user', accountId: a.id });
  }
  if (!quiet) changed(a.id);
  return { conversation: c };
}

export async function reclassify(conversationId, id, tool, actor) {
  const { account: a, conversation: c } = getConversation(conversationId);
  need(CLASSIFICATIONS.some((x) => x.id === id), 400, 'Unknown classification');
  c.classification = { id, tool: id === 'integration' ? (tool || a.platform?.erp || null) : null };
  c.classifiedBy = 'agent';
  await track('conversation.classified', a.id, actor, { conversationId: c.id, classification: c.classification });
  announce(`${first(customerOf(c))}'s conversation is now classified as ${classificationLabel(c.classification)}.`, { icon: 'i-tag', tone: 'info', accountId: a.id });
  changed(a.id);
  return { conversation: c };
}

export async function snooze(conversationId, until, actor) {
  const { account: a, conversation: c } = getConversation(conversationId);
  if (!until) {
    failIfRejected(await intercom.reopen(c.id));
    c.snoozedUntil = null;
    await track('conversation.unsnoozed', a.id, actor, { conversationId: c.id });
    announce(`${first(customerOf(c))}'s conversation is back in the queue.`, { icon: 'i-clock', accountId: a.id });
  } else {
    need(new Date(until) > new Date(), 400, 'Snooze time must be in the future');
    failIfRejected(await intercom.snooze(c.id, until));
    c.snoozedUntil = new Date(until).toISOString();
    await track('conversation.snoozed', a.id, actor, { conversationId: c.id, until: c.snoozedUntil });
    const hours = Math.round((new Date(until) - Date.now()) / 3600_000);
    announce(`Snoozed ${hours >= 12 ? 'until tomorrow' : `for ${hours} hour${hours === 1 ? '' : 's'}`}. It comes back sooner if ${first(customerOf(c))} replies.`, { icon: 'i-moon', tone: 'info', accountId: a.id });
  }
  changed(a.id);
  return { conversation: c };
}

// ---------------------------------------------------------------- AI assist

function accountContext(a, c) {
  const p = a.platform;
  const tickets = a.tickets.filter((t) => t.status !== 'Done');
  return [
    `${a.name}: ${a.segment}, ${a.properties} properties, ${a.status}, health ${a.health ?? 'n/a'}, ${money(a.deal.amount)} ARR. CSM ${a.csm}.`,
    p ? `Platform: ERP ${p.erp}, sync ${p.syncStatus} (${p.syncErrors24h} errors in 24h), app ${p.appVersion}.` : 'Platform: not live yet.',
    tickets.length ? `Open engineering tickets: ${tickets.map((t) => `${t.key} "${t.summary}" (${t.status})`).join('; ')}.` : 'No open engineering tickets.',
    c.escalatedTo ? `This conversation is escalated to ${c.escalatedTo}.` : '',
  ].filter(Boolean).join('\n');
}

// Mock-mode stand-in so the demo works without an API key. Deterministic keyword rules.
function heuristicAssist(a, c, agentName) {
  const last = c.messages.filter((m) => m.from === 'customer').at(-1);
  const all = c.messages.filter((m) => m.from === 'customer').map((m) => m.text).join(' ').toLowerCase();
  const first = last.author.split(' ')[0];
  const agent = agentName.split(' ')[0];
  const has = (re) => re.test(all);
  const sentiment = has(/unacceptable|third time|furious|cancel/) ? 'angry'
    : has(/still|again|broken|blocking|slow/) ? 'frustrated'
    : has(/how do|where do|how can|\?/) ? 'confused' : 'calm';
  const category = has(/netsuite|intacct|quickbooks|sync|gl code|erp/) ? 'integration'
    : has(/duplicate|error|502|broken|misread|wrong|failing/) ? 'bug_workaround'
    : has(/can frontline|feature|would be great|automatically/) ? 'feature_request'
    : has(/billing|pricing|seats?|contract/) ? 'account_billing' : 'how_to';
  const ticket = c.escalatedTo ?? a.tickets.find((t) => t.status !== 'Done' && !t.key.startsWith('ONB'))?.key;
  const sentence = last.text.split(/(?<=[.?!])\s/)[0];
  const erpNote = a.platform && a.platform.syncStatus !== 'ok' ? ` Their ${a.platform.erp} sync is ${a.platform.syncStatus} (${a.platform.syncErrors24h} errors in 24h).` : '';

  const steps = {
    integration: `Check the ${a.platform?.erp ?? 'ERP'} sync logs${ticket ? ` and link this to ${ticket}` : ', then escalate if it reproduces'}.`,
    bug_workaround: ticket ? `Reference ${ticket} and offer a workaround while engineering fixes it.` : 'Reproduce, then escalate to engineering with an example.',
    feature_request: 'Log it for product and set expectations. No timeline promises.',
    how_to: 'Send the relevant guide and offer a 10-minute walkthrough.',
    account_billing: `Loop in ${a.owner} for anything commercial.`,
  };
  const replies = {
    integration: `Hi ${first}, thanks for flagging this, and sorry for the hassle. I can see the ${a.platform?.erp ?? 'ERP'} sync issue on our side${ticket ? ` and it's already with engineering under ${ticket}` : ''}. I'm checking your sync logs now and will update you as soon as I know more. In the meantime, nothing is lost on the Frontline side.\n\n${agent}`,
    bug_workaround: `Hi ${first}, I'm sorry, that shouldn't happen, and I understand the manual work it's causing your team. ${ticket ? `Engineering is actively working on it (${ticket}). ` : ''}While they finish the fix, I'll clean up the affected records for you and keep you posted.\n\n${agent}`,
    feature_request: `Hi ${first}, great question. Frontline doesn't do that automatically yet. I've shared your use case with our product team, and I'll let you know if it makes the roadmap. Happy to show you the closest option we have today.\n\n${agent}`,
    how_to: `Hi ${first}, happy to help! You can set this up under Settings, and I'm sending a short guide with the steps. If it's easier, I can walk you through it on a 10-minute call.\n\n${agent}`,
    account_billing: `Hi ${first}, thanks for reaching out. I've looped in ${a.owner}, your account manager, who will follow up today.\n\n${agent}`,
  };
  const loopCsm = sentiment === 'angry' && a.segment === 'Enterprise' ? `Loop in ${a.csm} (CSM) first. ` : '';
  return {
    summary: `${last.author} (${a.name}): ${sentence}${erpNote}`,
    sentiment,
    category,
    next_step: loopCsm + steps[category],
    suggested_reply: replies[category],
  };
}

export async function aiAssist(conversationId, actor) {
  const { account: a, conversation: c } = getConversation(conversationId);
  need(c.messages.some((m) => m.from === 'customer'), 400, 'Nothing to summarize yet');
  const transcript = c.messages.map((m) => `${m.from === 'customer' ? 'Customer' : 'Agent'} (${m.author}): ${m.text}`).join('\n');
  const out = await claude.assist({
    context: accountContext(a, c),
    transcript,
    agentName: actor,
    categories: CLOSE_REASONS.map((r) => r.id),
    mock: () => heuristicAssist(a, c, actor),
  });
  c.ai = { ...out, forMessages: c.messages.length, at: now() };
  if (c.classifiedBy !== 'agent') c.classification = fromCloseReason(out.category, a) ?? c.classification;
  await track('ai.assist', a.id, actor, { conversationId: c.id, mode: out.mode });
  announce(`Summary and a draft reply are ready for ${first(customerOf(c))}'s conversation.`, { icon: 'i-sparkle', accountId: a.id });
  changed(a.id);
  return { ai: c.ai };
}

// One click: Jira bug for engineering + internal note in Intercom + alert in Slack.
export async function escalate(conversationId, actor) {
  const found = findConversation(conversationId);
  need(found, 404, 'Conversation not found');
  const { account: a, conversation: c } = found;
  need(!c.escalatedTo, 409, `Already escalated to ${c.escalatedTo}`);
  const last = c.messages.filter((m) => m.from === 'customer').at(-1);

  const issue = await jira.createIssue({
    type: 'Bug',
    priority: a.segment === 'Enterprise' ? 'Highest' : 'High',
    labels: ['escalation', a.segment.toLowerCase()],
    summary: `[${a.name}] ${c.subject}`,
    description: `Escalated by ${actor} from Intercom conversation ${c.id}.\nCustomer: ${last?.author} (${a.segment}, ${a.properties} properties, ${money(a.deal.amount)} ARR).\n\n"${last?.text}"`,
  });
  failIfRejected(issue);
  const key = issue.response.key;
  await intercom.note(c.id, `Escalated to engineering: ${key}`);
  await postEscalation(a, c, `:rotating_light: *Escalated by ${actor}* → Jira *${key}*`);

  c.escalatedTo = key;
  a.tickets.unshift({ key, summary: c.subject, status: 'To Do', priority: a.segment === 'Enterprise' ? 'Highest' : 'High', createdAt: now() });
  await track('conversation.escalated', a.id, actor, { conversationId: c.id, jira: key });
  const vp = PEOPLE.vpSupport;
  const csm = csmOf(a);
  if (csm) await slack.dm(csm.slackId, csm.name, `Heads-up: ${a.name} escalated to engineering (${key})`, [slack.section(`:rotating_light: *${a.name}*: “${c.subject}” was escalated to engineering as *${key}* by ${actor}.`)]);
  announce(`Ticket ${key} escalated to engineering. ${vp.name} (${vp.title})${csm ? ` and ${csm.name} (CSM)` : ''} were notified.`, { icon: 'i-alert', accountId: a.id });
  changed(a.id);
  return { conversation: c, key };
}

// Escalation alerts go to #support-escalations and tag the VP Support so nothing sits unseen.
function postEscalation(a, c, headline) {
  const last = c.messages.filter((m) => m.from === 'customer').at(-1);
  const vp = PEOPLE.vpSupport;
  return slack.postMessage(slack.channels().support, `${a.name}: ${c.subject}`, [
    slack.section(`${headline}\n*${a.name}* · ${a.segment} · ${money(a.deal.amount)} ARR · health ${a.health ?? 'n/a'}\ncc <@${vp.slackId}> (${vp.title})`),
    slack.section(`> ${last?.text ?? ''}`),
    slack.context(`<${hubUrl(`/inbox/${c.id}`)}|Open in Frontline Hub>`),
  ], 'Escalation');
}

// First sentence, cut at a word boundary
function subjectFrom(text) {
  const first = text.split(/(?<=[.?!])\s/)[0];
  return first.length <= 60 ? first : first.slice(0, 60).replace(/\s+\S*$/, '') + '…';
}

const isAngry = (text) => CONFIG.angryKeywords.some((k) => text.toLowerCase().includes(k));

// Inbound Intercom webhook (topic conversation.user.created / conversation.user.replied).
export async function ingestIntercom(payload) {
  const item = payload?.data?.item ?? {};
  const email = item.source?.author?.email ?? item.contacts?.contacts?.[0]?.email ?? payload.email;
  const text = String(item.source?.body ?? payload.text ?? 'Hi, can you help?').replace(/<[^>]+>/g, '');
  const a = (email && findAccountByEmail(email)) || db.accounts.find((x) => x.status !== 'Prospect');
  const id = String(item.id ?? Date.now());

  let c = a.conversations.find((x) => x.id === id);
  if (!c) {
    c = { id, subject: item.source?.subject || subjectFrom(text), state: 'open', messages: [] };
    a.conversations.unshift(c);
  }
  c.state = 'open';
  c.snoozedUntil = null; // a customer reply wakes a snoozed conversation
  c.messages.push({ from: 'customer', author: a.contact.name, text, at: now() });
  c.updatedAt = now();
  c.slaDueAt = new Date(Date.now() + (CONFIG.slaHours[a.segment] ?? 4) * 3600_000).toISOString();
  if (c.classifiedBy !== 'agent') c.classification = classify(`${c.subject}. ${c.messages.filter((m) => m.from === 'customer').map((m) => m.text).join(' ')}`, a);

  const reasons = [];
  if (a.segment === 'Enterprise') reasons.push('Enterprise account');
  if (isAngry(text)) reasons.push('Upset customer');
  if (reasons.length) {
    c.flagged = reasons;
    await postEscalation(a, c, `:warning: *Auto-flagged:* ${reasons.join(' + ')}`);
    const csm = csmOf(a);
    if (csm) await slack.dm(csm.slackId, csm.name, `New flagged support message from ${a.name}`, [slack.section(`:warning: *${a.name}* wrote in: “${text.slice(0, 140)}”`)]);
  }
  await track('conversation.inbound', a.id, 'intercom', { conversationId: c.id, flagged: reasons });
  const who = `${first(a.contact.name)} at ${a.name}`;
  announce(reasons.length
    ? `New message from ${who} (${classificationLabel(c.classification)}). Flagged for attention, and ${PEOPLE.vpSupport.name} (${PEOPLE.vpSupport.title}) was notified.`
    : `New message from ${who} (${classificationLabel(c.classification)}).`, { icon: reasons.length ? 'i-alert' : 'i-mail', tone: reasons.length ? 'warn' : 'info', accountId: a.id });
  bus.emit('inbound', { accountId: a.id, accountName: a.name, conversation: c, flagged: reasons });
  changed(a.id);
  return { ok: true, conversationId: c.id, flagged: reasons };
}

// Runs every 30s: any conversation past its SLA gets one alert in Slack.
export async function checkSla() {
  for (const a of db.accounts) {
    for (const c of a.conversations) {
      if (c.state !== 'open' || !c.slaDueAt || c.slaAlerted || new Date(c.slaDueAt) > new Date()) continue;
      c.slaAlerted = true;
      await withActivity('Frontline Hub', async () => {
        await postEscalation(a, c, `:alarm_clock: *SLA breached* (${CONFIG.slaHours[a.segment]}h target, ${a.segment})`);
        await track('sla.breached', a.id, 'system', { conversationId: c.id });
        announce(`${first(customerOf(c))} at ${a.name} has waited longer than the ${CONFIG.slaHours[a.segment]}h target. ${PEOPLE.vpSupport.name} (${PEOPLE.vpSupport.title}) was notified.`, { icon: 'i-clock', tone: 'bad', accountId: a.id });
      });
      changed(a.id);
    }
  }
}

// ---------------------------------------------------------------- onboarding / CS

// Mock: usage grows a little each sync so the demo shows steps ticking off.
function simulatedUsage(a) {
  const u = a.usage ?? {};
  const step = a.status === 'Onboarding' ? 1 : 0.02;
  const grow = (v, by) => Math.round((v ?? 0) + by * step);
  return {
    properties_live: Math.min(a.properties, (u.propertiesLive ?? 0) + (a.status === 'Onboarding' ? 1 : 0)),
    active_users: grow(u.activeUsers, 6),
    pos_30d: grow(u.pos30d, 14),
    invoices_ai_30d: grow(u.invoicesAi30d, 9),
    spend_30d: grow(u.spend30d, 42000),
    vendors_connected: grow(u.vendorsConnected, 3),
    last_active: now(),
  };
}

export async function syncUsage(accountId, actor) {
  const a = getAccount(accountId);
  need(a.status !== 'Prospect', 400, 'No product usage for prospects');
  const entry = await snowflake.queryUsage(a.hubspotCompanyId, () => simulatedUsage(a));
  failIfRejected(entry);
  const r = snowflake.rowsOf(entry)[0];
  need(r, 404, 'No usage rows in Snowflake for this account');
  a.usage = {
    propertiesLive: Number(r.properties_live), activeUsers: Number(r.active_users), pos30d: Number(r.pos_30d),
    invoicesAi30d: Number(r.invoices_ai_30d), spend30d: Number(r.spend_30d), vendorsConnected: Number(r.vendors_connected), lastActive: r.last_active,
  };

  const ticked = [];
  if (a.onboarding) {
    for (const s of ONBOARDING_STEPS) {
      if (s.auto && !a.onboarding.steps[s.id].done && s.auto(a.usage)) {
        a.onboarding.steps[s.id] = { done: true, at: now(), by: 'Snowflake' };
        ticked.push(s.label);
      }
    }
    if (ticked.length) {
      await slack.postMessage(a.onboarding.slackChannel, `${a.name}: ${ticked.join(', ')}`,
        [slack.section(`:white_check_mark: *Auto-completed from usage data:* ${ticked.join(', ')}`)], 'Onboarding progress');
    }
    announce(ticked.length
      ? `${a.name}: ${ticked.join(' and ')} completed automatically from usage data.`
      : `${a.name}'s usage is up to date. No new milestones yet.`, { icon: ticked.length ? 'i-done' : 'i-reset', tone: ticked.length ? 'good' : 'info', accountId: a.id });
    await maybeGoLive(a, actor);
  } else {
    announce(`${a.name}'s usage is up to date.`, { icon: 'i-reset', tone: 'info', accountId: a.id });
  }
  changed(a.id);
  return { account: a, ticked };
}

export async function toggleStep(accountId, stepId, actor) {
  const a = getAccount(accountId);
  need(a.onboarding, 400, 'Account is not onboarding');
  const def = ONBOARDING_STEPS.find((s) => s.id === stepId);
  need(def, 404, 'Unknown step');
  need(!def.auto, 400, 'This step is completed automatically from Snowflake usage');
  const cur = a.onboarding.steps[stepId];
  a.onboarding.steps[stepId] = cur.done ? { done: false } : { done: true, at: now(), by: actor };
  if (!cur.done) {
    await slack.postMessage(a.onboarding.slackChannel, `${a.name}: ${def.label} done`,
      [slack.section(`:white_check_mark: *${def.label}* marked done by ${actor}`)], 'Onboarding progress');
  }
  await track(cur.done ? 'onboarding.step_reopened' : 'onboarding.step_done', a.id, actor, { step: stepId });
  announce(cur.done ? `“${def.label}” reopened for ${a.name}.` : `“${def.label}” done for ${a.name}. The team was updated in ${a.onboarding.slackChannel}.`, { icon: cur.done ? 'i-reset' : 'i-done', accountId: a.id });
  await maybeGoLive(a, actor);
  changed(a.id);
  return { account: a };
}

async function maybeGoLive(a, actor) {
  if (a.status !== 'Onboarding' || !ONBOARDING_STEPS.every((s) => a.onboarding.steps[s.id].done)) return;
  a.status = 'Live';
  a.onboarding.completedAt = now();
  await slack.postMessage(slack.channels().deals, `${a.name} is live`, [
    slack.section(`:checkered_flag: *${a.name} completed onboarding* and is live on Frontline`),
    slack.context(`CSM: ${a.csm}`),
  ], 'Go-live');
  await track('onboarding.completed', a.id, actor, {});
  announce(`${a.name} finished onboarding and is live! The team was told in #deals.`, { icon: 'i-flag', accountId: a.id });
}

// ---------------------------------------------------------------- CS: usage anomalies (Snowflake)

const METRICS = [
  { id: 'pos', label: 'Purchase orders' },
  { id: 'invoicesAi', label: 'AI-processed invoices' },
  { id: 'activeUsers', label: 'Active users' },
  { id: 'syncErrors', label: 'ERP sync errors', spike: true },
];

// Latest week vs the average of the 4 weeks before: a drop of 30%+ or an error spike is an anomaly.
function findAnomalies(a, rows) {
  const found = [];
  for (const m of METRICS) {
    const vals = rows.map((r) => Number(r[m.id.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)]));
    if (vals.length < 5) continue;
    const latest = vals.at(-1);
    const base = vals.slice(-5, -1).reduce((x, y) => x + y, 0) / 4;
    if (m.spike) {
      if (latest >= 10 && latest >= base * 3) found.push({ metric: m.id, label: `${a.platform?.erp ?? 'ERP'} sync errors`, direction: 'up', change: latest / Math.max(1, base), current: latest, baseline: Math.round(base), severity: 'bad' });
    } else if (base >= 20 && latest <= base * 0.7) {
      const drop = 1 - latest / base;
      found.push({ metric: m.id, label: m.label, direction: 'down', change: drop, current: latest, baseline: Math.round(base), severity: drop >= 0.4 ? 'bad' : 'warn' });
    }
  }
  return found;
}

export async function detectAnomalies(actor) {
  const accounts = db.accounts.filter((a) => a.usageSeries && a.status !== 'Prospect');
  const entry = await snowflake.queryWeeklyUsage(accounts.map((a) => a.hubspotCompanyId), () =>
    accounts.flatMap((a) => a.usageSeries.pos.slice(-5).map((_, i) => {
      const k = a.usageSeries.pos.length - 5 + i;
      return { hubspot_company_id: a.hubspotCompanyId, week_start: new Date(Date.now() - (4 - i) * 7 * 86400000).toISOString().slice(0, 10), pos: a.usageSeries.pos[k], invoices_ai: a.usageSeries.invoicesAi[k], active_users: a.usageSeries.activeUsers[k], sync_errors: a.usageSeries.syncErrors[k] };
    })));
  failIfRejected(entry);
  const rows = snowflake.rowsOf(entry);
  const fresh = [];
  for (const a of accounts) {
    for (const x of findAnomalies(a, rows.filter((r) => r.hubspot_company_id === a.hubspotCompanyId))) {
      if (db.anomalies.some((o) => o.accountId === a.id && o.metric === x.metric && o.status !== 'resolved')) continue;
      const an = { id: `an_${Date.now()}_${x.metric}`, accountId: a.id, ...x, detectedAt: now(), status: 'new' };
      db.anomalies.unshift(an);
      fresh.push({ a, an });
    }
  }
  for (const { a, an } of fresh) {
    const csm = csmOf(a);
    if (csm) await slack.dm(csm.slackId, csm.name, `Usage anomaly at ${a.name}`, [slack.section(`:chart_with_downwards_trend: *${a.name}*: ${anomalyText(an)}`), slack.context(`<${hubUrl(`/accounts/${a.id}?tab=health`)}|Open in Frontline Hub>`)]);
    await track('usage.anomaly_detected', a.id, 'system', { metric: an.metric, change: an.change });
    changed(a.id);
  }
  if (!fresh.length && actor === 'Snowflake monitor') return { found: 0 }; // stay quiet on routine checks
  announce(fresh.length
    ? `${fresh.length === 1 ? 'Usage anomaly' : `${fresh.length} usage anomalies`} found: ${fresh.map(({ a, an }) => `${a.name}, ${anomalyText(an)}`).join('; ')}. The CSM was notified in Slack.`
    : 'Usage checked in Snowflake. No new anomalies.', { icon: fresh.length ? 'i-trend-down' : 'i-done', tone: fresh.length ? 'warn' : 'info' });
  return { found: fresh.length };
}

export async function acknowledgeAnomaly(id, actor, note = '') {
  const an = db.anomalies.find((x) => x.id === id);
  need(an, 404, 'Anomaly not found');
  need(an.status === 'new', 409, 'Already reviewed');
  const a = getAccount(an.accountId);
  failIfRejected(await hubspot.createNote(a.hubspotCompanyId, `Usage anomaly reviewed by ${actor}: ${anomalyText(an)}${note?.trim() ? `\nFindings: ${note.trim()}` : ''}`));
  Object.assign(an, { status: 'acknowledged', reviewedBy: actor, reviewedAt: now(), note: note?.trim() || null });
  await track('usage.anomaly_acknowledged', a.id, actor, { metric: an.metric });
  announce(`Anomaly at ${a.name} marked as reviewed. A note was saved in HubSpot.`, { icon: 'i-done', accountId: a.id });
  changed(a.id);
  return { anomaly: an };
}

// At-risk account: the CSM starts a save plan. Logged in HubSpot and shared with the AE in Slack.
export async function startSavePlan(accountId, text, actor) {
  const a = getAccount(accountId);
  need(text?.trim(), 400, 'Describe the plan in a sentence or two');
  need(!a.savePlan, 409, `A save plan is already running (started by ${a.savePlan?.by})`);
  failIfRejected(await hubspot.createNote(a.hubspotCompanyId, `Save plan started by ${actor}:\n${text.trim()}`));
  const ae = USERS.find((u) => u.name === a.owner);
  if (ae?.slackId) {
    await slack.dm(ae.slackId, ae.name, `${actor} started a save plan for ${a.name}`, [
      slack.section(`:shield: *Save plan: ${a.name}* (health ${a.health}, ${money(a.deal.amount)} ARR)\n${text.trim()}`),
      slack.context(`Started by ${actor} (CSM) · <${hubUrl(`/accounts/${a.id}?tab=health`)}|Open in Frontline Hub>`),
    ]);
  }
  a.savePlan = { at: now(), by: actor, text: text.trim() };
  await track('account.save_plan_started', a.id, actor, {});
  announce(`Save plan started for ${a.name}. It's in HubSpot${ae ? `, and ${ae.name} (AE) was told in Slack` : ''}.`, { icon: 'i-alert', tone: 'info', accountId: a.id });
  changed(a.id);
  return { account: a };
}

// ---------------------------------------------------------------- meetings (Google Calendar + Meet)

const userByName = (name) => USERS.find((u) => u.name === name) ?? PEOPLE.solutionsEngineers.find((p) => p.name === name);
// Times are shown in the booker's own time zone (the browser sends it); UTC if unknown.
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'UTC'; } };
const fmtWhen = (iso, tz = 'UTC') => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: validTz(tz) }) + (validTz(tz) === 'UTC' ? ' UTC' : '');

// Books a meeting on the organizer's calendar with a Meet link, emails the invite, and logs it in HubSpot.
// `team` are hub people by name; the account's contact is invited when `withContact` is set.
export async function scheduleMeeting(accountId, { title, start, minutes = 30, team = [], withContact = true, agenda = '', tz = 'UTC', confirmed = false }, actor) {
  const a = getAccount(accountId);
  need(title?.trim(), 400, 'Give the meeting a title');
  const startAt = start ? new Date(start) : new Date();
  need(!Number.isNaN(+startAt), 400, 'Pick a valid date and time');
  need(+startAt > Date.now() - 10 * 60_000, 400, "That time is in the past. Pick a new one, or choose 'Now'.");
  minutes = Math.min(240, Math.max(10, Number(minutes) || 30));
  const endAt = new Date(+startAt + minutes * 60_000);
  need(title.trim().length <= 150, 400, 'Please keep the title under 150 characters.', { field: 'title' });
  const clash = a.meetings.find((m) => new Date(m.start) < endAt && new Date(m.end) > startAt);
  if (clash && !confirmed) {
    const message = `There's already “${clash.title}” with ${a.name} at ${fmtWhen(new Date(clash.start), tz)}. Book this one anyway?`;
    throw new HttpError(409, message, { code: 'confirm', warnings: [{ field: 'start', message }], field: 'start' });
  }
  const organizer = userByName(actor);
  const people = [...new Set([actor, ...team])].map(userByName).filter(Boolean);
  const attendees = [...(withContact ? [{ name: a.contact.name, email: a.contact.email }] : []), ...people.map((p) => ({ name: p.name, email: p.email }))];
  need(attendees.length > 1, 400, 'Invite at least one other person');

  const ev = await google.createEvent({
    organizer: organizer?.email ?? 'hub@frontline.com.invalid', summary: title.trim(),
    description: `${agenda.trim() ? `${agenda.trim()}\n\n` : ''}Booked from Frontline Hub · ${a.name}`,
    start: startAt.toISOString(), end: endAt.toISOString(), attendees,
  });
  failIfRejected(ev);
  const link = ev.response.hangoutLink;
  await hubspot.logMeeting(a.hubspotCompanyId, a.status === 'Prospect' || !['closedwon', 'closedlost'].includes(a.deal.stage) ? a.deal.id : null,
    { title: title.trim(), body: agenda.trim(), start: startAt.toISOString(), end: endAt.toISOString(), link });
  const meeting = { id: `mtg_${ev.response.id}`, title: title.trim(), start: startAt.toISOString(), end: endAt.toISOString(), link, organizer: actor, attendees: attendees.map((x) => x.name), createdAt: now() };
  a.meetings.push(meeting);
  a.meetings.sort((x, y) => x.start.localeCompare(y.start));
  if (withContact) a.deal.activities.unshift({ type: 'meeting', dir: 'out', at: now(), subject: title.trim() });
  await track('meeting.scheduled', a.id, actor, { minutes, attendees: attendees.length });
  const soon = +startAt - Date.now() < 5 * 60_000;
  announce(`${soon ? 'Call started' : `Meeting booked for ${fmtWhen(startAt, tz)}`}${withContact ? ` with ${a.contact.name}` : ''}. ${attendees.length - 1 === 1 ? 'The invite' : 'Invites'} went out by email with a Google Meet link, and it's logged in HubSpot.`, { icon: 'i-video', accountId: a.id });
  changed(a.id);
  return { meeting };
}

// Support: "let's jump on a quick call". A Meet room, and the link goes to the customer as a reply.
export async function quickCall(conversationId, text, actor) {
  const { account: a, conversation: c } = getConversation(conversationId);
  need(c.state === 'open', 400, 'This conversation is closed');
  const space = await google.createSpace(userByName(actor)?.email ?? 'hub@frontline.com.invalid');
  failIfRejected(space);
  const link = space.response.meetingUri;
  const body = `${(text?.trim() || "It might be quicker to talk this through. Can you join me on a short video call?")}\n\n${link}`;
  failIfRejected(await intercom.reply(c.id, body));
  c.messages.push({ from: 'agent', author: actor, text: body, at: now() });
  c.updatedAt = now();
  c.slaDueAt = null;
  if (!c.assignee) await assign(c.id, actor, actor, { quiet: true });
  a.meetings.push({ id: `mtg_${space.response.meetingCode}`, title: `Quick call: ${c.subject}`, start: now(), end: new Date(Date.now() + 30 * 60_000).toISOString(), link, organizer: actor, attendees: [customerOf(c), actor], createdAt: now(), instant: true });
  await track('conversation.video_call', a.id, actor, { conversationId: c.id });
  announce(`Video call link sent to ${first(customerOf(c))} in the conversation. Join when you're ready.`, { icon: 'i-video', accountId: a.id });
  changed(a.id);
  return { link };
}

// ---------------------------------------------------------------- CS: feature requests (Jira PROD)

const frLabel = (id) => FR_STATUSES.find((x) => x.id === id)?.label ?? id;

// Words that carry meaning, for matching a new request to one already in Jira.
const keywords = (t) => new Set(String(t).toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !['from', 'with', 'that', 'this', 'into', 'have', 'differ', 'differs'].includes(w)).map((w) => w.replace(/s$/, '')) ?? []);
function similar(x, y) {
  const A = keywords(x), B = keywords(y);
  const shared = [...A].filter((w) => B.has(w)).length;
  return shared / Math.max(1, Math.min(A.size, B.size));
}

async function logFeatureRequest(a, c, actor) {
  const title = c.subject.replace(/^request:\s*/i, '');
  // Already tracked? Add this account to the existing request instead of opening a duplicate.
  const existing = db.featureRequests.find((f) => f.accounts.some((r) => r.source === c.id))
    ?? db.featureRequests.find((f) => f.status !== 'declined' && similar(f.title, `${title} ${c.messages.map((m) => m.text).join(' ')}`) >= 0.5);
  if (existing) {
    if (!existing.accounts.some((r) => r.accountId === a.id)) existing.accounts.push({ accountId: a.id, requestedAt: now(), source: c.id, notified: false });
    await track('feature_request.linked', a.id, actor, { jira: existing.jiraKey });
    announce(`Conversation closed. ${a.name} is now counted on the existing request “${existing.title}” (${existing.jiraKey}, ${FR_STATUSES.find((x) => x.id === existing.status)?.label}).`, { icon: 'i-bulb', accountId: a.id });
    return;
  }
  const issue = await jira.createIssue({
    project: 'product', type: 'Story', priority: 'Medium', labels: ['feature-request', a.segment.toLowerCase()],
    summary: title,
    description: `Requested by ${customerOf(c)} at ${a.name} (${a.segment}, ${money(a.deal.amount)} ARR). Logged by ${actor} from Intercom conversation ${c.id}.\n\n"${c.messages.find((m) => m.from === 'customer')?.text ?? ''}"`,
  });
  failIfRejected(issue);
  const fr = { id: `fr_${issue.response.key.split('-')[1]}`, title, jiraKey: issue.response.key, status: 'submitted', updatedAt: now(), accounts: [{ accountId: a.id, requestedAt: now(), source: c.id, notified: false }] };
  db.featureRequests.unshift(fr);
  await track('feature_request.logged', a.id, actor, { jira: fr.jiraKey });
  announce(`Conversation closed and the feature request was logged in Jira as ${fr.jiraKey}. ${a.csm} (CSM) can follow it on the account page.`, { icon: 'i-bulb', accountId: a.id });
}

// Jira tells us a request moved (webhook). CSMs of every account that asked are told.
export async function setFeatureStatus(jiraKey, status, actor = 'Jira') {
  const fr = db.featureRequests.find((x) => x.jiraKey === jiraKey);
  need(fr, 404, 'Feature request not found');
  need(FR_STATUSES.some((x) => x.id === status), 400, 'Unknown status');
  if (fr.status === status) return { featureRequest: fr };
  fr.status = status;
  fr.updatedAt = now();
  const csms = [...new Set(fr.accounts.map((r) => findAccount(r.accountId)?.csm).filter(Boolean))];
  for (const name of csms) {
    const u = USERS.find((x) => x.name === name);
    const accts = fr.accounts.map((r) => findAccount(r.accountId)).filter((x) => x?.csm === name).map((x) => x.name);
    if (u) await slack.dm(u.slackId, u.name, `${fr.jiraKey} is now ${frLabel(status)}`, [slack.section(`:bulb: *${fr.title}* (${fr.jiraKey}) moved to *${frLabel(status)}*.\nAsked for by: ${accts.join(', ')}`)]);
  }
  for (const r of fr.accounts) { await track('feature_request.status', r.accountId, actor, { jira: fr.jiraKey, status }); changed(r.accountId); }
  const names = fr.accounts.map((r) => findAccount(r.accountId)?.name).filter(Boolean);
  announce(`“${fr.title}” (${fr.jiraKey}) is now ${frLabel(status)}.${status === 'shipped' ? ` Time to tell ${names.join(' and ')}.` : ''} ${csms.join(' and ')} ${csms.length > 1 ? 'were' : 'was'} notified.`,
    { icon: status === 'shipped' ? 'i-rocket' : 'i-bulb', tone: status === 'shipped' ? 'good' : 'info' });
  return { featureRequest: fr };
}

// Demo helper: the next status a Jira update would move a request to.
export function nextFeatureStatus(fr) {
  const flow = ['submitted', 'under_review', 'planned', 'in_progress', 'shipped'];
  const i = flow.indexOf(fr.status);
  return i >= 0 && i < flow.length - 1 ? flow[i + 1] : null;
}

export async function tellCustomer(frId, accountId, actor) {
  const fr = db.featureRequests.find((x) => x.id === frId);
  need(fr, 404, 'Feature request not found');
  need(fr.status === 'shipped', 400, 'Only shipped requests can be announced');
  const r = fr.accounts.find((x) => x.accountId === accountId);
  need(r, 404, 'This account did not ask for it');
  need(!r.notified, 409, 'Customer already told');
  const a = getAccount(accountId);
  failIfRejected(await intercom.message(a.contact.email, a.contact.name, `Hi ${first(a.contact.name)}, good news: “${fr.title}”, which you asked for, is now live in Frontline. Reply here if you'd like a quick walkthrough. ${actor}`));
  await hubspot.createNote(a.hubspotCompanyId, `Told ${a.contact.name} that “${fr.title}” (${fr.jiraKey}) shipped.`);
  Object.assign(r, { notified: true, notifiedAt: now(), notifiedBy: actor });
  await track('feature_request.customer_told', a.id, actor, { jira: fr.jiraKey });
  announce(`${first(a.contact.name)} at ${a.name} was told that “${fr.title}” is live. A note was saved in HubSpot.`, { icon: 'i-mail', accountId: a.id });
  changed(a.id);
  return { featureRequest: fr };
}
