// Frontline Hub: front end. Plain JS, no build step: hash routing + template strings.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');

const SYSTEMS = {
  hubspot: { name: 'HubSpot', color: 'var(--hubspot)', letter: 'H' },
  intercom: { name: 'Intercom', color: 'var(--intercom)', letter: 'I' },
  jira: { name: 'Jira', color: 'var(--jira)', letter: 'J' },
  slack: { name: 'Slack', color: 'var(--slack)', letter: 'S' },
  snowflake: { name: 'Snowflake', color: 'var(--snowflake)', letter: 'SF' },
  claude: { name: 'Claude', color: 'var(--claude)', letter: 'C' },
  google: { name: 'Google Calendar', color: 'var(--google)', letter: 'G' },
};

const state = { meta: null, log: [], logFilter: null, flashId: null };

// ---------- helpers ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
const compact = (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const moneyCompact = (n) => '$' + compact(n);
function relText(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const rel = (iso) => `<time datetime="${esc(iso)}" title="${esc(new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}">${relText(iso)}</time>`;
const days = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso)) / 86400000));
const stageLabel = (id) => state.meta.stages.find((s) => s.id === id)?.label ?? id;
const src = (sys, text) => `<span class="src ${sys}">${esc(text ?? SYSTEMS[sys].name)}</span>`;
const user = () => state.meta.users.find((u) => u.id === $('#user').value) ?? state.meta.users[0];
// Access (the server enforces the same rules; see src/access.js)
const role = () => state.meta.roles[user().access] ?? state.meta.roles.ae;
const can = (cap) => role().caps.includes('*') || role().caps.includes(cap);
const PAGE_CAP = { pipeline: 'pipeline.view', approvals: 'approvals.view', inbox: 'inbox.work', portfolio: 'portfolio.view', onboarding: 'onboarding.edit', requests: 'fr.view', accounts: 'accounts.view', log: 'log.view', ops: 'ops.view', connections: 'connections.view' };
const isAdmin = () => role().caps.includes('*');
const canSee = (section) => !PAGE_CAP[section] || can(PAGE_CAP[section]);
// Deals: AEs work their own, managers and admins the team's.
const canEditDeal = (a) => can('deal.edit') && (can('pipeline.team') || a.owner === user().name);

// The sidebar shows only what the signed-in role can use; empty groups disappear.
function applyNav() {
  $$('[data-nav]').forEach((a) => { a.hidden = !canSee(a.dataset.nav); });
  $$('.nav-label').forEach((label) => {
    let el = label.nextElementSibling, any = false;
    while (el && !el.classList.contains('nav-label')) { if (!el.hidden) any = true; el = el.nextElementSibling; }
    label.hidden = !any;
  });
}

const healthBar = (h) => h == null ? '<span class="muted small">n/a</span>' :
  `<div class="health"><div class="bar"><span style="width:${h}%;background:${h >= 75 ? 'var(--good)' : h >= 50 ? 'var(--warn)' : 'var(--bad)'}"></span></div><span class="small num">${h}</span></div>`;
const statusChip = (s) => `<span class="chip ${s === 'Live' ? 'good' : s === 'Onboarding' ? 'info' : ''}">${esc(s)}</span>`;
const priorityChip = (p) => `<span class="chip ${/High/.test(p) ? 'bad' : p === 'Medium' ? 'warn' : ''}">${esc(p)}</span>`;
const ticketStatus = (s) => `<span class="chip ${s === 'Done' ? 'good' : s === 'In Progress' ? 'info' : ''}">${esc(s)}</span>`;

function slaChip(c) {
  if (c.state !== 'open' || !c.slaDueAt) return '';
  const mins = Math.round((new Date(c.slaDueAt) - Date.now()) / 60000);
  if (mins < 0) return `<span class="chip bad" title="Past the response-time target">Reply overdue ${fmtMins(-mins)}</span>`;
  return `<span class="chip ${mins <= 30 ? 'warn' : ''}" title="Time left to reply within the target">Reply due in ${fmtMins(mins)}</span>`;
}
// How urgent a conversation is, in words: drives the colored status line and left edge.
function urgency(c) {
  if (c.state !== 'open' || !c.slaDueAt) return null;
  const mins = Math.round((new Date(c.slaDueAt) - Date.now()) / 60000);
  if (mins < 0) return { tone: 'bad', text: `Reply overdue ${fmtMins(-mins)}` };
  return { tone: mins <= 30 ? 'warn' : 'calm', text: `Reply due in ${fmtMins(mins)}` };
}
// A reply-due line that keeps itself current: tickDue() updates text and colour every 15s without a re-render.
function dueTag(c, cls = 'st', tag = 'span') {
  const u = urgency(c);
  if (!u) return '';
  const mins = Math.round((new Date(c.slaDueAt) - Date.now()) / 60000);
  return `<${tag} class="${cls} ${u.tone} ${mins >= 0 && mins <= 15 ? 'soon' : ''}" data-due="${esc(c.slaDueAt)}"><svg class="ico"><use href="#i-clock"/></svg><span class="due-text">${u.text}</span></${tag}>`;
}
function tickDue() {
  $$('[data-due]').forEach((el) => {
    const u = urgency({ state: 'open', slaDueAt: el.dataset.due });
    const mins = Math.round((new Date(el.dataset.due) - Date.now()) / 60000);
    ['bad', 'warn', 'calm'].forEach((t) => el.classList.toggle(t, t === u.tone));
    el.classList.toggle('soon', mins >= 0 && mins <= 15);
    const txt = $('.due-text', el);
    if (txt && txt.textContent !== u.text) txt.textContent = u.text;
    const tr = el.closest('tr');
    if (tr) { tr.classList.remove('u-bad', 'u-warn', 'u-calm', 'u-none'); tr.classList.add(`u-${u.tone}`); }
  });
}

// Line icon from the sprite in index.html (names start with i-); anything else is shown as text.
const icon = (name, cls = '') => (String(name ?? '').startsWith('i-') ? `<svg class="ico ${cls}" aria-hidden="true"><use href="#${esc(name)}"/></svg>` : esc(name ?? ''));
const segBadge = (seg) => (seg === 'Enterprise' ? '<span class="seg-badge" title="Enterprise customer">Enterprise</span>' : '');

function confirmEscalate() {
  const vp = state.meta.people.vpSupport;
  return confirmDialog({
    title: 'Escalate to engineering?',
    body: `<p class="muted mb-2">This will:</p><ul class="small plain-list">
      <li>Open a high-priority bug in Jira with this conversation attached</li>
      <li>Alert <b>#support-escalations</b> in Slack and notify <b>${esc(vp.name)} (${esc(vp.title)})</b></li>
      <li>Leave an internal note in Intercom so the team sees it</li></ul>`,
    confirmLabel: 'Escalate',
    danger: true,
  });
}

const fmtMins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User': user().id },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), data, { status: res.status });
  return data;
}

function toast(html, { system, error, tone, ms = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${system ?? ''} ${tone ? `t-${tone}` : ''} ${error ? 'error' : ''}`;
  el.setAttribute('role', error ? 'alert' : 'status');
  el.innerHTML = `${html}<button class="t-close" aria-label="Dismiss"><svg class="ico"><use href="#i-x"/></svg></button>`;
  const box = $('#toasts');
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  let timer;
  const arm = () => { timer = setTimeout(() => el.remove(), error ? ms * 2 : ms); };
  el.addEventListener('mouseenter', () => clearTimeout(timer)); // hovering keeps it open to read
  el.addEventListener('mouseleave', arm);
  $('.t-close', el).addEventListener('click', () => el.remove());
  arm();
}

// Runs an action with the button disabled; errors become a toast.
async function run(btn, fn) {
  if (btn) { btn.disabled = true; btn.classList.add('busy'); btn.setAttribute('aria-busy', 'true'); }
  try { return await fn(); }
  catch (err) { toast(`<strong>Couldn't complete:</strong> ${esc(err.message)}`, { error: true }); }
  finally { if (btn) { btn.disabled = false; btn.classList.remove('busy'); btn.removeAttribute('aria-busy'); } }
}

// ---------- live updates ----------
let renderTimer;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    // Don't wipe out something the user is typing
    const a = document.activeElement;
    if (a && view.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.value) return;
    if ($('#modal').open) return;
    if (motion.busy) { scheduleRender(); return; } // let a "done" animation finish first
    route({ keepScroll: true });
  }, 250);
}

function connectEvents() {
  const es = new EventSource('/api/events');
  // Raw system calls aren't shown to users; they only refresh the activity log if it's open.
  es.addEventListener('integration', () => { if (/^#\/(log|ops)/.test(location.hash)) scheduleRender(); });
  es.addEventListener('activity', (e) => {
    const x = JSON.parse(e.data);
    const byOther = x.actor && x.actor !== user().name;
    // You see what you did, plus what happens in your own area (Support doesn't get deal updates)
    if (byOther && !role().areas.includes(x.area)) return;
    toast(`<div class="t-body"><span class="t-ico" aria-hidden="true">${icon(x.icon)}</span>
      <div><div>${esc(x.text)}</div>${byOther ? `<div class="muted xs">by ${esc(x.actor)}</div>` : ''}</div></div>
      ${can('log.view') ? `<a class="link xs t-more" href="#/log?open=${esc(x.id)}">Details</a>` : ''}`, { tone: x.tone || 'good', ms: 6000 });
  });
  es.addEventListener('inbound', (e) => { state.flashId = JSON.parse(e.data).conversation.id; });
  es.addEventListener('changed', () => {
    refreshBadges();
    scheduleRender();
  });
}

async function refreshBadges() {
  const set = (id, n) => {
    const b = $(id);
    const up = n > Number(b.textContent || 0) && !b.hidden;
    b.hidden = !n; b.textContent = n;
    if (up) replay(b, 'bump');
  };
  const [inbox, approvals, accounts, ops] = await Promise.all([
    can('inbox.work') ? api('/api/inbox') : [], can('approvals.view') ? api('/api/approvals') : [], can('portfolio.view') ? api('/api/accounts') : [],
    can('ops.view') ? api('/api/ops') : null,
  ]);
  if (ops) set('#badge-ops', ops.checks.filter((c) => c.level === 'bad').length);
  set('#badge-inbox', inbox.filter((c) => c.state === 'open').length);
  set('#badge-approvals', approvals.filter((p) => p.status === 'pending').length);
  set('#badge-portfolio', accounts.filter((a) => a.csm === user().name || isAdmin()).reduce((n, a) => n + a.anomalies.length, 0));
}


// ---------- CS building blocks ----------
const RISK = { high: { label: 'High risk', tone: 'bad' }, medium: { label: 'Medium risk', tone: 'warn' }, low: { label: 'Healthy', tone: 'good' } };
const riskChip = (level, score) => (level ? `<span class="chip ${RISK[level].tone}"><span class="dot" aria-hidden="true"></span>${RISK[level].label}${score != null ? ` · ${score}` : ''}</span>` : '<span class="muted small">–</span>');
const trendText = (pct) => (pct == null ? '<span class="muted">too early</span>' : `<span class="${pct <= -10 ? 'tone-bad' : pct >= 5 ? 'tone-good' : ''}">${pct > 0 ? '↑' : pct < 0 ? '↓' : '→'} ${Math.abs(pct)}%</span>`);

// Single-series sparkline: 2px line, marker on the latest point, hover title per week.
function sparkline(values, { label = '', alert = false, w = 160, h = 40 } = {}) {
  if (!values?.length) return '';
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const x = (i) => 4 + (i * (w - 8)) / (values.length - 1);
  const y = (v) => h - 4 - ((v - min) / (max - min || 1)) * (h - 8);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values.length - 1;
  const weekOf = (i) => new Date(Date.now() - (last - i) * 7 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `<svg class="spark ${alert ? 'alert' : ''}" data-draw viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}: ${values.join(', ')} over the last ${values.length} weeks">
    <polyline points="${pts}" fill="none" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(last)}" cy="${y(values[last])}" r="4" class="last"/>
    ${values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="9" class="hit"><title>Week of ${weekOf(i)}: ${v.toLocaleString('en-US')}</title></circle>`).join('')}
  </svg>`;
}

const FR_FLOW = ['submitted', 'under_review', 'planned', 'in_progress', 'shipped'];
const frLabel = (id) => state.meta.frStatuses.find((x) => x.id === id)?.label ?? id;
function frStatus(status) {
  if (status === 'declined') return '<span class="chip">Declined</span>';
  const i = FR_FLOW.indexOf(status);
  return `<span class="fr-status" title="${esc(frLabel(status))}"><span class="fr-dots" aria-hidden="true">${FR_FLOW.map((_, k) => `<span class="${k <= i ? 'on' : ''} ${status === 'shipped' ? 'shipped' : ''}"></span>`).join('')}</span><span class="${status === 'shipped' ? 'tone-good' : ''}">${esc(frLabel(status))}</span></span>`;
}

// Shared by the Feature requests page and the account's Requests tab.
function frCustomerCell(f, r) {
  if (f.status === 'shipped' && !r.notified && !can('fr.edit')) return '<span class="muted small">Not told yet</span>';
  if (f.status === 'shipped') return r.notified ? '<span class="chip good">Told</span>' : `<button class="btn sm primary" data-tell="${esc(f.id)}" data-account="${esc(r.accountId)}">Tell the customer</button>`;
  if (f.status === 'declined') return '<span class="muted small">Not planned</span>';
  return '<span class="muted small">Waiting on product</span>';
}
const frSimBtn = (f) => (f.next && can('fr.edit') ? `<button class="fr-sim" data-advance="${esc(f.id)}" title="Demo: simulate a Jira update → ${esc(frLabel(f.next))}" aria-label="Simulate Jira update to ${esc(frLabel(f.next))}"><svg class="ico"><use href="#i-arrow"/></svg></button>` : '');

// ---------- good morning ----------
function ctaButton(c, primary) {
  if (!c) return '';
  const cls = `btn sm ${primary ? 'primary' : ''}`;
  if (c.kind === 'link') return `<a class="${cls}" href="${esc(c.href)}">${esc(c.label)}</a>`;
  return `<button class="${cls}" data-endpoint="${esc(c.endpoint)}" data-body="${esc(c.body ? JSON.stringify(c.body) : '')}" data-confirm="${esc(c.confirm ?? '')}">${esc(c.label)}</button>`;
}

async function renderHome() {
  const d = await api('/api/home');
  const first = d.user.name.split(' ')[0];
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  view.innerHTML = `
    <section class="gm-hero">
      <div class="grow">
        <div class="muted small">${today}</div>
        <h1>Good morning, ${esc(first)}</h1>
        <p class="gm-summary">${esc(d.summary)}</p>
      </div>
      <span class="chip gm-role">${esc(d.user.role)}</span>
    </section>

    <div class="kpis">
      ${d.kpis.map((k) => `<div class="card kpi"><div class="muted small">${esc(k.label)}</div><div class="v num ${k.tone ? `tone-${k.tone}` : ''}">${esc(k.value)}</div></div>`).join('')}
    </div>

    <div class="spread mb-3">
      <h2>Your next suggested actions <span class="muted fw-500">· ${d.actions.length}</span></h2>
      ${ctaButton(d.footer)}
    </div>
    <div class="card">
      ${d.actions.map((a) => `
        <div class="gm-action p-${a.priority}" data-key="${esc(a.title)}">
          <span class="gm-ico" aria-hidden="true">${icon(a.icon)}</span>
          <div class="grow">
            <div class="gm-title">${esc(a.title)} ${a.badge ? segBadge(a.badge) : ''}</div>
            <div class="muted small">${esc(a.detail)}</div>
            ${a.tags.length ? `<div class="row mt-2 gap-1">${a.tags.map((t) => `<span class="chip ${esc(t.tone)}">${esc(t.text)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="gm-ctas">${ctaButton(a.secondary)}${ctaButton(a.cta, true)}</div>
        </div>`).join('') || '<div class="empty">Nothing needs you right now.</div>'}
    </div>`;

  $$('[data-endpoint]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.confirm === 'escalate' && !(await confirmEscalate())) return;
    run(b, async () => {
      await api(b.dataset.endpoint, { method: 'POST', body: b.dataset.body ? JSON.parse(b.dataset.body) : undefined });
      route({ keepScroll: true });
    });
  }));
}

// ---------- pipeline ----------
// ---------- deal pop-ups (shared by the pipeline and the account page) ----------
const OPEN_STAGES = () => state.meta.stages.filter((s) => !['closedwon', 'closedlost'].includes(s.id));
const stageName = (id) => state.meta.stages.find((s) => s.id === id)?.label ?? id;
const stageIdx = (id) => state.meta.stages.findIndex((s) => s.id === id);

// Mirrors src/deals.js: forward moves collect every gate on the way; Closed lost only asks why.
function gatesBetween(from, to) {
  const G = state.meta.stageGates;
  if (to === 'closedlost') return ['closedlost'];
  const i = stageIdx(from), j = stageIdx(to);
  if (j <= i) return [];
  return state.meta.stages.slice(i + 1, j + 1).map((s) => s.id).filter((id) => G[id] && id !== 'closedlost');
}
function gateValue(a, id) {
  if (id === 'closeDate') return a.deal.closeDate ? a.deal.closeDate.slice(0, 10) : '';
  if (id === 'demoDate') return utcFieldToLocal(a.deal.fields?.demoDate);
  const v = a.deal.fields?.[id];
  if (v != null && v !== '') return v;
  if (id === 'properties') return a.properties;
  if (id === 'erp') return a.platform?.erp ?? a.platformErp ?? '';
  return '';
}

function gateFieldsHtml(a, gates) {
  const G = state.meta.stageGates;
  return gates.map((g) => `
    <fieldset class="gate">
      ${gates.length > 1 ? `<legend>${esc(G[g].title)}</legend>` : ''}
      ${G[g].fields.map((f) => {
        const v = gateValue(a, f.id);
        const id = `gf-${f.id}`;
        const req = f.requiredIf ? '' : 'required';
        // New dates can't be in the past; a date already on record (e.g. a demo that happened) can stay
        const today = new Date().toLocaleDateString('en-CA');
        const min = f.type === 'date' && (!v || v >= today) ? `min="${today}"` : f.type === 'datetime-local' && (!v || new Date(v) >= new Date()) ? `min="${toLocalInput(new Date())}"` : '';
        const cap = f.type === 'textarea' ? 'maxlength="2000"' : f.type === 'text' ? 'maxlength="200"' : f.type === 'number' ? 'min="1" step="1"' : '';
        const label = `<label for="${id}">${esc(f.label)}${f.requiredIf ? ` <span class="muted xs">(needed if “${esc(f.requiredIf[1])}”)</span>` : ''}</label>`;
        if (f.type === 'textarea') return `<div class="field">${label}<textarea class="input" id="${id}" name="${f.id}" rows="2" ${req} ${cap} placeholder="${esc(f.placeholder ?? '')}">${esc(v)}</textarea></div>`;
        if (f.type === 'select') return `<div class="field">${label}<select class="input" id="${id}" name="${f.id}" ${req}><option value="">Choose…</option>${f.options.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
        if (f.type === 'multi') return `<div class="field"><span class="flabel" ${req ? 'data-required' : ''}>${esc(f.label)}</span><div class="checks" data-multi="${f.id}">${f.options.map((o) => `<label class="check-pill"><input type="checkbox" name="${f.id}" value="${esc(o)}" ${(v || []).includes(o) ? 'checked' : ''} /> ${esc(o)}</label>`).join('')}</div></div>`;
        return `<div class="field">${label}<input class="input" id="${id}" name="${f.id}" type="${f.type}" value="${esc(v)}" ${req} ${min} ${cap} placeholder="${esc(f.placeholder ?? '')}" />${f.hint ? `<div class="muted xs">${esc(f.hint)}</div>` : ''}</div>`;
      }).join('')}
    </fieldset>`).join('');
}

// Validates the pieces the browser can't: at least one checkbox in a multi field, conditional fields.
function gateCheck(form, gates) {
  const G = state.meta.stageGates;
  for (const g of gates) for (const f of G[g].fields) {
    // Returned as an error that points at its field, so it shows under that field
    if (f.type === 'multi' && !$$(`input[name="${f.id}"]:checked`, form).length) return Object.assign(new Error(`Pick at least one: ${f.label.toLowerCase()}.`), { field: f.id });
    if (f.requiredIf && form[f.requiredIf[0]]?.value === f.requiredIf[1] && !form[f.id].value.trim()) return Object.assign(new Error(`Please add the ${f.label.toLowerCase()}.`), { field: f.id });
  }
  return null;
}
function collectGate(form, gates) {
  const G = state.meta.stageGates, out = {};
  for (const g of gates) for (const f of G[g].fields) out[f.id] = f.type === 'multi' ? $$(`input[name="${f.id}"]:checked`, form).map((x) => x.value) : form[f.id]?.value ?? '';
  if ('demoDate' in out) out.demoDate = localToUtcField(out.demoDate);
  if (form.sendInvite) out.sendInvite = form.sendInvite.checked;
  return out;
}

// ---------- forms: required marks, errors under the field, "are you sure?" and "someone else edited this" ----------
const agoWords = (iso) => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} minute${m === 1 ? '' : 's'} ago` : `${Math.round(m / 60)} hour${m < 90 ? '' : 's'} ago`; };

// Every required field gets a *, and the form says what * means.
function markRequired(form) {
  let any = false;
  $$('[required], .flabel[data-required]', form).forEach((el) => {
    const label = el.matches('.flabel') ? el : (el.id && $(`label[for="${el.id}"]`, form)) || el.closest('.field')?.querySelector('label, .flabel');
    if (!label) return;
    any = true;
    if (!$('.req', label)) label.insertAdjacentHTML('beforeend', '<span class="req" aria-hidden="true">*</span>');
  });
  if (any && !$('.req-note', form)) ($('h2', form) ?? form.firstElementChild)?.insertAdjacentHTML('afterend', '<p class="req-note"><span class="req" aria-hidden="true">*</span> Required</p>');
}
const labelOf = (el, form) => ((el.id && $(`label[for="${el.id}"]`, form)) || el.closest('.field')?.querySelector('label, .flabel'))?.firstChild?.textContent.trim() || 'this field';
function clearErrors(form) {
  $$('.field-error', form).forEach((x) => x.remove());
  $$('[aria-invalid]', form).forEach((x) => x.removeAttribute('aria-invalid'));
  $('.form-error', form).hidden = true;
}
// Puts a message under the field it's about and moves the cursor there.
function fieldError(form, name, msg, focus = true) {
  const el = form.elements[name] instanceof RadioNodeList ? form.elements[name][0] : form.elements[name];
  const target = el ?? $(`[data-multi="${name}"]`, form);
  if (!target) return false;
  (target.closest('.field') ?? target.parentElement).insertAdjacentHTML('beforeend', `<p class="field-error" role="alert">${esc(msg)}</p>`);
  target.setAttribute('aria-invalid', 'true');
  if (focus) (el ?? $('input', target))?.focus();
  return true;
}
// The browser's checks, in our words, shown inline for every field at once.
function clientCheck(form) {
  const bad = $$('input, select, textarea', form).filter((el) => !el.disabled && !el.closest('[hidden]') && !el.checkValidity());
  bad.forEach((el, i) => {
    const label = labelOf(el, form), v = el.validity;
    const msg = v.valueMissing ? el.dataset.missing ?? `Please fill in ${label.toLowerCase()}.`
      : v.rangeUnderflow && el.type === 'date' ? `${label} can't be in the past. Please pick today or a later date.`
      : v.rangeUnderflow && el.type === 'datetime-local' ? `${label} can't be in the past. Please pick an upcoming date and time.`
      : v.rangeUnderflow ? `${label} should be at least ${el.min}.`
      : v.rangeOverflow ? `${label} should be at most ${el.max}.`
      : v.stepMismatch ? `${label} should be a whole number.`
      : v.typeMismatch && el.type === 'email' ? 'Please enter a valid email address.'
      : el.validationMessage;
    fieldError(form, el.name, msg, i === 0);
  });
  return !bad.length;
}
// What the server said, shown where it helps: under the field, as an "are you sure?", or as "someone else edited this".
function showFormError(form, x, opts, go, label) {
  const box = $('.form-alert', form), err = $('.form-error', form);
  if (x.code === 'confirm') {
    box.className = 'form-alert warn';
    box.innerHTML = `${icon('i-alert')}<div>${(x.warnings ?? [{ message: x.message }]).map((w) => `<p>${esc(w.message)}</p>`).join('')}<p class="muted xs mt-1">Change it above, or continue if it's right.</p></div>`;
    box.hidden = false;
    opts.confirmed = true;
    go.textContent = label === 'Send invite' || label === 'Start the call' ? 'Book anyway' : 'Save anyway';
    return;
  }
  if (x.code === 'stale') {
    box.className = 'form-alert info';
    box.innerHTML = `${icon('i-clock')}<div><p><b>${esc(x.by)}</b> edited this deal ${agoWords(x.at)}${x.what ? ` (${esc(x.what)})` : ''}.</p>
      <p class="muted small">You opened this before their change. Check the latest version, or save yours over it.</p>
      <div class="row mt-2"><button type="button" class="btn sm" data-latest>Show the latest</button><button class="btn sm" value="force">Save mine anyway</button></div></div>`;
    box.hidden = false;
    $('[data-latest]', box).addEventListener('click', () => { form.closest('dialog').close(); route({ keepScroll: true }); });
    opts.force = true;
    return;
  }
  if (x.field && fieldError(form, x.field, x.message)) return;
  err.textContent = x.message; err.hidden = false;
}
// Shown when a deal pop-up opens and someone else changed the deal in the last half hour.
const editNote = (a) => {
  const d = a.deal;
  if (!d?.editedBy || d.editedBy === user().name || Date.now() - new Date(d.editedAt) > 30 * 60_000) return '';
  return `<div class="form-alert info">${icon('i-clock')}<div><p><b>${esc(d.editedBy)}</b> edited this deal ${agoWords(d.editedAt)}${d.lastChange ? ` (${esc(d.lastChange)})` : ''}.</p></div></div>`;
};
const dealBase = (a) => ({ baseVersion: a.deal.version, tz: browserTz() });

// A small form dialog: validates, calls onSubmit(form, opts), closes on success.
// opts.confirmed / opts.force are set when the user answers "are you sure?" or "someone else edited this".
function formDialog(html, submitLabel, onSubmit, { danger = false } = {}) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form method="dialog" class="wide-form" novalidate>${html}<div class="form-alert" role="status" hidden></div><p class="form-error" role="alert" hidden></p>
    <div class="dialog-actions"><button class="btn ${danger ? 'danger-fill' : 'primary'}" value="ok">${esc(submitLabel)}</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div></form>`;
  const form = $('form', dlg);
  const go = $('button[value="ok"]', form);
  const opts = { confirmed: false, force: false };
  markRequired(form);
  form.addEventListener('submit', (e) => {
    if (!['ok', 'force'].includes(e.submitter?.value)) return;
    e.preventDefault();
    clearErrors(form);
    if (!clientCheck(form)) return;
    run(e.submitter, async () => {
      try { await onSubmit(form, opts); dlg.close(); } catch (x) { showFormError(form, x, opts, go, go.textContent); }
    });
  });
  // Changing anything after a warning means it gets checked again
  form.addEventListener('input', () => {
    if (!opts.confirmed) return;
    opts.confirmed = false; go.textContent = submitLabel; $('.form-alert.warn', form)?.setAttribute('hidden', '');
  });
  dlg.showModal();
  $('input:not([type=checkbox]), textarea, select', form)?.focus();
  return form;
}

// Move a deal, asking for whatever the target stage requires first.
function moveDeal(a, to, after = afterAction) {
  if (to === a.deal.stage) return;
  if (isBackwardMove(a.deal.stage, to)) return moveBack(a, to, after);
  const gates = gatesBetween(a.deal.stage, to);
  const post = (fields, o = {}) => api(`/api/accounts/${a.id}/deal-stage`, { method: 'POST', body: { stage: to, fields, ...dealBase(a), ...o } }).then(after);
  const G = state.meta.stageGates;
  if (to === 'closedwon') {
    return formDialog(`<h2>Close ${esc(a.name)} as won?</h2>${editNote(a)}
      ${gates.length ? `<p class="muted small mb-2">A couple of details first. They're saved to HubSpot.</p>${gateFieldsHtml(a, gates)}` : ''}
      <p class="muted small mt-3 mb-2">Then the onboarding automation runs:</p>
      <ul class="small plain-list"><li>HubSpot deal → <b>Closed won</b></li><li>Slack: announce in <span class="mono">#deals</span>, create <span class="mono">#onb-${esc(a.id)}</span> with the checklist</li><li>Jira: onboarding epic in <span class="mono">ONB</span></li></ul>`,
      'Close won', (form, o) => { const m = gateCheck(form, gates); if (m) throw m; return post(collectGate(form, gates), o); });
  }
  if (!gates.length) return run(null, () => post({}));
  const last = G[gates.at(-1)];
  const form = formDialog(`<h2>${esc(to === 'closedlost' ? `${a.name} · ${last.title.toLowerCase()}` : `Move ${a.name} to ${stageName(to)}`)}</h2>
    ${editNote(a)}<p class="muted small mb-3">${esc(last.why)} Prefilled from HubSpot; your answers are saved back to the deal.</p>
    ${gateFieldsHtml(a, gates)}
    ${gates.includes('presentationscheduled') ? `<label class="check-pill invite-opt"><input type="checkbox" name="sendInvite" checked /> ${icon('i-video')}Send a calendar invite with a Google Meet link to ${esc(a.contact?.name ?? 'the prospect')} and the Solutions Engineer</label>` : ''}`,
    to === 'closedlost' ? 'Mark as lost' : `Move to ${stageName(to)}`,
    (f, o) => { const m = gateCheck(f, gates); if (m) throw m; return post(collectGate(f, gates), o); },
    { danger: to === 'closedlost' });
  return form;
}

