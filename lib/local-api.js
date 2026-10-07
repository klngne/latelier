import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { NextResponse } from 'next/server';
import { assertProductionConfig, dataDir, db, now, passwordHash } from './db.js';
import { cookieOptions, createSession, getRequestUser, originIsAllowed, projectForUser, requestProjectId, requestToken, revokeMemberSessions, revokeSession, SESSION_COOKIE, PROJECT_COOKIE, verifyPassword } from './auth.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || 'M';
const safeUser = (row) => ({ id: row.id, name: row.name, initials: row.initials, tone: row.tone || '', email: row.email, role: row.role });
const memberRows = (sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r, author: r.name, initials: r.member_initials, tone: r.tone || '' }));
const requireUser = (req) => { const u = getRequestUser(req); if (!u) throw new HttpError(401, 'Connectez-vous pour continuer.'); return u; };
const requireProject = (req, user) => { const p = projectForUser(user.id, requestProjectId(req)); if (!p) throw new HttpError(403, 'Aucun projet accessible pour ce compte.'); return p; };
async function readLimited(req, limit) {
  if (Number(req.headers.get('content-length') || 0) > limit) throw new HttpError(413, 'Requête trop volumineuse.');
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader(), chunks = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Requête trop volumineuse.'); } chunks.push(Buffer.from(value)); }
  return Buffer.concat(chunks, size);
}
async function readJson(req) { try { return JSON.parse((await readLimited(req, 1_000_000)).toString() || '{}'); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'Corps JSON invalide.'); } }
function sessionResponse(user, token, projectId, status = 200) {
  const response = json({ user, project_id: projectId }, status);
  response.cookies.set(SESSION_COOKIE, token, cookieOptions());
  if (projectId) response.cookies.set(PROJECT_COOKIE, String(projectId), cookieOptions());
  return response;
}
function rateLimit(req, identity, label = 'login') {
  const address = req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  const key = hash(`${label}:${address.toLowerCase()}:${identity}`), row = db.prepare('SELECT count,window_started FROM login_attempts WHERE attempt_key=?').get(key), ms = Date.now();
  db.prepare('DELETE FROM login_attempts WHERE window_started < ?').run(ms - 86400_000);
  if (row && ms - row.window_started < 15 * 60_000 && row.count >= 8) throw new HttpError(429, 'Trop de tentatives. Réessayez dans 15 minutes.');
  if (!row || ms - row.window_started >= 15 * 60_000) db.prepare('INSERT OR REPLACE INTO login_attempts(attempt_key,count,window_started) VALUES(?,?,0)').run(key, ms);
  db.prepare('UPDATE login_attempts SET count=count+1 WHERE attempt_key=?').run(key);
}
function projectName(input) { const name = String(input || '').trim().slice(0, 80); if (name.length < 2) throw new HttpError(400, 'Le nom du projet doit contenir au moins 2 caractères.'); return name; }

