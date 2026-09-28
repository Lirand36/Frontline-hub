// Slack live, against a fake Slack (no network): DMs only ever reach SLACK_DM_USER_ID.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SLACK_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_DM_USER_ID = 'UME';

const calls = [];
let failPosts = null; // set to a Slack error code to make chat.postMessage fail
let taken = new Set(['onb-harborline']);
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(String(url)).pathname;
  const body = init.body ? JSON.parse(init.body) : {};
  calls.push({ path, body });
  const json = (x) => new Response(JSON.stringify(x));
  if (path === '/api/conversations.create') return json(taken.has(body.name) ? { ok: false, error: 'name_taken' } : { ok: true, channel: { id: 'CNEW', name: body.name } });
  if (path === '/api/auth.test') return json({ ok: true, team: 'Acme', user: 'frontline-hub' });
  if (failPosts && path === '/api/chat.postMessage') return json({ ok: false, error: failPosts });
  return json({ ok: true, channel: body.channel, ts: '1.1' });
};

const slack = await import('../src/connectors/slack.js');
const { USERS, PEOPLE } = await import('../src/store.js');
const { dealSignals } = await import('../src/deals.js'); // loads the rest of the app's modules too

test('every DM goes to SLACK_DM_USER_ID, labelled with who it was for', async () => {
  const people = [...USERS.filter((u) => u.slackId), ...PEOPLE.solutionsEngineers, PEOPLE.vpSupport];
  for (const p of people) await slack.dm(p.slackId, p.name, 'Hello', [slack.section('x')]);
  const dms = calls.filter((c) => c.path === '/api/chat.postMessage');
  assert.equal(dms.length, people.length);
  for (const [i, m] of dms.entries()) {
    assert.equal(m.body.channel, 'UME', 'no made-up Slack ID is ever messaged');
    assert.match(m.body.text, new RegExp(`^For ${people[i].name.replace('.', '\\.')}:`));
    assert.match(JSON.stringify(m.body.blocks[0]), /demo: all DMs come to you/);
  }
});

test('a DM without blocks still carries the label', async () => {
  await slack.dm('U04MAYAK', 'Maya K.', 'Plain text');
  const m = calls.filter((c) => c.path === '/api/chat.postMessage').at(-1).body;
  assert.equal(m.channel, 'UME');
  assert.equal(m.blocks.length, 1);
});

test('a taken channel name gets a number, and you are added to the new channel', async () => {
  const r = await slack.createChannel('onb-harborline');
  assert.equal(r.ok, true);
  assert.equal(r.response.channel.name, 'onb-harborline-2');
  const inv = calls.find((c) => c.path === '/api/conversations.invite');
  assert.deepEqual(inv.body, { channel: 'CNEW', users: 'UME' });
});

test('channel posts go to the configured channel, not to you', async () => {
  await slack.postMessage(slack.channels().deals, 'We won', []);
  assert.equal(calls.at(-1).body.channel, '#deals');
});

test('connection test reads the workspace', async () => {
  const r = await slack.authTest();
  assert.equal(r.ok, true);
  assert.equal(r.response.team, 'Acme');
  assert.ok(typeof dealSignals === 'function');
});

test('when Slack refuses, the person sees why (not just "didn\'t respond")', async () => {
  const svc = await import('../src/services.js');
  failPosts = 'channel_not_found';
  await assert.rejects(
    svc.requestMoveBack('lakeview', { to: 'appointmentscheduled', reason: 'Moved by mistake' }, 'Maya K.'),
    (err) => err.status === 502 && /Slack said “channel_not_found”: the channel or member ID doesn't exist/.test(err.message),
  );
  failPosts = null;
  const r = await svc.requestMoveBack('lakeview', { to: 'appointmentscheduled', reason: 'Moved by mistake' }, 'Maya K.');
  assert.equal(r.request.status, 'pending');
  const dmToAdmin = calls.filter((c) => c.path === '/api/chat.postMessage').at(-1).body;
  assert.equal(dmToAdmin.channel, 'UME', 'the admin DM is redirected to you');
  assert.match(dmToAdmin.text, /^For Alex M\.: Move-back request: Lakeview Lodges/);
});

test('the admin DM has Move it back / Decline buttons, and a click in Slack decides and updates the message', async () => {
  const svc = await import('../src/services.js');
  const { db } = await import('../src/store.js');
  const r = await svc.requestMoveBack('northgate', { to: 'appointmentscheduled', reason: 'Deal details were wrong' }, 'Maya K.');
  const dm = calls.filter((c) => c.path === '/api/chat.postMessage').at(-1).body;
  const buttons = dm.blocks.find((b) => b.type === 'actions').elements;
  assert.deepEqual(buttons.map((b) => b.action_id), ['moveback_approve', 'moveback_decline']);
  assert.equal(buttons[0].value, r.request.id);
  assert.ok(r.request.slack?.ts, 'the Slack message is remembered so it can be updated');

  await svc.decideMoveBack(r.request.id, 'approved', 'Alex M.', 'slack');
  assert.equal(db.accounts.find((a) => a.id === 'northgate').deal.stage, 'appointmentscheduled');
  const upd = calls.filter((c) => c.path === '/api/chat.update').at(-1).body;
  assert.equal(upd.ts, r.request.slack.ts);
  assert.match(JSON.stringify(upd.blocks), /moved back to Discovery by Alex M\./);
  assert.ok(!JSON.stringify(upd.blocks).includes('moveback_approve'), 'buttons are gone after the decision');
});