// Deals only move forward. Back (or out of Closed won/lost) is for an admin: others send a request with the reason.
const CLOSED_STAGES = ['closedwon', 'closedlost'];
function isBackwardMove(from, to) {
  if (from === to) return false;
  if (CLOSED_STAGES.includes(from)) return true;
  const open = state.meta.stages.map((s) => s.id).filter((id) => !CLOSED_STAGES.includes(id));
  return !CLOSED_STAGES.includes(to) && open.indexOf(to) < open.indexOf(from);
}
function moveBack(a, to, after = afterAction) {
  const reasonFields = `<div class="field"><label for="mb-reason">Reason</label><select class="input" id="mb-reason" name="reason" required><option value="">Choose…</option>${state.meta.moveBackReasons.map((r) => `<option>${esc(r)}</option>`).join('')}</select></div>
    <div class="field"><label for="mb-note">Note <span class="muted xs">(needed if “Other”)</span></label><textarea class="input" id="mb-note" name="note" rows="2" maxlength="500" data-missing="For “Other”, tell the admin in a line what happened." placeholder="A line on what happened"></textarea></div>`;
  let form;
  if (isAdmin()) {
    form = formDialog(`<h2>Move ${esc(a.name)} back to ${esc(stageName(to))}?</h2>${editNote(a)}
      <p class="muted small mb-3">Deals normally only move forward. The reason is saved to HubSpot${a.deal.stage === 'closedwon' ? ', and onboarding stays as it is' : ''}.</p>${reasonFields}`,
      `Move back to ${stageName(to)}`, (f, o) => api(`/api/accounts/${a.id}/deal-stage`, { method: 'POST', body: { stage: to, fields: {}, reason: f.reason.value, note: f.note.value, ...dealBase(a), ...o } }).then(after));
  } else if (a.moveBackRequest) {
    return toast(`${esc(a.moveBackRequest.by)} already asked the admin to move ${esc(a.name)} back to ${esc(stageName(a.moveBackRequest.to))}. It stays in ${esc(stageName(a.deal.stage))} until they decide.`, { tone: 'info' });
  } else {
    form = formDialog(`<h2>Move ${esc(a.name)} back to ${esc(stageName(to))}?</h2>
      <p class="muted small mb-3">Deals only move forward, so moving one back goes through an admin. Tell them why: they get it in Slack and can move it with one click.</p>${reasonFields}`,
      'Send to the admin', (f) => api(`/api/accounts/${a.id}/move-back`, { method: 'POST', body: { to, reason: f.reason.value, note: f.note.value } }).then(after));
  }
  // "Other" needs a note
  form.reason.addEventListener('change', () => { form.note.required = form.reason.value === 'Other'; });
  return form;
}

function editDealDetails(a, gates, after = afterAction) {
  formDialog(`<h2>${esc(a.name)} · deal details</h2>${editNote(a)}
    <p class="muted small mb-3">Needed for the stage it's in. Saved to HubSpot${gates.includes('presentationscheduled') ? ', and the Solutions Engineer gets the demo details in Slack' : ''}.</p>
    ${gateFieldsHtml(a, gates)}`, 'Save details',
    (f, o) => { const m = gateCheck(f, gates); if (m) throw m; return api(`/api/accounts/${a.id}/deal-fields`, { method: 'POST', body: { fields: collectGate(f, gates), ...dealBase(a), ...o } }).then(after); });
}

function editCloseDate(a, after = afterAction) {
  const soon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  formDialog(`<h2>${esc(a.name)} · close date</h2>${editNote(a)}
    <p class="muted small mb-3">Currently ${a.deal.closeDate ? new Date(a.deal.closeDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'not set'}. Pick a date you believe in; the forecast uses it.</p>
    <div class="field"><label for="cd">New close date</label><input class="input" id="cd" name="closeDate" type="date" required min="${new Date().toLocaleDateString('en-CA')}" value="${soon}" /></div>`,
    'Save to HubSpot', (f, o) => api(`/api/accounts/${a.id}/deal-fields`, { method: 'POST', body: { fields: { closeDate: f.closeDate.value }, ...dealBase(a), ...o } }).then(after));
}

function writeFollowUp(a, draft, after = afterAction) {
  formDialog(`<h2>Follow up with ${esc(a.contact.name)}</h2>
    <div class="field"><label>To</label><div class="input ro">${esc(draft.to)}</div></div>
    <div class="field"><label for="fu-s">Subject</label><input class="input" id="fu-s" name="subject" required value="${esc(draft.subject)}" /></div>
    <div class="field"><label for="fu-b">Message</label><textarea class="input" id="fu-b" name="body" rows="9" required>${esc(draft.body)}</textarea></div>
    <p class="muted small">Sent from your mailbox and logged on the deal in HubSpot.</p>`,
    'Send follow-up', (f) => api(`/api/accounts/${a.id}/follow-up`, { method: 'POST', body: { subject: f.subject.value, body: f.body.value } }).then(after));
}

// One place that knows what each next-action button does.
function runDealCta(a, x, btn) {
  const c = x.cta;
  if (c.kind === 'followup') return writeFollowUp(a, a.draft);
  if (c.kind === 'closedate') return editCloseDate(a);
  if (c.kind === 'details') return editDealDetails(a, a.gaps);
  if (c.kind === 'stage') return moveDeal(a, c.to);
  if (c.kind === 'ask') return run(btn, async () => { await api(`/api/accounts/${a.id}/ask-colleague`, { method: 'POST', body: { wonId: c.wonId } }); afterAction(); });
}

// ---------- pipeline ----------
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const prefKey = () => `frontline-hub-pipeline-view:${user().id}`;
function pipelineView() {
  try { return localStorage.getItem(prefKey()) || 'board'; } catch { return 'board'; }
}
function setPipelineView(v) {
  try { localStorage.setItem(prefKey(), v); } catch { /* per-viewer convenience only */ }
}
const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
function closeCell(a) {
  if (!a.deal.closeDate) return '<span class="muted">–</span>';
  const late = new Date(a.deal.closeDate) < new Date();
  return `<span class="${late ? 'tone-bad' : ''}" title="${late ? 'Close date has passed' : ''}">${fmtDay(a.deal.closeDate)}</span>`;
}
function replyCell(a) {
  if (!a.lastReplyAt) return '<span class="muted">No reply yet</span>';
  const d = Math.floor((Date.now() - new Date(a.lastReplyAt)) / 86400000);
  const tone = d >= state.meta.silentDays.high ? 'tone-bad' : d >= state.meta.silentDays.flag ? 'tone-warn' : '';
  return `<span class="${tone}">${d ? `${d}d ago` : 'today'}</span>`;
}
const signalTone = (x) => (x.priority === 'high' || x.priority === 'urgent' ? 'bad' : x.type === 'similar' || x.type === 'tell' ? 'idea' : x.priority === 'normal' ? 'warn' : 'calm');
// Suggested actions: every suggestion is the same card, "what to do" plus "why", and the whole card is the button.
// The column shows the top one; "+N more" opens the rest as identical cards underneath.
// The deal's own next step leads; a colleague's similar win is always an extra suggestion.
const suggestions = (a) => { const all = a.signals.filter((x) => x.cta); return a.next?.cta ? [a.next, ...all.filter((x) => x !== a.next && x.type !== a.next.type)] : all; };
const saCard = (a, x, attr = 'cta') => `<button class="sa t-${signalTone(x)}" data-${attr}="${esc(a.id)}" data-sig="${esc(x.key ?? x.type)}" title="${esc(x.detail)}">
    <svg class="ico sa-ico" aria-hidden="true"><use href="#${esc(x.icon)}"/></svg>
    <span class="sa-text"><span class="sa-do">${esc(x.action)}</span><span class="sa-why">${esc(x.why)}</span></span>
    <svg class="ico sa-go" aria-hidden="true"><use href="#i-arrow"/></svg>
  </button>`;
function saCell(a) {
  const list = suggestions(a);
  if (!list.length) {
    const w = a.signals.find((x) => x.type === 'waiting');
    return w ? `<div class="sa-wait"><svg class="ico" aria-hidden="true"><use href="#i-clock"/></svg>${esc(w.action)}</div>` : '<span class="muted small">Nothing to do right now</span>';
  }
  const open = state.plOpen?.has(a.id);
  return `${saCard(a, list[0])}${list.length > 1 ? `<button class="sa-more" data-expand="${esc(a.id)}" aria-expanded="${open}">${open ? 'Hide' : `+${list.length - 1} more`} ${list.length - 1 === 1 ? 'suggestion' : 'suggestions'}</button>` : ''}`;
}

const PL_COLS = [
  { id: 'deal', label: 'Deal', key: (a) => a.name.toLowerCase() },
  { id: 'stage', label: 'Stage', key: (a) => stageIdx(a.deal.stage) },
  { id: 'amount', label: 'ARR', key: (a) => a.deal.amount, num: true },
  { id: 'close', label: 'Close date', key: (a) => a.deal.closeDate ?? '9' },
  { id: 'owner', label: 'Owner', key: (a) => a.owner, team: true },
  { id: 'reply', label: 'Last reply', key: (a) => a.lastReplyAt ?? '' },
  { id: 'next', label: 'Next suggested action', key: (a) => PRIORITY_RANK[a.next?.priority ?? 'low'] * 1e9 - a.deal.amount },
];

