import type { APIRoute } from 'astro';
import { DISCORD_INVITE } from '../lib/config';

// lahtiag.fi/dc — the short way into the Discord, for posters, slides and
// saying out loud. A temporary redirect on purpose: the invite behind it
// can be replaced without browsers having cached the old one for good.
export const GET: APIRoute = ({ redirect }) => redirect(DISCORD_INVITE, 302);
