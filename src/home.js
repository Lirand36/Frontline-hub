// "Good morning" dashboard: per-role KPIs plus a ranked list of next suggested actions.
// Each action carries a CTA the UI can render as a link or as a one-click API call.

import { CONFIG, DEAL_STAGES, ONBOARDING_STEPS, db } from './store.js';
import { dealSignals, isOpen } from './deals.js';
import { accountSuggestions } from './cs.js';
import { classificationLabel } from './classify.js';
import { anomalyText, computeHealth } from './health.js';

const RANK = { urgent: 0, high: 1, normal: 2, info: 3 };
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const moneyK = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1000)}K`);
const minsUntil = (iso) => Math.round((new Date(iso) - Date.now()) / 60000);
const daysSince = (iso) => Math.floor((Date.now() - new Date(iso)) / 86400000);
const fmtMins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
const plural = (n, word, many) => `${n} ${n === 1 ? word : many ?? `${word}s`}`;

const link = (label, href) => ({ label, kind: 'link', href });
const call = (label, endpoint, body, done) => ({ label, kind: 'action', endpoint, body, done });

function awaitingReply(c) {
  return c.state === 'open' && c.messages.at(-1)?.from === 'customer';
}

// ---------------------------------------------------------------- support

function support(user) {
  const convs = db.accounts.flatMap((a) => a.conversations.map((c) => ({ a, c })));
  const snoozed = ({ c }) => c.snoozedUntil && new Date(c.snoozedUntil) > new Date();
  const waitingAll = convs.filter((x) => awaitingReply(x.c) && !snoozed(x));
  const mine = waitingAll.filter(({ c }) => c.assignee === user.name);
  const unassigned = waitingAll.filter(({ c }) => !c.assignee);
  const breached = waitingAll.filter(({ c }) => c.slaDueAt && minsUntil(c.slaDueAt) < 0);
  const escalated = convs.filter(({ c }) => c.escalatedTo && c.state === 'open' && c.assignee === user.name);

  const actions = [...mine, ...unassigned].map(({ a, c }) => {
    const m = c.slaDueAt ? minsUntil(c.slaDueAt) : null;
    const last = c.messages.at(-1);
    const priority = m == null ? 'normal' : m < 0 ? 'urgent' : m <= 30 ? 'high' : 'normal';
    const flagged = c.flagged?.length && !c.escalatedTo;
    return {
      id: `reply-${c.id}`, priority, icon: c.assignee ? 'i-mail' : 'i-inbox', sort: m ?? 9999,
      title: c.assignee ? `Reply to ${last.author} at ${a.name}` : `Unassigned: ${last.author} at ${a.name}`,
      detail: c.ai && c.ai.forMessages === c.messages.length ? `AI summary: ${c.ai.summary}` : `“${last.text.length > 120 ? last.text.slice(0, 117) + '…' : last.text}”`,
      badge: a.segment === 'Enterprise' ? 'Enterprise' : null,
      tags: [
        m == null ? null : m < 0 ? { text: `Reply overdue ${fmtMins(-m)}`, tone: 'bad' } : { text: `Reply due in ${fmtMins(m)}`, tone: m <= 30 ? 'warn' : '' },
        { text: classificationLabel(c.classification), tone: 'info' },
        c.escalatedTo ? { text: c.escalatedTo, tone: 'info' } : null,
      ].filter(Boolean),
      cta: link('Reply now', `#/inbox/${c.id}`),
      secondary: !c.assignee
        ? call('Assign to me', `/api/conversations/${c.id}/assign`, { assignee: user.name }, 'Assigned to you in Intercom')
        : flagged ? { ...call('Escalate to engineering', `/api/conversations/${c.id}/escalate`, null, 'Escalated to Jira + Slack'), confirm: 'escalate' } : null,
    };
  });

  for (const { a, c } of escalated.filter(({ c }) => !awaitingReply(c))) {
    actions.push({
      id: `esc-${c.id}`, priority: 'info', icon: 'i-clock', sort: 0,
      title: `Waiting on engineering: ${c.escalatedTo}`,
      detail: `${a.name}: ${c.subject}. Give the customer an update when Jira moves.`,
      tags: [{ text: c.escalatedTo, tone: 'info' }],
      cta: link('Open conversation', `#/inbox/${c.id}`),
    });
  }

  const parts = [];
  if (mine.length) parts.push(`${plural(mine.length, 'customer')} waiting on you`);
  if (unassigned.length) parts.push(`${unassigned.length} unassigned in the queue`);
  const summary = parts.length
    ? `${parts.join(', ')}${breached.length ? `. ${breached.length} already overdue` : ''}.`
    : 'Inbox zero. Nobody is waiting on you.';

  return {
    summary,
    kpis: [
      { label: 'Waiting on you', value: mine.length },
      { label: 'Unassigned', value: unassigned.length, tone: unassigned.length ? 'warn' : '' },
      { label: 'Overdue replies (team)', value: breached.length, tone: breached.length ? 'bad' : '' },
      { label: 'Yours with engineering', value: escalated.length },
    ],
    actions,
    footer: link('Open inbox', '#/inbox'),
  };
}