async function renderPipeline(query = new URLSearchParams()) {
  const me = user();
  state.plOpen ??= new Set();
  if (!can('pipeline.team')) state.plScope = 'mine';
  state.plScope ??= 'team';
  state.plSort ??= { id: 'next', dir: 1 };
  const viewMode = pipelineView();
  const all = await api('/api/pipeline');
  const deals = all.filter((a) => state.plScope === 'team' || a.owner === me.name);
  const team = state.plScope === 'team';
  const total = deals.reduce((s, a) => s + a.deal.amount, 0);
  const soon = deals.filter((a) => a.deal.closeDate && new Date(a.deal.closeDate) >= new Date() && new Date(a.deal.closeDate) - Date.now() < 30 * 86400000);
  const quiet = deals.filter((a) => a.signals.some((x) => x.type === 'silent'));
  const cols = PL_COLS.filter((c) => !c.team || team);
  const col = PL_COLS.find((c) => c.id === state.plSort.id) ?? PL_COLS.at(-1);
  const sorted = [...deals].sort((x, y) => { const p = col.key(x), q = col.key(y); return (p < q ? -1 : p > q ? 1 : 0) * state.plSort.dir; });

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Pipeline</h1><p class="muted">${team ? 'Open deals across the team' : 'Your open deals'} and what each one needs next. Synced with HubSpot.</p></div>
      <div class="row">
        ${can('pipeline.team') ? `<div class="seg seg-inline" role="group" aria-label="Whose deals">
          <button class="${!team ? 'sel' : ''}" data-plscope="mine" aria-pressed="${!team}">Mine</button>
          <button class="${team ? 'sel' : ''}" data-plscope="team" aria-pressed="${team}">Team</button>
        </div>` : ''}
        <div class="seg seg-inline" role="group" aria-label="View">
          <button class="${viewMode === 'board' ? 'sel' : ''}" data-plview="board" aria-pressed="${viewMode === 'board'}"><svg class="ico"><use href="#i-board"/></svg>Board</button>
          <button class="${viewMode === 'table' ? 'sel' : ''}" data-plview="table" aria-pressed="${viewMode === 'table'}"><svg class="ico"><use href="#i-list"/></svg>Table</button>
        </div>
      </div>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="muted small">Open pipeline (ARR)</div><div class="v num">${moneyCompact(total)}</div><div class="muted xs">${deals.length} ${deals.length === 1 ? 'deal' : 'deals'}</div></div>
      <div class="card kpi"><div class="muted small">Closing in 30 days</div><div class="v num">${moneyCompact(soon.reduce((s, a) => s + a.deal.amount, 0))}</div><div class="muted xs">${soon.length} ${soon.length === 1 ? 'deal' : 'deals'}</div></div>
      <div class="card kpi"><div class="muted small">Gone quiet (${state.meta.silentDays.flag}+ days)</div><div class="v num ${quiet.length ? 'tone-warn' : ''}">${quiet.length}</div><div class="muted xs">${moneyCompact(quiet.reduce((s, a) => s + a.deal.amount, 0))} at stake</div></div>
      <div class="card kpi"><div class="muted small">Close date passed</div><div class="v num ${deals.some((a) => a.signals.some((x) => x.type === 'overdue')) ? 'tone-bad' : ''}">${deals.filter((a) => a.signals.some((x) => x.type === 'overdue')).length}</div></div>
    </div>

    ${viewMode === 'board' ? `
    <div class="board board5" id="board">
      ${OPEN_STAGES().map((s) => {
        const items = deals.filter((a) => a.deal.stage === s.id).sort((x, y) => y.deal.amount - x.deal.amount);
        return `<div class="col" data-drop="${s.id}" aria-label="${esc(s.label)}">
          <div class="col-head"><span>${esc(s.label)}</span><span class="muted num">${items.length} · ${moneyCompact(items.reduce((x, a) => x + a.deal.amount, 0))}</span></div>
          ${items.map((a) => `
            <article class="deal" draggable="true" data-deal="${esc(a.id)}" tabindex="0" aria-label="${esc(a.name)}, ${esc(s.label)}">
              <div class="spread items-start"><a class="name" href="#/accounts/${esc(a.id)}">${esc(a.name)}</a>${a.pendingApproval ? '<span class="chip warn" title="Discount waiting for approval">Approval</span>' : ''}${a.moveBackRequest ? `<span class="chip info" title="${esc(a.moveBackRequest.by)} asked the admin to move it back to ${esc(stageName(a.moveBackRequest.to))}">Move back asked</span>` : ''}</div>
              <div class="muted xs">${moneyCompact(a.deal.amount)} ARR · ${a.properties} ${a.properties === 1 ? 'property' : 'properties'}${team ? ` · ${esc(a.owner)}` : ''}</div>
              <div class="xs deal-meta"><span>${a.deal.closeDate ? `Closes ${closeCell(a)}` : ''}</span><span>Reply ${replyCell(a)}</span></div>
              <div class="deal-sa">${saCell(a)}${state.plOpen?.has(a.id) ? `<div class="sa-list">${suggestions(a).slice(1).map((x) => saCard(a, x)).join('')}</div>` : ''}</div>
            </article>`).join('') || '<div class="muted xs col-empty">No deals</div>'}
        </div>`;
      }).join('')}
    </div>
    <div class="drop-closed" id="drop-closed" hidden>
      <div class="dz won" data-drop="closedwon">Drop to close won</div>
      <div class="dz lost" data-drop="closedlost">Drop to mark lost</div>
    </div>
    <p class="muted xs mt-2">Drag a deal to move it. If the next stage needs details (like the demo date and Solutions Engineer), you'll be asked for them first.</p>` : `
    <div class="card table-wrap">
      <table class="table pl-table">
        <thead><tr>${cols.map((c) => {
          const on = c.id === col.id;
          return `<th class="${c.num ? 'num-col' : ''}" aria-sort="${on ? (state.plSort.dir === 1 ? 'ascending' : 'descending') : 'none'}"><button class="th-sort" data-plsort="${c.id}">${esc(c.label)}<span class="sort-ind" aria-hidden="true">${on ? (state.plSort.dir === 1 ? '▲' : '▼') : ''}</span></button></th>`;
        }).join('')}</tr></thead>
        <tbody>${sorted.map((a) => `
          <tr data-href="#/accounts/${esc(a.id)}">
            <td data-label="Deal"><a class="row-link" href="#/accounts/${esc(a.id)}">${esc(a.name)}</a> ${segBadge(a.segment)}<div class="muted xs">${esc(((x) => x[0].toUpperCase() + x.slice(1))(a.deal.name.split(': ')[1] ?? a.deal.name))}</div></td>
            <td data-label="Stage"><select class="input sm" data-move="${esc(a.id)}" aria-label="Stage for ${esc(a.name)}">${state.meta.stages.map((s) => `<option value="${s.id}" ${s.id === a.deal.stage ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>${a.daysInStage != null ? `<div class="muted xs">${a.daysInStage}d in stage</div>` : ''}</td>
            <td data-label="ARR" class="num num-col">${money(a.deal.amount)}</td>
            <td data-label="Close date" class="small">${closeCell(a)}</td>
            ${team ? `<td data-label="Owner" class="small">${esc(a.owner)}</td>` : ''}
            <td data-label="Last reply" class="small">${replyCell(a)}</td>
            <td data-label="Next suggested action" class="pl-next">${saCell(a)}</td>
          </tr>${state.plOpen?.has(a.id) && suggestions(a).length > 1 ? `
          <tr class="sa-row"><td colspan="${cols.length}">
            <div class="sa-row-head">More suggestions for ${esc(a.name)}</div>
            <div class="sa-grid">${suggestions(a).slice(1).map((x) => saCard(a, x)).join('')}</div>
          </td></tr>` : ''}`).join('') || `<tr><td colspan="${cols.length}" class="empty">No open deals.</td></tr>`}</tbody>
      </table>
    </div>`}`;

  const byId = Object.fromEntries(all.map((a) => [a.id, a]));
  // Every table row opens its account (except clicks on the row's own controls)
  $$('.pl-table tbody tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a, button, select')) location.hash = tr.dataset.href; }));
  $$('[data-plscope]').forEach((b) => b.addEventListener('click', () => { state.plScope = b.dataset.plscope; renderPipeline(); }));
  $$('[data-plview]').forEach((b) => b.addEventListener('click', () => { setPipelineView(b.dataset.plview); renderPipeline(); }));
  $$('[data-plsort]').forEach((b) => b.addEventListener('click', () => {
    const same = state.plSort.id === b.dataset.plsort;
    state.plSort = { id: b.dataset.plsort, dir: same ? -state.plSort.dir : 1 };
    renderPipeline();
  }));
  $$('[data-cta]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const a = byId[b.dataset.cta];
    runDealCta(a, a.signals.find((x) => x.type === b.dataset.sig), b);
  }));
  $$('[data-expand]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const id = b.dataset.expand;
    if (state.plOpen.has(id)) state.plOpen.delete(id); else state.plOpen.add(id);
    renderPipeline();
  }));


  $$('[data-move]').forEach((sel) => sel.addEventListener('change', () => {
    const a = byId[sel.dataset.move];
    const to = sel.value;
    sel.value = a.deal.stage; // stays put until the move succeeds
    moveDeal(a, to);
  }));
  bindBoardDrag(byId);

  // Deep links from Good morning: #/pipeline?do=followup&deal=lakeview
  const target = byId[query.get('deal')];
  const act = query.get('do');
  if (target && act) {
    history.replaceState(null, '', '#/pipeline');
    const sig = { followup: 'silent', closedate: 'overdue', details: 'details' }[act];
    if (act === 'stage') moveDeal(target, query.get('to'));
    else if (sig && target.signals.some((x) => x.type === sig)) runDealCta(target, target.signals.find((x) => x.type === sig));
  }
}

function bindBoardDrag(byId) {
  const board = $('#board');
  if (!board) return;
  const closed = $('#drop-closed');
  let dragging = null;
  $$('.deal[draggable]', board).forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      dragging = card.dataset.deal;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragging);
      liftGhost(card, e);
      card.classList.add('dragging');
      board.classList.add('is-dragging');
      closed.hidden = false;
    });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); board.classList.remove('is-dragging'); closed.hidden = true; $$('.drop-on').forEach((x) => x.classList.remove('drop-on')); dragging = null; });
    card.addEventListener('click', (e) => { if (!e.target.closest('a, button')) location.hash = `#/accounts/${card.dataset.deal}`; });
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) location.hash = `#/accounts/${card.dataset.deal}`; });
  });
  $$('[data-drop]').forEach((zone) => {
    zone.addEventListener('dragover', (e) => { if (!dragging) return; e.preventDefault(); zone.classList.add('drop-on'); });
    zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drop-on'); });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drop-on');
      const a = byId[e.dataTransfer.getData('text/plain') || dragging];
      // Open the pop-up after the drag has fully ended
      if (a && zone.dataset.drop !== a.deal.stage) setTimeout(() => moveDeal(a, zone.dataset.drop), 0);
    });
  });
}

// One filter control everywhere: a joined segmented group; counts sit in a small pill like the tabs.
const segButtons = (attr, items, selected) => items.map(([id, label, count]) =>
  `<button class="${selected === id ? 'sel' : ''}" data-${attr}="${id}" aria-pressed="${selected === id}">${label}${count != null ? ` <span class="num">${count}</span>` : ''}</button>`).join('');

// ---------- accounts ----------
const ACCOUNT_COLS = [
  { id: 'name', label: 'Account', val: (a) => a.name.toLowerCase() },
  { id: 'status', label: 'Status', val: (a) => ['Live', 'Onboarding', 'Prospect'].indexOf(a.status) },
  { id: 'segment', label: 'Segment', val: (a) => a.segment, sm: true, opt: 'opt-a' },
  { id: 'properties', label: 'Properties', val: (a) => a.properties, sm: true, center: true },
  { id: 'arr', label: 'ARR', val: (a) => a.deal.amount, sm: true, num: true },
  { id: 'spend', label: 'Spend (30d)', val: (a) => a.usage?.spend30d ?? -1, sm: true, num: true, opt: 'opt-b' },
  { id: 'health', label: 'Health', val: (a) => a.health ?? -1 },
  { id: 'open', label: 'Open', val: (a) => a.openConversations + a.openTickets, sm: true, opt: 'opt-a' },
];

async function renderAccounts() {
  const list = await api('/api/accounts');
  state.acctSort ??= { id: 'health', dir: 1 };
  const col = ACCOUNT_COLS.find((c) => c.id === state.acctSort.id);
  list.sort((x, y) => (col.val(x) > col.val(y) ? 1 : col.val(x) < col.val(y) ? -1 : 0) * state.acctSort.dir);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Accounts</h1><p class="muted">Hotel groups: CRM, product usage from Snowflake, and open work, in one row.</p></div>
      <input class="input filter-input" id="q" type="search" placeholder="Filter accounts…" aria-label="Filter accounts" value="${esc(state.acctQ ?? '')}" />
    </div>
    <div class="card table-wrap">
      <table class="table">
        <thead><tr>${ACCOUNT_COLS.map((c) => {
          const on = c.id === state.acctSort.id;
          return `<th class="${c.sm ? 'hide-sm' : ''} ${c.opt ?? ''} ${c.center ? 'center-col' : c.num ? 'num-col' : ''}" aria-sort="${on ? (state.acctSort.dir === 1 ? 'ascending' : 'descending') : 'none'}"><button class="th-sort" data-sort="${c.id}">${esc(c.label)}<span class="sort-ind" aria-hidden="true">${on ? (state.acctSort.dir === 1 ? '▲' : '▼') : ''}</span></button></th>`;
        }).join('')}</tr></thead>
        <tbody>${list.map((a) => `
          <tr data-href="#/accounts/${a.id}" data-q="${esc(`${a.name} ${a.domain} ${a.segment} ${a.status}`.toLowerCase())}">
            <td><a class="row-link" href="#/accounts/${a.id}">${esc(a.name)}</a><div class="muted xs">${esc(a.domain)}</div></td>
            <td>${statusChip(a.status)}</td>
            <td class="hide-sm opt-a small">${esc(a.segment)}</td>
            <td class="hide-sm small num center-col">${a.usage ? `${a.usage.propertiesLive}/` : ''}${a.properties}</td>
            <td class="hide-sm num num-col">${money(a.deal.amount)}</td>
            <td class="hide-sm opt-b num num-col">${a.usage ? moneyCompact(a.usage.spend30d) : '<span class="muted">–</span>'}</td>
            <td>${a.health != null ? riskChip(a.healthLevel, a.health) : '<span class="muted">–</span>'}</td>
            <td class="hide-sm opt-a small">${a.openConversations + a.openTickets ? [a.openConversations && `${a.openConversations} ${a.openConversations === 1 ? 'conversation' : 'conversations'}`, a.openTickets && `${a.openTickets} ${a.openTickets === 1 ? 'ticket' : 'tickets'}`].filter(Boolean).join(' · ') : '<span class="muted">–</span>'}</td>
          </tr>`).join('')}</tbody>
      </table>
      <div class="empty" id="no-match" hidden>No accounts match your filter.</div>
    </div>`;
  $$('tbody tr').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a')) location.hash = tr.dataset.href; }));
  $$('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    const same = state.acctSort.id === b.dataset.sort;
    state.acctSort = { id: b.dataset.sort, dir: same ? -state.acctSort.dir : 1 };
    renderAccounts();
  }));
  const filter = () => {
    const q = (state.acctQ = $('#q').value.trim().toLowerCase());
    let n = 0;
    $$('tbody tr').forEach((tr) => { tr.hidden = Boolean(q) && !tr.dataset.q.includes(q); n += tr.hidden ? 0 : 1; });
    $('#no-match').hidden = n > 0;
  };
  $('#q').addEventListener('input', filter);
  filter();
}

function conversationBlock(c) {
  return `
    <div class="thread">
      ${c.messages.map((m) => `<div class="msg ${m.from}"><div class="who">${esc(m.author)} · ${rel(m.at)}</div>${esc(m.text)}</div>`).join('')}
    </div>
    ${c.state === 'open' ? `
      <form class="reply" data-conv="${esc(c.id)}" data-reason="${esc(c.ai?.category ?? '')}">
        <textarea class="input" name="text" rows="2" placeholder="Reply to customer (sent via Intercom)…" required></textarea>
        <button class="btn primary" name="send">Send</button>
      </form>` : `<div class="empty">Closed${c.closeReason ? ` as “${esc(reasonLabel(c.closeReason))}”` : ''}${c.closedBy ? ` by ${esc(c.closedBy)}` : ''}</div>`}`;
}

const reasonLabel = (id) => state.meta.closeReasons.find((r) => r.id === id)?.label ?? id;

// Closing always asks why; Claude's suggested category is preselected when available.
function pickCloseReason(suggested, onPick) {
  openModal(`
    <h2>Why is this conversation closing?</h2>
    <div class="reasons" role="radiogroup" aria-label="Close reason">
      ${state.meta.closeReasons.map((r) => `
        <label class="reason"><input type="radio" name="reason" value="${r.id}" ${r.id === suggested ? 'checked' : ''} required />
          <span>${esc(r.label)}</span>${r.id === suggested ? `<span class="chip ai">${icon('i-sparkle')}Suggested</span>` : ''}</label>`).join('')}
    </div>
    <p class="muted small">Tagged in Intercom and logged to Snowflake, so we can see what drives support volume.</p>`,
    'Close conversation', async (data) => onPick(data.reason));
}

function bindReplies(root) {
  $$('form.reply', root).forEach((form) => form.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = e.submitter;
    const text = form.text.value;
    run(btn, async () => {
      await api(`/api/conversations/${form.dataset.conv}/reply`, { method: 'POST', body: { text } });
      form.reset();
      route({ keepScroll: true });
    });
  }));
}


// ---------- meetings (Google Calendar + Meet) ----------
const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const toLocalInput = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
// Demo dates are stored in UTC ('YYYY-MM-DDTHH:mm'); the inputs show and take the viewer's local time.
const utcFieldToLocal = (v) => (v ? toLocalInput(new Date(`${v}:00Z`)) : '');
const localToUtcField = (v) => (v ? new Date(v).toISOString().slice(0, 16) : '');
const fmtMeeting = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// After booking: the link, ready to join or share.
function meetingReady(link, heading, text) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form method="dialog"><h2>${esc(heading)}</h2><p class="small mb-3">${esc(text)}</p>
    <div class="meet-link">${icon('i-video')}<span class="mono small grow ellipsis">${esc(link.replace('https://', ''))}</span><button type="button" class="btn sm" id="copy-link">Copy</button></div>
    <div class="dialog-actions"><a class="btn primary" href="${esc(link)}" target="_blank" rel="noopener">Join now</a><button class="btn" value="cancel">Done</button></div></form>`;
  $('#copy-link', dlg).addEventListener('click', (e) => { navigator.clipboard?.writeText(link).then(() => { e.target.textContent = 'Copied'; }, () => {}); });
  dlg.showModal();
}

// "Meet": a call right now, or a scheduled invite. Google Calendar emails it with a Meet link.
function openMeetDialog(a, after = afterAction) {
  const me = user();
  const team = [...new Set([a.owner, a.csm].filter((n) => n && n !== me.name))];
  const title = me.team === 'support' ? `Quick call: ${a.name}` : me.team === 'cs' ? `Check-in: ${a.name}` : `${a.name} × Frontline`;
  const tomorrow = new Date(Date.now() + 86400000); tomorrow.setHours(10, 0, 0, 0);
  let result = null;
  const form = formDialog(`
    <h2>Meet with ${esc(a.name)}</h2>
    <div class="seg seg-inline meet-when" role="group" aria-label="When">
      <button type="button" class="sel" data-when="now" aria-pressed="true">Now</button>
      <button type="button" data-when="later" aria-pressed="false">Schedule</button>
    </div>
    <div class="field when-later" hidden><label for="mt-start">Date and time</label><input class="input" id="mt-start" name="start" type="datetime-local" required min="${toLocalInput(new Date())}" value="${toLocalInput(tomorrow)}" /></div>
    <div class="field"><label for="mt-len">Length</label><select class="input" id="mt-len" name="minutes">${[15, 30, 45, 60].map((m) => `<option value="${m}" ${m === (me.team === 'support' ? 15 : 30) ? 'selected' : ''}>${m} minutes</option>`).join('')}</select></div>
    <div class="field"><span class="flabel">Invite</span><div class="checks">
      <label class="check-pill"><input type="checkbox" name="contact" checked /> ${esc(a.contact.name)} <span class="muted xs">${esc(a.contact.role)}</span></label>
      ${team.map((n) => `<label class="check-pill"><input type="checkbox" name="team" value="${esc(n)}" /> ${esc(n)}</label>`).join('')}
    </div></div>
    <div class="field"><label for="mt-title">Title</label><input class="input" id="mt-title" name="title" value="${esc(title)}" required /></div>
    <div class="field"><label for="mt-agenda">Agenda <span class="muted xs">(optional)</span></label><textarea class="input" id="mt-agenda" name="agenda" rows="2"></textarea></div>
    <p class="muted small">Google Calendar emails the invite with a Meet link, and the meeting is logged in HubSpot.</p>`,
    'Start the call', async (f, o) => {
      const later = !$('.when-later', f).hidden;
      if (later && !f.start.value) throw Object.assign(new Error('Pick a date and time.'), { field: 'start' });
      result = await api(`/api/accounts/${a.id}/meetings`, { method: 'POST', body: {
        title: f.title.value, start: later ? new Date(f.start.value).toISOString() : null, minutes: Number(f.minutes.value),
        withContact: f.contact.checked, team: $$('input[name="team"]:checked', f).map((x) => x.value), agenda: f.agenda.value, tz: browserTz(), confirmed: o.confirmed,
      } });
      result.later = later;
      await after();
    });
  const go = $('button[value="ok"]', form);
  $$('[data-when]', form).forEach((b) => b.addEventListener('click', () => {
    const later = b.dataset.when === 'later';
    $$('[data-when]', form).forEach((x) => { x.classList.toggle('sel', x === b); x.setAttribute('aria-pressed', x === b); });
    $('.when-later', form).hidden = !later;
    go.textContent = later ? 'Send invite' : 'Start the call';
  }));
  // formDialog closes itself after a successful submit; then show the link
  $('#modal').addEventListener('close', () => {
    if (!result) return;
    const m = result.meeting;
    setTimeout(() => meetingReady(m.link, result.later ? 'Invite sent' : 'Your call is ready',
      result.later ? `${m.title}, ${fmtMeeting(m.start)}. Everyone got the invite by email.` : `${m.attendees.filter((n) => n !== user().name).join(', ')} got the invite by email. Join now and they can hop in.`), 0);
  }, { once: true });
}

// The account's meetings: upcoming first, then the last two.
function meetingsCard(a) {
  const nowIso = new Date().toISOString();
  const upcoming = (a.meetings ?? []).filter((m) => m.end > nowIso);
  const past = (a.meetings ?? []).filter((m) => m.end <= nowIso).slice(-2).reverse();
  const row = (m, isPast) => `<div class="list-item meeting ${isPast ? 'past' : ''}">
      ${icon('i-video')}
      <div class="grow"><div class="fw-500">${esc(m.title)}</div><div class="muted xs">${m.instant && !isPast ? 'Started ' + rel(m.start) : fmtMeeting(m.start)} · ${esc(m.attendees.join(', '))}</div></div>
      ${isPast ? '' : `<a class="btn sm" href="${esc(m.link)}" target="_blank" rel="noopener">Join</a>`}
    </div>`;
  return `<section class="card">
    <div class="card-head"><h2>Meetings</h2>${src('google', 'Google Calendar')}</div>
    ${upcoming.map((m) => row(m, false)).join('') || '<div class="empty small">Nothing booked.</div>'}
    ${past.length ? `<div class="sa-row-head past-head">Past</div>${past.map((m) => row(m, true)).join('')}` : ''}
  </section>`;
}

