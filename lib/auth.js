import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, now } from './db.js';

export const SESSION_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-latelier_session' : 'latelier_session';
export const PROJECT_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-latelier_project' : 'latelier_project';
const SESSION_DAYS = 14;
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export function verifyPassword(password, encoded) {
  if (!encoded) return false;
  const [algorithm, saltHex, hashHex] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createSession(memberId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.prepare('INSERT INTO sessions(member_id,token_hash,expires_at,created_at) VALUES(?,?,?,?)')
    .run(memberId, tokenHash(token), expiresAt, now());
  return { token, expiresAt };
}

export function revokeSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
}

export function revokeMemberSessions(memberId) {
  db.prepare('DELETE FROM sessions WHERE member_id=?').run(memberId);
}

export function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT m.id,m.name,m.initials,m.tone,m.email,m.role,m.active,s.expires_at
    FROM sessions s JOIN members m ON m.id=s.member_id WHERE s.token_hash=?`).get(tokenHash(token));
  if (!row || !row.active || row.expires_at < now()) {
    if (row) revokeSession(token);
    return null;
  }
  return { id: row.id, name: row.name, initials: row.initials, tone: row.tone, email: row.email, role: row.role };
}

export function requestToken(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const entry = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!entry) return null;
  try { return decodeURIComponent(entry.slice(SESSION_COOKIE.length + 1)); }
  catch { return null; }
}

export function requestProjectId(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const entry = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${PROJECT_COOKIE}=`));
  if (!entry) return null;
  const value = Number(decodeURIComponent(entry.slice(PROJECT_COOKIE.length + 1)));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function projectForUser(memberId, preferredId = null) {
  const row = preferredId && db.prepare(`SELECT p.id,p.name,pm.role FROM projects p JOIN project_members pm ON pm.project_id=p.id WHERE pm.member_id=? AND p.id=?`).get(memberId, preferredId);
  return row || db.prepare(`SELECT p.id,p.name,pm.role FROM projects p JOIN project_members pm ON pm.project_id=p.id WHERE pm.member_id=? ORDER BY p.id LIMIT 1`).get(memberId) || null;
}

export function getRequestUser(request) {
  return userFromToken(requestToken(request));
}

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  };
}

export function originIsAllowed(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() || new URL(request.url).protocol.replace(':', '');
    const host = request.headers.get('x-forwarded-host')?.split(',')[0].trim() || request.headers.get('host') || new URL(request.url).host;
    return new URL(origin).origin === `${protocol}://${host}`;
  }
  catch { return false; }
}