// ---------------------------------------------------------------- sales (AE)

const stageName = (id) => DEAL_STAGES.find((x) => x.id === id)?.label ?? id;
// One pipeline signal as a Good morning action; CTAs open the same pop-ups as the Pipeline page.
function dealAction(a, x, { team = false } = {}) {
  const open = (kind, extra = '') => `#/pipeline?do=${kind}&deal=${a.id}${extra}`;
  const cta = {
    followup: () => link(x.cta.label, open('followup')),
    closedate: () => link(x.cta.label, open('closedate')),
    details: () => link(x.cta.label, open('details')),
    stage: () => link(x.cta.label, open('stage', `&to=${x.cta.to}`)),
    ask: () => call(x.cta.label, `/api/accounts/${a.id}/ask-colleague`, { wonId: x.cta.wonId }, 'Asked in Slack'),
  }[x.cta.kind]();
  return {
    id: `deal-${a.id}-${x.type}`, dealId: a.id, priority: x.priority, icon: x.icon, sort: -a.deal.amount / 1e6,
    title: `${a.name} · ${x.title}`, badge: a.segment === 'Enterprise' ? 'Enterprise' : null,
    detail: x.detail,
    tags: [{ text: stageName(a.deal.stage), tone: 'brand' }, { text: `${moneyK(a.deal.amount)} ARR`, tone: '' }, team ? { text: a.owner, tone: '' } : null].filter(Boolean),
    cta: team ? link('Open pipeline', '#/pipeline') : cta,
  };
}

function sales(user) {
  const mine = db.accounts.filter((a) => a.owner === user.name);
  const open = mine.filter((a) => !['closedwon', 'closedlost'].includes(a.deal.stage));
  const actions = [];

  for (const p of db.approvals.filter((p) => p.status === 'pending' && p.requestedBy === user.name)) {
    const a = db.accounts.find((x) => x.id === p.accountId);
    actions.push({
      id: `apr-${p.id}`, priority: 'info', icon: 'i-clock', sort: 0,
      title: `Waiting on approval: ${a.name}, ${p.pct}% off`,
      detail: `Sent to #deal-desk ${daysSince(p.requestedAt) ? `${daysSince(p.requestedAt)}d` : 'today'}. You can't close the deal until it's decided.`,
      tags: [{ text: 'Deal desk', tone: 'warn' }],
      cta: link('View request', '#/approvals'),
    });
  }

  // Next best actions from the pipeline engine (src/deals.js)
  for (const a of open) {
    // At most two per deal, so one messy deal doesn't bury the rest
    for (const x of dealSignals(a).filter((x) => x.cta && x.priority !== 'low').slice(0, 2)) {
      actions.push(dealAction(a, x));
    }
  }
  for (const a of open) {
    if (a.status === 'Live' && a.health != null && a.health < 50) {
      actions.push({
        id: `risk-${a.id}`, priority: 'high', icon: 'i-alert', sort: 1,
        title: `${a.name} renewal at risk`,
        detail: `Health ${a.health} with ${plural(a.tickets.filter((t) => t.status !== 'Done').length, 'open ticket')}. Sync with ${a.csm} before pushing the ${moneyK(a.deal.amount)} renewal.`,
        tags: [{ text: `Health ${a.health}`, tone: 'bad' }],
        cta: link('Open account', `#/accounts/${a.id}`),
      });
    }
  }

  const pipeline = open.reduce((s, a) => s + a.deal.amount * (1 - (a.deal.discountPct || 0) / 100), 0);
  const top = new Set(actions.filter((x) => x.priority !== 'info' && x.dealId).map((x) => x.dealId)).size;
  return {
    summary: `${moneyK(pipeline)} open across ${plural(open.length, 'deal')}. ${top ? `${plural(top, 'deal')} need${top === 1 ? 's' : ''} a push today.` : 'Nothing urgent.'}`,
    kpis: [
      { label: 'Open pipeline', value: moneyK(pipeline) },
      { label: 'Open deals', value: open.length },
      { label: 'Gone quiet', value: open.filter((a) => dealSignals(a).some((x) => x.type === 'silent')).length, tone: open.some((a) => dealSignals(a).some((x) => x.type === 'silent')) ? 'warn' : '' },
      { label: 'Awaiting approval', value: db.approvals.filter((p) => p.status === 'pending' && p.requestedBy === user.name).length },
    ],
    actions,
    footer: link('Open pipeline', '#/pipeline'),
  };
}