// ---------- account tabs ----------
const ACCOUNT_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'health', label: 'Health & usage', live: true, count: (a) => a.anomalies.length || '' },
  { id: 'support', label: 'Support', count: (a) => a.support.open || '' },
  { id: 'requests', label: 'Feature requests', count: (a) => a.featureRequestList.length || '' },
];
const METRIC_TILES = [
  ['pos', 'Purchase orders / week'], ['invoicesAi', 'AI-processed invoices / week'], ['activeUsers', 'Active users'], ['syncErrors', 'ERP sync errors / week'],
];

function healthPanel(a) {
  const anomalyFor = (m) => a.anomalies.find((x) => x.metric === m);
  const partTone = (v) => (v >= 70 ? 'good' : v >= 50 ? 'warn' : 'bad');
  const list = can('portfolio.edit') ? (a.csSuggestions ?? []) : [];
  return `
    ${list.length ? `<section class="card acct-sa cs-sa"><div class="sa-row-head">Next suggested action${list.length > 1 ? 's' : ''}</div><div class="sa-grid">${list.map((x) => csCard(a, x)).join('')}</div></section>` : ''}
    <div class="health-grid">
      <section class="card card-pad">
        <div class="muted small">Health score</div>
        <div class="hs-row"><span class="hs-num tone-${RISK[a.healthLevel].tone}">${a.health}</span>${riskChip(a.healthLevel)}</div>
        <div class="muted small">${a.renewalDate ? `Renewal ${new Date(a.renewalDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · in ${a.renewalDays} days` : ''}</div>
        <h3 class="sub">Why</h3>
        ${a.healthReasons.length ? `<ul class="reasons-list">${a.healthReasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '<p class="muted small">No warning signs. Keep doing what works.</p>'}
      </section>
      <section class="card card-pad">
        <div class="spread"><h2>What makes up the score</h2><span class="muted xs">Weighted</span></div>
        <div class="parts">
          ${a.healthParts.map((p) => `
            <div class="part">
              <div class="spread"><span class="small fw-500">${esc(p.label)} <span class="muted xs">${Math.round(state.meta.healthWeights[p.id] * 100)}%</span></span><span class="num small tone-${partTone(p.score)}">${p.score}</span></div>
              <div class="bar"><span style="width:${p.score}%;background:var(--${partTone(p.score)})"></span></div>
              <div class="muted xs">${esc(p.detail)}</div>
            </div>`).join('')}
        </div>
      </section>
    </div>

    <section class="card mt-4">
      <div class="card-head">
        <div><h2>Weekly usage · last 12 weeks</h2><div class="muted small">From Snowflake. An anomaly is last week vs the 4 weeks before: a drop of 30%+ or an error spike.</div></div>
        ${can('anomalies.edit') ? `<button class="btn sm" data-scan>${icon('i-search')}Check usage now</button>` : ''}
      </div>
      <div class="metric-grid">
        ${METRIC_TILES.map(([m, label]) => {
          const vals = a.usageSeries?.[m] ?? [];
          const an = anomalyFor(m);
          return `<div class="metric ${an ? 'is-alert' : ''}">
            <div class="muted xs">${esc(label)}</div>
            <div class="spread"><span class="v num">${vals.length ? vals.at(-1).toLocaleString('en-US') : '–'}</span>${an ? `<span class="chip ${an.severity}"><svg class="ico"><use href="#i-alert"/></svg>Anomaly</span>` : ''}</div>
            ${sparkline(vals, { label, alert: Boolean(an) })}
          </div>`;
        }).join('')}
      </div>
    </section>

    <section class="card mt-4">
      <div class="card-head"><h2>Usage anomalies</h2>${src('snowflake')}</div>
      ${a.allAnomalies.length ? a.allAnomalies.map((x) => `
        <div class="list-item">
          <svg class="ico tone-${x.severity} ico-18"><use href="#i-alert"/></svg>
          <div class="grow"><div>${esc(x.text)}</div><div class="muted xs">Detected ${rel(x.detectedAt)}${x.reviewedBy ? ` · reviewed by ${esc(x.reviewedBy)}` : ''}</div>${x.note ? `<div class="small mt-1">“${esc(x.note)}”</div>` : ''}</div>
          ${x.status === 'new' ? '<span class="chip warn">To review</span>' : '<span class="chip good">Reviewed</span>'}
        </div>`).join('') : '<div class="empty">No anomalies. Usage looks normal.</div>'}
    </section>`;
}

// Conversations open in the Inbox for Support; other roles see them in place.
const convTag = (c) => (can('inbox.work') ? `a class="list-item link-row" href="#/inbox/${esc(c.id)}"` : 'div class="list-item"');

function supportPanel(a) {
  const open = a.conversationsView.filter((c) => c.state === 'open');
  const closed = a.conversationsView.filter((c) => c.state === 'closed');
  const bugs = a.tickets.filter((t) => t.status !== 'Done');
  return `
    <div class="kpis kpis-3">
      <div class="card kpi"><div class="muted small">Open conversations</div><div class="v num">${a.support.open}</div></div>
      <div class="card kpi"><div class="muted small">With engineering</div><div class="v num ${a.support.escalated ? 'tone-warn' : ''}">${a.support.escalated}</div></div>
      <div class="card kpi"><div class="muted small">Overdue replies</div><div class="v num ${a.support.overdue ? 'tone-bad' : ''}">${a.support.overdue}</div></div>
    </div>
    <div class="detail-grid">
      <section class="card">
        <div class="card-head"><h2>Open conversations</h2>${src('intercom')}</div>
        ${open.map((c) => `
          <${convTag(c)}>
            <div class="grow">
              <div class="fw-500">${esc(c.subject)}</div>
              <div class="ii-facts">
                ${dueTag(c, 'fact', 'div')}
                <div class="fact"><svg class="ico"><use href="#i-tag"/></svg><span class="k">Classification:</span>${esc(c.classificationLabel)}${c.escalatedTo ? ` <span class="mono info-text">· ${esc(c.escalatedTo)}</span>` : ''}</div>
                <div class="fact ${c.assignee ? '' : 'warn'}"><svg class="ico"><use href="#i-user"/></svg><span class="k">Owner:</span>${c.assignee ? esc(c.assignee) : 'Unassigned'}</div>
              </div>
            </div>
            ${can('inbox.work') ? '<svg class="ico muted"><use href="#i-arrow"/></svg>' : ''}
          </${convTag(c).split(' ')[0]}>`).join('') || '<div class="empty">No open conversations.</div>'}
        <div class="card-head bt"><h2>Past conversations</h2></div>
        ${closed.map((c) => `
          <${convTag(c)}><div class="grow"><div>${esc(c.subject)}</div><div class="muted xs">${esc(c.classificationLabel)} · closed as ${esc(reasonLabel(c.closeReason ?? ''))} · ${rel(c.updatedAt)}</div></div></${convTag(c).split(' ')[0]}>`).join('') || '<div class="empty">None yet.</div>'}
      </section>
      <section class="card">
        <div class="card-head"><h2>Engineering tickets</h2>${src('jira')}</div>
        ${bugs.map((t) => `
          <div class="list-item">
            <span class="mono muted key-col">${esc(t.key)}</span>
            <div class="grow">${esc(t.summary)}<div class="muted xs">${rel(t.createdAt)}</div></div>
            ${ticketStatus(t.status)}
          </div>`).join('') || '<div class="empty">No open tickets.</div>'}
      </section>
    </div>`;
}

function requestsPanel(a) {
  const list = a.featureRequestList;
  return `
    <section class="card">
      <div class="card-head"><div><h2>Feature requests from ${esc(a.name)}</h2><div class="muted small">Tracked in Jira. You're notified in Slack whenever one moves.</div></div>${src('jira')}</div>
      ${list.length ? `<div class="table-wrap"><table class="table fr-table">
        <thead><tr><th>Request</th><th>Status</th><th>Asked</th><th>Also asked by</th><th>Customer</th></tr></thead>
        <tbody>${list.map((f) => {
          const mine = f.accounts.find((r) => r.accountId === a.id);
          const others = f.accounts.filter((r) => r.accountId !== a.id);
          return `<tr>
            <td data-label="Request"><div class="fw-500">${esc(f.title)}</div><div class="mono muted xs">${esc(f.jiraKey)}</div></td>
            <td data-label="Status"><div class="row gap-1 no-wrap">${frStatus(f.status)}${frSimBtn(f)}</div><div class="muted xs">Updated ${rel(f.updatedAt)}</div></td>
            <td data-label="Asked" class="small">${rel(mine.requestedAt)}</td>
            <td data-label="Also asked by" class="small">${others.length ? `${others.map((r) => `<a class="link" href="#/accounts/${esc(r.accountId)}?tab=requests">${esc(r.name)}</a>`).join(', ')}<div class="muted xs">${moneyCompact(f.arr)} ARR asking in total</div>` : '<span class="muted">No one else yet</span>'}</td>
            <td data-label="Customer">${frCustomerCell(f, mine)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : '<div class="empty">No feature requests yet. Support conversations closed as “Feature request” show up here automatically.</div>'}
    </section>`;
}

// Buttons shared by the account tabs, portfolio and requests pages.
function bindCsActions(root) {
  const go = (btn, path, body) => run(btn, async () => { await api(path, { method: 'POST', body }); route({ keepScroll: true }); });
  $$('[data-scan]', root).forEach((b) => b.addEventListener('click', () => go(b, '/api/anomalies/scan')));
  $$('[data-ack]', root).forEach((b) => b.addEventListener('click', () => go(b, `/api/anomalies/${b.dataset.ack}/ack`)));
  $$('[data-tell]', root).forEach((b) => b.addEventListener('click', () => go(b, `/api/feature-requests/${b.dataset.tell}/tell`, { accountId: b.dataset.account })));
  $$('[data-advance]', root).forEach((b) => b.addEventListener('click', () => go(b, `/api/feature-requests/${b.dataset.advance}/advance`)));
}

async function renderAccount(id, query = new URLSearchParams()) {
  const a = await api(`/api/accounts/${id}`);
  // Open deals get the same suggested actions as the Pipeline
  const dealOpen = !['closedwon', 'closedlost'].includes(a.deal.stage);
  const pl = dealOpen && canEditDeal(a) ? (await api('/api/pipeline')).find((x) => x.id === id) : null;
  const stages = state.meta.stages;
  const idx = stages.findIndex((s) => s.id === a.deal.stage);
  const pending = a.approvals.find((p) => p.status === 'pending');
  const lastDecided = a.approvals.find((p) => p.status !== 'pending');
  const steps = state.meta.steps;
  const doneCount = a.onboarding ? steps.filter((s) => a.onboarding.steps[s.id].done).length : 0;
  const net = a.deal.amount * (1 - (a.deal.discountPct || 0) / 100);
  // Each role sees the tabs it needs, in its own order of importance; ?tab= deep-links.
  const tabs = role().accountTabs.map((t) => ACCOUNT_TABS.find((x) => x.id === t)).filter((t) => !t.live || a.status !== 'Prospect');
  const tab = tabs.some((t) => t.id === query.get('tab')) ? query.get('tab') : tabs[0].id;

  view.innerHTML = `
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/accounts">Accounts</a><span aria-hidden="true">/</span><span aria-current="page">${esc(a.name)}</span></nav>
    <div class="page-head">
      <div>
        <h1>${esc(a.name)}</h1>
        <div class="row mt-2">
          ${statusChip(a.status)}
          <span class="chip">${esc(a.segment)}</span>
          <span class="chip">${a.properties} ${a.properties === 1 ? 'property' : 'properties'} · ${esc(a.region)}</span>
          <span class="chip">AE ${esc(a.owner)} · CSM ${esc(a.csm)}</span>
          ${a.health != null ? riskChip(a.healthLevel, a.health) : ''}
          ${a.renewalDays != null ? `<span class="chip ${a.renewalDays <= 90 ? 'warn' : ''}" title="in ${a.renewalDays} days">Renews ${fmtDate(a.renewalDate)}</span>` : ''}
        </div>
      </div>
      <div class="row">
        ${can('meetings.create') ? `<button class="btn" data-meet>${icon('i-video')}Meet</button>` : ''}
        <button class="btn" id="add-note">${icon('i-plus')}Note</button>
        ${can('tickets.create') ? `<button class="btn" id="new-ticket">${icon('i-plus')}Jira ticket</button>` : ''}
      </div>
    </div>

    <div class="tabs" role="tablist" aria-label="Account sections">
      ${tabs.map((t) => `<button role="tab" class="tab ${t.id === tab ? 'sel' : ''}" data-acct-tab="${t.id}" aria-selected="${t.id === tab}" aria-controls="panel-${t.id}">${esc(t.label)}${t.count ? ` <span class="num">${t.count(a)}</span>` : ''}</button>`).join('')}
    </div>

    <div class="tab-panel" id="panel-health" role="tabpanel" ${tab === 'health' ? '' : 'hidden'}>${a.status === 'Prospect' ? '' : healthPanel(a)}</div>
    <div class="tab-panel" id="panel-support" role="tabpanel" ${tab === 'support' ? '' : 'hidden'}>${supportPanel(a)}</div>
    <div class="tab-panel" id="panel-requests" role="tabpanel" ${tab === 'requests' ? '' : 'hidden'}>${requestsPanel(a)}</div>

    <div class="tab-panel detail-grid" id="panel-overview" role="tabpanel" ${tab === 'overview' ? '' : 'hidden'}>
      <div class="stack">
        <section class="card">
          <div class="card-head">
            <div><h2>${esc(a.deal.name)}</h2><div class="muted small">${canEditDeal(a) ? 'Click a stage to update HubSpot' : `Owned by ${esc(a.owner)} · read-only`}</div></div>
            ${src('hubspot', `Deal ${a.deal.id}`)}
          </div>
          ${pending ? `<div class="banner">${icon('i-clock')}${pending.pct}% discount waiting for manager approval in Slack <span class="mono">#deal-desk</span>. <a class="link" href="#/approvals">View</a></div>` : ''}
          <div class="pipeline">
            ${stages.map((s, i) => `<button class="stage ${s.id === 'closedlost' ? 'lost' : ''} ${i === idx ? 'current' : i < idx && a.deal.stage !== 'closedlost' ? 'done' : ''}" data-stage="${s.id}" ${canEditDeal(a) ? '' : 'disabled'}>${esc(s.label)}</button>`).join('')}
          </div>
          <div class="deal-foot">
            <div class="row">
              <span class="num fw-600">${money(net)} ARR</span>
              ${a.deal.discountPct ? `<span class="muted small">list ${money(a.deal.amount)} · −${a.deal.discountPct}%</span>` : ''}
              ${lastDecided && !pending ? `<span class="chip ${lastDecided.status === 'approved' ? 'good' : 'bad'}">${lastDecided.pct}% ${lastDecided.status} by ${esc(lastDecided.decidedBy)}</span>` : ''}
            </div>
            ${a.deal.stage !== 'closedwon' && !pending && canEditDeal(a) ? '<button class="btn sm" id="discount">Request discount</button>' : ''}
          </div>
          ${pl && suggestions(pl).length ? `<div class="acct-sa"><div class="sa-row-head">Next suggested action${suggestions(pl).length > 1 ? 's' : ''}</div><div class="sa-grid">${suggestions(pl).map((x) => saCard(pl, x)).join('')}</div></div>` : ''}
        </section>

        ${a.onboarding ? `
        <${a.onboarding.completedAt ? 'details' : 'section'} class="card onb-card">
          <${a.onboarding.completedAt ? 'summary' : 'div'} class="card-head">
            <div><h2>Onboarding · ${doneCount}/${steps.length}</h2>
              <div class="muted small">${a.onboarding.completedAt ? `Completed ${rel(a.onboarding.completedAt)}` : `Day ${days(a.onboarding.startedAt)}`} · Slack <span class="mono">${esc(a.onboarding.slackChannel)}</span> · Jira <span class="mono">${esc(a.onboarding.jiraEpic ?? '')}</span></div></div>
            ${a.onboarding.completedAt ? `<span class="link small onb-toggle">Show steps</span>` : (can('onboarding.edit') ? `<button class="btn sm" id="sync">${icon('i-reset')}Refresh usage</button>` : '')}
          </${a.onboarding.completedAt ? 'summary' : 'div'}>
          <div class="steps">
            ${steps.map((s) => {
              const st = a.onboarding.steps[s.id];
              return `<div class="step ${st.done ? 'done' : ''}">
                <button class="check ${st.done ? 'on' : ''}" data-step="${s.id}" ${s.auto || !can('onboarding.edit') ? 'disabled' : ''} aria-label="${esc(s.label)}" title="${s.auto ? `Completed automatically: ${esc(s.hint)}` : 'Toggle'}">${st.done ? '✓' : ''}</button>
                <div class="grow"><span class="label">${esc(s.label)}</span>${st.done ? `<div class="muted xs">${esc(st.by)} · ${rel(st.at)}</div>` : ''}</div>
                ${s.auto ? `${src('snowflake', 'auto')}` : ''}
              </div>`;
            }).join('')}
          </div>
        </${a.onboarding.completedAt ? 'details' : 'section'}>` : ''}

      </div>

      <div class="stack">
        ${meetingsCard(a)}
        <section class="card card-pad">
          <h2 class="mb-3">Primary contact</h2>
          <dl class="kv">
            <dt>Name</dt><dd>${esc(a.contact.name)}</dd>
            <dt>Role</dt><dd>${esc(a.contact.role)}</dd>
            <dt>Email</dt><dd class="mono">${esc(a.contact.email)}</dd>
          </dl>
        </section>

        <section class="card card-pad">
          <div class="spread mb-3"><h2>Product usage</h2>${src('snowflake')}</div>
          ${a.usage ? `
            <div class="usage">
              <div><div class="muted xs">Properties live</div><div class="v num">${a.usage.propertiesLive} / ${a.properties}</div>
                <div class="bar mt-1"><span style="width:${Math.round((a.usage.propertiesLive / a.properties) * 100)}%"></span></div></div>
              <div><div class="muted xs">Active users</div><div class="v num">${compact(a.usage.activeUsers)}</div></div>
              <div><div class="muted xs">Purchase orders (30d)</div><div class="v num">${compact(a.usage.pos30d)}</div></div>
              <div><div class="muted xs">AI-processed invoices (30d)</div><div class="v num">${compact(a.usage.invoicesAi30d)}</div></div>
              <div><div class="muted xs">Spend via Frontline (30d)</div><div class="v num">${moneyCompact(a.usage.spend30d)}</div></div>
              <div><div class="muted xs">Vendors connected</div><div class="v num">${compact(a.usage.vendorsConnected)}</div></div>
            </div>
            <div class="spread mt-3"><span class="muted xs">Last active ${rel(a.usage.lastActive)}</span>
              ${a.onboarding || !can('onboarding.edit') ? '' : `<button class="btn sm" id="sync">${icon('i-reset')}Refresh</button>`}</div>`
          : '<p class="muted small">Prospect: no product usage yet.</p>'}
        </section>

        <section class="card">
          <div class="card-head"><h2>Notes</h2>${src('hubspot')}</div>
          ${a.notes.length ? a.notes.map((n) => `<div class="note">${esc(n.text)}<div class="muted xs mt-1">${esc(n.author)} · ${rel(n.at)}</div></div>`).join('') : '<div class="empty">No notes yet.</div>'}
        </section>
      </div>
    </div>`;
  state.flashId = null;

  $$('[data-acct-tab]').forEach((b) => b.addEventListener('click', () => {
    history.replaceState(null, '', `#/accounts/${id}?tab=${b.dataset.acctTab}`);
    $$('[data-acct-tab]').forEach((x) => { const on = x === b; x.classList.toggle('sel', on); x.setAttribute('aria-selected', on); });
    $$('.tab-panel').forEach((p) => (p.hidden = p.id !== `panel-${b.dataset.acctTab}`));
  }));
  $$('.acct-sa [data-cta]').forEach((b) => b.addEventListener('click', () => runDealCta(pl, pl.signals.find((x) => x.type === b.dataset.sig), b)));
  $$('[data-meet]').forEach((b) => b.addEventListener('click', () => openMeetDialog(a)));
  bindCsCards(view, { [a.id]: a });
  bindCsActions(view);

  $$('.stage').forEach((b) => b.addEventListener('click', () => {
    if (!b.classList.contains('current')) moveDeal(a, b.dataset.stage);
  }));

  $('#discount')?.addEventListener('click', () => openModal(`
    <h2>Request a discount</h2>
    <div class="field"><label for="pct">Discount %</label><input class="input" id="pct" name="pct" type="number" min="1" max="50" value="10" required /></div>
    <div class="field"><label for="reason">Reason <span class="muted xs">(optional, helps the approver)</span></label><textarea class="input" id="reason" name="reason" rows="3" maxlength="500" placeholder="Why does this deal need it?"></textarea></div>
    <p class="muted small">Up to ${state.meta.config.discountApprovalThreshold}% is applied in HubSpot right away. Above that, a manager approves it in Slack <span class="mono">#deal-desk</span>.</p>`,
    'Submit', async (data) => {
      await api(`/api/accounts/${id}/discount`, { method: 'POST', body: data });
      route({ keepScroll: true });
    }));

  $$('.check[data-step]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
    await api(`/api/accounts/${id}/steps/${b.dataset.step}`, { method: 'POST' });
    route({ keepScroll: true });
  })));

  $('#sync')?.addEventListener('click', (e) => run(e.currentTarget, async () => {
    await api(`/api/accounts/${id}/sync-usage`, { method: 'POST' });
    route({ keepScroll: true });
  }));

  bindReplies(view);

  $('#new-ticket')?.addEventListener('click', () => openModal(`
    <h2>New Jira ticket · ${esc(a.name)}</h2>
    <div class="field"><label for="t-sum">Summary</label><input class="input" id="t-sum" name="summary" required /></div>
    <div class="field"><label for="t-desc">Description <span class="muted xs">(optional)</span></label><textarea class="input" id="t-desc" name="description" rows="3" maxlength="2000"></textarea></div>
    <div class="field"><label for="t-pri">Priority</label><select class="input" id="t-pri" name="priority"><option>Low</option><option selected>Medium</option><option>High</option><option>Highest</option></select></div>`,
    'Create', (data) => api(`/api/accounts/${id}/tickets`, { method: 'POST', body: data }).then(() => route({ keepScroll: true }))));

  $('#add-note').addEventListener('click', () => openModal(`
    <h2>Note · ${esc(a.name)}</h2>
    <div class="field"><textarea class="input" name="text" rows="4" required placeholder="What should the team know?" aria-label="Note"></textarea></div>
    <p class="muted small">Saved as a note on the company in HubSpot.</p>`,
    'Save', (data) => api(`/api/accounts/${id}/notes`, { method: 'POST', body: data }).then(() => route({ keepScroll: true }))));
  if (query.get('note')) {
    history.replaceState(null, '', `#/accounts/${id}?tab=overview`);
    $('#add-note').click();
  }
}

