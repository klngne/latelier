import { handleApi } from '../runtime-handler';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (request) => handleApi(request, 'GET');
