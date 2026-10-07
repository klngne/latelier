export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handler(request, method) {
  const implementation = process.env.VERCEL
    ? await import('../../../lib/vercel-store.js')
    : await import('../../../lib/local-api.js');
  return process.env.VERCEL
    ? implementation.vercelDispatch(request, method)
    : implementation.localHandler(request, method);
}
export const GET = (request) => handler(request, 'GET');
export const POST = (request) => handler(request, 'POST');
export const PATCH = (request) => handler(request, 'PATCH');