// ---------- inbox ----------
const INBOUND_SAMPLES = [
  { label: 'Enterprise: angry about invoices', email: 'greg.walsh@meridiansuites.com.invalid', text: 'Invoices from US Foods are still broken after your fix. Unacceptable. We need someone on this today.' },
  { label: 'Onboarding: ERP question', email: 'priya@sableandpine.com.invalid', text: 'Our Sage Intacct sync is failing for resort #3 again. Can someone look?' },
  { label: 'Live: feature question', email: 'ana@coastalkeys.com.invalid', text: 'Can we set par levels per outlet for the pool bar?' },
];

const isSnoozed = (c) => c.snoozedUntil && new Date(c.snoozedUntil) > new Date();
const INBOX_TABS = [
  { id: 'mine', label: 'Mine', test: (c, me) => c.state === 'open' && !isSnoozed(c) && c.assignee === me },
  { id: 'unassigned', label: 'Unassigned', test: (c) => c.state === 'open' && !isSnoozed(c) && !c.assignee },
  { id: 'enterprise', label: 'Enterprise', test: (c) => c.state === 'open' && !isSnoozed(c) && c.account.segment === 'Enterprise' },
  { id: 'overdue', label: 'Overdue', test: (c) => c.state === 'open' && !isSnoozed(c) && c.slaDueAt && new Date(c.slaDueAt) < new Date() },
  { id: 'open', label: 'All open', test: (c) => c.state === 'open' && !isSnoozed(c) },
  { id: 'snoozed', label: 'Snoozed', test: (c) => c.state === 'open' && isSnoozed(c) },
  { id: 'closed', label: 'Closed', test: (c) => c.state === 'closed' },
];

function snoozeOptions() {
  const at = (h) => new Date(Date.now() + h * 3600_000);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  return [['1 hour', at(1)], ['4 hours', at(4)], ['Tomorrow 9:00', tomorrow]];
}

const SENTIMENT_TONE = { calm: 'good', confused: 'info', frustrated: 'warn', angry: 'bad' };

function aiCard(c) {
  if (c.state !== 'open') return '';
  if (!c.ai) {
    return `<div class="ai-card empty-ai"><span>${icon('i-sparkle')}Get a summary, the customer's mood and a draft reply.</span>
      <button class="btn sm ai-btn" id="ai-run">${icon('i-sparkle')}Summarize &amp; draft reply</button></div>`;
  }
  const stale = c.ai.forMessages !== c.messages.length;
  return `
    <div class="ai-card">
      <div class="spread">
        <div class="row"><strong class="ai-title">${icon('i-sparkle')}AI assist</strong>
          <span class="chip ${SENTIMENT_TONE[c.ai.sentiment] ?? ''}">${esc(c.ai.sentiment)}</span>
          <span class="chip">Likely: ${esc(reasonLabel(c.ai.category))}</span>
          ${stale ? '<span class="chip warn">New messages since</span>' : ''}</div>
        <button class="btn sm ghost" id="ai-run" title="Regenerate">${icon('i-reset')}${stale ? 'Refresh' : 'Regenerate'}</button>
      </div>
      <p class="ai-summary">${esc(c.ai.summary)}</p>
      <p class="small"><b>Next step:</b> ${esc(c.ai.next_step)}</p>
      <div class="ai-draft">
        <div class="spread"><span class="small fw-600">Suggested reply</span><button class="btn sm primary" id="ai-use">Use this reply</button></div>
        <pre class="draft">${esc(c.ai.suggested_reply)}</pre>
      </div>
      <div class="muted xs">${c.ai.mode === 'live' ? `Claude · ${esc(c.ai.model)}` : 'Mock mode: rules-based stand-in until ANTHROPIC_API_KEY is set'} · ${rel(c.ai.at)}</div>
    </div>`;
}

function snapshotPanel(a, currentId) {
  const p = a.platform;
  const tickets = a.tickets.filter((t) => t.status !== 'Done');
  const history = a.conversations.filter((c) => c.id !== currentId).slice(0, 4);
  const syncTone = { ok: 'good', degraded: 'warn', failing: 'bad' }[p?.syncStatus] ?? '';
  return `
    <div class="snap-head">
      <div class="spread"><h2>Account snapshot</h2><div class="row gap-1"><a class="link xs" href="#/accounts/${a.id}">Full account →</a><button class="icon-close" data-close-drawer aria-label="Close"><svg class="ico"><use href="#i-x"/></svg></button></div></div>
      <div class="snap-name">${esc(a.name)}</div>
      <div class="row gap-1 mt-2">${statusChip(a.status)}<span class="chip">${esc(a.segment)}</span><span class="chip">${money(a.deal.amount)} ARR</span></div>
      <div class="mt-3">${a.health != null ? riskChip(a.healthLevel, a.health) : ''}</div>
      <div class="muted xs mt-2">CSM ${esc(a.csm)} · AE ${esc(a.owner)} · ${a.properties} properties</div>
    </div>
    <div class="snap-sec">
      <div class="spread"><h3>Platform</h3>${src('snowflake')}</div>
      ${p ? `<dl class="kv small">
          <dt>ERP</dt><dd>${esc(p.erp)}</dd>
          <dt>Sync</dt><dd><span class="chip ${syncTone}">${esc(p.syncStatus)}</span> <span class="muted xs">${rel(p.lastSyncAt)}</span></dd>
          <dt>Errors 24h</dt><dd class="num ${p.syncErrors24h ? 'tone-bad' : ''}">${p.syncErrors24h}</dd>
          <dt>Version</dt><dd class="mono">${esc(p.appVersion)}</dd>
          ${a.usage ? `<dt>Live</dt><dd>${a.usage.propertiesLive}/${a.properties} properties · ${compact(a.usage.activeUsers)} users</dd>` : ''}
        </dl>` : '<p class="muted small">Not live on the platform yet.</p>'}
    </div>
    <div class="snap-sec">
      <div class="spread"><h3>Open tickets · ${tickets.length}</h3>${src('jira')}</div>
      ${tickets.map((t) => `<div class="snap-row"><span class="mono muted">${esc(t.key)}</span><span class="grow ellipsis">${esc(t.summary)}</span>${ticketStatus(t.status)}</div>`).join('') || '<p class="muted small">None.</p>'}
    </div>
    <div class="snap-sec">
      <div class="spread"><h3>Past conversations</h3>${src('intercom')}</div>
      ${history.map((c) => `<a class="snap-row" href="#/inbox/${esc(c.id)}"><span class="grow ellipsis">${esc(c.subject)}</span><span class="chip ${c.state === 'open' ? 'warn' : ''}">${c.state === 'open' ? 'Open' : esc(reasonLabel(c.closeReason ?? '')) || 'Closed'}</span></a>`).join('') || '<p class="muted small">First conversation.</p>'}
    </div>
    ${a.onboarding && a.status === 'Onboarding' ? `<div class="snap-sec"><h3>Onboarding</h3><p class="small">Day ${days(a.onboarding.startedAt)} · ${Object.values(a.onboarding.steps).filter((x) => x.done).length}/${state.meta.steps.length} steps</p></div>` : ''}`;
}

// ---------- inbox ----------
// Two modes: the queue (a table, most urgent first) and one conversation at a time,
// with the customer's account one click away in a side panel.
const dueTime = (c) => (c.state === 'open' && c.slaDueAt ? new Date(c.slaDueAt).getTime() : Infinity);
const INBOX_COLS = [
  { id: 'customer', label: 'Customer', key: (c) => c.account.name.toLowerCase() },
  { id: 'subject', label: 'Subject', key: (c) => c.subject.toLowerCase() },
  { id: 'class', label: 'Classification', key: (c) => c.classificationLabel, opt: 'opt-b' },
  { id: 'due', label: 'Reply due', key: dueTime },
  { id: 'owner', label: 'Owner', key: (c) => c.assignee ?? '~' },
  { id: 'updated', label: 'Last message', key: (c) => -new Date(c.updatedAt).getTime(), opt: 'opt-a' },
];

function inboxQueue(items, me) {
  const tab = INBOX_TABS.find((t) => t.id === state.inboxTab) ?? INBOX_TABS[4];
  state.inboxSort ??= { id: 'due', dir: 1 };
  // Closed conversations have no reply target, so "Reply due" falls back to newest first.
  const sortId = tab.id === 'closed' && state.inboxSort.id === 'due' ? 'updated' : state.inboxSort.id;
  const col = INBOX_COLS.find((c) => c.id === sortId);
  const dir = sortId === state.inboxSort.id ? state.inboxSort.dir : 1;
  const list = items.filter((c) => tab.test(c, me.name)).sort((a, b) => {
    const x = col.key(a), y = col.key(b);
    return ((x < y ? -1 : x > y ? 1 : 0) * dir) || (dueTime(a) - dueTime(b));
  });
  return { tab, list };
}

function dueCell(i) {
  if (i.state === 'closed') return `<span class="st calm"><svg class="ico"><use href="#i-done"/></svg>Closed: ${esc(reasonLabel(i.closeReason ?? '')) || 'no reason'}</span>`;
  if (isSnoozed(i)) return `<span class="st info"><svg class="ico"><use href="#i-clock"/></svg>Snoozed until ${new Date(i.snoozedUntil).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>`;
  return dueTag(i) || '<span class="muted">–</span>';
}

function renderInbox(selectedId) {
  return selectedId ? renderConversation(selectedId) : renderInboxQueue();
}

async function renderInboxQueue() {
  const me = user();
  state.inboxTab ??= me.team === 'support' ? 'mine' : 'open';
  const [items, reasons] = await Promise.all([api('/api/inbox'), state.inboxTab === 'closed' ? api('/api/support/reasons') : null]);
  const { tab, list } = inboxQueue(items, me);
  const maxReason = reasons ? Math.max(1, ...reasons.map((r) => r.count)) : 1;
  state.inboxCursor = Math.min(state.inboxCursor ?? -1, list.length - 1);
  const sortOn = tab.id === 'closed' && state.inboxSort.id === 'due' ? 'updated' : state.inboxSort.id;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Inbox</h1><p class="muted">Intercom conversations, most urgent first. Open one to reply with the customer's account at hand.</p></div>
      <button class="btn" id="simulate" title="Demo: pretend a customer just wrote in through Intercom">${icon('i-play')}Simulate a message</button>
    </div>
    <div class="tabs" role="tablist" aria-label="Queues">
      ${INBOX_TABS.map((t) => { const n = items.filter((c) => t.test(c, me.name)).length; return `<button role="tab" class="tab ${t.id === tab.id ? 'sel' : ''}" data-tab="${t.id}" aria-selected="${t.id === tab.id}">${esc(t.label)} <span class="num">${n}</span></button>`; }).join('')}
    </div>
    ${reasons ? `<div class="card card-pad reasons-card"><div class="muted small mb-2">Why customers contacted us</div>
      ${reasons.filter((r) => r.count).sort((x, y) => y.count - x.count).map((r) => `<div class="rbar"><span class="xs ellipsis">${esc(r.label)}</span><div class="bar"><span style="width:${(r.count / maxReason) * 100}%"></span></div><span class="xs num">${r.count}</span></div>`).join('')}</div>` : ''}
    <div class="card table-wrap">
      <table class="table inbox-table">
        <thead><tr>${INBOX_COLS.map((c) => {
          const on = c.id === sortOn;
          const dir = on && c.id === state.inboxSort.id ? state.inboxSort.dir : 1;
          return `<th class="${c.opt ?? ''}" aria-sort="${on ? (dir === 1 ? 'ascending' : 'descending') : 'none'}"><button class="th-sort" data-isort="${c.id}">${esc(c.id === 'due' && tab.id === 'closed' ? 'Outcome' : c.label)}<span class="sort-ind" aria-hidden="true">${on ? (dir === 1 ? '▲' : '▼') : ''}</span></button></th>`;
        }).join('')}</tr></thead>
        <tbody>${list.map((i, n) => `
          <tr data-href="#/inbox/${esc(i.id)}" class="u-${urgency(i)?.tone ?? 'none'} ${n === state.inboxCursor ? 'cursor' : ''} ${i.id === state.flashId ? 'flash' : ''}">
            <td data-label="Customer"><a class="row-link" href="#/inbox/${esc(i.id)}">${esc(i.account.name)}</a> ${segBadge(i.account.segment)}</td>
            <td data-label="Subject" class="subj"><div class="ellipsis fw-500">${esc(i.subject)}</div><div class="muted xs ellipsis">${i.ai && i.ai.forMessages === i.messages.length ? `${icon('i-sparkle', 'inline')}${esc(i.ai.summary)}` : esc(i.messages.at(-1)?.text)}</div></td>
            <td data-label="Classification" class="small opt-b">${esc(i.classificationLabel)}${i.escalatedTo ? `<div class="mono info-text xs">${esc(i.escalatedTo)}</div>` : ''}</td>
            <td data-label="Reply due">${dueCell(i)}</td>
            <td data-label="Owner" class="small ${i.assignee ? '' : 'tone-warn'}">${i.assignee ? esc(i.assignee) : 'Unassigned'}</td>
            <td data-label="Last message" class="small muted opt-a">${rel(i.updatedAt)}</td>
          </tr>`).join('') || `<tr><td colspan="${INBOX_COLS.length}" class="empty">${tab.id === 'mine' ? 'Nothing assigned to you. Check <b>Unassigned</b>.' : 'Nothing here.'}</td></tr>`}</tbody>
      </table>
    </div>`;
  state.flashId = null;

  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.inboxTab = b.dataset.tab; state.inboxCursor = -1; renderInboxQueue(); }));
  $$('[data-isort]').forEach((b) => b.addEventListener('click', () => {
    const same = state.inboxSort.id === b.dataset.isort;
    state.inboxSort = { id: b.dataset.isort, dir: same ? -state.inboxSort.dir : 1 };
    renderInboxQueue();
  }));
  $$('.inbox-table tbody tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a')) location.hash = tr.dataset.href; }));
  bindSimulate();
}

// A one-line account summary that opens the full snapshot in a side panel.
function accountStrip(a) {
  const p = a.platform;
  const syncTone = { ok: 'good', degraded: 'warn', failing: 'bad' }[p?.syncStatus] ?? '';
  const tickets = a.tickets.filter((t) => t.status !== 'Done').length;
  const bit = (k, v) => `<span class="as-item"><span class="muted">${k}</span> ${v}</span>`;
  return `<button class="acct-strip" id="open-snap" type="button" aria-haspopup="dialog">
    <svg class="ico" aria-hidden="true"><use href="#i-building"/></svg>
    <span class="as-item fw-600">${esc(a.name)}</span>
    ${a.health != null ? riskChip(a.healthLevel, a.health) : statusChip(a.status)}
    ${bit('ARR', money(a.deal.amount))}
    ${p ? bit(esc(p.erp), `<span class="chip ${syncTone}">${esc(p.syncStatus)}</span>`) : ''}
    ${bit('Open tickets', `<span class="${tickets ? 'tone-warn' : ''}">${tickets}</span>`)}
    ${bit('CSM', esc(a.csm))}
    <span class="grow"></span><span class="link small as-more">Account details<svg class="ico"><use href="#i-arrow"/></svg></span>
  </button>`;
}

function openDrawer(html) {
  const dlg = $('#drawer');
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
  $('[data-close-drawer]', dlg)?.addEventListener('click', () => dlg.close());
}
const drawerHtml = (a, currentId) => snapshotPanel(a, currentId);

async function renderConversation(id) {
  const me = user();
  state.inboxTab ??= me.team === 'support' ? 'mine' : 'open';
  const items = await api('/api/inbox');
  const sel = items.find((i) => i.id === id);
  if (!sel) { view.innerHTML = '<div class="empty">This conversation no longer exists. <a class="link" href="#/inbox">Back to the inbox</a></div>'; return; }
  // Keep prev/next inside a queue that actually holds this conversation.
  if (!INBOX_TABS.find((t) => t.id === state.inboxTab)?.test(sel, me.name)) state.inboxTab = INBOX_TABS.find((t) => t.test(sel, me.name))?.id ?? 'open';
  const { tab, list } = inboxQueue(items, me);
  const pos = list.findIndex((i) => i.id === sel.id);
  const prev = list[pos - 1], next = list[pos + 1];
  const account = await api(`/api/accounts/${sel.account.id}`);
  const agents = state.meta.users.filter((u) => u.team === 'support');

  view.innerHTML = `
    <div class="spread conv-top">
      <nav class="crumbs m-0" aria-label="Breadcrumb"><a href="#/inbox">Inbox · ${esc(tab.label)}</a><span aria-hidden="true" class="sep">/</span><span aria-current="page" class="ellipsis">${esc(sel.subject)}</span></nav>
      <div class="row conv-pager gap-1">
        <a class="btn sm ${prev ? '' : 'disabled'}" ${prev ? `href="#/inbox/${esc(prev.id)}"` : 'aria-disabled="true"'} id="prev" title="Previous (K)">‹ Previous</a>
        <span class="muted small">${pos + 1} of ${list.length}</span>
        <a class="btn sm ${next ? '' : 'disabled'}" ${next ? `href="#/inbox/${esc(next.id)}"` : 'aria-disabled="true"'} id="next" title="Next (J)">Next ›</a>
      </div>
    </div>
    <div class="card conv">
      <div class="card-head">
        <div class="grow"><h2>${esc(sel.subject)}</h2><div class="row gap-1 mt-1"><span class="small">${esc(sel.account.name)}</span>${segBadge(sel.account.segment)}</div></div>
        ${src('intercom', `#${sel.id}`)}
      </div>
      ${accountStrip(account)}
      ${sel.state === 'open' ? `
      <div class="toolbar-row">
        <label class="xs muted" for="assignee">Owner</label>
        <select class="input sm" id="assignee">
          <option value="">Unassigned</option>
          ${agents.map((u) => `<option value="${esc(u.name)}" ${sel.assignee === u.name ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
        </select>
        ${me.team === 'support' && sel.assignee !== me.name ? '<button class="btn sm" id="take">Assign to me</button>' : ''}
        ${isSnoozed(sel) ? '<button class="btn sm" id="unsnooze">Unsnooze</button>'
          : `<select class="input sm" id="snooze" aria-label="Snooze"><option value="">Snooze…</option>${snoozeOptions().map(([l, d]) => `<option value="${d.toISOString()}">${l}</option>`).join('')}</select>`}
        <button class="btn sm" id="video-call">${icon('i-video')}Video call</button>
        <span class="grow"></span>
        <div class="decide">
          ${sel.escalatedTo ? `<span class="st info"><svg class="ico"><use href="#i-alert"/></svg>With engineering · ${esc(sel.escalatedTo)}</span>` : '<button class="btn sm btn-escalate" id="escalate"><svg class="ico"><use href="#i-alert"/></svg>Escalate to engineering</button>'}
          <span class="vr" aria-hidden="true"></span>
          <button class="btn sm btn-close" id="close"><svg class="ico"><use href="#i-done"/></svg>Close conversation</button>
        </div>
      </div>` : ''}
      <div class="ctx">
        ${dueTag(sel)}
        <label class="st calm" for="classify"><svg class="ico"><use href="#i-tag"/></svg>Classification</label>
        ${sel.state === 'open' ? `<select class="input sm" id="classify" title="Correct the classification if it's wrong">
          ${state.meta.classifications.map((k) => { const tool = k.id === 'integration' ? (sel.classification?.tool ?? sel.account.platformErp) : null; return `<option value="${k.id}" ${sel.classification?.id === k.id ? 'selected' : ''}>${esc(k.label)}${tool ? ` · ${esc(tool)}` : ''}</option>`; }).join('')}
        </select>` : `<span class="small">${esc(sel.classificationLabel)}</span>`}
        ${isSnoozed(sel) ? `<span class="chip info">Snoozed until ${new Date(sel.snoozedUntil).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })} (reply target still running)</span>` : ''}
      </div>
      ${aiCard(sel)}
      ${conversationBlock(sel)}
    </div>`;

  // Keep an open account panel in sync with live updates.
  if ($('#drawer').open) openDrawer(drawerHtml(account, sel.id));
  $('#open-snap').addEventListener('click', () => openDrawer(drawerHtml(account, sel.id)));
  bindReplies(view);
  // Closing or snoozing takes it out of the queue, so move on to the next one.
  const after = next ?? prev;
  const moveOn = () => { location.hash = after ? `#/inbox/${after.id}` : '#/inbox'; };
  const act = (btn, path, body, leaves) => run(btn, async () => {
    await api(`/api/conversations/${sel.id}/${path}`, { method: 'POST', body });
    if (leaves) moveOn(); else route({ keepScroll: true });
  });
  $('#classify')?.addEventListener('change', (e) => act(e.target, 'classify', { id: e.target.value }));
  $('#assignee')?.addEventListener('change', (e) => act(e.target, 'assign', { assignee: e.target.value || null }));
  $('#take')?.addEventListener('click', (e) => act(e.currentTarget, 'assign', { assignee: me.name }));
  $('#snooze')?.addEventListener('change', (e) => e.target.value && act(e.target, 'snooze', { until: e.target.value }, true));
  $('#unsnooze')?.addEventListener('click', (e) => act(e.currentTarget, 'snooze', { until: null }));
  $('#escalate')?.addEventListener('click', async (e) => { const btn = e.currentTarget; if (await confirmEscalate()) act(btn, 'escalate'); });
  $('#close')?.addEventListener('click', (e) => { const btn = e.currentTarget; pickCloseReason(sel.suggestedCloseReason, (reason) => act(btn, 'close', { reason }, true)); });
  $('#ai-run')?.addEventListener('click', (e) => act(e.currentTarget, 'ai'));
  // Quick video call: a Meet link goes to the customer as a reply
  $('#video-call')?.addEventListener('click', () => {
    const who = sel.messages.find((m) => m.from === 'customer')?.author ?? 'the customer';
    let link = null;
    formDialog(`<h2>Video call with ${esc(who.split(' ')[0])}</h2>
      <p class="muted small mb-3">Creates a Google Meet link and sends it to ${esc(who)} as your reply.</p>
      <div class="field"><label for="vc-text">Message</label><textarea class="input" id="vc-text" name="text" rows="3" required maxlength="2000">It might be quicker to talk this through. Can you join me on a short video call?</textarea></div>
      <p class="muted xs">The link is added under your message.</p>`,
      'Send the link', async (f) => { link = (await api(`/api/conversations/${sel.id}/call`, { method: 'POST', body: { text: f.text.value } })).link; await route({ keepScroll: true }); });
    $('#modal').addEventListener('close', () => { if (link) setTimeout(() => meetingReady(link, 'Link sent', `${who} got the link in the conversation. Join now and wait for them to hop in.`), 0); }, { once: true });
  });
  $('#ai-use')?.addEventListener('click', () => {
    const ta = $('form.reply textarea');
    ta.value = sel.ai.suggested_reply;
    ta.focus();
    ta.style.height = `${Math.min(ta.scrollHeight + 4, 260)}px`;
  });
}

