import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Workspace from './workspace.jsx';
import { SESSION_COOKIE, PROJECT_COOKIE, userFromToken, projectForUser } from '../lib/auth.js';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const jar = await cookies();
  const user = userFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!user) redirect('/login');
  const project = projectForUser(user.id, Number(jar.get(PROJECT_COOKIE)?.value) || null);
  if (!project) redirect('/login');
  return <Workspace user={{ ...user, role: project.role }} project={project} />;
}
