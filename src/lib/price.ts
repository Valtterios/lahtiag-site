// What a ticket costs, said in one line. The events list wants the entry
// price ("From 8.00 €, members 5.00 €"), the shop the whole range
// ("8.00 – 14.00 €"); both read the counts that come with an event row, so
// neither page has to ask the database about ticket types itself.
import type { EventWithCounts } from './db';

export function euro(cents: number): string {
  return `${(cents / 100).toFixed(2)} €`;
}

// A tile on the events page: free to sign up, a free ticket, or the
// cheapest seat with the members' price beside it.
export function ticketPrice(event: EventWithCounts): string {
  if (event.ticket_types === 0) return 'Free · sign up';
  if (event.from_cents === null) return 'Free ticket';
  const from = event.ticket_types > 1 ? 'From ' : '';
  const member = event.from_member_cents !== null && event.from_member_cents < event.from_cents ? ` · members ${euro(event.from_member_cents)}` : '';
  return `${from}${euro(event.from_cents)}${member}`;
}

// The shop, where an event sits beside the patches: the range of what a
// seat costs, and the members' range under it when it differs.
export function ticketRange(event: EventWithCounts): { price: string; member: string | null } {
  if (event.from_cents === null || event.to_cents === null) return { price: 'Free ticket', member: null };
  const price = event.from_cents === event.to_cents ? euro(event.from_cents) : `${euro(event.from_cents)} – ${euro(event.to_cents)}`;
  const from = event.from_member_cents;
  const to = event.to_member_cents;
  if (from === null || to === null || (from === event.from_cents && to === event.to_cents)) return { price, member: null };
  return { price, member: from === to ? `members ${euro(from)}` : `members ${euro(from)} – ${euro(to)}` };
}

// How many places are left, and whether that is none.
export function seatsLeft(event: EventWithCounts): number | null {
  if (event.capacity === null) return null;
  const taken = event.team_size !== null ? event.teams_count : event.yes_count;
  return Math.max(0, event.capacity - taken);
}

export function isFull(event: EventWithCounts): boolean {
  return seatsLeft(event) === 0;
}
