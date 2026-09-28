// Who can see and do what. One map, used by the server to enforce and by the UI to build itself.
// In production, roles come from SSO groups (Google / Okta); records are scoped by HubSpot owner.

export const ROLES = {
  ae: {
    label: 'Account Executive', home: '#/home', areas: ['sales'],
    caps: ['pipeline.view', 'deal.edit', 'approvals.view', 'accounts.view', 'accounts.note', 'meetings.create'],
    accountTabs: ['overview', 'health'],
  },
  manager: {
    label: 'Sales Manager', home: '#/home', areas: ['sales'],
    caps: ['pipeline.view', 'pipeline.team', 'deal.edit', 'approvals.view', 'approvals.team', 'approvals.decide', 'accounts.view', 'accounts.note', 'meetings.create'],
    accountTabs: ['overview', 'health'],
  },
  support: {
    label: 'Support', home: '#/home', areas: ['support'],
    caps: ['inbox.work', 'fr.view', 'accounts.view', 'accounts.note', 'tickets.create', 'meetings.create'],
    accountTabs: ['support', 'overview', 'requests'],
  },
  cs: {
    label: 'Customer Success', home: '#/home', areas: ['cs'],
    caps: ['portfolio.view', 'portfolio.edit', 'onboarding.edit', 'anomalies.edit', 'fr.view', 'fr.edit', 'accounts.view', 'accounts.note', 'tickets.create', 'meetings.create'],
    accountTabs: ['health', 'support', 'requests', 'overview'],
  },
  admin: {
    label: 'Admin', home: '#/home', areas: ['sales', 'support', 'cs', 'account', 'system'],
    caps: ['*'],
    accountTabs: ['overview', 'health', 'support', 'requests'],
  },
};

// Capability prefix → the area it belongs to (live notifications only reach people in that area)
// and the team it's for (friendly "this is for …" messages).
const AREAS = {
  pipeline: 'sales', deal: 'sales', approvals: 'sales',
  inbox: 'support',
  portfolio: 'cs', onboarding: 'cs', anomalies: 'cs', fr: 'cs',
  accounts: 'account', tickets: 'account', meetings: 'account',
  log: 'system', connections: 'system', system: 'system',
};
const OWNERS = {
  pipeline: 'Sales', deal: 'Sales', approvals: 'Sales', inbox: 'Support',
  portfolio: 'Customer Success', onboarding: 'Customer Success', anomalies: 'Customer Success',
  fr: 'Support and Customer Success', tickets: 'Support and Customer Success', log: 'Admin', connections: 'Admin', system: 'Admin',
};
export const areaOf = (cap) => AREAS[String(cap).split('.')[0]] ?? 'account';

export const roleOf = (user) => ROLES[user?.access] ?? ROLES.ae;
export const can = (user, cap) => { const caps = roleOf(user).caps; return caps.includes('*') || caps.includes(cap); };
// Some capabilities are narrower than their team, so they get their own wording.
const SPECIFIC = {
  'approvals.decide': 'Only the Sales Manager can approve or reject discounts.',
  'fr.edit': 'Customer Success tells customers and updates feature requests.',
  'pipeline.team': "Only the Sales Manager sees the whole team's pipeline.",
  'deal.moveback': 'Only an admin can move a deal back.',
};
export const deniedMessage = (cap) => SPECIFIC[cap] ?? `This is for ${OWNERS[String(cap).split('.')[0]] ?? 'another team'}. Ask an admin if you need access.`;
