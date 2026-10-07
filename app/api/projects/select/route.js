import { handleApi } from '../../runtime-handler';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = (request) => handleApi(request, 'POST');