// ---------------------------------------------------------------- sales manager

function manager(user) {
  const pending = db.approvals.filter((p) => p.status === 'pending');
  const actions = pending.map((p) => {
    const a = db.accounts.find((x) => x.id === p.accountId);
    const hours = Math.floor((Date.now() - new Date(p.requestedAt)) / 3600000);
    return {
      id: `apr-${p.id}`, priority: hours >= 2 ? 'high' : 'normal', icon: 'i-check', sort: -hours,
      title: `Approve ${p.pct}% off for ${a.name}?`,
      detail: `${money(a.deal.amount)} → ${money(a.deal.amount * (1 - p.pct / 100))} ARR. ${p.requestedBy}: “${p.reason || 'no reason given'}”`,
      tags: [{ text: hours ? `Waiting ${hours}h` : 'Just in', tone: hours >= 2 ? 'warn' : '' }, { text: a.segment, tone: '' }],
      cta: call('Approve', `/api/approvals/${p.id}`, { decision: 'approved' }, `Approved. HubSpot and #deal-desk updated`),
      secondary: call('Reject', `/api/approvals/${p.id}`, { decision: 'rejected' }, 'Rejected. Rep notified in #deal-desk'),
    };
  });
  const open = db.accounts.filter(isOpen);
  // Deals across the team that need a push (high priority only, so it stays short)
  for (const a of open) {
    const x = dealSignals(a).find((y) => y.priority === 'high' && y.type !== 'sign');
    if (x) actions.push({ ...dealAction(a, x, { team: true }), priority: 'normal', sort: 3 });
  }
  const atRisk = db.accounts.filter((a) => a.status === 'Live' && a.health != null && a.health < 50);
  for (const a of atRisk) {
    actions.push({
      id: `risk-${a.id}`, priority: 'normal', icon: 'i-alert', sort: 5,
      title: `${a.name} renewal at risk (${moneyK(a.deal.amount)})`,
      detail: `Health ${a.health} · AE ${a.owner} · CSM ${a.csm}`,
      tags: [{ text: `Health ${a.health}`, tone: 'bad' }],
      cta: link('Open account', `#/accounts/${a.id}`),
    });
  }
  return {
    summary: pending.length ? `${plural(pending.length, 'discount')} waiting on your call.` : 'No approvals waiting. Team is unblocked.',
    kpis: [
      { label: 'Pending approvals', value: pending.length, tone: pending.length ? 'warn' : '' },
      { label: 'Team pipeline', value: moneyK(open.reduce((s, a) => s + a.deal.amount, 0)) },
      { label: 'Contracts out', value: open.filter((a) => a.deal.stage === 'contractsent').length },
      { label: 'Renewals at risk', value: atRisk.length, tone: atRisk.length ? 'bad' : '' },
    ],
    actions,
    footer: link('Open approvals', '#/approvals'),
  };
}

// ---------------------------------------------------------------- customer success