function bindSimulate() {
  $('#simulate').addEventListener('click', () => openModal(`
    <h2>Simulate a customer message</h2>
    <p class="muted small mb-3">Sends the hub the same notification Intercom sends when a customer writes in.</p>
    <div class="reasons">${INBOUND_SAMPLES.map((x, i) => `<label class="reason"><input type="radio" name="sample" value="${i}" ${i ? '' : 'checked'} required /><span>${esc(x.label)}<span class="muted xs block">“${esc(x.text)}”</span></span></label>`).join('')}</div>`,
    'Send message', (data) => simulateInbound(INBOUND_SAMPLES[data.sample])));
}

// Sends the hub exactly what Intercom sends (conversation.user.created) when a customer writes in.
async function simulateInbound(x) {
  const res = await fetch('/webhooks/intercom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'notification_event', topic: 'conversation.user.created', data: { item: { type: 'conversation', id: String(215470000 + Math.floor(Math.random() * 99999)), source: { body: `<p>${x.text}</p>`, author: { type: 'user', email: x.email } } } } }),
  });
  const r = await res.json();
  if (!res.ok) throw new Error(r.error);
  state.inboxTab = 'unassigned';
  location.hash = `#/inbox/${r.conversationId}`;
}


// ---------- customer success: suggested actions (src/cs.js) ----------
// Same cards as the Pipeline; these open the CS pop-ups below.
const csCard = (a, x) => saCard(a, x, 'cs');
function csCell(a) {
  const list = a.csSuggestions ?? [];
  if (!list.length) return '<span class="muted small">Nothing to do right now</span>';
  const open = state.pfOpen?.has(a.id);
  return `${csCard(a, list[0])}${list.length > 1 ? `<button class="sa-more" data-pfexpand="${esc(a.id)}" aria-expanded="${open}">${open ? 'Hide' : `+${list.length - 1} more`} ${list.length - 1 === 1 ? 'suggestion' : 'suggestions'}</button>` : ''}`;
}
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
// Renewal as a date (like close dates in the Pipeline); amber within 90 days, "in N days" on hover.
const renewalCell = (a) => (a.renewalDate ? `<span class="${a.renewalDays <= 90 ? 'tone-warn' : ''}" title="in ${a.renewalDays} days">${fmtDate(a.renewalDate)}</span>` : '<span class="muted">–</span>');

// One pop-up per kind of CS action, shared by My portfolio, the Health tab and Good morning.
function runCsAction(a, x, after = afterAction) {
  const head = `<div class="muted small">${esc(a.name)}</div><h2 class="mt-1">${esc(x.action)}</h2><p class="small mb-3">${esc(x.detail)}</p>`;
  if (x.cta.kind === 'anomaly') {
    return formDialog(`${head}<div class="field"><label for="an-note">What did you find? <span class="muted xs">(optional, saved to HubSpot)</span></label><textarea class="input" id="an-note" name="note" rows="3" placeholder="e.g. NetSuite credentials expired; their IT is fixing it today."></textarea></div>`,
      'Mark reviewed', (f) => api(`/api/anomalies/${x.cta.anomalyId}/ack`, { method: 'POST', body: { note: f.note.value } }).then(after));
  }
  if (x.cta.kind === 'saveplan') {
    const plan = `1. Exec sponsor call with ${a.contact?.name ?? 'the customer'} this week\n2. Weekly check-in until health is back above 70\n3. Fix the open issues: ${(a.healthReasons ?? []).filter((r) => !r.startsWith('Renewal')).slice(0, 2).join('; ') || 'see the Health tab'}\n4. Align with ${a.owner} (AE) on the renewal`;
    return formDialog(`${head}<div class="field"><label for="sp-text">The plan</label><textarea class="input" id="sp-text" name="text" rows="6" required>${esc(plan)}</textarea></div><p class="muted small">Saved to HubSpot, and ${esc(a.owner)} (AE) gets it in Slack.</p>`,
      'Start the save plan', (f) => api(`/api/accounts/${a.id}/save-plan`, { method: 'POST', body: { text: f.text.value } }).then(after));
  }
  if (x.cta.kind === 'tell') {
    return formDialog(`${head}<p class="muted small">Sends ${esc(a.contact?.name ?? 'the customer')} a message in Intercom and saves a note in HubSpot.</p>`,
      'Send the message', () => api(`/api/feature-requests/${x.cta.frId}/tell`, { method: 'POST', body: { accountId: a.id } }).then(after));
  }
  if (x.cta.kind === 'step') {
    return formDialog(`${head}`, 'Mark done', () => api(`/api/accounts/${a.id}/steps/${x.cta.stepId}`, { method: 'POST' }).then(after));
  }
}
const csSignal = (a, key) => (a.csSuggestions ?? []).find((x) => x.key === key);
function bindCsCards(root, byId) {
  $$('[data-cs]', root).forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const a = byId[b.dataset.cs];
    const x = csSignal(a, b.dataset.sig);
    if (x) runCsAction(a, x);
  }));
}

// ---------- my portfolio (CS) ----------
async function renderPortfolio(query = new URLSearchParams()) {
  const me = user();
  state.pfOpen ??= new Set();
  state.pfScope ??= me.team === 'cs' ? 'mine' : 'team';
  const all = (await api('/api/accounts')).filter((a) => a.status !== 'Prospect');
  const list = all.filter((a) => state.pfScope === 'team' || a.csm === me.name);
  const rank = { high: 0, medium: 1, low: 2 };
  // Highest risk first; within a level, the sooner the renewal and the bigger the ARR, the higher.
  list.sort((x, y) => rank[x.healthLevel] - rank[y.healthLevel] || (x.renewalDays ?? 999) - (y.renewalDays ?? 999) || y.deal.amount - x.deal.amount);
  const atRisk = list.filter((a) => a.healthLevel !== 'low');
  const anoms = list.reduce((n, a) => n + a.anomalies.length, 0);
  const team = state.pfScope === 'team';
  const cols = 6;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>My portfolio</h1><p class="muted">Your accounts, riskiest first, and what each one needs next.</p></div>
      <div class="row">
        <div class="seg seg-inline" role="group" aria-label="Whose accounts">
          <button class="${!team ? 'sel' : ''}" data-scope="mine" aria-pressed="${!team}">Mine</button>
          <button class="${team ? 'sel' : ''}" data-scope="team" aria-pressed="${team}">Team</button>
        </div>
        ${can('anomalies.edit') ? `<button class="btn" data-scan>${icon('i-search')}Check usage now</button>` : ''}
      </div>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="muted small">ARR at risk</div><div class="v num tone-warn">${moneyCompact(atRisk.reduce((n, a) => n + a.deal.amount, 0))}</div><div class="muted xs">${atRisk.length} of ${list.length} accounts</div></div>
      <div class="card kpi"><div class="muted small">High risk</div><div class="v num ${list.some((a) => a.healthLevel === 'high') ? 'tone-bad' : ''}">${list.filter((a) => a.healthLevel === 'high').length}</div></div>
      <div class="card kpi"><div class="muted small">Usage anomalies to review</div><div class="v num ${anoms ? 'tone-warn' : ''}">${anoms}</div></div>
      <div class="card kpi"><div class="muted small">Renewals in 90 days</div><div class="v num">${list.filter((a) => a.renewalDays != null && a.renewalDays <= 90).length}</div></div>
    </div>
    <div class="card table-wrap">
      <table class="table pf-table">
        <thead><tr><th>Account</th><th>Health</th><th>What's going on</th><th class="hide-sm opt-a">Usage (12 wks)</th><th class="hide-sm opt-b">Renewal</th><th>Next suggested action</th></tr></thead>
        <tbody>${list.map((a) => {
          const vol = a.usageSeries ? a.usageSeries.pos.map((v, i) => v + a.usageSeries.invoicesAi[i]) : null;
          return `<tr data-href="#/accounts/${a.id}?tab=health">
            <td data-label="Account"><a class="row-link" href="#/accounts/${a.id}?tab=health">${esc(a.name)}</a> ${segBadge(a.segment)}<div class="muted xs">${esc(a.status)} · ${moneyCompact(a.deal.amount)} ARR${team ? ` · ${esc(a.csm)}` : ''}</div></td>
            <td data-label="Health">${riskChip(a.healthLevel, a.health)}</td>
            <td data-label="What's going on" class="small ${a.csStatus?.tone ? `tone-${a.csStatus.tone}` : ''}">${esc(a.csStatus?.text ?? '')}${a.support.open ? `<div class="muted xs">${a.support.open} open support${a.support.escalated ? ` · ${a.support.escalated} with engineering` : ''}</div>` : ''}</td>
            <td class="hide-sm opt-a"><div class="row gap-2 no-wrap">${vol ? sparkline(vol, { label: 'POs + AI invoices per week', w: 110, h: 30 }) : ''}<span class="small">${trendText(a.usageTrendPct)}</span></div></td>
            <td class="hide-sm opt-b small">${renewalCell(a)}</td>
            <td data-label="Next suggested action" class="pl-next">${csCell(a)}</td>
          </tr>${state.pfOpen.has(a.id) && a.csSuggestions.length > 1 ? `
          <tr class="sa-row"><td colspan="${cols}">
            <div class="sa-row-head">More suggestions for ${esc(a.name)}</div>
            <div class="sa-grid">${a.csSuggestions.slice(1).map((x) => csCard(a, x)).join('')}</div>
          </td></tr>` : ''}`;
        }).join('') || `<tr><td colspan="${cols}" class="empty">No accounts in your portfolio.</td></tr>`}</tbody>
      </table>
    </div>`;
  const byId = Object.fromEntries(all.map((a) => [a.id, a]));
  $$('tbody tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a, button')) location.hash = tr.dataset.href; }));
  $$('[data-scope]').forEach((b) => b.addEventListener('click', () => { state.pfScope = b.dataset.scope; renderPortfolio(); }));
  $$('[data-pfexpand]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = b.dataset.pfexpand;
    if (state.pfOpen.has(id)) state.pfOpen.delete(id); else state.pfOpen.add(id);
    renderPortfolio();
  }));
  bindCsCards(view, byId);
  bindCsActions(view);

  // Deep links from Good morning: #/portfolio?do=saveplan&acct=meridian
  const target = byId[query.get('acct')];
  if (target && query.get('do')) {
    history.replaceState(null, '', '#/portfolio');
    const x = csSignal(target, query.get('do'));
    if (x) runCsAction(target, x);
  }
}

// ---------- feature requests ----------
// One row per account × request, so it's always clear who asked for what.
async function renderRequests() {
  const me = user();
  state.frScope ??= me.team === 'cs' ? 'mine' : 'all';
  state.frStatus ??= 'active';
  state.frGroup ??= 'account';
  const all = await api('/api/feature-requests');
  const rows = all.flatMap((f) => f.accounts
    .filter((r) => state.frScope === 'all' || r.csm === me.name)
    .map((r) => ({ ...r, fr: f })));
  const filters = [
    ['active', 'Open', (x) => !['shipped', 'declined'].includes(x.fr.status)],
    ['shipped', 'Shipped', (x) => x.fr.status === 'shipped'],
    ['declined', 'Declined', (x) => x.fr.status === 'declined'],
    ['all', 'All', () => true],
  ];
  const test = filters.find((x) => x[0] === state.frStatus)[2];
  const list = rows.filter(test);
  const toTell = rows.filter((x) => x.fr.status === 'shipped' && !x.notified);
  const statusOrder = [...FR_FLOW, 'declined'];

  // Build groups: key → { head, rows, sortKey }.
  const groups = new Map();
  for (const x of list) {
    const key = state.frGroup === 'account' ? x.accountId : state.frGroup === 'request' ? x.fr.id : x.fr.status;
    if (!groups.has(key)) groups.set(key, { key, first: x, rows: [] });
    groups.get(key).rows.push(x);
  }
  const ordered = [...groups.values()].sort((a, b) => (state.frGroup === 'status'
    ? statusOrder.indexOf(b.key) - statusOrder.indexOf(a.key)
    : state.frGroup === 'account' ? b.first.arr - a.first.arr : b.first.fr.arr - a.first.fr.arr));
  ordered.forEach((g) => g.rows.sort((a, b) => (state.frGroup === 'request' ? b.arr - a.arr : b.fr.arr - a.fr.arr)));

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const groupHead = (g) => {
    const x = g.first;
    if (state.frGroup === 'account') {
      return `<a class="link" href="#/accounts/${esc(x.accountId)}?tab=requests">${esc(x.name)}</a> ${segBadge(x.segment)}
        <span class="muted xs">${moneyCompact(x.arr)} ARR${state.frScope === 'all' ? ` · CSM ${esc(x.csm)}` : ''} · ${plural(g.rows.length, 'request')}</span>`;
    }
    if (state.frGroup === 'request') {
      return `<b>${esc(x.fr.title)}</b> <span class="mono muted xs">${esc(x.fr.jiraKey)}</span>
        <span class="muted xs">${plural(g.rows.length, 'account')} · ${moneyCompact(g.rows.reduce((n, r) => n + r.arr, 0))} ARR asking</span>`;
    }
    return `<b>${esc(frLabel(g.key))}</b> <span class="muted xs">${plural(g.rows.length, 'request')}</span>`;
  };
  const showAccount = state.frGroup !== 'account';
  const showRequest = state.frGroup !== 'request';
  const showStatus = state.frGroup === 'account'; // other groupings show status in the header
  const cols = 2 + showAccount + showRequest + showStatus;
  const row = (x) => `<tr data-href="#/accounts/${esc(x.accountId)}?tab=requests">
    ${showAccount ? `<td data-label="Account"><a class="link" href="#/accounts/${esc(x.accountId)}?tab=requests">${esc(x.name)}</a> ${segBadge(x.segment)}<div class="muted xs">${moneyCompact(x.arr)} ARR${state.frScope === 'all' ? ` · CSM ${esc(x.csm)}` : ''}</div></td>` : ''}
    ${showRequest ? `<td data-label="Request"><div class="fw-500">${esc(x.fr.title)}</div><div class="row gap-1"><span class="mono muted xs">${esc(x.fr.jiraKey)}</span>${showStatus ? '' : frSimBtn(x.fr)}</div></td>` : ''}
    ${showStatus ? `<td data-label="Status"><div class="row gap-1 no-wrap">${frStatus(x.fr.status)}${frSimBtn(x.fr)}</div><div class="muted xs">Updated ${rel(x.fr.updatedAt)}</div></td>` : ''}
    <td data-label="Asked" class="small">${rel(x.requestedAt)}</td>
    <td data-label="Customer">${frCustomerCell(x.fr, x)}</td>
  </tr>`;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Feature requests</h1><p class="muted">Who asked for what, where it stands in Jira, and who to tell when it ships.</p></div>
      <div class="seg seg-inline" role="group" aria-label="Whose accounts">
        <button class="${state.frScope === 'mine' ? 'sel' : ''}" data-frscope="mine" aria-pressed="${state.frScope === 'mine'}">Mine</button>
        <button class="${state.frScope === 'all' ? 'sel' : ''}" data-frscope="all" aria-pressed="${state.frScope === 'all'}">Team</button>
      </div>
    </div>
    ${toTell.length ? `<div class="card callout"><svg class="ico"><use href="#i-bulb"/></svg><div class="grow"><b>${toTell.length} ${toTell.length === 1 ? 'customer is' : 'customers are'} waiting to hear</b> that their request shipped.</div><button class="btn sm" data-frfilter="shipped">Show shipped</button></div>` : ''}
    <div class="spread fr-toolbar">
      <div class="seg seg-inline" role="group" aria-label="Status">${segButtons('frfilter', filters.map(([id, label, t]) => [id, label, rows.filter(t).length]), state.frStatus)}</div>
      <div class="row gap-2"><span class="muted small">Group by</span>
        <div class="seg seg-inline" role="group" aria-label="Group by">
          ${[['account', 'Account'], ['request', 'Request'], ['status', 'Status']].map(([id, label]) => `<button class="${state.frGroup === id ? 'sel' : ''}" data-frgroup="${id}" aria-pressed="${state.frGroup === id}">${label}</button>`).join('')}
        </div>
      </div>
    </div>
    <div class="card table-wrap">
      <table class="table fr-table">
        <thead><tr>
          ${showAccount ? '<th>Account</th>' : ''}${showRequest ? '<th>Request</th>' : ''}${showStatus ? '<th>Status</th>' : ''}<th>Asked</th><th>Customer</th>
        </tr></thead>
        ${ordered.map((g) => `<tbody>
          <tr class="group-row"><th colspan="${cols}" scope="rowgroup"><div class="row gap-2">${groupHead(g)}${state.frGroup === 'request' ? `<span class="grow"></span>${frStatus(g.first.fr.status)}${frSimBtn(g.first.fr)}` : ''}</div></th></tr>
          ${g.rows.map(row).join('')}
        </tbody>`).join('') || `<tbody><tr><td colspan="${cols}" class="empty">No feature requests here.</td></tr></tbody>`}
      </table>
    </div>`;
  $$('.fr-table tbody tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a, button')) location.hash = tr.dataset.href; }));
  $$('[data-frscope]').forEach((b) => b.addEventListener('click', () => { state.frScope = b.dataset.frscope; renderRequests(); }));
  $$('[data-frgroup]').forEach((b) => b.addEventListener('click', () => { state.frGroup = b.dataset.frgroup; renderRequests(); }));
  $$('[data-frfilter]').forEach((b) => {
    const pick = () => { state.frStatus = b.dataset.frfilter; renderRequests(); };
    b.addEventListener('click', pick);
    b.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()));
  });
  bindCsActions(view);
}

