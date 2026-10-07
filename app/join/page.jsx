'use client';
import { useEffect, useState } from 'react';

function JoinForm() {
  const [token, setToken] = useState('');
  useEffect(() => setToken(new URLSearchParams(window.location.search).get('token') || ''), []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password'));
    if (password !== form.get('confirm')) { setError('Les mots de passe ne correspondent pas.'); setBusy(false); return; }
    try {
      const response = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, name: form.get('name'), password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Inscription impossible.');
      window.location.assign('/');
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return <main className="authPage"><section className="authCard"><div className="authBrand"><span className="logo">Ⅱ</span><b>L’atelier</b></div><h1>Rejoindre un projet</h1><p>Choisissez un mot de passe d’au moins 12 caractères. Si vous avez déjà un compte, saisissez votre mot de passe actuel.</p>{token?<form onSubmit={submit}><label>Votre nom<input name="name" autoComplete="name" minLength="2" required autoFocus/></label><label>Mot de passe<input type="password" name="password" autoComplete="new-password" minLength="12" required/></label><label>Confirmer le mot de passe<input type="password" name="confirm" autoComplete="new-password" minLength="12" required/></label>{error&&<div className="authError" role="alert">{error}</div>}<button className="btn primary authSubmit" disabled={busy}>{busy?'Ajout au projet…':'Rejoindre le projet'}</button></form>:<div className="authError">Le lien d’invitation est manquant. Demandez un nouveau lien à l’administrateur.</div>}</section></main>;
}

export default function JoinPage() { return <JoinForm/>; }
