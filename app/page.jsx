import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Workspace from './workspace.jsx';
import { SESSION_COOKIE, PROJECT_COOKIE } from '../lib/cookies.js';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const jar = await cookies();
  if (process.env.VERCEL) {
    const { vercelHomeUser, vercelHomeProject } = await import('../lib/vercel-store.js');
    const user = await vercelHomeUser(jar.get(SESSION_COOKIE)?.value);
    if (!user) redirect('/login');
    const project = await vercelHomeProject(user.id, jar.get(PROJECT_COOKIE)?.value);
    if (!project) redirect('/login');
    return <Workspace user={{ ...user, role: project.role }} project={project} />;
  }
  const { userFromToken, projectForUser } = await import('../lib/auth.js');
  const user = userFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!user) redirect('/login');
  const project = projectForUser(user.id, Number(jar.get(PROJECT_COOKIE)?.value) || null);
  if (!project) redirect('/login');
  return <Workspace user={{ ...user, role: project.role }} project={project} />;
}
