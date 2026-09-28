// Slack Web API. Docs: https://api.slack.com/methods
import { send } from './http.js';

const BASE = 'https://slack.com/api';
export const isLive = () => Boolean(process.env.SLACK_BOT_TOKEN);
const auth = () => ({ Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` });

// Channel IDs are preferred in production; names keep the demo readable.
export const channels = () => ({
  deals: process.env.SLACK_CHANNEL_DEALS || '#deals',
  support: process.env.SLACK_CHANNEL_SUPPORT || '#support-escalations',
  dealDesk: process.env.SLACK_CHANNEL_DEAL_DESK || '#deal-desk',
});

const fakeTs = () => `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;

// `where` is a readable channel name for the activity log when `channel` is an ID.
export function postMessage(channel, text, blocks, action = 'Post message', where = channel) {
  return send({
    system: 'slack',
    action: `${action} → ${where}`,
    summary: `Posted in ${where}: “${text}”`,
    method: 'POST',
    url: `${BASE}/chat.postMessage`,
    headers: auth(),
    body: { channel, text, ...(blocks ? { blocks } : {}) },
    live: isLive(),
    mockResponse: () => ({ ok: true, channel: channel.startsWith('#') ? 'C0' + Math.random().toString(36).slice(2, 10).toUpperCase() : channel, ts: fakeTs() }),
  });
}

// Direct message to a person (e.g. the account's CSM).
// Demo safety: with SLACK_DM_USER_ID set, every DM goes to that one person instead, labelled with who it was for,
// so the sample team's made-up Slack IDs are never messaged.
export const dmRedirect = () => process.env.SLACK_DM_USER_ID || null;
export function dm(slackId, name, text, blocks) {
  const to = isLive() && dmRedirect() ? dmRedirect() : slackId;
  const label = to !== slackId ? [context(`:bust_in_silhouette: For *${name}* (demo: all DMs come to you)`)] : [];
  return postMessage(to, to !== slackId ? `For ${name}: ${text}` : text, blocks ? [...label, ...blocks] : label, 'Direct message', `a DM to ${name}`);
}

export function updateMessage(channel, ts, text, blocks) {
  return send({
    system: 'slack',
    action: 'Update message',
    summary: `Updated the Slack message: “${text}”`,
    method: 'POST',
    url: `${BASE}/chat.update`,
    headers: auth(),
    body: { channel, ts, text, ...(blocks ? { blocks } : {}) },
    live: isLive(),
    mockResponse: { ok: true, channel, ts },
  });
}

// A channel name can already exist (e.g. from an earlier demo run); then try a numbered one.
// The new channel is shared with SLACK_DM_USER_ID, so you see onboarding channels the hub creates.
export async function createChannel(name) {
  let entry = await createChannelOnce(name);
  for (let n = 2; isLive() && !entry.ok && entry.response?.error === 'name_taken' && n <= 5; n++) entry = await createChannelOnce(`${name}-${n}`);
  if (entry.ok && isLive() && dmRedirect()) await invite(entry.response.channel.id, dmRedirect(), entry.response.channel.name);
  return entry;
}

function invite(channel, user, name) {
  return send({
    system: 'slack', action: `Add you to #${name}`, summary: `Added you to #${name}`,
    method: 'POST', url: `${BASE}/conversations.invite`, headers: auth(), body: { channel, users: user },
    live: isLive(), mockResponse: { ok: true },
  });
}

// "Test connection" on the Connections page
export const authTest = () => send({
  system: 'slack', action: 'Check connection', summary: 'Checked the Slack connection',
  method: 'POST', url: `${BASE}/auth.test`, headers: auth(), body: {},
  live: isLive(), mockResponse: { ok: true, team: 'Demo', user: 'frontline-hub' },
});

function createChannelOnce(name) {
  return send({
    system: 'slack',
    action: `Create channel #${name}`,
    summary: `Created the Slack channel #${name}`,
    method: 'POST',
    url: `${BASE}/conversations.create`,
    headers: auth(),
    body: { name, is_private: false },
    live: isLive(),
    mockResponse: () => ({ ok: true, channel: { id: 'C0' + Math.random().toString(36).slice(2, 10).toUpperCase(), name } }),
  });
}

// Block Kit helpers
export const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
export const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
export const buttons = (items) => ({
  type: 'actions',
  elements: items.map((b) => ({ type: 'button', text: { type: 'plain_text', text: b.text }, action_id: b.actionId, value: b.value, ...(b.style ? { style: b.style } : {}) })),
});
