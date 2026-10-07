import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());
const { db, passwordHash } = await import('../lib/db.js');

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!email || !password || password.length < 16) {
  console.error('Définissez ADMIN_EMAIL et ADMIN_PASSWORD (16 caractères minimum) dans l’environnement.');
  process.exit(1);
}
const admin = db.prepare("SELECT id FROM members WHERE lower(email)=? AND role='admin'").get(email);
if (!admin) {
  console.error('Aucun compte administrateur correspondant à ADMIN_EMAIL.');
  process.exit(1);
}
db.transaction(() => {
  db.prepare('UPDATE members SET password_hash=?,active=1 WHERE id=?').run(passwordHash(password), admin.id);
  db.prepare('DELETE FROM sessions WHERE member_id=?').run(admin.id);
})();
console.log(`Mot de passe réinitialisé pour ${email}. Les sessions existantes ont été fermées.`);
