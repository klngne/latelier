import { Rest } from 'ably';

let client;

export function realtimeEnabled() {
  return Boolean(process.env.ABLY_API_KEY);
}

export async function issueProjectToken(userId, projectId) {
  if (!process.env.ABLY_API_KEY) throw new Error('Les sockets ne sont pas configurés.');
  client ||= new Rest({ key: process.env.ABLY_API_KEY });
  return client.auth.createTokenRequest({
    clientId: String(userId),
    capability: { [`project:${projectId}`]: ['subscribe'] },
    ttl: 10 * 60 * 1000,
  });
}

export async function publishProjectChange(projectId, event) {
  if (!process.env.ABLY_API_KEY) return;
  try {
    client ||= new Rest({ key: process.env.ABLY_API_KEY });
    await client.channels.get(`project:${projectId}`).publish('project-change', event);
  } catch (error) {
    // Database writes are authoritative; realtime delivery failures fall back to polling.
    console.error('[realtime] Publication échouée', error?.message || error);
  }
}
