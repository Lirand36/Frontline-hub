// Ops center: what needs fixing right now, across the systems and the revenue process.
// The activity log is history ("what happened"); these checks are state ("what's wrong now").
// Each check says what it looks at, who owns it, and lists the items behind it with a link.

import { getLog } from './connectors/http.js';
import { getActivities } from './activity.js';
import { DEAL_STAGES, STAGE_GATES, db } from './store.js';
import { dealSignals, gapsSoFar, isOpen } from './deals.js';
import { usageTrend } from './health.js';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const age = (iso) => Date.now() - new Date(iso);
const stageLabel = (id) => DEAL_STAGES.find((s) => s.id === id)?.label ?? id;
const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const ago = (iso) => { const m = Math.round(age(iso) / MIN); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const SYSTEM_NAMES = { hubspot: 'HubSpot', intercom: 'Intercom', jira: 'Jira', slack: 'Slack', snowflake: 'Snowflake', google: 'Google Calendar', claude: 'Claude' };

// Background jobs report in here, so a job that fails or stops running shows up as a failed check.
const bootedAt = Date.now();
export const jobs = {
  sla: { label: 'Reply-deadline check', every: 30_000, lastRun: null, lastError: null },
  anomalies: { label: 'Usage anomaly scan', every: 30 * MIN, lastRun: null, lastError: null },
};
export async function runJob(id, fn) {
  const j = jobs[id];
  try {
    await fn();
    j.lastRun = new Date().toISOString();
    j.lastError = null;
  } catch (err) {
    j.lastError = { message: err.message, at: new Date().toISOString() };
    throw err;
  }
}
const everyText = (ms) => (ms < HOUR ? (ms < MIN ? `${ms / 1000}s` : `${ms / MIN} min`) : `${ms / HOUR}h`);

// ---------------------------------------------------------------- the checks

const CHECKS = [
  // Systems
  {
    id: 'calls', group: 'Systems', owner: 'Admin', level: 'bad',
    title: 'Calls to outside systems that failed',
    about: 'Requests to HubSpot, Slack, Jira, Intercom, Snowflake, Google or Claude that got an error in the last 24 hours.',
    clear: 'Every call in the last 24 hours went through.',
    items() {
      const failed = getLog().filter((e) => !e.ok && age(e.ts ?? e.at ?? Date.now()) < DAY);
      const bySys = Object.groupBy ? Object.groupBy(failed, (e) => e.system) : failed.reduce((m, e) => ((m[e.system] ??= []).push(e), m), {});
      return Object.entries(bySys).map(([sys, list]) => ({
        text: `${SYSTEM_NAMES[sys] ?? sys}: ${list.length} failed ${list.length === 1 ? 'call' : 'calls'}`,
        sub: `Last: ${list[0].action} · ${String(list[0].response?.error ?? list[0].response?.message ?? `status ${list[0].status}`).slice(0, 120)}`,
        at: list.at(-1).ts ?? null, href: '#/log',
      }));
    },
  },
  {
    id: 'jobs', group: 'Systems', owner: 'Admin', level: 'bad',
    title: 'Background jobs that stopped',
    about: 'The jobs that run on their own: the reply-deadline check (every 30s) and the Snowflake usage scan (every 30 min).',
    clear: 'Both background jobs are running on schedule.',
    items() {
      return Object.values(jobs).flatMap((j) => {
        if (j.lastError) return [{ text: `${j.label} failed`, sub: `${j.lastError.message} · runs every ${everyText(j.every)}`, at: j.lastError.at }];
        const last = j.lastRun ? new Date(j.lastRun).getTime() : bootedAt;
        if (Date.now() - last > j.every * 3) return [{ text: `${j.label} hasn't run`, sub: `${j.lastRun ? `Last ran ${ago(j.lastRun)}` : 'No run since the hub started'} · should run every ${everyText(j.every)}`, at: new Date(last).toISOString() }];
        return [];
      });
    },
  },
  {
    id: 'actions', group: 'Systems', owner: 'Admin', level: 'bad',
    title: 'Actions that stopped partway',
    about: 'Something a person clicked (or an automation ran) where a system failed, so part of it may not have happened.',
    clear: 'Every action in the last 24 hours finished.',
    items() {
      return getActivities().filter((x) => x.failed && age(x.ts) < DAY).map((x) => ({
        text: x.outcome, sub: `${x.actor} · ${ago(x.ts)}`, at: x.ts, href: `#/log?open=${x.id}`,
      }));
    },
  },

  // Customer integrations
  {
    id: 'erp', group: 'Customer integrations', owner: 'Customer Success',
    title: 'Customers whose ERP sync is failing',
    about: "Live customers whose accounting system (NetSuite, Sage Intacct, QuickBooks…) isn't syncing cleanly. Invoices may be missing or duplicated on their side.",
    clear: 'Every customer ERP sync is healthy.',
    level: (items) => (items.some((i) => i.bad) ? 'bad' : 'warn'),
    items() {
      return db.accounts.filter((a) => a.platform && a.platform.syncStatus !== 'ok').map((a) => ({
        text: `${a.name}: ${a.platform.erp} sync ${a.platform.syncStatus}`,
        sub: `${a.platform.syncErrors24h} errors in 24h · last sync ${ago(a.platform.lastSyncAt)} · CSM ${a.csm}`,
        at: a.platform.lastSyncAt, href: `#/accounts/${a.id}?tab=health`, bad: a.platform.syncStatus === 'failing',
      }));
    },
  },

  // Revenue process
  {
    id: 'fields', group: 'Revenue process', owner: 'Sales', level: 'warn',
    title: 'Deals missing required details',
    about: "Open deals that passed a stage without the details that stage needs (e.g. a demo with no Solutions Engineer). Reports and handoffs rely on them.",
    clear: 'Every open deal has the details its stage needs.',
    items() {
      return db.accounts.filter(isOpen).flatMap((a) => {
        const gaps = gapsSoFar(a);
        if (!gaps.length) return [];
        const labels = gaps.flatMap((g) => STAGE_GATES[g].fields.filter((f) => !f.requiredIf && (a.deal.fields[f.id] == null || a.deal.fields[f.id] === '' || (Array.isArray(a.deal.fields[f.id]) && !a.deal.fields[f.id].length)) && f.id !== 'closeDate').map((f) => f.label.toLowerCase()));
        return [{ text: `${a.name}: missing ${labels.slice(0, 3).join(', ') || 'stage details'}`, sub: `${stageLabel(a.deal.stage)} · ${a.owner}`, at: a.deal.stageEnteredAt ?? null, href: `#/accounts/${a.id}` }];
      });
    },
  },
  {
    id: 'closedate', group: 'Revenue process', owner: 'Sales', level: 'warn',
    title: 'Close dates already passed',
    about: 'Open deals whose close date is in the past. The forecast counts them in the wrong month until someone picks a new date.',
    clear: 'Every open deal has a close date ahead.',
    items() {
      return db.accounts.filter((a) => isOpen(a) && a.deal.closeDate && new Date(a.deal.closeDate) < new Date()).map((a) => ({
        text: `${a.name}: close date ${fmtDay(a.deal.closeDate)} passed`, sub: `${stageLabel(a.deal.stage)} · ${a.owner}`, at: a.deal.closeDate, href: `#/pipeline?do=closedate&deal=${a.id}`,
      }));
    },
  },
  {
    id: 'quiet-deals', group: 'Revenue process', owner: 'Sales', level: 'warn',
    title: 'Prospects quiet for 7+ days, no follow-up',
    about: "Open deals where the prospect hasn't replied in 7 days or more and nobody followed up since.",
    clear: 'Every quiet prospect has been followed up.',
    items() {
      return db.accounts.filter(isOpen).flatMap((a) => {
        const s = dealSignals(a).find((x) => x.type === 'silent');
        return s ? [{ text: `${a.name}: no reply in ${s.days} days`, sub: `${a.contact.name} · ${a.owner}`, at: new Date(Date.now() - s.days * DAY).toISOString(), href: `#/pipeline?do=followup&deal=${a.id}` }] : [];
      });
    },
  },
  {
    id: 'waiting', group: 'Revenue process', owner: 'Sales Manager · Admin', level: 'warn',
    title: 'Decisions waiting too long',
    about: 'Discount approvals waiting over 24 hours, and requests to move a deal back waiting over 4 hours. The rep is blocked until someone decides.',
    clear: 'No decision has been waiting too long.',
    items() {
      const apr = db.approvals.filter((p) => p.status === 'pending' && age(p.requestedAt) > DAY).map((p) => {
        const a = db.accounts.find((x) => x.id === p.accountId);
        return { text: `${a?.name}: ${p.pct}% discount waiting for approval`, sub: `Asked by ${p.requestedBy} ${ago(p.requestedAt)}`, at: p.requestedAt, href: '#/approvals' };
      });
      const mv = db.moveRequests.filter((r) => r.status === 'pending' && age(r.at) > 4 * HOUR).map((r) => {
        const a = db.accounts.find((x) => x.id === r.accountId);
        return { text: `${a?.name}: move back to ${stageLabel(r.to)} waiting`, sub: `Asked by ${r.by} ${ago(r.at)}`, at: r.at, href: '#/home' };
      });
      return [...apr, ...mv];
    },
  },

  // Customers
  {
    id: 'overdue', group: 'Customers', owner: 'Support', level: 'bad',
    title: 'Customers past their reply deadline',
    about: 'Open conversations where the reply target (1h Enterprise, 4h others) has passed.',
    clear: 'Every customer got a reply in time.',
    items() {
      return convs().filter(({ c }) => c.slaDueAt && new Date(c.slaDueAt) < new Date()).map(({ a, c }) => ({
        text: `${a.name}: “${c.subject}”`, sub: `${c.assignee ?? 'Unassigned'} · due ${ago(c.slaDueAt)}`, at: c.slaDueAt, href: `#/inbox/${c.id}`,
      }));
    },
  },
  {
    id: 'unassigned', group: 'Customers', owner: 'Support', level: 'warn',
    title: 'Conversations nobody owns',
    about: 'Open conversations without an assigned agent.',
    clear: 'Every open conversation has an owner.',
    items() {
      return convs().filter(({ c }) => !c.assignee).map(({ a, c }) => ({
        text: `${a.name}: “${c.subject}”`, sub: `Waiting ${ago(c.messages?.at(-1)?.at ?? c.updatedAt).replace(' ago', '')}`, at: c.updatedAt, href: `#/inbox/${c.id}`,
      }));
    },
  },
  {
    id: 'quiet-customers', group: 'Customers', owner: 'Customer Success', level: 'warn',
    title: 'Customers going quiet',
    about: 'Live customers whose product usage dropped 20% or more over the last 4 weeks compared with the 4 before. Often the first sign of a churn risk.',
    clear: "No customer's usage is dropping.",
    items() {
      return db.accounts.filter((a) => a.status === 'Live').flatMap((a) => {
        const t = usageTrend(a);
        return t != null && t <= -0.2 ? [{ text: `${a.name}: usage down ${Math.round(-t * 100)}%`, sub: `Last 4 weeks vs the 4 before · CSM ${a.csm}`, at: null, href: `#/accounts/${a.id}?tab=health` }] : [];
      });
    },
  },
  {
    id: 'anomalies', group: 'Customers', owner: 'Customer Success', level: 'warn',
    title: 'Usage anomalies nobody reviewed',
    about: 'Sudden spikes or drops the Snowflake scan found that a CSM has not looked at yet.',
    clear: 'Every usage anomaly has been reviewed.',
    items() {
      return db.anomalies.filter((x) => x.status === 'new').map((x) => {
        const a = db.accounts.find((y) => y.id === x.accountId);
        return { text: `${a?.name}: ${x.label} ${x.direction === 'up' ? 'up' : 'down'}`, sub: `Found ${ago(x.detectedAt)} · CSM ${a?.csm}`, at: x.detectedAt, href: `#/accounts/${x.accountId}?tab=health` };
      });
    },
  },
  {
    id: 'onboarding', group: 'Customers', owner: 'Customer Success', level: 'warn',
    title: 'Onboarding running past 10 days',
    about: 'New customers still onboarding after 10 days. Most go live within two weeks.',
    clear: 'Every onboarding is on track.',
    items() {
      return db.accounts.filter((a) => a.status === 'Onboarding' && a.onboarding && age(a.onboarding.startedAt) > 10 * DAY).map((a) => ({
        text: `${a.name}: day ${Math.floor(age(a.onboarding.startedAt) / DAY)} of onboarding`, sub: `CSM ${a.csm}`, at: a.onboarding.startedAt, href: `#/accounts/${a.id}?tab=overview`,
      }));
    },
  },
  {
    id: 'not-told', group: 'Customers', owner: 'Customer Success', level: 'warn',
    title: "Shipped requests customers weren't told about",
    about: 'A feature a customer asked for is live, but nobody told them yet.',
    clear: 'Every customer knows their request shipped.',
    items() {
      return db.featureRequests.filter((f) => f.status === 'shipped').flatMap((f) => f.accounts.filter((r) => !r.notified).map((r) => {
        const a = db.accounts.find((x) => x.id === r.accountId);
        return { text: `${a?.name}: “${f.title}”`, sub: `${f.jiraKey} · CSM ${a?.csm}`, at: f.updatedAt ?? null, href: '#/requests' };
      }));
    },
  },
];

function convs() {
  const snoozed = (c) => c.snoozedUntil && new Date(c.snoozedUntil) > new Date();
  return db.accounts.flatMap((a) => a.conversations.filter((c) => c.state === 'open' && !snoozed(c)).map((c) => ({ a, c })));
}

// Everything the page needs: each check with its state, plus the connections at a glance.
export function opsView(integrations) {
  const log = getLog();
  const checks = CHECKS.map((c) => {
    const items = c.items();
    const oldest = items.map((i) => i.at).filter(Boolean).sort()[0] ?? null;
    const level = !items.length ? 'ok' : typeof c.level === 'function' ? c.level(items) : c.level;
    return { id: c.id, group: c.group, title: c.title, about: c.about, owner: c.owner, clear: c.clear, level, count: items.length, oldest, items: items.map(({ bad, ...i }) => i) };
  });
  const connections = integrations.map((x) => {
    const calls = log.filter((e) => e.system === x.id);
    const failed = calls.filter((e) => !e.ok && age(e.ts ?? Date.now()) < DAY).length;
    return { id: x.id, name: x.name, live: x.live, lastCallAt: calls[0]?.ts ?? null, lastOk: calls[0]?.ok ?? null, failed24h: failed };
  });
  return { checks, connections, jobs: Object.values(jobs).map(({ label, every, lastRun, lastError }) => ({ label, every, lastRun, lastError })), at: new Date().toISOString() };
}
