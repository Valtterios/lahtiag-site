import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { addEventPhoto, deleteEventPhoto, RuleError } from '../../../lib/db';
import { later, postPhotosNotice } from '../../../lib/event-channel';

// Board: add photos of an event (several at once, each with the thumbnail
// the browser made), or remove one.

export const POST: APIRoute = async ({ request, params, redirect, locals, url }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const now = Math.floor(Date.now() / 1000);
  try {
    if (form.get('action') === 'remove') {
      const photo = Number(form.get('photo_id'));
      if (!Number.isInteger(photo) || !(await deleteEventPhoto(env.DB, id, photo))) return redirect(`${back}?err=missing`, 303);
      return redirect(`${back}?ok=photo_removed#photos`, 303);
    }
    const files = form.getAll('photos').filter((f): f is File => f instanceof File && f.size > 0);
    const thumbs = form.getAll('thumbs').filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) return redirect(`${back}?err=photo_missing`, 303);
    const added: number[] = [];
    for (let i = 0; i < files.length; i++) {
      const thumb = thumbs[i] ? await thumbs[i].arrayBuffer() : null;
      added.push(await addEventPhoto(env.DB, id, files[i].type, await files[i].arrayBuffer(), thumb, now + i));
    }
    // A few of them go to the event's channel, or the general channel.
    later(locals.cfContext, postPhotosNotice(env.DB, env, id, added, url.origin));
    return redirect(`${back}?ok=photos_added#photos`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code === 'bad_input' ? 'photo_bad' : error.code}`, 303);
    throw error;
  }
};
