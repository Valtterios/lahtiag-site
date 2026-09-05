import type { APIRoute } from 'astro';

// The old Google Sites address that search results still carry. A
// permanent redirect home, so the result works and Google learns the
// real address.
export const GET: APIRoute = ({ redirect }) => redirect('/', 301);
