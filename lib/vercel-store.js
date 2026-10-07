import { neon } from '@neondatabase/serverless';
import { createHash, randomBytes } from 'node:crypto';
import { get, put } from '@vercel/blob';
import { passwordHash, verifyPassword } from './credentials.js';
import { issueProjectToken, publishProjectChange, realtimeEnabled } from './realtime.js';

const SESSION_COOKIE = '__Host-latelier_session';
const PROJECT_COOKIE = '__Host-latelier_project';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'M';
let schemaPromise;
function client() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent : reliez une base Neon/Postgres à ce projet Vercel.');
  return neon(process.env.DATABASE_URL);
}
async function ensureSchema() {
  if (!schemaPromise) schemaPromise = (async () => {
    const sql = client();
    const statements = [
      `CREATE TABLE IF NOT EXISTS members(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,initials TEXT NOT NULL,tone TEXT NOT NULL DEFAULT '',email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',active BOOLEAN NOT NULL DEFAULT TRUE)`,
      `CREATE TABLE IF NOT EXISTS projects(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,created_by BIGINT REFERENCES members(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS project_members(project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,role TEXT NOT NULL DEFAULT 'member',joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(project_id,member_id))`,
      `CREATE TABLE IF NOT EXISTS sessions(id BIGSERIAL PRIMARY KEY,member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,token_hash TEXT NOT NULL UNIQUE,expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS login_attempts(attempt_key TEXT PRIMARY KEY,count INTEGER NOT NULL,window_started BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS invites(id BIGSERIAL PRIMARY KEY,project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,email TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'En attente',token_hash TEXT NOT NULL UNIQUE,expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),accepted_at TIMESTAMPTZ)`,
      `CREATE TABLE IF NOT EXISTS project_files(file_path TEXT PRIMARY KEY,project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,uploaded_by BIGINT NOT NULL REFERENCES members(id),file_name TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS messages(id BIGSERIAL PRIMARY KEY,project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,member_id BIGINT NOT NULL REFERENCES members(id),body TEXT NOT NULL DEFAULT '',file_name TEXT,file_path TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS deliveries(id BIGSERIAL PRIMARY KEY,project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,member_id BIGINT NOT NULL REFERENCES members(id),title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',file_name TEXT NOT NULL DEFAULT '',file_path TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'À valider',created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS tasks(id BIGSERIAL PRIMARY KEY,project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,title TEXT NOT NULL,assignee TEXT NOT NULL DEFAULT '',due_date TEXT NOT NULL DEFAULT '',done BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS events(id BIGSERIAL PRIMARY KEY,project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,title TEXT NOT NULL,date TEXT,time TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    ];
    await sql.transaction(statements.map((statement) => sql.query(statement)));
    // A bootstrap account is optional. Public registration remains usable without admin secrets.
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase(), password = process.env.ADMIN_PASSWORD;
    if (email && password && password.length >= 16) {
      const name = process.env.ADMIN_NAME?.trim() || email.split('@')[0];
      const created = await sql.query("INSERT INTO members(name,initials,email,password_hash,role) VALUES($1,$2,$3,$4,'admin') ON CONFLICT(email) DO NOTHING RETURNING id", [name, initials(name), email, passwordHash(password)]);
      const memberId = created[0]?.id || (await sql.query('SELECT id FROM members WHERE lower(email)=$1 LIMIT 1', [email]))[0]?.id;
      if (!memberId) throw new Error('Impossible de créer le compte administrateur.');
      let projects = await sql.query('SELECT id FROM projects WHERE created_by=$1 ORDER BY id LIMIT 1', [memberId]);
      if (!projects.length) {
        const rows = await sql.query("INSERT INTO projects(name,created_by) VALUES($1,$2) RETURNING id", [process.env.PROJECT_NAME?.trim() || 'Collectif design', memberId]);
        const projectId = rows[0].id;
        await sql.query("INSERT INTO project_members(project_id,member_id,role) VALUES($1,$2,'admin') ON CONFLICT DO NOTHING", [projectId, memberId]);
      } else {
        await sql.query("INSERT INTO project_members(project_id,member_id,role) VALUES($1,$2,'admin') ON CONFLICT DO NOTHING", [projects[0].id, memberId]);
      }
    }
  })().catch((error) => { schemaPromise = undefined; throw error; });
  await schemaPromise;
}
function cookie(req, name) { const value=(req.headers.get('cookie')||'').split(';').map((x)=>x.trim()).find((x)=>x.startsWith(`${name}=`))?.slice(name.length+1)||'';try{return decodeURIComponent(value);}catch{return '';} }
function setCookie(response, name, value, maxAge=1209600) { response.headers.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`); }
function response(body,status=200){return Response.json(body,{status,headers:{'Cache-Control':'no-store'}})}
function fail(status,message){return response({error:message},status)}
async function currentUser(req, sql) {
  const token = cookie(req,SESSION_COOKIE); if(!token)return null;
  const rows=await sql.query(`SELECT m.id,m.name,m.initials,m.tone,m.email,m.role,m.active,s.expires_at FROM sessions s JOIN members m ON m.id=s.member_id WHERE s.token_hash=$1 AND s.expires_at>now() AND m.active=TRUE`,[digest(token)]);
  return rows[0]||null;
}
async function currentProject(req,sql,user){
  const selected=Number(cookie(req,PROJECT_COOKIE)||0);
  const rows=await sql.query(`SELECT p.id,p.name,pm.role FROM project_members pm JOIN projects p ON p.id=pm.project_id WHERE pm.member_id=$1 AND ($2=0 OR p.id=$2) ORDER BY CASE WHEN p.id=$2 THEN 0 ELSE 1 END,p.id LIMIT 1`,[user.id,selected]);
  return rows[0]||null;
}
function cleanUser(row){return {id:Number(row.id),name:row.name,initials:row.initials,tone:row.tone||'',email:row.email,role:row.role};}
function validProjectName(value){const name=String(value||'').trim().slice(0,80);if(name.length<2)throw Object.assign(new Error('Le nom du projet doit contenir au moins 2 caractères.'),{status:400});return name;}
function failFor(error){console.error('[vercel-api]',error);return response({error:error.status?error.message:'Service de données indisponible. Vérifiez DATABASE_URL et les journaux Vercel.'},error.status||503);}
async function rateLimit(req,sql,identity,kind='login'){
  const ip=req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown',key=digest(`${kind}:${ip}:${identity}`),nowMs=Date.now(),found=await sql.query('SELECT count,window_started FROM login_attempts WHERE attempt_key=$1',[key]),row=found[0];
  if(row&&nowMs-Number(row.window_started)<900000&&row.count>=8)throw Object.assign(new Error('Trop de tentatives. Réessayez dans 15 minutes.'),{status:429});
  await sql.query(`INSERT INTO login_attempts(attempt_key,count,window_started) VALUES($1,1,$2) ON CONFLICT(attempt_key) DO UPDATE SET count=CASE WHEN $2-login_attempts.window_started>=900000 THEN 1 ELSE login_attempts.count+1 END,window_started=CASE WHEN $2-login_attempts.window_started>=900000 THEN $2 ELSE login_attempts.window_started END`,[key,nowMs]);
  return key;
}

export async function vercelDispatch(req, method) {
  try {
    await ensureSchema(); const sql=client(),url=new URL(req.url),parts=url.pathname.replace(/^\/api\/?/,'').split('/').filter(Boolean).map(decodeURIComponent),key=parts.join('/'),body=(method==='POST'||method==='PATCH')&&key!=='files'?await req.json().catch(()=>({})):{};
    if(method!=='GET'){const origin=req.headers.get('origin');if(origin){const host=req.headers.get('x-forwarded-host')||req.headers.get('host');if(new URL(origin).host!==host)return fail(403,'Origine de requête refusée.');}}
    if(method==='GET'&&key==='health'){await sql.query('SELECT 1');return response({ok:true,database:'postgres'});}
    if(method==='POST'&&key==='auth/register'){
      const token=String(body.token||''),name=String(body.name||'').trim().slice(0,100),password=String(body.password||'');
      if(name.length<2)return fail(400,'Saisissez votre nom.');if(password.length<12||password.length>1024)return fail(400,'Choisissez un mot de passe de 12 caractères minimum.');
      let member,projectId;
      if(token){
        const invitations=await sql.query("SELECT * FROM invites WHERE token_hash=$1 AND status='En attente' AND expires_at>now()",[digest(token)]),invite=invitations[0];if(!invite)return fail(410,'Ce lien d’invitation est invalide ou expiré.');
        const existing=(await sql.query('SELECT * FROM members WHERE lower(email)=$1',[invite.email.toLowerCase()]))[0];
        if(existing){if(!existing.active||!verifyPassword(password,existing.password_hash))return fail(401,'Un compte existe déjà. Saisissez son mot de passe actuel pour rejoindre le projet.');member=existing;await sql.transaction([sql.query("INSERT INTO project_members(project_id,member_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING",[invite.project_id,existing.id]),sql.query("UPDATE invites SET status='Acceptée',accepted_at=now() WHERE id=$1",[invite.id])]);}
        else {const rows=await sql.query(`WITH m AS (INSERT INTO members(name,initials,email,password_hash) VALUES($1,$2,$3,$4) RETURNING *), pm AS (INSERT INTO project_members(project_id,member_id,role) SELECT $5,id,'member' FROM m RETURNING member_id), accepted AS (UPDATE invites SET status='Acceptée',accepted_at=now() WHERE id=$6 RETURNING id) SELECT m.* FROM m JOIN pm ON pm.member_id=m.id`,[name,initials(name),invite.email.toLowerCase(),passwordHash(password),invite.project_id,invite.id]);member=rows[0];}
        projectId=Number(invite.project_id);await publishProjectChange(projectId,{type:'members',id:Number(member.id)});
      } else {
        const email=String(body.email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return fail(400,'Adresse e-mail invalide.');
        await rateLimit(req,sql,email,'register');
        const projectName=validProjectName(body.project_name),existing=await sql.query('SELECT id FROM members WHERE lower(email)=$1',[email]);if(existing.length)return fail(409,'Un compte existe déjà avec cette adresse.');
        const rows=await sql.query(`WITH m AS (INSERT INTO members(name,initials,email,password_hash) VALUES($1,$2,$3,$4) RETURNING *), p AS (INSERT INTO projects(name,created_by) SELECT $5,id FROM m RETURNING *), pm AS (INSERT INTO project_members(project_id,member_id,role) SELECT p.id,m.id,'admin' FROM p,m RETURNING project_id) SELECT m.*,p.id AS project_id FROM m,p,pm`,[name,initials(name),email,passwordHash(password),projectName]);member=rows[0];projectId=Number(rows[0].project_id);
      }
      const session=randomBytes(32).toString('base64url');await sql.query('INSERT INTO sessions(member_id,token_hash,expires_at) VALUES($1,$2,now()+interval \'14 days\')',[member.id,digest(session)]);const res=response({user:cleanUser(member),project_id:projectId},201);setCookie(res,SESSION_COOKIE,session);setCookie(res,PROJECT_COOKIE,String(projectId));return res;
    }
    if(method==='POST'&&key==='auth/login'){
      const email=String(body.email||'').trim().toLowerCase(),password=String(body.password||'');if(!email||!password)return fail(400,'Saisissez votre adresse e-mail et votre mot de passe.');
      const attemptKey=await rateLimit(req,sql,email);
      const rows=await sql.query('SELECT * FROM members WHERE lower(email)=$1 AND active=TRUE',[email]),member=rows[0];if(!member||!verifyPassword(password,member.password_hash))return fail(401,'Adresse e-mail ou mot de passe incorrect.');
      await sql.query('DELETE FROM login_attempts WHERE attempt_key=$1',[attemptKey]);
      const projects=await sql.query('SELECT p.id FROM projects p JOIN project_members pm ON pm.project_id=p.id WHERE pm.member_id=$1 ORDER BY p.id LIMIT 1',[member.id]);if(!projects.length)return fail(403,'Ce compte ne fait partie d’aucun projet.');
      const session=randomBytes(32).toString('base64url');await sql.query('INSERT INTO sessions(member_id,token_hash,expires_at) VALUES($1,$2,now()+interval \'14 days\')',[member.id,digest(session)]);const res=response({user:cleanUser(member),project_id:Number(projects[0].id)});setCookie(res,SESSION_COOKIE,session);setCookie(res,PROJECT_COOKIE,String(projects[0].id));return res;
    }
    if(method==='POST'&&key==='auth/logout'){const raw=cookie(req,SESSION_COOKIE);if(raw)await sql.query('DELETE FROM sessions WHERE token_hash=$1',[digest(raw)]);const res=response({ok:true});setCookie(res,SESSION_COOKIE,'',0);setCookie(res,PROJECT_COOKIE,'',0);return res;}
    const user=await currentUser(req,sql);
    if(method==='GET'&&key==='auth/me')return response({user:user?cleanUser(user):null});
    if(!user)return fail(401,'Connectez-vous pour continuer.');
    if(method==='POST'&&key==='auth/password'){
      const row=(await sql.query('SELECT password_hash FROM members WHERE id=$1',[user.id]))[0],current=String(body.current_password||''),next=String(body.new_password||'');
      if(!verifyPassword(current,row.password_hash))return fail(401,'Mot de passe actuel incorrect.');if(next.length<12||next.length>1024)return fail(400,'Le nouveau mot de passe doit contenir au moins 12 caractères.');
      await sql.query('UPDATE members SET password_hash=$1 WHERE id=$2',[passwordHash(next),user.id]);await sql.query('DELETE FROM sessions WHERE member_id=$1',[user.id]);const token=randomBytes(32).toString('base64url');await sql.query('INSERT INTO sessions(member_id,token_hash,expires_at) VALUES($1,$2,now()+interval \'14 days\')',[user.id,digest(token)]);const res=response({user:cleanUser(user)});setCookie(res,SESSION_COOKIE,token);const active=await currentProject(req,sql,user);if(active)setCookie(res,PROJECT_COOKIE,String(active.id));return res;
    }
    if(key==='projects'&&method==='GET'){const projects=await sql.query('SELECT p.id,p.name,pm.role FROM projects p JOIN project_members pm ON pm.project_id=p.id WHERE pm.member_id=$1 ORDER BY p.id',[user.id]);const active=await currentProject(req,sql,user);return response({projects:projects.map(p=>({...p,id:Number(p.id)})),selected_project_id:active?Number(active.id):null});}
    if(key==='projects'&&method==='POST'){const name=validProjectName(body.name),rows=await sql.query('WITH p AS (INSERT INTO projects(name,created_by) VALUES($1,$2) RETURNING *) INSERT INTO project_members(project_id,member_id,role) SELECT p.id,$2,\'admin\' FROM p RETURNING project_id',[name,user.id]);const id=Number(rows[0].project_id),res=response({project:{id,name,role:'admin'}},201);setCookie(res,PROJECT_COOKIE,String(id));return res;}
    if(key==='projects/select'&&method==='POST'){const selected=await sql.query('SELECT p.id,p.name,pm.role FROM projects p JOIN project_members pm ON pm.project_id=p.id WHERE p.id=$1 AND pm.member_id=$2',[Number(body.project_id),user.id]);if(!selected.length)return fail(404,'Projet inaccessible.');const p=selected[0],res=response({project:{...p,id:Number(p.id)}});setCookie(res,PROJECT_COOKIE,String(p.id));return res;}
    const project=await currentProject(req,sql,user);if(!project)return fail(403,'Aucun projet accessible pour ce compte.');const pid=Number(project.id);
    const rows=async(text,args=[])=>sql.query(text,args);
    const personRows=async(text,args=[])=>{const found=await rows(text,args);return found.map(r=>({...r,author:r.name,initials:r.member_initials,tone:r.tone||''}));};
    if(method==='POST'&&key==='realtime/token')return response(await issueProjectToken(user.id,pid));
    if(method==='GET'&&key==='snapshot'){
      const [messages,deliveries,tasks,events,members,projects]=await Promise.all([
        personRows('SELECT x.*,m.name,m.initials AS member_initials,m.tone FROM messages x JOIN members m ON m.id=x.member_id WHERE x.project_id=$1 ORDER BY x.id',[pid]),
        personRows('SELECT x.*,m.name,m.initials AS member_initials,m.tone FROM deliveries x JOIN members m ON m.id=x.member_id WHERE x.project_id=$1 ORDER BY x.id DESC',[pid]),
        rows('SELECT * FROM tasks WHERE project_id=$1 ORDER BY id DESC',[pid]),
        rows('SELECT * FROM events WHERE project_id=$1 ORDER BY date,time,id',[pid]),
        rows('SELECT m.id,m.name,m.initials,m.tone,m.email,pm.role FROM members m JOIN project_members pm ON pm.member_id=m.id WHERE pm.project_id=$1 AND m.active=TRUE ORDER BY m.id',[pid]),
        rows('SELECT p.id,p.name,pm.role FROM projects p JOIN project_members pm ON pm.project_id=p.id WHERE pm.member_id=$1 ORDER BY p.id',[user.id]),
      ]);
      return response({
        messages, deliveries, tasks, events, members,
        projects: projects.map((p) => ({ ...p, id: Number(p.id) })),
        selected_project_id: pid,
        realtime: realtimeEnabled(),
        summary: {
          messages: messages.slice(-4),
          actions: tasks.filter((task) => !task.done).slice(0, 3).map(({ id,title,assignee,due_date }) => ({ id,title,assignee,due_date })),
        },
      });
    }
    if(method==='GET'&&key==='messages')return response(await personRows('SELECT x.*,m.name,m.initials AS member_initials,m.tone FROM messages x JOIN members m ON m.id=x.member_id WHERE x.project_id=$1 ORDER BY x.id',[pid]));
    if(method==='GET'&&key==='deliveries')return response(await personRows('SELECT x.*,m.name,m.initials AS member_initials,m.tone FROM deliveries x JOIN members m ON m.id=x.member_id WHERE x.project_id=$1 ORDER BY x.id DESC',[pid]));
    if(method==='GET'&&key==='tasks')return response(await rows('SELECT * FROM tasks WHERE project_id=$1 ORDER BY id DESC',[pid]));
    if(method==='GET'&&key==='events')return response(await rows('SELECT * FROM events WHERE project_id=$1 ORDER BY date,time,id',[pid]));
    if(method==='GET'&&key==='members')return response(await rows('SELECT m.id,m.name,m.initials,m.tone,m.email,pm.role FROM members m JOIN project_members pm ON pm.member_id=m.id WHERE pm.project_id=$1 AND m.active=TRUE ORDER BY m.id',[pid]));
    if(method==='GET'&&key==='summary'){const messages=await personRows('SELECT x.*,m.name,m.initials AS member_initials,m.tone FROM messages x JOIN members m ON m.id=x.member_id WHERE x.project_id=$1 ORDER BY x.id DESC LIMIT 4',[pid]);return response({messages:messages.reverse(),actions:await rows('SELECT id,title,assignee,due_date FROM tasks WHERE project_id=$1 AND done=FALSE ORDER BY id LIMIT 3',[pid])});}
    if(method==='POST'&&key==='assistant'){const q=String(body.query||'').trim().toLocaleLowerCase('fr-FR'),terms=q.split(/\s+/).filter(x=>x.length>2).slice(0,8);if(!q)return response({answer:'Saisissez un mot-clé pour chercher dans ce projet.'});const data=await Promise.all([rows('SELECT body AS text FROM messages WHERE project_id=$1',[pid]),rows('SELECT title AS text FROM deliveries WHERE project_id=$1',[pid]),rows('SELECT title AS text FROM tasks WHERE project_id=$1',[pid]),rows('SELECT title AS text FROM events WHERE project_id=$1',[pid])]);const results=data.flatMap((list,i)=>list.filter(x=>terms.some(t=>x.text.toLocaleLowerCase('fr-FR').includes(t))).map(x=>({type:['Message','Rendu','Tâche','Événement'][i],text:x.text})));return response({answer:`${results.length} élément(s) correspondant(s) dans ce projet.`,results:results.slice(0,8)});}
    if(method==='POST'&&key==='files'){if(!process.env.BLOB_READ_WRITE_TOKEN&&!process.env.VERCEL_OIDC_TOKEN)return fail(503,'Stockage de fichiers non configuré : ajoutez Vercel Blob au projet.');if(Number(req.headers.get('content-length')||0)>4*1024*1024)return fail(413,'Le fichier dépasse la limite de 4 Mo sur Vercel.');const rawName=decodeURIComponent(req.headers.get('x-filename')||'fichier').replace(/[\x00-\x1f]/g,'').slice(0,180),buffer=Buffer.from(await req.arrayBuffer());if(buffer.length>4*1024*1024)return fail(413,'Le fichier dépasse la limite de 4 Mo sur Vercel.');const pathname=`projects/${pid}/${randomBytes(18).toString('hex')}-${rawName.replace(/[^\p{L}\p{N}._-]/gu,'_')}`;const blob=await put(pathname,buffer,{access:'private',addRandomSuffix:false,contentType:req.headers.get('content-type')||'application/octet-stream'});await rows('INSERT INTO project_files(file_path,project_id,uploaded_by,file_name) VALUES($1,$2,$3,$4)',[blob.pathname,pid,user.id,rawName]);return response({file_name:rawName,file_path:blob.pathname},201);}
    if(method==='GET'&&parts[0]==='files'&&parts.length>1){const pathname=decodeURIComponent(parts.slice(1).join('/')),file=(await rows('SELECT file_name FROM project_files WHERE file_path=$1 AND project_id=$2',[pathname,pid]))[0];if(!file)return fail(404,'Fichier introuvable.');const blob=await get(pathname,{access:'private'});if(!blob)return fail(404,'Fichier introuvable.');return new Response(blob.stream,{headers:{'Content-Type':blob.blob.contentType||'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
    if(method==='POST'&&key==='messages'){const text=String(body.body||'').trim().slice(0,5000),filePath=String(body.file_path||'').slice(0,240),fileName=String(body.file_name||'').slice(0,180);if(!text&&!filePath)return fail(400,'Le message ne peut pas être vide.');if(filePath&&!(await rows('SELECT 1 FROM project_files WHERE file_path=$1 AND project_id=$2',[filePath,pid])).length)return fail(400,'Fichier invalide pour ce projet.');const r=await personRows('WITH x AS (INSERT INTO messages(project_id,member_id,body,file_name,file_path) VALUES($1,$2,$3,$4,$5) RETURNING *) SELECT x.*,m.name,m.initials AS member_initials,m.tone FROM x JOIN members m ON m.id=x.member_id',[pid,user.id,text,fileName||null,filePath||null]);await publishProjectChange(pid,{type:'messages',id:r[0]?.id});return response(r[0],201);}
    if(method==='POST'&&key==='deliveries'){const title=String(body.title||'').trim().slice(0,180),file=String(body.file_path||'').slice(0,240);if(!title)return fail(400,'Le titre est obligatoire.');if(file&&!(await rows('SELECT 1 FROM project_files WHERE file_path=$1 AND project_id=$2',[file,pid])).length)return fail(400,'Fichier invalide pour ce projet.');const r=await personRows("WITH x AS (INSERT INTO deliveries(project_id,member_id,title,description,file_name,file_path,status) VALUES($1,$2,$3,$4,$5,$6,'À valider') RETURNING *) SELECT x.*,m.name,m.initials AS member_initials,m.tone FROM x JOIN members m ON m.id=x.member_id",[pid,user.id,title,String(body.description||'').slice(0,1000),String(body.file_name||'').slice(0,180),file]);await publishProjectChange(pid,{type:'deliveries',id:r[0]?.id});return response(r[0],201);}
    if(method==='POST'&&key==='tasks'){const title=String(body.title||'').trim().slice(0,180);if(!title)return fail(400,'Le titre est obligatoire.');const r=await rows('INSERT INTO tasks(project_id,title,assignee,due_date) VALUES($1,$2,$3,$4) RETURNING *',[pid,title,String(body.assignee||user.name).slice(0,100),String(body.due_date||'').slice(0,10)]);await publishProjectChange(pid,{type:'tasks',id:r[0]?.id});return response(r[0],201);}
    if(method==='POST'&&key==='events'){const title=String(body.title||'').trim().slice(0,180);if(!title)return fail(400,'Le nom de l’événement est obligatoire.');const r=await rows('INSERT INTO events(project_id,title,date,time) VALUES($1,$2,$3,$4) RETURNING *',[pid,title,String(body.date||'').slice(0,10),String(body.time||'').slice(0,30)]);await publishProjectChange(pid,{type:'events',id:r[0]?.id});return response(r[0],201);}
    if(method==='POST'&&key==='invites'){if(project.role!=='admin')return fail(403,'Seuls les administrateurs du projet peuvent inviter des membres.');const email=String(body.email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return fail(400,'Adresse e-mail invalide.');const existing=(await rows('SELECT id FROM members WHERE lower(email)=$1',[email]))[0];if(existing&&(await rows('SELECT 1 FROM project_members WHERE project_id=$1 AND member_id=$2',[pid,existing.id])).length)return fail(409,'Cette personne appartient déjà au projet.');const token=randomBytes(32).toString('base64url'),expires=new Date(Date.now()+7*86400000).toISOString();await rows("INSERT INTO invites(project_id,email,note,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)",[pid,email,String(body.note||'').slice(0,1000),digest(token),expires]);return response({invite_path:`/join?token=${encodeURIComponent(token)}`,expires_at:expires},201);}
    if(method==='PATCH'&&parts[0]==='tasks'&&parts[1]){const r=await rows('UPDATE tasks SET done=$1 WHERE id=$2 AND project_id=$3 RETURNING *',[Boolean(body.done),Number(parts[1]),pid]);if(!r.length)return fail(404,'Tâche introuvable.');await publishProjectChange(pid,{type:'tasks',id:r[0].id});return response(r[0]);}
    if(method==='PATCH'&&parts[0]==='deliveries'&&parts[1]){const status=String(body.status||'');if(!['À valider','En cours','Terminé'].includes(status))return fail(400,'Statut invalide.');const r=await personRows('WITH x AS (UPDATE deliveries SET status=$1 WHERE id=$2 AND project_id=$3 RETURNING *) SELECT x.*,m.name,m.initials AS member_initials,m.tone FROM x JOIN members m ON m.id=x.member_id',[status,Number(parts[1]),pid]);if(!r.length)return fail(404,'Rendu introuvable.');await publishProjectChange(pid,{type:'deliveries',id:r[0].id});return response(r[0]);}
    return fail(404,'Route inconnue.');
  } catch(error){return failFor(error);}
}
export async function vercelHomeUser(token){await ensureSchema();if(!token)return null;const sql=client(),rows=await sql.query('SELECT m.id,m.name,m.initials,m.tone,m.email,m.role,m.active FROM sessions s JOIN members m ON m.id=s.member_id WHERE s.token_hash=$1 AND s.expires_at>now() AND m.active=TRUE',[digest(token)]);return rows[0]?cleanUser(rows[0]):null;}
export async function vercelHomeProject(memberId,preferred){await ensureSchema();const sql=client(),rows=await sql.query('SELECT p.id,p.name,pm.role FROM projects p JOIN project_members pm ON pm.project_id=p.id WHERE pm.member_id=$1 AND ($2=0 OR p.id=$2) ORDER BY CASE WHEN p.id=$2 THEN 0 ELSE 1 END,p.id LIMIT 1',[memberId,Number(preferred)||0]);return rows[0]?{...rows[0],id:Number(rows[0].id)}:null;}
