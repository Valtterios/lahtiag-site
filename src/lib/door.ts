// The door's attach form, read and reported. One payment can pay for
// several things, so the form posts a line per thing: what it was
// (`ticket:<id>`, `ticket:<id>:m` for the members' price, `item:<id>`,
// `item:<id>:m`), a name for a ticket and a quantity for an item. The
// shop's own page posts item lines only.
import type { DoorLine, DoorAttachment } from './purchases';

export const MAX_DOOR_LINES = 8;

export function doorLines(form: FormData, buyerName: string, itemsOnly = false): DoorLine[] {
  const whats = form.getAll('line_what').map(String);
  const names = form.getAll('line_name').map(String);
  const quantities = form.getAll('line_qty').map(String);
  const lines: DoorLine[] = [];
  whats.forEach((what, i) => {
    const [kind, idText, variant] = what.split(':');
    const id = Number(idText);
    if (!Number.isInteger(id) || id < 1 || lines.length >= MAX_DOOR_LINES) return;
    const members = variant === 'm';
    if (kind === 'ticket' && !itemsOnly) {
      lines.push({ kind: 'ticket', typeId: id, name: (names[i] ?? '').replace(/\s+/g, ' ').trim() || buyerName, members });
    } else if (kind === 'item') {
      const quantity = Math.min(10, Math.max(1, Math.floor(Number(quantities[i])) || 1));
      lines.push({ kind: 'item', productId: id, quantity, members });
    }
  });
  return lines;
}

// What the board is told it just did, in the flash line: names for the
// tickets, "2 × Sticker sheet" for the items.
export function attachSummary(made: DoorAttachment): string {
  const parts = [
    ...made.tickets.map((t) => t.holder_name),
    ...made.items.map((i) => (i.quantity > 1 ? `${i.quantity} × ${i.name}` : i.name)),
  ];
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
