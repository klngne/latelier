import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';

export const dataDir = process.env.LATELIER_DATA_DIR || join(process.cwd(), 'data');
let instance;

const now = () => new Date().toISOString();
export { now };

function passwordHash(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}
export { passwordHash };

export function assertProductionConfig() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (process.env.NODE_ENV === 'production' && (!email || !password || password.length < 16)) {
    throw new Error('Configure ADMIN_EMAIL et ADMIN_PASSWORD (16 caractères minimum) avant le démarrage en production.');
  }
}

function initialize() {
  if (instance) return instance;
  mkdirSync(dataDir, { recursive: true, mode: 0o750 });
  mkdirSync(join(dataDir, 'uploads'), { recursive: true, mode: 0o750 });
  chmodSync(dataDir, 0o750);
  chmodSync(join(dataDir, 'uploads'), 0o750);
  const databasePath = join(dataDir, 'latelier.sqlite3');
  const connection = new Database(databasePath);
  chmodSync(databasePath, 0o640);
  connection.pragma('busy_timeout = 10000');
  connection.pragma('foreign_keys = ON');

  const tableColumns = (table) => new Set(connection.prepare(`PRAGMA table_info(${table})`).all().map((x) => x.name));
  const addColumn = (table, name, definition) => {
    if (!tableColumns(table).has(name)) connection.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };

  const migrateAndSeed = connection.transaction(() => {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER REFERENCES members(id), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, initials TEXT NOT NULL,
        tone TEXT NOT NULL DEFAULT '', email TEXT UNIQUE
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id),
        body TEXT NOT NULL DEFAULT '', file_name TEXT, file_path TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id),
        title TEXT NOT NULL, description TEXT DEFAULT '', file_name TEXT DEFAULT '',
        file_path TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'À valider', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, assignee TEXT DEFAULT '', due_date TEXT DEFAULT '',
        done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, date TEXT, time TEXT DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        id INTEGER PRIMARY KEY, email TEXT NOT NULL, note TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'En attente', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_attempts (
        attempt_key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_started INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_members (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member', joined_at TEXT NOT NULL,
        PRIMARY KEY(project_id,member_id)
      );
      CREATE TABLE IF NOT EXISTS project_files (
        file_path TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        uploaded_by INTEGER NOT NULL REFERENCES members(id), created_at TEXT NOT NULL
      );
    `);
    addColumn('members', 'password_hash', 'TEXT');
    addColumn('members', 'role', "TEXT NOT NULL DEFAULT 'member'");
    addColumn('members', 'active', 'INTEGER NOT NULL DEFAULT 1');
    addColumn('invites', 'token_hash', 'TEXT');
    addColumn('invites', 'expires_at', 'TEXT');
    addColumn('invites', 'accepted_at', 'TEXT');
    addColumn('invites', 'project_id', 'INTEGER REFERENCES projects(id) ON DELETE CASCADE');
    for (const table of ['messages', 'deliveries', 'tasks', 'events']) addColumn(table, 'project_id', 'INTEGER REFERENCES projects(id) ON DELETE CASCADE');

    const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD;
    const countMembers = () => connection.prepare('SELECT COUNT(*) AS n FROM members').get().n;
    if (countMembers() === 0 && adminEmail && adminPassword) {
      const name = process.env.ADMIN_NAME?.trim() || adminEmail.split('@')[0];
      const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'AD';
      connection.prepare('INSERT INTO members(name,initials,email,password_hash,role) VALUES(?,?,?,?,?)')
        .run(name, initials, adminEmail, passwordHash(adminPassword), 'admin');
    }
    if (adminEmail && adminPassword && countMembers() > 0) {
      const account = connection.prepare('SELECT id,password_hash FROM members WHERE lower(email)=?').get(adminEmail);
      if (account && !account.password_hash) {
        connection.prepare("UPDATE members SET password_hash=?,role='admin',active=1 WHERE id=?").run(passwordHash(adminPassword), account.id);
      } else if (!account) {
        const unclaimed = connection.prepare('SELECT id FROM members WHERE password_hash IS NULL ORDER BY id LIMIT 1').get();
        if (unclaimed) {
          const name = process.env.ADMIN_NAME?.trim() || adminEmail.split('@')[0];
          const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'AD';
          connection.prepare("UPDATE members SET name=?,initials=?,email=?,password_hash=?,role='admin',active=1 WHERE id=?")
            .run(name, initials, adminEmail, passwordHash(adminPassword), unclaimed.id);
        }
      }
    }

    let defaultProject = connection.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get();
    if (!defaultProject && countMembers() > 0) {
      const creator = connection.prepare("SELECT id FROM members WHERE role='admin' ORDER BY id LIMIT 1").get() || connection.prepare('SELECT id FROM members ORDER BY id LIMIT 1').get();
      const result = connection.prepare('INSERT INTO projects(name,created_by,created_at) VALUES(?,?,?)')
        .run(process.env.PROJECT_NAME?.trim() || 'Collectif design', creator.id, stampNow());
      defaultProject = { id: result.lastInsertRowid };
      const members = connection.prepare('SELECT id,role FROM members').all();
      const addMembership = connection.prepare('INSERT OR IGNORE INTO project_members(project_id,member_id,role,joined_at) VALUES(?,?,?,?)');
      for (const member of members) addMembership.run(defaultProject.id, member.id, member.role === 'admin' ? 'admin' : 'member', now());
    }
    if (defaultProject) {
      for (const table of ['messages', 'deliveries', 'tasks', 'events']) connection.prepare(`UPDATE ${table} SET project_id=? WHERE project_id IS NULL`).run(defaultProject.id);
      connection.prepare('UPDATE invites SET project_id=? WHERE project_id IS NULL').run(defaultProject.id);
      const legacyFiles = connection.prepare(`SELECT file_path,member_id FROM messages WHERE file_path IS NOT NULL AND file_path!=''
        UNION SELECT file_path,member_id FROM deliveries WHERE file_path IS NOT NULL AND file_path!=''`).all();
      const addFile = connection.prepare('INSERT OR IGNORE INTO project_files(file_path,project_id,uploaded_by,created_at) VALUES(?,?,?,?)');
      for (const file of legacyFiles) addFile.run(file.file_path, defaultProject.id, file.member_id, now());
    }

    const demo = process.env.NODE_ENV !== 'production' && process.env.APP_DEMO_DATA !== 'false';
    const memberIds = connection.prepare('SELECT id FROM members ORDER BY id').all().map((row) => row.id);
    const stamp = now();
    if (demo && memberIds.length === 1) {
      const insertMember = connection.prepare('INSERT OR IGNORE INTO members(name,initials,tone,email) VALUES(?,?,?,?)');
      insertMember.run('Léo Malfait', 'LM', 'lm', 'leo@example.local');
      insertMember.run('Antoine Janssens', 'AJ', 'aj', 'antoine@example.local');
      if (defaultProject) {
        const demoMembers = connection.prepare("SELECT id FROM members WHERE email IN ('leo@example.local','antoine@example.local')").all();
        const addDemoMembership = connection.prepare("INSERT OR IGNORE INTO project_members(project_id,member_id,role,joined_at) VALUES(?,?,'member',?)");
        for (const member of demoMembers) addDemoMembership.run(defaultProject.id, member.id, now());
      }
    }
    const ids = connection.prepare('SELECT id FROM members ORDER BY id').all().map((row) => row.id);
    if (demo && connection.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 0 && ids.length) {
      const insert = connection.prepare('INSERT INTO messages(project_id,member_id,body,file_name,created_at) VALUES(?,?,?,?,?)');
      insert.run(defaultProject?.id, ids[0], 'Bonjour à tous ! On se retrouve à 14 h pour faire le point sur le projet.\nVous pouvez partager vos premières idées ici avant notre échange.', null, stamp);
      insert.run(defaultProject?.id, ids[1] || ids[0], 'Voici mes premières pistes pour l’espace commun.\nJ’ai travaillé sur un lieu ouvert, simple et accueillant. Qu’en pensez-vous ?', 'Premières pistes.pdf', stamp);
      insert.run(defaultProject?.id, ids[2] || ids[0], 'J’aime beaucoup cette direction ! La circulation est vraiment fluide.\nJe prépare quelques références de matériaux pour en discuter cet après-midi.', null, stamp);
    }
    if (demo && connection.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n === 0 && ids.length) {
      const insert = connection.prepare('INSERT INTO deliveries(project_id,member_id,title,description,file_name,status,created_at) VALUES(?,?,?,?,?,?,?)');
      insert.run(defaultProject?.id, ids[0], 'Plan masse et circulation — version 02', 'Plan du projet', 'PDF · 2,4 Mo', 'À valider', stamp);
      insert.run(defaultProject?.id, ids[1] || ids[0], 'Premières pistes d’aménagement — version 01', 'Propositions pour l’espace commun', 'PDF · 1,8 Mo', 'En cours', stamp);
      insert.run(defaultProject?.id, ids[2] || ids[0], 'Palette de matériaux — sélection finale', 'Sélection des finitions', 'PDF · 3,1 Mo', 'Terminé', stamp);
    }
    if (demo && connection.prepare('SELECT COUNT(*) AS n FROM tasks').get().n === 0) {
      const insert = connection.prepare('INSERT INTO tasks(project_id,title,assignee,due_date,created_at) VALUES(?,?,?,?,?)');
      insert.run(defaultProject?.id, 'Valider le concept d’espace commun', 'Killian Garnier', '2026-10-07', stamp);
      insert.run(defaultProject?.id, 'Partager les références de matériaux', 'Antoine Janssens', '2026-10-07', stamp);
      insert.run(defaultProject?.id, 'Finaliser le plan masse', 'Killian Garnier', '2026-10-09', stamp);
      insert.run(defaultProject?.id, 'Préparer l’atelier de co-création', 'Léo Malfait', '2026-10-14', stamp);
    }
    if (demo && connection.prepare('SELECT COUNT(*) AS n FROM events').get().n === 0) {
      const insert = connection.prepare('INSERT INTO events(project_id,title,date,time,created_at) VALUES(?,?,?,?,?)');
      insert.run(defaultProject?.id, 'Point d’équipe', '2026-10-07', '14:00 – 14:45', stamp);
      insert.run(defaultProject?.id, 'Rendu des premières pistes', '2026-10-09', 'Avant 18:00', stamp);
      insert.run(defaultProject?.id, 'Atelier de co-création', '2026-10-14', '10:00 – 12:00', stamp);
    }
  });
  migrateAndSeed.immediate();
  instance = connection;
  return instance;
}

function stampNow() { return new Date().toISOString(); }

export const db = new Proxy({}, {
  get(_target, property) {
    const connection = initialize();
    const value = connection[property];
    return typeof value === 'function' ? value.bind(connection) : value;
  },
});
