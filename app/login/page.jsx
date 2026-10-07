'use client';
import { useState } from 'react';

export default function LoginPage() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    const form = new FormData(e.currentTarget);
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Connexion impossible.');
      window.location.assign('/');
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return <main className="authPage"><section className="authCard"><div className="authBrand"><span className="logo">Ⅱ</span><b>L’atelier</b></div><h1>Content de vous revoir</h1><p>Connectez-vous à votre espace de travail.</p><form onSubmit={submit}><label>Adresse e-mail<input type="email" name="email" autoComplete="username" required autoFocus/></label><label>Mot de passe<input type="password" name="password" autoComplete="current-password" required/></label>{error&&<div className="authError" role="alert">{error}</div>}<button className="btn primary authSubmit" disabled={busy}>{busy?'Connexion…':'Se connecter'}</button></form><small className="authFoot"><a href="/register">Créer un compte et un projet</a></small></section></main>;
}