// ---------- onboarding ----------
async function renderOnboarding() {
  const all = (await api('/api/accounts')).filter((a) => a.onboarding);
  state.onbFilter ??= 'active';
  const filters = [
    ['active', 'In progress', (a) => a.status === 'Onboarding'],
    ['live', 'Live', (a) => a.status !== 'Onboarding'],
    ['all', 'All', () => true],
  ];
  const test = filters.find((f) => f[0] === state.onbFilter)[2];
  const list = all.filter(test).sort((x, y) => (x.status === 'Onboarding') === (y.status === 'Onboarding') ? days(y.onboarding.startedAt) - days(x.onboarding.startedAt) : x.status === 'Onboarding' ? -1 : 1);
  const anyActive = all.some((a) => a.status === 'Onboarding');
  const stepCell = (a) => {
    const x = (a.csSuggestions ?? []).find((s) => s.type === 'step');
    if (x && can('onboarding.edit')) return csCard(a, x);
    if (a.onboarding.completedAt) return `<span class="muted small">Live since ${fmtDate(a.onboarding.completedAt)}</span>`;
    return '<span class="muted small">Waiting on usage (ticks itself off)</span>';
  };

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Onboarding</h1><p class="muted">Every hotel group from kickoff to go-live. Usage-based steps tick themselves off.</p></div>
      ${anyActive && can('onboarding.edit') ? `<button class="btn" id="sync-all">${icon('i-reset')}Refresh usage</button>` : ''}
    </div>
    <div class="toolbar"><div class="seg seg-inline" role="group" aria-label="Show">${segButtons('onbf', filters.map(([id, label, t]) => [id, label, all.filter(t).length]), state.onbFilter)}</div></div>
    <div class="card table-wrap">
      <table class="table onb-table">
        <thead><tr><th>Account</th><th>Progress</th><th>Next suggested action</th><th>Timeline</th><th class="center-col">Properties live</th><th class="opt-a">CSM</th></tr></thead>
        <tbody>${list.map((a) => `
          <tr data-href="#/accounts/${esc(a.id)}?tab=overview">
            <td data-label="Account"><a class="row-link" href="#/accounts/${esc(a.id)}?tab=overview">${esc(a.name)}</a> ${segBadge(a.segment)}<div class="muted xs">${esc(a.status)}</div></td>
            <td data-label="Progress"><div class="pips" aria-hidden="true">${Array.from({ length: a.onboarding.total }, (_, i) => `<span class="pip ${i < a.onboarding.done ? 'on' : ''}"></span>`).join('')}</div><div class="small mt-1">${a.onboarding.done}/${a.onboarding.total} steps</div></td>
            <td data-label="Next suggested action" class="pl-next">${stepCell(a)}</td>
            <td data-label="Timeline" class="small">${a.onboarding.completedAt ? `Done in ${days(a.onboarding.startedAt) - days(a.onboarding.completedAt)} days` : `<span class="${days(a.onboarding.startedAt) > 10 ? 'tone-warn' : ''}">Day ${days(a.onboarding.startedAt)}</span>`}</td>
            <td data-label="Properties live" class="num center-col small">${a.usage?.propertiesLive ?? 0}/${a.properties}</td>
            <td data-label="CSM" class="small opt-a">${esc(a.csm)}</td>
          </tr>`).join('') || `<tr><td colspan="6" class="empty">${state.onbFilter === 'active' ? 'Nobody is onboarding right now. Closing a deal starts one automatically.' : 'Nothing here yet.'}</td></tr>`}</tbody>
      </table>
    </div>`;
  const byId = Object.fromEntries(all.map((a) => [a.id, a]));
  $$('.onb-table tbody tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a, button')) location.hash = tr.dataset.href; }));
  $$('[data-onbf]').forEach((c) => {
    const pick = () => { state.onbFilter = c.dataset.onbf; renderOnboarding(); };
    c.addEventListener('click', pick);
    c.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()));
  });
  bindCsCards(view, byId);
  $('#sync-all')?.addEventListener('click', (e) => run(e.currentTarget, async () => {
    await api('/api/onboarding/sync', { method: 'POST' });
    route({ keepScroll: true });
  }));
}

// ---------- approvals ----------
async function renderApprovals() {
  const list = await api('/api/approvals');
  const me = user();
  state.aprFilter ??= 'pending';
  const filters = [
    ['pending', 'Pending', (p) => p.status === 'pending'],
    ['decided', 'Decided', (p) => p.status !== 'pending'],
    ['all', 'All', () => true],
  ];
  const test = filters.find((f) => f[0] === state.aprFilter)[2];
  const rows = list.filter(test).sort((x, y) => (x.status === 'pending') === (y.status === 'pending') ? y.requestedAt.localeCompare(x.requestedAt) : x.status === 'pending' ? -1 : 1);
  const approver = state.meta.users.find((u) => u.approver);
  const net = (p) => p.account.deal.amount * (1 - p.pct / 100);
  const decision = (p) => {
    if (p.status !== 'pending') {
      return `<span class="chip ${p.status === 'approved' ? 'good' : 'bad'}">${icon(p.status === 'approved' ? 'i-done' : 'i-x')}${p.status === 'approved' ? 'Approved' : 'Rejected'}</span>
        <div class="muted xs mt-1">by ${esc(p.decidedBy)} ${p.via === 'slack' ? 'in Slack' : 'in the hub'} · ${rel(p.decidedAt)}</div>`;
    }
    if (can('approvals.decide')) {
      return `<div class="row gap-1 no-wrap"><button class="btn primary sm" data-decide="approved" data-id="${p.id}">Approve</button><button class="btn sm danger" data-decide="rejected" data-id="${p.id}">Reject</button></div>`;
    }
    return `<div class="small">Waiting on ${esc(approver.name)}</div>
      <button class="btn sm ghost apr-sim" data-slack="${p.id}" title="Demo: sends the same payload Slack sends when ${esc(approver.name)} clicks Approve">${icon('i-play')}Approve as ${esc(approver.name.split(' ')[0])} in Slack</button>`;
  };

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Approvals</h1><p class="muted">Discounts above ${state.meta.config.discountApprovalThreshold}% go to <span class="mono">#deal-desk</span> in Slack. ${esc(approver.name)} approves there or here, and HubSpot updates either way.</p></div>
    </div>
    <div class="toolbar"><div class="seg seg-inline" role="group" aria-label="Show">${segButtons('aprf', filters.map(([id, label, t]) => [id, label, list.filter(t).length]), state.aprFilter)}</div></div>
    <div class="card table-wrap">
      <table class="table apr-table">
        <thead><tr><th>Deal</th><th class="num-col">Discount</th><th class="num-col">ARR after discount</th><th>Reason</th><th>Requested</th><th>Decision</th></tr></thead>
        <tbody>${rows.map((p) => `
          <tr data-href="#/accounts/${esc(p.accountId)}">
            <td data-label="Deal"><a class="row-link" href="#/accounts/${esc(p.accountId)}">${esc(p.account.name)}</a> ${segBadge(p.account.segment)}<div class="muted xs">${esc(stageName(p.account.deal.stage))}</div></td>
            <td data-label="Discount" class="num num-col"><b>${p.pct}%</b></td>
            <td data-label="ARR after discount" class="num num-col">${money(net(p))}<div class="muted xs">from ${money(p.account.deal.amount)}</div></td>
            <td data-label="Reason" class="small" title="${esc(p.reason || '')}"><div class="apr-reason">${p.reason ? esc(p.reason) : '<span class="muted">No reason given</span>'}</div></td>
            <td data-label="Requested" class="small">${esc(p.requestedBy)}<div class="muted xs">${rel(p.requestedAt)}</div></td>
            <td data-label="Decision" class="apr-decision">${decision(p)}</td>
          </tr>`).join('') || `<tr><td colspan="6" class="empty">${state.aprFilter === 'pending' ? 'Nothing waiting for approval.' : 'No approvals here yet.'}</td></tr>`}</tbody>
      </table>
    </div>`;

  $$('.apr-table tbody tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a, button')) location.hash = tr.dataset.href; }));
  $$('[data-aprf]').forEach((c) => {
    const pick = () => { state.aprFilter = c.dataset.aprf; renderApprovals(); };
    c.addEventListener('click', pick);
    c.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()));
  });
  $$('[data-decide]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
    await api(`/api/approvals/${b.dataset.id}`, { method: 'POST', body: { decision: b.dataset.decide } });
    route({ keepScroll: true });
  })));
  $$('[data-slack]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
    // Slack interactivity posts form-encoded `payload` JSON
    const payload = { type: 'block_actions', user: { id: 'U0EITAN', name: approver.name }, actions: [{ action_id: 'discount_approve', value: b.dataset.slack }] };
    const res = await fetch('/webhooks/slack', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ payload: JSON.stringify(payload) }) });
    if (!res.ok) throw new Error((await res.json()).error);
    route({ keepScroll: true });
  })));
}

// ---------- activity log ----------
state.openActs = new Set();

async function renderLog(query = new URLSearchParams()) {
  if (query.get('open')) { state.openActs.add(query.get('open')); history.replaceState(null, '', '#/log'); }
  const all = await api('/api/activity');
  const systemsOf = (a) => [...new Set(a.steps.map((x) => x.system))];
  const rows = all.filter((a) => !state.logFilter || systemsOf(a).includes(state.logFilter));
  const toneOf = (a) => (a.failed || a.steps.some((x) => !x.ok) ? 'bad' : a.tone);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Activity log</h1><p class="muted">Everything the hub did for the team, in plain words. Open a row to see each step it took in HubSpot, Intercom, Jira, Slack, Snowflake or Claude.</p></div>
      <div class="seg seg-inline" role="group" aria-label="System">${segButtons('f', [['', 'All', all.length], ...Object.entries(SYSTEMS).map(([k, x]) => [k, x.name, all.filter((a) => systemsOf(a).includes(k)).length]).filter((x) => x[2])], state.logFilter ?? '')}</div>
    </div>
    <div class="card">
      ${rows.map((a) => `
        <details class="act" data-id="${a.id}" ${state.openActs.has(a.id) ? 'open' : ''}>
          <summary>
            <span class="act-ico t-${toneOf(a)}" aria-hidden="true">${icon(a.icon)}</span>
            <span class="grow">
              <span class="act-text">${esc(a.outcome)}</span>
              <span class="muted xs">${esc(a.actor)} · ${rel(a.ts)}${a.steps.length ? ` · ${a.steps.length} ${a.steps.length === 1 ? 'step' : 'steps'}` : ''}</span>
            </span>
            <span class="act-sys hide-sm">${systemsOf(a).map((k) => `<span class="sysdot" style="background:${SYSTEMS[k]?.color}" title="${esc(SYSTEMS[k]?.name)}"></span>`).join('')}</span>
          </summary>
          <ol class="act-steps">
            ${a.steps.map((x) => `
              <li>
                <span class="step-mark ${x.ok ? 'ok' : 'err'}" aria-label="${x.ok ? 'Done' : 'Failed'}">${icon(x.ok ? 'i-done' : 'i-x')}</span>
                <div class="grow">
                  <div><b>${esc(SYSTEMS[x.system]?.name ?? x.system)}</b> · ${esc(x.summary)}</div>
                  <details class="tech"><summary class="xs muted">Technical details</summary>
                    <div class="xs muted mt-2 mb-2">${x.mode === 'live' ? 'Live' : 'Mock mode (nothing left the server)'} · ${x.status} · ${x.durationMs} ms</div>
                    <div class="log-body">
                      <div><div class="muted xs mb-1">Sent</div><pre class="code">${esc(`${x.request.method} ${x.request.url}\n\n${JSON.stringify(x.request.body ?? null, null, 2)}`)}</pre></div>
                      <div><div class="muted xs mb-1">Received</div><pre class="code">${esc(JSON.stringify(x.response, null, 2))}</pre></div>
                    </div>
                  </details>
                </div>
              </li>`).join('') || '<li class="muted small">No outside systems were involved.</li>'}
          </ol>
        </details>`).join('') || '<div class="empty">Nothing yet. Try closing a deal or escalating a conversation.</div>'}
    </div>`;

  $$('details.act').forEach((d) => d.addEventListener('toggle', () => (d.open ? state.openActs.add(d.dataset.id) : state.openActs.delete(d.dataset.id))));
  $$('[data-f]').forEach((c) => {
    const pick = () => { state.logFilter = c.dataset.f || null; renderLog(); };
    c.addEventListener('click', pick);
    c.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()));
  });
}

// ---------- connections ----------
function renderConnections() {
  const origin = location.origin;
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Connections</h1><p class="muted">Systems without credentials run in <b>mock</b> mode: every request is built exactly as the real API expects, but never leaves the server.</p></div>
      <button class="btn danger" id="reset">${icon('i-reset')}Reset demo data</button>
    </div>
    <div class="conn-grid">
      ${state.meta.integrations.map((i) => `
        <div class="card conn">
          <div class="row"><span class="logo" style="background:${SYSTEMS[i.id].color}">${SYSTEMS[i.id].letter}</span>
            <div class="grow"><strong>${esc(i.name)}</strong><div class="muted xs">${esc(i.role)}</div></div>
            <span class="chip ${i.live ? 'good' : 'warn'}">${i.live ? 'Live' : 'Mock'}</span></div>
          <div class="mono muted xs">${i.env.map(esc).join('<br>')}</div>
        </div>`).join('')}
    </div>
    <div class="card card-pad mt-4">
      <h2 class="mb-2">Inbound webhooks</h2>
      <p class="muted small mb-3">Point these at the hub. Signatures are verified when the secrets are set.</p>
      <pre class="code">POST ${esc(origin)}/webhooks/intercom   # Intercom: conversation.user.created, conversation.user.replied
POST ${esc(origin)}/webhooks/slack      # Slack app → Interactivity request URL (approval buttons)
POST ${esc(origin)}/webhooks/jira       # Jira: issue updated (feature request status)</pre>
    </div>`;
  $('#reset').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!(await confirmDialog({ title: 'Reset demo data?', body: '<p class="muted">Every account, conversation and approval goes back to the starting point for everyone using this link.</p>', confirmLabel: 'Reset', danger: true }))) return;
    run(btn, () => api('/api/reset', { method: 'POST' }));
  });
}

// ---------- ops center (admin) ----------
// "What needs fixing right now": one row per check, same table language as the rest of the hub.
// "+N items" opens the items behind a check as cards (like "+N more suggestions"); each links where it's fixed.
const OPS_LEVEL = { bad: { label: 'Needs attention', tone: 'bad' }, warn: { label: 'Worth a look', tone: 'warn' }, ok: { label: 'All clear', tone: 'good' } };
// How long something has been open: "48 min", "3 hours", "12 days"
const ageText = (iso) => { const m = Math.max(1, Math.round((Date.now() - new Date(iso)) / 60000)); return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} ${Math.round(m / 60) === 1 ? 'hour' : 'hours'}` : `${Math.round(m / 1440)} ${Math.round(m / 1440) === 1 ? 'day' : 'days'}`; };
async function renderOps() {
  const d = await api('/api/ops');
  state.opsOpen ??= new Set();
  state.opsView ??= 'open';
  const n = (lvl) => d.checks.filter((c) => c.level === lvl).length;
  const shown = d.checks.filter((c) => state.opsView === 'all' || c.level !== 'ok');
  const groups = [...new Set(d.checks.map((c) => c.group))];
  const live = d.connections.filter((c) => c.live).length;
  const jobText = (j) => `${esc(j.label)}: ${j.lastError ? '<span class="tone-bad">failed</span>' : j.lastRun ? `ran ${relText(j.lastRun)}` : 'starting up'}`;
  // Items reuse the suggestion card: what's wrong, the detail, and an arrow to where it's fixed
  const item = (c, i) => `<${i.href ? `a href="${esc(i.href)}"` : 'div'} class="sa t-${c.level === 'bad' ? 'bad' : 'warn'}">
      <span class="sa-text"><span class="sa-do">${esc(i.text)}</span><span class="sa-why">${esc(i.sub ?? '')}</span></span>
      ${i.href ? '<svg class="ico sa-go" aria-hidden="true"><use href="#i-arrow"/></svg>' : ''}</${i.href ? 'a' : 'div'}>`;
  const row = (c) => {
    const open = state.opsOpen.has(c.id) && c.count;
    const L = OPS_LEVEL[c.level];
    return `<tr class="ops-row l-${c.level}" data-key="ops-${esc(c.id)}">
        <td data-label="Check"><div class="${c.level === 'ok' ? 'muted' : 'fw-600'}">${esc(c.title)}</div><div class="muted xs ops-about">${esc(c.count ? c.about : c.clear)}</div>
          ${c.count ? `<button class="sa-more" data-opsexpand="${esc(c.id)}" aria-expanded="${Boolean(open)}">${open ? 'Hide items' : `+${c.count} ${c.count === 1 ? 'item' : 'items'}`}</button>` : ''}</td>
        <td data-label="Status"><span class="chip ${L.tone}"><span class="dot" aria-hidden="true"></span>${L.label}</span></td>
        <td class="center-col num">${c.count ? `${c.count}<span class="ops-unit"> ${c.count === 1 ? 'item' : 'items'}</span>` : '<span class="muted">–</span>'}</td>
        <td class="hide-sm small ops-age">${c.oldest ? ageText(c.oldest) : '<span class="muted">–</span>'}</td>
        <td class="hide-sm small">${esc(c.owner)}</td>
      </tr>${open ? `<tr class="sa-row"><td colspan="5"><div class="sa-row-head">Items for “${esc(c.title)}”</div><div class="sa-grid">${c.items.map((i) => item(c, i)).join('')}</div></td></tr>` : ''}`;
  };

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Ops center</h1><p class="muted">What needs fixing right now, across the systems and the revenue process. The <a class="link" href="#/log">Activity log</a> shows what already happened.</p></div>
      <div class="seg seg-inline" role="group" aria-label="Show">${segButtons('opsview', [['open', 'Open issues', n('bad') + n('warn')], ['all', 'All checks', d.checks.length]], state.opsView)}</div>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="muted small">Needs attention</div><div class="v num ${n('bad') ? 'tone-bad' : ''}">${n('bad')}</div><div class="muted xs">Broken or blocking now</div></div>
      <div class="card kpi"><div class="muted small">Worth a look</div><div class="v num ${n('warn') ? 'tone-warn' : ''}">${n('warn')}</div><div class="muted xs">Drifting; fix this week</div></div>
      <div class="card kpi"><div class="muted small">All clear</div><div class="v num">${n('ok')} of ${d.checks.length}</div><div class="muted xs">Checks with nothing to fix</div></div>
      <div class="card kpi"><div class="muted small">Connections live</div><div class="v num">${live} of ${d.connections.length}</div><div class="muted xs">${live ? 'The rest run in mock mode' : 'All in mock mode'}</div></div>
    </div>
    <div class="card ops-strip">
      <div class="ops-conns">${d.connections.map((c) => `<a class="ops-conn" href="#/connections" title="${c.lastCallAt ? `Last call ${relText(c.lastCallAt)}` : 'No calls yet'}">${src(c.id, c.name)}<span class="xs ${c.failed24h ? 'tone-bad' : 'muted'}">${c.failed24h ? `${c.failed24h} failed` : c.live ? 'Live' : 'Mock'}</span></a>`).join('')}</div>
      <div class="muted xs ops-jobs">${icon('i-clock', 'inline')}${d.jobs.map(jobText).join(' · ')}</div>
    </div>
    <div class="card table-wrap">
      <table class="table ops-table">
        <thead><tr><th>Check</th><th>Status</th><th class="center-col">Items</th><th class="hide-sm">Oldest</th><th class="hide-sm">Team</th></tr></thead>
        ${groups.map((g) => { const rows = shown.filter((c) => c.group === g); return rows.length ? `<tbody><tr class="group-row"><th colspan="5">${esc(g)}</th></tr>${rows.map(row).join('')}</tbody>` : ''; }).join('')
          || `<tbody><tr><td colspan="5" class="empty">Nothing open. All ${d.checks.length} checks are clear.</td></tr></tbody>`}
      </table>
    </div>`;

  $$('[data-opsview]').forEach((b) => b.addEventListener('click', () => { state.opsView = b.dataset.opsview; renderOps(); }));
  $$('[data-opsexpand]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.opsexpand;
    if (state.opsOpen.has(id)) state.opsOpen.delete(id); else state.opsOpen.add(id);
    renderOps().then(() => $(`[data-opsexpand="${id}"]`)?.focus());
  }));
}

