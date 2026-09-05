import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { getTicketType } from '../../../../lib/db';
import { readBasket, writeBasket, withLine } from '../../../../lib/basket';

// What the door's sales QR encodes: one ticket of this type goes in the
// basket (once) and the buyer lands on the checkout on their own phone.

export const GET: APIRoute = async ({ params, redirect, cookies }) => {
  const id = Number(params.id);
  const typeId = Number(params.type);
  const type = Number.isInteger(typeId) ? await getTicketType(env.DB, typeId) : null;
  if (!type || type.event_id !== id || type.active !== 1) return redirect(`/events/${Number.isInteger(id) ? id : ''}`, 303);
  const basket = readBasket(cookies);
  if (!basket.some((l) => l.kind === 'ticket' && l.id === typeId)) {
    writeBasket(cookies, withLine(basket, { kind: 'ticket', id: typeId, count: 1 }));
  }
  return redirect('/checkout', 303);
};
