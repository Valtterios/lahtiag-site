import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createProduct, listProducts, getProduct, productOffer, deleteProduct, createPurchase, updateProduct } from '../src/lib/purchases';

// Products off the menu: deleted ones vanish everywhere but keep their
// purchases; ones not on sale stay listed as out of stock.

const NOW = 1_760_000_000;
const db = () => env.DB;
const input = { name: 'Patch', description: '', price_cents: 300, member_price_cents: null, stock: 5, active: true };

describe('products', () => {
  beforeEach(async () => {
    for (const table of ['purchase_items', 'purchases', 'product_images', 'products']) await db().prepare(`DELETE FROM ${table}`).run();
  });

  it('lists what is not on sale only when asked, and never a deleted one', async () => {
    const onSale = await createProduct(db(), input, NOW);
    const off = await createProduct(db(), { ...input, name: 'Sticker', active: false }, NOW);
    expect((await listProducts(db(), NOW)).map((p) => p.id)).toEqual([onSale]);
    expect((await listProducts(db(), NOW, true)).map((p) => p.id).sort()).toEqual([onSale, off].sort());
    expect((await productOffer(db(), (await getProduct(db(), off, NOW))!, null)).ok).toBe(false);
    await deleteProduct(db(), onSale, NOW);
    expect(await getProduct(db(), onSale, NOW)).toBeNull();
    expect((await listProducts(db(), NOW, true)).map((p) => p.id)).toEqual([off]);
  });

  it('keeps a product that was bought, hidden, so the purchase still names it', async () => {
    const id = await createProduct(db(), input, NOW);
    const product = (await getProduct(db(), id, NOW))!;
    const created = await createPurchase(db(), { buyer: null, buyerName: 'Guest', status: 'paid', lines: [{ kind: 'item', product, quantity: 1 }] }, NOW);
    await deleteProduct(db(), id, NOW + 5);
    expect(await getProduct(db(), id, NOW)).toBeNull();
    expect(await listProducts(db(), NOW, true)).toEqual([]);
    const row = await db().prepare('SELECT deleted_at, active FROM products WHERE id = ?1').bind(id).first<{ deleted_at: number; active: number }>();
    expect(row).toEqual({ deleted_at: NOW + 5, active: 0 });
    const item = await db().prepare('SELECT product_id FROM purchase_items WHERE purchase_id = ?1').bind(created.purchase.id).first<{ product_id: number }>();
    expect(item?.product_id).toBe(id);
    await expect(deleteProduct(db(), id, NOW)).rejects.toMatchObject({ code: 'missing' });
    await expect(updateProduct(db(), 999, input)).rejects.toMatchObject({ code: 'missing' });
  });
});