// ---------- modal ----------
function openModal(html, submitLabel, onSubmit) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form method="dialog" novalidate>${html}<div class="form-alert" role="status" hidden></div><p class="form-error" role="alert" hidden></p>
    <div class="dialog-actions">${submitLabel ? `<button class="btn primary" value="ok">${esc(submitLabel)}</button>` : ''}<button class="btn" value="cancel" formnovalidate>${submitLabel ? 'Cancel' : 'Done'}</button></div></form>`;
  const form = $('form', dlg);
  if (submitLabel) markRequired(form);
  form.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    clearErrors(form);
    if (!clientCheck(form)) return;
    const data = Object.fromEntries(new FormData(form));
    run(e.submitter, async () => {
      try { await onSubmit(data); dlg.close(); } catch (x) { showFormError(form, x, {}, e.submitter, submitLabel); }
    });
  });
  dlg.showModal();
  $('input, textarea', dlg)?.focus();
}

function openTour() {
  openModal(`<h2>Demo guide · 8 minutes</h2>
    <ol class="tour">
      <li><b>Good morning.</b> <a class="link" href="#/home">Start here</a>: each role lands on its own to-do list with one-click actions. Switch user (bottom-left) to see how each role's workspace changes; <i>Alex (Admin)</i> sees everything, including the Activity log.</li>
      <li><b>Sales: close a deal.</b> <a class="link" href="#/accounts/harborline">Harborline</a> → <i>Closed won</i>. One click updates HubSpot, tells the team in Slack, opens a Jira epic and starts onboarding.</li>
      <li><b>Deal desk.</b> <a class="link" href="#/accounts/northgate">Northgate</a> → <i>Request discount</i> 20%. Then <a class="link" href="#/approvals">Approvals</a> → <i>Simulate Slack click</i>.</li>
      <li><b>Support.</b> As Ron, open the <a class="link" href="#/inbox">Inbox</a>: queues, the <i>Account snapshot</i>, <i>Summarize &amp; draft reply</i>, then <i>Close</i> with a reason.</li>
      <li><b>Customer Success.</b> As Dana, open <a class="link" href="#/portfolio">My portfolio</a>: accounts by risk. Open Meridian's <i>Health &amp; usage</i> tab, then <i>Check for anomalies</i>, and <a class="link" href="#/requests">Feature requests</a> → <i>Tell the customer</i>.</li>
      <li><b>Onboarding.</b> <a class="link" href="#/onboarding">Onboarding</a> → <i>Refresh usage</i>. Usage-based steps tick themselves off.</li>
      <li><b>Under the hood.</b> The <a class="link" href="#/log">Activity log</a> tells the story of every action in plain words.</li>
    </ol>`, null, null);
  $$('#modal a').forEach((a) => a.addEventListener('click', () => $('#modal').close()));
}

// Promise-based confirmation for irreversible or high-impact actions.
function confirmDialog({ title, body = '', confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#modal');
    dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${body}
      <div class="dialog-actions"><button class="btn ${danger ? 'danger-fill' : 'primary'}" value="ok">${esc(confirmLabel)}</button><button class="btn" value="cancel">Cancel</button></div></form>`;
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
    $('button[value=ok]', dlg).focus();
  });
}

// ---------- help & keyboard shortcuts ----------
const SHORTCUTS = [
  ['Ctrl K', 'Search accounts, conversations and pages'],
  ['/', 'Search'],
  ['G then H', 'Good morning'], ['G then P', 'Pipeline'], ['G then I', 'Inbox'], ['G then M', 'My portfolio'], ['G then O', 'Onboarding'], ['G then R', 'Feature requests'], ['G then A', 'Accounts'], ['G then L', 'Activity log'],
  ['J / K', 'Next / previous conversation (Inbox)'],
  ['Enter', 'Open the highlighted conversation (Inbox)'],
  ['?', 'This help'],
];

function openHelp() {
  openModal(`<h2>Keyboard shortcuts</h2>
    <dl class="shortcuts">${SHORTCUTS.map(([k, d]) => `<dt>${k.split(' ').map((x) => (x === 'then' || x === '/' && k.length > 1 ? `<span class="muted xs">${x}</span>` : `<kbd>${esc(x)}</kbd>`)).join(' ')}</dt><dd>${esc(d)}</dd>`).join('')}</dl>
    <button class="btn sm" type="button" id="help-tour"><svg class="ico"><use href="#i-play"/></svg>Open the demo guide</button>`, null, null);
  $('#help-tour').addEventListener('click', () => { $('#modal').close(); openTour(); });
}

// ---------- user menu ----------
const initials = (name) => name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();

function renderUserChip() {
  const u = user();
  $('#user-avatar').textContent = initials(u.name);
  $('#user-name').textContent = u.name;
  $('#user-role').textContent = u.role;
}

function getTheme() { try { return localStorage.getItem('frontline-hub-theme') || 'system'; } catch { return 'system'; } }
function setTheme(t) {
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { localStorage.setItem('frontline-hub-theme', t); } catch {}
}

function toggleUserMenu(open) {
  const menu = $('#user-menu');
  const btn = $('#user-btn');
  open ??= menu.hidden;
  if (!open) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
  const me = user();
  const theme = getTheme();
  menu.innerHTML = `
    <div class="menu-label">Switch user (demo)</div>
    ${state.meta.users.map((u) => `<button role="menuitemradio" aria-checked="${u.id === me.id}" class="menu-item ${u.id === me.id ? 'sel' : ''}" data-user="${u.id}">
      <span class="avatar sm" aria-hidden="true">${initials(u.name)}</span><span class="grow">${esc(u.name)}<span class="muted xs"> · ${esc(u.role)}</span></span></button>`).join('')}
    <div class="menu-sep"></div>
    <div class="menu-label">Theme</div>
    <div class="seg" role="group" aria-label="Theme">
      ${[['system', 'i-monitor', 'System'], ['light', 'i-sun', 'Light'], ['dark', 'i-moon', 'Dark']].map(([v, i, l]) => `<button class="${theme === v ? 'sel' : ''}" data-theme-set="${v}" aria-pressed="${theme === v}"><svg class="ico"><use href="#${i}"/></svg>${l}</button>`).join('')}
    </div>
    <div class="menu-sep"></div>
    <button role="menuitem" class="menu-item" data-menu="tour"><svg class="ico"><use href="#i-play"/></svg><span class="grow">Demo guide</span></button>
    <button role="menuitem" class="menu-item" data-menu="help"><svg class="ico"><use href="#i-help"/></svg><span class="grow">Keyboard shortcuts</span><kbd>?</kbd></button>
    <button role="menuitem" class="menu-item" data-menu="reset"><svg class="ico"><use href="#i-reset"/></svg><span class="grow">Reset demo data</span></button>`;
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  $('.menu-item', menu).focus();

  $$('[data-user]', menu).forEach((b) => b.addEventListener('click', () => {
    $('#user').value = b.dataset.user;
    $('#user').dispatchEvent(new Event('change'));
    toggleUserMenu(false);
  }));
  $$('[data-theme-set]', menu).forEach((b) => b.addEventListener('click', () => { setTheme(b.dataset.themeSet); toggleUserMenu(true); }));
  $('[data-menu=tour]', menu).addEventListener('click', () => { toggleUserMenu(false); openTour(); });
  $('[data-menu=help]', menu).addEventListener('click', () => { toggleUserMenu(false); openHelp(); });
  $('[data-menu=reset]', menu).addEventListener('click', async () => {
    toggleUserMenu(false);
    if (await confirmDialog({ title: 'Reset demo data?', body: '<p class="muted">Every account, conversation and approval goes back to the starting point for everyone using this link.</p>', confirmLabel: 'Reset', danger: true })) {
      await run(null, () => api('/api/reset', { method: 'POST' }));
    }
  });
}

// ---------- search (command palette) ----------
const PAGES = [
  ['Good morning', '#/home', 'i-sun'], ['Pipeline', '#/pipeline', 'i-board'], ['Approvals', '#/approvals', 'i-check'], ['Inbox', '#/inbox', 'i-inbox'],
  ['My portfolio', '#/portfolio', 'i-heart'], ['Onboarding', '#/onboarding', 'i-flag'], ['Feature requests', '#/requests', 'i-bulb'], ['Accounts', '#/accounts', 'i-building'], ['Activity log', '#/log', 'i-activity'], ['Connections', '#/connections', 'i-plug'],
];

async function openPalette() {
  const dlg = $('#palette');
  if (dlg.open) return;
  const [accounts, convs] = await Promise.all([api('/api/accounts'), can('inbox.work') ? api('/api/inbox') : []]);
  const items = [
    ...PAGES.filter(([, href]) => canSee(href.split('/')[1])).map(([label, href, icon]) => ({ group: 'Pages', label, href, icon, hint: '' })),
    ...accounts.map((a) => ({ group: 'Accounts', label: a.name, href: `#/accounts/${a.id}`, icon: 'i-building', hint: `${a.status} · ${a.segment}`, q: `${a.domain} ${a.contact?.name ?? ''}` })),
    ...convs.filter((c) => c.state === 'open').map((c) => ({ group: 'Open conversations', label: c.subject, href: `#/inbox/${c.id}`, icon: 'i-inbox', hint: c.account.name, q: c.messages.map((m) => m.author).join(' ') })),
  ];
  dlg.innerHTML = `
    <div class="pal-input"><svg class="ico"><use href="#i-search"/></svg><input id="pal-q" placeholder="Search accounts, conversations, pages…" aria-label="Search" autocomplete="off" /><kbd>Esc</kbd></div>
    <div class="pal-list" id="pal-list" role="listbox"></div>`;
  let sel = 0;
  let shown = [];
  const draw = () => {
    const q = $('#pal-q', dlg).value.trim().toLowerCase();
    shown = items.filter((x) => !q || `${x.label} ${x.hint} ${x.q ?? ''}`.toLowerCase().includes(q)).slice(0, 12);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    let group = '';
    $('#pal-list', dlg).innerHTML = shown.map((x, i) => {
      const head = x.group !== group ? `<div class="pal-group">${esc((group = x.group))}</div>` : '';
      return `${head}<a role="option" aria-selected="${i === sel}" class="pal-item ${i === sel ? 'sel' : ''}" href="${esc(x.href)}" data-i="${i}">
        <svg class="ico"><use href="#${x.icon}"/></svg><span class="grow ellipsis">${esc(x.label)}</span><span class="muted xs">${esc(x.hint)}</span></a>`;
    }).join('') || '<div class="empty">No matches.</div>';
    $('.pal-item.sel', dlg)?.scrollIntoView({ block: 'nearest' });
  };
  const go = (x) => { if (!x) return; dlg.close(); location.hash = x.href; };
  $('#pal-q', dlg).addEventListener('input', () => { sel = 0; draw(); });
  $('#pal-q', dlg).addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); draw(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    if (e.key === 'Enter') { e.preventDefault(); go(shown[sel]); }
  });
  $('#pal-list', dlg).addEventListener('click', (e) => { const a = e.target.closest('.pal-item'); if (a) { e.preventDefault(); go(shown[a.dataset.i]); } });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // click outside
  draw();
  dlg.showModal();
  $('#pal-q', dlg).focus();
}

// ---------- keyboard ----------
let gPending = 0;
function onKey(e) {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || $('#modal').open || $('#palette').open || $('#drawer').open) return;
  if (e.key === '/') { e.preventDefault(); openPalette(); return; }
  if (e.key === '?') { e.preventDefault(); openHelp(); return; }
  if (e.key === 'Escape' && !$('#user-menu').hidden) { toggleUserMenu(false); $('#user-btn').focus(); return; }
  if (e.key.toLowerCase() === 'g') { gPending = Date.now(); return; }
  if (Date.now() - gPending < 1200) {
    const dest = { h: '#/home', p: '#/pipeline', i: '#/inbox', o: '#/onboarding', a: '#/accounts', l: '#/log', c: '#/connections', m: '#/portfolio', r: '#/requests' }[e.key.toLowerCase()];
    if (dest && !canSee(dest.split('/')[1])) { gPending = 0; return; }
    gPending = 0;
    if (dest) { location.hash = dest; return; }
  }
  if (location.hash.startsWith('#/inbox/') && (e.key === 'j' || e.key === 'k')) {
    $(e.key === 'j' ? '#next[href]' : '#prev[href]')?.click();
  } else if (/^#\/inbox\/?$/.test(location.hash) && /^[jk]$|^Enter$/.test(e.key)) {
    const rows = $$('.inbox-table tbody tr[data-href]');
    if (!rows.length) return;
    if (e.key === 'Enter') { if (document.activeElement.closest('a, button')) return; if (rows[state.inboxCursor]) location.hash = rows[state.inboxCursor].dataset.href; return; }
    state.inboxCursor = Math.min(Math.max((state.inboxCursor ?? -1) + (e.key === 'j' ? 1 : -1), 0), rows.length - 1);
    rows.forEach((r, i) => r.classList.toggle('cursor', i === state.inboxCursor));
    rows[state.inboxCursor].scrollIntoView({ block: 'nearest' });
  }

}

// ---------- router ----------
// ---------- motion ----------
// Motion only where it tells you something: what's new, what moved, what changed, what's urgent.
// Pages re-render as a whole on every live update, so we compare before/after and animate the difference.
const motion = { busy: false, lastSa: null };
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const replay = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); el.addEventListener('animationend', () => el.classList.remove(cls), { once: true }); };
const KEYED = 'tr[data-href], tr[data-key], .deal[data-deal], .act[data-id], .gm-action[data-key]';
const keyOf = (el) => el.dataset.href ?? el.dataset.deal ?? el.dataset.id ?? el.dataset.key;
const COUNTED = '.kpi .v, .metric .v, .hs-num';
const countKey = (el, i) => `${el.closest('.kpi, .metric')?.firstElementChild?.textContent.trim() ?? 'n'}#${i}`;

function motionSnapshot() {
  const rows = new Map();
  $$(KEYED, view).forEach((el) => rows.set(keyOf(el), el.getBoundingClientRect()));
  const nums = new Map($$(COUNTED, view).map((el, i) => [countKey(el, i), el.textContent.trim()]));
  return { rows, nums, section: lastSection };
}

// After a live re-render: glide moved items into place, slide in new ones, count changed numbers.
function motionAfter(before) {
  if (!before || before.section !== lastSection || calm()) return;
  $$(KEYED, view).forEach((el) => {
    const was = before.rows.get(keyOf(el));
    if (!was) { el.classList.add('m-new'); return; }
    const now = el.getBoundingClientRect();
    const dx = was.left - now.left, dy = was.top - now.top;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  });
  $$(COUNTED, view).forEach((el, i) => {
    const old = before.nums.get(countKey(el, i));
    if (old != null && old !== el.textContent.trim()) countTo(el, old, el.textContent.trim());
  });
}

// "$1.2M" → "$1.4M": counts through the numbers when the unit matches, otherwise just highlights.
function countTo(el, from, to) {
  const parse = (t) => t.match(/^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/);
  const a = parse(from), b = parse(to);
  replay(el, 'm-changed');
  if (!a || !b || a[1] !== b[1] || a[3] !== b[3]) return;
  const x0 = Number(a[2].replace(/,/g, '')), x1 = Number(b[2].replace(/,/g, ''));
  const dec = (b[2].split('.')[1] ?? '').length;
  const t0 = performance.now(), dur = 700;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3;
    el.textContent = `${b[1]}${(x0 + (x1 - x0) * e).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}${b[3]}`;
    if (k < 1) requestAnimationFrame(step); else el.textContent = to;
  };
  requestAnimationFrame(step);
}

// First view of a page: bars fill, progress pips and sparklines draw in. Not on live refreshes.
function enterView() {
  if (calm()) return;
  view.classList.remove('m-enter'); void view.offsetWidth; view.classList.add('m-enter');
  clearTimeout(enterView.t);
  enterView.t = setTimeout(() => view.classList.remove('m-enter'), 1200);
}

// A suggestion you just acted on checks itself off and folds away, then the page refreshes.
document.addEventListener('click', (e) => { const sa = e.target.closest('.sa'); if (sa) motion.lastSa = { el: sa, at: Date.now() }; }, true);
function afterAction() {
  const sa = motion.lastSa;
  motion.lastSa = null;
  if (!sa || !sa.el.isConnected || Date.now() - sa.at > 10 * 60_000 || calm()) return route({ keepScroll: true });
  motion.busy = true; // hold live refreshes until the card has folded away
  // Wait a beat so the dialog has closed and the card is visible again
  setTimeout(() => {
    sa.el.classList.add('sa-done');
    $('.sa-go use', sa.el)?.setAttribute('href', '#i-done');
    setTimeout(() => { motion.busy = false; route({ keepScroll: true }); }, 650);
  }, 60);
}

// Dragging a deal: the card you hold is a lifted, slightly tilted copy.
function liftGhost(card, e) {
  if (calm() || !e.dataTransfer.setDragImage) return;
  const r = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.style.width = `${r.width}px`;
  document.body.append(ghost);
  e.dataTransfer.setDragImage(ghost, e.clientX - r.left, e.clientY - r.top);
  setTimeout(() => ghost.remove(), 0);
}

const TITLES = { home: 'Good morning', pipeline: 'Pipeline', approvals: 'Approvals', inbox: 'Inbox', onboarding: 'Onboarding', portfolio: 'My portfolio', requests: 'Feature requests', accounts: 'Accounts', ops: 'Ops center', log: 'Activity log', connections: 'Connections' };
let lastSection = null;

// A friendly stop for links to areas outside your role.
function renderNoAccess(section) {
  view.innerHTML = `<div class="card empty-state no-access">
    ${icon('i-flag')}
    <h2>${esc(TITLES[section] ?? 'This page')} isn't part of your workspace</h2>
    <p class="muted">You're signed in as ${esc(user().name)} (${esc(user().role)}). Ask an admin if you need access.</p>
    <a class="btn primary" href="#/home">Go to your Good morning</a></div>`;
}

async function route({ keepScroll = false } = {}) {
  const [path, qs = ''] = (location.hash || '#/home').split('?');
  const [, section = 'home', id] = path.split('/');
  const query = new URLSearchParams(qs);
  const nav = section === 'accounts' && id ? 'accounts' : section;
  $$('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === nav;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.title = `${TITLES[section] ?? 'Frontline Hub'} · Frontline Hub`;
  const y = scrollY;
  const navigated = !keepScroll && lastSection !== `${section}/${id ?? ''}`;
  lastSection = `${section}/${id ?? ''}`;
  // Show a skeleton only if loading is noticeable, so fast pages don't flicker.
  const before = navigated ? null : motionSnapshot();
  const skel = navigated ? setTimeout(() => { view.innerHTML = SKELETON; }, 150) : null;
  try {
    if (!canSee(section)) renderNoAccess(section);
    else if (section === 'home') await renderHome();
    else if (section === 'accounts' && id) await renderAccount(id, query);
    else if (section === 'accounts') await renderAccounts();
    else if (section === 'inbox') await renderInbox(id);
    else if (section === 'onboarding') await renderOnboarding();
    else if (section === 'portfolio') await renderPortfolio(query);
    else if (section === 'requests') await renderRequests();
    else if (section === 'approvals') await renderApprovals();
    else if (section === 'log') await renderLog(query);
    else if (section === 'ops') await renderOps();
    else if (section === 'connections') renderConnections();
    else if (section === 'pipeline') await renderPipeline(query);
    else await renderHome();
  } catch (err) {
    view.innerHTML = `<div class="card empty-state"><h2>Couldn't load this page</h2><p class="muted">${esc(err.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
  } finally {
    clearTimeout(skel);
  }
  if (keepScroll) scrollTo(0, y);
  else if (navigated) { scrollTo(0, 0); view.focus({ preventScroll: true }); }
  if (navigated) enterView(); else motionAfter(before);
  tickDue();
}

const SKELETON = `<div class="skel" aria-busy="true" aria-label="Loading"><div class="sk sk-title"></div><div class="sk sk-line"></div>
  <div class="kpis">${'<div class="sk sk-card"></div>'.repeat(4)}</div><div class="sk sk-block"></div></div>`;

async function init() {
  state.meta = await fetch('/api/meta').then((r) => r.json());
  const sel = $('#user');
  sel.innerHTML = state.meta.users.map((u) => `<option value="${u.id}">${esc(u.name)} · ${esc(u.role)}</option>`).join('');
  try { const saved = localStorage.getItem('frontline-hub-user'); if (saved && state.meta.users.some((u) => u.id === saved)) sel.value = saved; } catch {}
  sel.addEventListener('change', () => {
    try { localStorage.setItem('frontline-hub-user', sel.value); } catch {}
    renderUserChip(); applyNav(); refreshBadges();
    // Switching role: land on their Good morning rather than a page they can't use
    if (!canSee((location.hash.split('/')[1] ?? 'home').split('?')[0])) location.hash = '#/home'; else route({ keepScroll: true });
  });
  renderUserChip();
  applyNav();
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) $('#kbd-k').textContent = 'Ctrl K'; else $('#kbd-k').textContent = '⌘K';

  $('#user-btn').addEventListener('click', () => toggleUserMenu());
  document.addEventListener('click', (e) => { if (!$('#user-menu').hidden && !e.target.closest('.sidebar-foot')) toggleUserMenu(false); });
  $('#search-btn').addEventListener('click', openPalette);
  document.addEventListener('keydown', onKey);
  $('#drawer').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }); // backdrop
  addEventListener('hashchange', () => { route(); });
  setInterval(tickDue, 15_000); // reply-due countdowns tick in place
  setInterval(() => { if (/^#\/inbox\/?$/.test(location.hash)) scheduleRender(); }, 60_000); // and the queue re-sorts each minute
  connectEvents();
  refreshBadges();
  await route();
}

init();
