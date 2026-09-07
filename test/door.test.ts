import { describe, it, expect } from 'vitest';
import { doorLines, attachSummary, MAX_DOOR_LINES } from '../src/lib/door';

// The door's attach form: what the board picked, line by line.

function form(pairs: [string, string][]): FormData {
  const data = new FormData();
  for (const [key, value] of pairs) data.append(key, value);
  return data;
}

describe('the lines of an attach form', () => {
  it('reads a ticket and an item, with the payer as the default name', () => {
    const lines = doorLines(
      form([
        ['line_what', 'ticket:3'],
        ['line_name', ''],
        ['line_qty', '1'],
        ['line_what', 'item:7:m'],
        ['line_name', ''],
        ['line_qty', '3'],
      ]),
      'Pekka K',
    );
    expect(lines).toEqual([
      { kind: 'ticket', typeId: 3, name: 'Pekka K', members: false, quantity: 1 },
      { kind: 'item', productId: 7, quantity: 3, members: true },
    ]);
  });

  it('counts two of the same on one line', () => {
    expect(doorLines(form([['line_what', 'ticket:3'], ['line_name', ''], ['line_qty', '2']]), 'Pekka K')).toEqual([
      { kind: 'ticket', typeId: 3, name: 'Pekka K', members: false, quantity: 2 },
    ]);
  });

  it('keeps a name of its own, caps the quantity and drops nonsense', () => {
    const lines = doorLines(
      form([
        ['line_what', 'ticket:3:m'],
        ['line_name', '  Sanna  R '],
        ['line_qty', '1'],
        ['line_what', 'item:7'],
        ['line_name', ''],
        ['line_qty', '99'],
        ['line_what', 'nope:1'],
        ['line_name', ''],
        ['line_qty', '1'],
        ['line_what', 'item:x'],
        ['line_name', ''],
        ['line_qty', '1'],
      ]),
      'Pekka K',
    );
    expect(lines).toEqual([
      { kind: 'ticket', typeId: 3, name: 'Sanna R', members: true, quantity: 1 },
      { kind: 'item', productId: 7, quantity: 10, members: false },
    ]);
  });

  it('takes no tickets on the shop page, and no more lines than the cap', () => {
    const many: [string, string][] = [];
    for (let i = 0; i < MAX_DOOR_LINES + 3; i++) many.push(['line_what', 'item:1'], ['line_name', ''], ['line_qty', '1']);
    expect(doorLines(form(many), 'Buyer', true)).toHaveLength(MAX_DOOR_LINES);
    expect(doorLines(form([['line_what', 'ticket:3'], ['line_name', ''], ['line_qty', '1']]), 'Buyer', true)).toEqual([]);
  });

  it('says what the payment turned into', () => {
    const ticket = (holder_name: string) => ({ holder_name }) as never;
    const item = (name: string, quantity: number) => ({ name, quantity }) as never;
    expect(attachSummary({ tickets: [], purchase: null, items: [] })).toBe('');
    expect(attachSummary({ tickets: [ticket('Pekka K')], purchase: null, items: [] })).toBe('Pekka K');
    expect(attachSummary({ tickets: [ticket('Pekka K')], purchase: null, items: [item('Patch', 1), item('Sticker sheet', 3)] })).toBe(
      'Pekka K, Patch and 3 × Sticker sheet',
    );
  });
});
