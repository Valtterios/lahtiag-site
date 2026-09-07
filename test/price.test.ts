import { describe, it, expect } from 'vitest';
import { euro, ticketPrice, ticketRange, seatsLeft, isFull } from '../src/lib/price';
import type { EventWithCounts } from '../src/lib/db';

// What the events page and the shop say a seat costs, from the counts
// that come with an event row.

const event = (over: Partial<EventWithCounts> = {}): EventWithCounts =>
  ({
    id: 1,
    title: 'LAN',
    capacity: null,
    team_size: null,
    members_only: 0,
    yes_count: 0,
    maybe_count: 0,
    teams_count: 0,
    interest_count: 0,
    ticket_types: 0,
    from_cents: null,
    from_member_cents: null,
    to_cents: null,
    to_member_cents: null,
    ...over,
  }) as EventWithCounts;

describe('what a ticket costs', () => {
  it('says how to get in on the events page', () => {
    expect(euro(850)).toBe('8.50 €');
    expect(ticketPrice(event())).toBe('Free · sign up');
    // Tickets on sale, all of them free.
    expect(ticketPrice(event({ ticket_types: 1 }))).toBe('Free ticket');
    expect(ticketPrice(event({ ticket_types: 1, from_cents: 800, from_member_cents: 800, to_cents: 800, to_member_cents: 800 }))).toBe('8.00 €');
    expect(ticketPrice(event({ ticket_types: 1, from_cents: 800, from_member_cents: 500, to_cents: 800, to_member_cents: 500 }))).toBe('8.00 € · members 5.00 €');
    // Several types: the cheapest, said as a starting price.
    expect(ticketPrice(event({ ticket_types: 3, from_cents: 800, from_member_cents: 500, to_cents: 1400, to_member_cents: 1100 }))).toBe('From 8.00 € · members 5.00 €');
  });

  it('gives the shop the range', () => {
    expect(ticketRange(event({ ticket_types: 1 }))).toEqual({ price: 'Free ticket', member: null });
    expect(ticketRange(event({ ticket_types: 1, from_cents: 800, to_cents: 800, from_member_cents: 800, to_member_cents: 800 }))).toEqual({ price: '8.00 €', member: null });
    expect(ticketRange(event({ ticket_types: 3, from_cents: 800, to_cents: 1400, from_member_cents: 500, to_member_cents: 1100 }))).toEqual({
      price: '8.00 € – 14.00 €',
      member: 'members 5.00 € – 11.00 €',
    });
    // One members' price for every type.
    expect(ticketRange(event({ ticket_types: 2, from_cents: 800, to_cents: 1400, from_member_cents: 500, to_member_cents: 500 }))).toEqual({
      price: '8.00 € – 14.00 €',
      member: 'members 5.00 €',
    });
  });

  it('counts the seats left, teams for a team event', () => {
    expect(seatsLeft(event())).toBeNull();
    expect(seatsLeft(event({ capacity: 38, yes_count: 12 }))).toBe(38 - 12);
    expect(seatsLeft(event({ capacity: 8, teams_count: 4, yes_count: 16, team_size: 5 }))).toBe(4);
    // Over capacity (the board let someone in anyway) is none left, never negative.
    expect(seatsLeft(event({ capacity: 12, yes_count: 13 }))).toBe(0);
    expect(isFull(event({ capacity: 12, yes_count: 12 }))).toBe(true);
    expect(isFull(event({ capacity: 12, yes_count: 11 }))).toBe(false);
    expect(isFull(event())).toBe(false);
  });
});
