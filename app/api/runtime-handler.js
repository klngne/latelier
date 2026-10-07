export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function handleApi(request, method) {
  const implementation = process.env.VERCEL
    ? await import('../../lib/vercel-store.js')
    : await import('../../lib/local-api.js');

  return process.env.VERCEL
    ? implementation.vercelDispatch(request, method)
    : implementation.localHandler(request, method);
}