function cs(user) {
  const mine = db.accounts.filter((a) => a.csm === user.name && a.status !== 'Prospect');
  const live = mine.filter((a) => a.status === 'Live');
  const onboarding = mine.filter((a) => a.status === 'Onboarding');
  const healthOf = (a) => computeHealth(a, db.anomalies);
  const actions = [];

  // 1. Suggested actions per account (src/cs.js), the same cards as My portfolio and the Health tab.
  //    Each opens the same pop-up there, so there's one way to do each thing.
  for (const a of mine) {
    for (const x of accountSuggestions(a)) {
      actions.push({
        id: `cs-${a.id}-${x.key}`, priority: x.priority === 'high' ? 'urgent' : x.priority, icon: x.icon, sort: x.type === 'anomaly' ? 0 : 1,
        title: `${a.name} · ${x.action}`, badge: a.segment === 'Enterprise' ? 'Enterprise' : null,
        detail: x.detail,
        tags: [{ text: x.why, tone: x.priority === 'high' ? 'bad' : 'warn' }, { text: `${moneyK(a.deal.amount)} ARR`, tone: '' }],
        cta: link(x.cta.label, `#/portfolio?do=${x.key}&acct=${a.id}`),
      });
    }
  }

  // 3. Support on my accounts: escalations and anything overdue or technical
  for (const a of mine) {
    for (const c of a.conversations.filter((x) => x.state === 'open')) {
      const important = c.escalatedTo || (c.slaDueAt && minsUntil(c.slaDueAt) < 0) || ['bug', 'integration'].includes(c.classification?.id);
      if (!important) continue;
      actions.push({
        id: `sup-${c.id}`, priority: c.escalatedTo ? 'high' : 'normal', icon: 'i-inbox', sort: 2,
        title: `${a.name} · support: “${c.subject}”`, badge: a.segment === 'Enterprise' ? 'Enterprise' : null,
        detail: `${classificationLabel(c.classification)} · owner ${c.assignee ?? 'unassigned'}${c.escalatedTo ? ` · with engineering (${c.escalatedTo})` : ''}.`,
        tags: [{ text: classificationLabel(c.classification), tone: 'info' }],
        cta: link('View on the account', `#/accounts/${a.id}?tab=support`),
      });
    }
  }

  actions.push({
    id: 'scan', priority: 'info', icon: 'i-search', sort: 9,
    title: 'Check usage for unusual changes',
    detail: 'Compares last week with the 4 weeks before for POs, AI invoices, active users and ERP sync errors. Also runs by itself every 30 minutes.',
    tags: [],
    cta: call('Check usage now', '/api/anomalies/scan', null),
  });

  const scored = mine.map((a) => ({ a, h: healthOf(a) }));
  const high = scored.filter((x) => x.h.level === 'high');
  const arrAtRisk = scored.filter((x) => x.h.level !== 'low').reduce((s, x) => s + x.a.deal.amount, 0);
  const openAnoms = db.anomalies.filter((x) => x.status === 'new' && mine.some((a) => a.id === x.accountId)).length;
  const openSupport = mine.reduce((s, a) => s + a.conversations.filter((c) => c.state === 'open').length, 0);

  return {
    summary: `${plural(mine.length, 'account')} in your portfolio. ${high.length ? `${plural(high.length, 'account')} at high risk` : 'None at high risk'}${openAnoms ? `, ${plural(openAnoms, 'usage anomaly', 'usage anomalies')} to review` : ''}.`,
    kpis: [
      { label: 'ARR at risk', value: moneyK(arrAtRisk), tone: arrAtRisk ? 'warn' : '' },
      { label: 'High-risk accounts', value: high.length, tone: high.length ? 'bad' : '' },
      { label: 'Usage anomalies', value: openAnoms, tone: openAnoms ? 'warn' : '' },
      { label: 'Open support (your accounts)', value: openSupport },
    ],
    actions,
    footer: link('Open my portfolio', '#/portfolio'),
  };
}

// ---------------------------------------------------------------- admin

