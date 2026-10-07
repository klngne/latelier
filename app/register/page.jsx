'use client';
import { useState } from 'react';

export default function RegisterPage() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    const form = new FormData(e.currentTarget), password = String(form.get('password'));
    if (password !== form.get('confirm')) { setError('Les mots de passe ne correspondent pas.'); setBusy(false); return; }
    try {
      const response = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: form.get('name'), email: form.get('email'), project_name: form.get('project_name'), password }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Inscription impossible.');
      window.location.assign('/');
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return <main className="authPage"><section className="authCard"><div className="authBrand"><span className="logo">Ⅱ</span><b>L’atelier</b></div><h1>Créez votre espace</h1><p>Votre compte démarre avec un projet privé que vous pourrez partager.</p><form onSubmit={submit}><label>Votre nom<input name="name" autoComplete="name" minLength="2" required autoFocus/></label><label>Adresse e-mail<input type="email" name="email" autoComplete="email" required/></label><label>Nom du premier projet<input name="project_name" minLength="2" maxLength="80" placeholder="Ex. Collectif design" required/></label><label>Mot de passe<input type="password" name="password" autoComplete="new-password" minLength="12" required/></label><label>Confirmer le mot de passe<input type="password" name="confirm" autoComplete="new-password" minLength="12" required/></label>{error&&<div className="authError" role="alert">{error}</div>}<button className="btn primary authSubmit" disabled={busy}>{busy?'Création du compte…':'Créer mon espace'}</button></form><small className="authFoot"><a href="/login">J’ai déjà un compte · Se connecter</a></small></section></main>;
}