async function dispatch(req, method) {
  assertProductionConfig(); const url = new URL(req.url), parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent), key = parts.join('/');
  if (method !== 'GET' && !originIsAllowed(req)) throw new HttpError(403, 'Origine de requête refusée.');
  if (method === 'GET' && key === 'health') { db.prepare('SELECT 1').get(); return json({ ok: true, database: 'sqlite' }); }
  if (method === 'POST' && key === 'auth/login') {
    const b = await readJson(req), email = String(b.email || '').trim().toLowerCase(), password = String(b.password || '');
    if (!email || !password || email.length > 254 || password.length > 1024) throw new HttpError(400, 'Saisissez votre adresse e-mail et votre mot de passe.');
    const attemptKey = rateLimit(req, email); const account = db.prepare('SELECT * FROM members WHERE lower(email)=? AND active=1').get(email);
    if (!account || !verifyPassword(password, account.password_hash)) throw new HttpError(401, 'Adresse e-mail ou mot de passe incorrect.');
    db.prepare('DELETE FROM login_attempts WHERE attempt_key=?').run(attemptKey);
    const project = projectForUser(account.id); if (!project) throw new HttpError(403, 'Ce compte ne fait partie d’aucun projet.');
    const session = createSession(account.id); return sessionResponse(safeUser(account), session.token, project.id);
  }
  if (method === 'POST' && key === 'auth/register') {
    const b = await readJson(req), token = String(b.token || ''), name = String(b.name || '').trim().slice(0, 100), password = String(b.password || '');
    const email = String(b.email || '').trim().toLowerCase();
    if (name.length < 2) throw new HttpError(400, 'Saisissez votre nom.');
    if (password.length < 12 || password.length > 1024) throw new HttpError(400, 'Choisissez un mot de passe de 12 caractères minimum.');
    let member, projectId;
    if (token) {
      const invite = db.prepare("SELECT * FROM invites WHERE token_hash=? AND status='En attente' AND expires_at>? AND project_id IS NOT NULL").get(hash(token), now());
      if (!invite) throw new HttpError(410, 'Ce lien d’invitation est invalide ou expiré.');
      const existing = db.prepare('SELECT * FROM members WHERE lower(email)=?').get(invite.email.toLowerCase());
      if (existing && (!existing.active || !verifyPassword(password, existing.password_hash))) throw new HttpError(401, 'Un compte existe déjà avec cette adresse. Saisissez son mot de passe actuel pour rejoindre le projet.');
      const result = db.transaction(() => {
        const id = existing?.id || db.prepare("INSERT INTO members(name,initials,tone,email,password_hash,role,active) VALUES(?,?, '',?,?, 'member',1)").run(name, initials(name), invite.email.toLowerCase(), passwordHash(password)).lastInsertRowid;
        db.prepare("INSERT OR IGNORE INTO project_members(project_id,member_id,role,joined_at) VALUES(?,?,'member',?)").run(invite.project_id, id, now());
        db.prepare("UPDATE invites SET status='Acceptée',accepted_at=? WHERE id=?").run(now(), invite.id);
        return db.prepare('SELECT * FROM members WHERE id=?').get(id);
      })(); member = result; projectId = invite.project_id;
    } else {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Adresse e-mail invalide.');
      rateLimit(req, email, 'register');
      const nameOfProject = projectName(b.project_name);
      if (db.prepare('SELECT 1 FROM members WHERE lower(email)=?').get(email)) throw new HttpError(409, 'Un compte existe déjà avec cette adresse.');
      const created = db.transaction(() => {
        const id = db.prepare("INSERT INTO members(name,initials,tone,email,password_hash,role,active) VALUES(?,?, '',?,?, 'member',1)").run(name, initials(name), email, passwordHash(password)).lastInsertRowid;
        const pid = db.prepare('INSERT INTO projects(name,created_by,created_at) VALUES(?,?,?)').run(nameOfProject, id, now()).lastInsertRowid;
        db.prepare("INSERT INTO project_members(project_id,member_id,role,joined_at) VALUES(?,?,'admin',?)").run(pid, id, now());
        return { member: db.prepare('SELECT * FROM members WHERE id=?').get(id), projectId: pid };
      })(); member = created.member; projectId = created.projectId;
    }
    const session = createSession(member.id); return sessionResponse(safeUser(member), session.token, projectId, 201);
  }
  if (method === 'POST' && key === 'auth/logout') {
    revokeSession(requestToken(req)); const response = json({ ok: true });
    for (const name of [SESSION_COOKIE, PROJECT_COOKIE]) response.cookies.set(name, '', { ...cookieOptions(), maxAge: 0 }); return response;
  }
  if (method === 'POST' && key === 'auth/password') {
    const u = requireUser(req), b = await readJson(req), account = db.prepare('SELECT password_hash FROM members WHERE id=?').get(u.id), next = String(b.new_password || '');
    if (!verifyPassword(String(b.current_password || ''), account.password_hash)) throw new HttpError(401, 'Mot de passe actuel incorrect.');
    if (next.length < 12 || next.length > 1024) throw new HttpError(400, 'Le nouveau mot de passe doit contenir au moins 12 caractères.');
    const session = db.transaction(() => { db.prepare('UPDATE members SET password_hash=? WHERE id=?').run(passwordHash(next), u.id); revokeMemberSessions(u.id); return createSession(u.id); })();
    return sessionResponse(u, session.token, requestProjectId(req));
  }
  if (method === 'GET' && key === 'auth/me') return json({ user: getRequestUser(req) });
  if (key === 'projects' && method === 'GET') {
    const u = requireUser(req), projects = db.prepare('SELECT p.id,p.name,pm.role FROM projects p JOIN project_members pm ON pm.project_id=p.id WHERE pm.member_id=? ORDER BY p.id').all(u.id);
    return json({ projects, selected_project_id: projectForUser(u.id, requestProjectId(req))?.id || null });
  }
  if (key === 'projects' && method === 'POST') {
    const u = requireUser(req), name = projectName((await readJson(req)).name);
    const created = db.transaction(() => { const id = db.prepare('INSERT INTO projects(name,created_by,created_at) VALUES(?,?,?)').run(name, u.id, now()).lastInsertRowid; db.prepare("INSERT INTO project_members(project_id,member_id,role,joined_at) VALUES(?,?,'admin',?)").run(id, u.id, now()); return { id, name, role: 'admin' }; })();
    const response = json({ project: created }, 201); response.cookies.set(PROJECT_COOKIE, String(created.id), cookieOptions()); return response;
  }
  if (key === 'projects/select' && method === 'POST') {
    const u = requireUser(req), id = Number((await readJson(req)).project_id), project = projectForUser(u.id, id);
    if (!project) throw new HttpError(404, 'Projet inaccessible.');
    const response = json({ project }); response.cookies.set(PROJECT_COOKIE, String(project.id), cookieOptions()); return response;
  }
  if (method === 'GET' && parts[0] === 'files' && parts[1]) {
    const u = requireUser(req), p = requireProject(req, u), name = basename(parts[1]);
    if (!db.prepare('SELECT 1 FROM project_files WHERE file_path=? AND project_id=?').get(name, p.id)) throw new HttpError(404, 'Fichier introuvable.');
    try { const data = await readFile(join(dataDir, 'uploads', name)), ext = extname(name).toLowerCase(), type = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : ['.jpg','.jpeg'].includes(ext) ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'application/octet-stream'; return new Response(data, { headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name.replace(/["\\\r\n]/g, '_')}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } }); } catch { throw new HttpError(404, 'Fichier introuvable.'); }
  }
  const u = requireUser(req), p = requireProject(req, u), pid = p.id;
  if (method === 'GET' && key === 'messages') return json(memberRows('SELECT x.*,m.name,m.initials AS member_initials,m.tone FROM messages x JOIN members m ON m.id=x.member_id JOIN project_members pm ON pm.member_id=m.id AND pm.project_id=x.project_id WHERE x.project_id=? AND m.active=1 ORDER BY x.id', pid));
  if (method === 'GET' && key === 'deliveries') return json(memberRows('SELECT x.*,m.name,m.initials AS member_initials,m.tone FROM deliveries x JOIN members m ON m.id=x.member_id WHERE x.project_id=? AND m.active=1 ORDER BY x.id DESC', pid));
  if (method === 'GET' && key === 'tasks') return json(db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY id DESC').all(pid));
  if (method === 'GET' && key === 'events') return json(db.prepare('SELECT * FROM events WHERE project_id=? ORDER BY date,time,id').all(pid));
  if (method === 'GET' && key === 'members') return json(db.prepare('SELECT m.id,m.name,m.initials,m.tone,m.email,pm.role FROM members m JOIN project_members pm ON pm.member_id=m.id WHERE pm.project_id=? AND m.active=1 ORDER BY m.id').all(pid));
  if (method === 'GET' && key === 'summary') return json({ messages: memberRows('SELECT x.*,m.name,m.initials AS member_initials,m.tone FROM messages x JOIN members m ON m.id=x.member_id WHERE x.project_id=? AND m.active=1 ORDER BY x.id DESC LIMIT 4', pid).reverse(), actions: db.prepare('SELECT id,title,assignee,due_date FROM tasks WHERE project_id=? AND done=0 ORDER BY id LIMIT 3').all(pid) });
  if (method === 'POST' && key === 'assistant') {
    const query = String((await readJson(req)).query || '').trim().toLocaleLowerCase('fr-FR'), terms = query.split(/\s+/).filter((x) => x.length > 2).slice(0, 8);
    if (!query) return json({ answer: 'Saisissez un mot-clé pour chercher dans ce projet.' });
    const sources = [['Message',db.prepare('SELECT body AS text FROM messages WHERE project_id=? ORDER BY id DESC').all(pid)],['Rendu',db.prepare('SELECT title AS text FROM deliveries WHERE project_id=? ORDER BY id DESC').all(pid)],['Tâche',db.prepare('SELECT title AS text FROM tasks WHERE project_id=? ORDER BY id DESC').all(pid)],['Événement',db.prepare('SELECT title AS text FROM events WHERE project_id=? ORDER BY id DESC').all(pid)]];
    const results = sources.flatMap(([type, rows]) => rows.filter((r) => terms.some((t) => r.text.toLocaleLowerCase('fr-FR').includes(t))).map((r) => ({ type, text: r.text })));
    return json({ answer: `${results.length} élément(s) correspondant(s) dans ce projet.`, results: results.slice(0, 8) });
  }
  if (method === 'POST' && key === 'files') {
    let original; try { original = decodeURIComponent(req.headers.get('x-filename') || 'fichier'); } catch { throw new HttpError(400, 'Nom de fichier invalide.'); }
    original = original.replace(/[\x00-\x1f]/g, '').slice(0, 180); const data = await readLimited(req, 20 * 1024 * 1024), stored = `${randomBytes(20).toString('hex')}${extname(original).slice(0,12)}`;
    await mkdir(join(dataDir,'uploads'),{recursive:true}); const target = join(dataDir,'uploads',stored); await writeFile(target,data,{flag:'wx',mode:0o640}); await chmod(target,0o640);
    db.prepare('INSERT INTO project_files(file_path,project_id,uploaded_by,created_at) VALUES(?,?,?,?)').run(stored,pid,u.id,now()); return json({ file_name: basename(original)||'fichier', file_path: stored },201);
  }
  if (method === 'POST' && key === 'messages') {
    const b=await readJson(req), body=String(b.body||'').trim().slice(0,5000), file=String(b.file_path||'').slice(0,80), fileName=String(b.file_name||'').slice(0,180);
    if (!body&&!file) throw new HttpError(400,'Le message ne peut pas être vide.');
    if (file&&!db.prepare('SELECT 1 FROM project_files WHERE file_path=? AND project_id=?').get(file,pid)) throw new HttpError(400,'Fichier invalide pour ce projet.');
    const id=db.prepare('INSERT INTO messages(project_id,member_id,body,file_name,file_path,created_at) VALUES(?,?,?,?,?,?)').run(pid,u.id,body,fileName,file||null,now()).lastInsertRowid;
    return json(memberRows('SELECT x.*,m.name,m.initials AS member_initials,m.tone FROM messages x JOIN members m ON m.id=x.member_id WHERE x.id=? AND x.project_id=?',id,pid)[0],201);
  }
  if (method === 'POST' && key === 'deliveries') {
    const b=await readJson(req), title=String(b.title||'').trim().slice(0,180), file=String(b.file_path||'').slice(0,80); if(!title)throw new HttpError(400,'Le titre est obligatoire.');
    if(file&&!db.prepare('SELECT 1 FROM project_files WHERE file_path=? AND project_id=?').get(file,pid))throw new HttpError(400,'Fichier invalide pour ce projet.');
    const id=db.prepare("INSERT INTO deliveries(project_id,member_id,title,description,file_name,file_path,status,created_at) VALUES(?,?,?,?,?,?,?,?)").run(pid,u.id,title,String(b.description||'').slice(0,1000),String(b.file_name||'').slice(0,180),file,'À valider',now()).lastInsertRowid;
    return json(memberRows('SELECT x.*,m.name,m.initials AS member_initials,m.tone FROM deliveries x JOIN members m ON m.id=x.member_id WHERE x.id=? AND x.project_id=?',id,pid)[0],201);
  }
  if(method==='POST'&&key==='tasks'){const b=await readJson(req),title=String(b.title||'').trim().slice(0,180);if(!title)throw new HttpError(400,'Le titre est obligatoire.');const id=db.prepare('INSERT INTO tasks(project_id,title,assignee,due_date,created_at) VALUES(?,?,?,?,?)').run(pid,title,String(b.assignee||u.name).slice(0,100),String(b.due_date||'').slice(0,10),now()).lastInsertRowid;return json(db.prepare('SELECT * FROM tasks WHERE id=? AND project_id=?').get(id,pid),201);}
  if(method==='POST'&&key==='events'){const b=await readJson(req),title=String(b.title||'').trim().slice(0,180);if(!title)throw new HttpError(400,'Le nom de l’événement est obligatoire.');const id=db.prepare('INSERT INTO events(project_id,title,date,time,created_at) VALUES(?,?,?,?,?)').run(pid,title,String(b.date||'').slice(0,10),String(b.time||'').slice(0,30),now()).lastInsertRowid;return json(db.prepare('SELECT * FROM events WHERE id=? AND project_id=?').get(id,pid),201);}
  if(method==='POST'&&key==='invites'){
    if(p.role!=='admin')throw new HttpError(403,'Seuls les administrateurs du projet peuvent inviter des membres.');const b=await readJson(req),email=String(b.email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw new HttpError(400,'Adresse e-mail invalide.');
    const existing=db.prepare('SELECT id FROM members WHERE lower(email)=?').get(email);if(existing&&db.prepare('SELECT 1 FROM project_members WHERE project_id=? AND member_id=?').get(pid,existing.id))throw new HttpError(409,'Cette personne appartient déjà au projet.');
    const token=randomBytes(32).toString('base64url'),expires=new Date(Date.now()+7*86400_000).toISOString();db.prepare("INSERT INTO invites(project_id,email,note,status,created_at,token_hash,expires_at) VALUES(?,?,?,'En attente',?,?,?)").run(pid,email,String(b.note||'').slice(0,1000),now(),hash(token),expires);return json({invite_path:`/join?token=${encodeURIComponent(token)}`,expires_at:expires},201);
  }
  if(method==='PATCH'&&parts[0]==='tasks'&&parts[1]){const id=Number(parts[1]),b=await readJson(req);db.prepare('UPDATE tasks SET done=? WHERE id=? AND project_id=?').run(b.done?1:0,id,pid);const row=db.prepare('SELECT * FROM tasks WHERE id=? AND project_id=?').get(id,pid);if(!row)throw new HttpError(404,'Tâche introuvable.');return json(row);}
  if(method==='PATCH'&&parts[0]==='deliveries'&&parts[1]){const id=Number(parts[1]),status=String((await readJson(req)).status||'');if(!['À valider','En cours','Terminé'].includes(status))throw new HttpError(400,'Statut invalide.');db.prepare('UPDATE deliveries SET status=? WHERE id=? AND project_id=?').run(status,id,pid);const row=memberRows('SELECT x.*,m.name,m.initials AS member_initials,m.tone FROM deliveries x JOIN members m ON m.id=x.member_id WHERE x.id=? AND x.project_id=?',id,pid)[0];if(!row)throw new HttpError(404,'Rendu introuvable.');return json(row);}
  throw new HttpError(404,'Route inconnue.');
}
export async function localHandler(req,method){try{return await dispatch(req,method);}catch(e){const status=e instanceof HttpError?e.status:500;if(status>=500)console.error('[api]',e);return json({error:status===500?'Une erreur interne est survenue.':e.message},status);}}