// The whole hub at a glance: what's blocked across Sales, Support and Customer Success.
function admin(user) {
  const m = manager(user);
  const actions = [...m.actions];
  // Deals only move forward; a rep's request to move one back waits here (and in the admin's Slack)
  for (const r of db.moveRequests.filter((x) => x.status === 'pending')) {
    const a = db.accounts.find((x) => x.id === r.accountId);
    const label = (id) => DEAL_STAGES.find((s) => s.id === id)?.label ?? id;
    const mins = Math.floor((Date.now() - new Date(r.at)) / 60000);
    actions.push({
      id: `mv-${r.id}`, priority: 'high', icon: 'i-arrow', sort: -1,
      title: `Move ${a.name} back to ${label(r.to)}?`,
      detail: `${r.by}: “${r.reason}${r.note ? `: ${r.note}` : ''}”. It's in ${label(r.from)} now.`,
      tags: [{ text: mins < 60 ? `Asked ${mins || 1}m ago` : `Asked ${Math.floor(mins / 60)}h ago`, tone: mins >= 120 ? 'warn' : '' }, { text: 'Sales', tone: 'info' }],
      cta: call('Move it back', `/api/move-requests/${r.id}`, { decision: 'approved' }, `Moved back. ${r.by} was told in Slack`),
      secondary: call('Decline', `/api/move-requests/${r.id}`, { decision: 'declined' }, `Declined. ${r.by} was told in Slack`),
    });
  }
  const convs = db.accounts.flatMap((a) => a.conversations.map((c) => ({ a, c })));
  const snoozed = ({ c }) => c.snoozedUntil && new Date(c.snoozedUntil) > new Date();
  const waiting = convs.filter((x) => awaitingReply(x.c) && !snoozed(x));
  const overdue = waiting.filter(({ c }) => c.slaDueAt && minsUntil(c.slaDueAt) < 0);
  for (const { a, c } of waiting.filter(({ c }) => !c.assignee || (c.slaDueAt && minsUntil(c.slaDueAt) < 0))) {
    const mins = c.slaDueAt ? minsUntil(c.slaDueAt) : null;
    actions.push({
      id: `conv-${c.id}`, priority: mins != null && mins < 0 ? 'high' : 'normal', icon: 'i-inbox', sort: 2,
      title: `${a.name} · ${c.assignee ? 'reply overdue' : 'nobody assigned'}`, badge: a.segment === 'Enterprise' ? 'Enterprise' : null,
      detail: `“${c.subject}”. ${c.assignee ? `${c.assignee} owns it; the reply is overdue.` : 'Waiting in the Support queue.'}`,
      tags: [{ text: 'Support', tone: 'info' }, mins != null ? { text: mins < 0 ? `Overdue ${fmtMins(-mins)}` : `Due in ${fmtMins(mins)}`, tone: mins < 0 ? 'bad' : '' } : null].filter(Boolean),
      cta: link('Open conversation', `#/inbox/${c.id}`),
    });
  }
  const fresh = db.anomalies.filter((x) => x.status === 'new');
  for (const an of fresh) {
    const a = db.accounts.find((x) => x.id === an.accountId);
    actions.push({
      id: `an-${an.id}`, priority: 'normal', icon: 'i-trend-down', sort: 4,
      title: `${a.name} · usage anomaly`, badge: a.segment === 'Enterprise' ? 'Enterprise' : null,
      detail: `${anomalyText(an)} · CSM ${a.csm}`,
      tags: [{ text: 'Customer Success', tone: 'info' }],
      cta: link('Open account', `#/accounts/${a.id}?tab=health`),
    });
  }
  const pending = db.approvals.filter((p) => p.status === 'pending').length;
  const parts = [pending && plural(pending, 'approval'), waiting.length && `${plural(waiting.length, 'customer')} waiting on Support`, fresh.length && plural(fresh.length, 'usage anomaly', 'usage anomalies')].filter(Boolean);
  return {
    summary: parts.length ? `Across the hub: ${parts.join(', ')}.` : 'Everything is moving. Nothing is blocked.',
    kpis: [
      { label: 'Team pipeline', value: m.kpis[1].value },
      { label: 'Pending approvals', value: pending, tone: pending ? 'warn' : '' },
      { label: 'Overdue replies', value: overdue.length, tone: overdue.length ? 'bad' : '' },
      { label: 'Usage anomalies', value: fresh.length, tone: fresh.length ? 'warn' : '' },
    ],
    actions,
    footer: link('Open activity log', '#/log'),
  };
}

export function goodMorning(user) {
  const build = user.access === 'admin' ? admin : user.approver ? manager : { sales, support, cs }[user.team] ?? sales;
  const data = build(user);
  data.actions.sort((x, y) => RANK[x.priority] - RANK[y.priority] || x.sort - y.sort);
  return { user, ...data, slaHours: CONFIG.slaHours };
}
