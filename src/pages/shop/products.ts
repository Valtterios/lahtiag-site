import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { RuleError } from '../../lib/db';
import { createProduct, updateProduct } from '../../lib/purchases';

// Board: add or change a product. Prices arrive in euros.

const cents = (raw: FormDataEntryValue | null): number | null => {
  const text = String(raw ?? '').trim().replace(',', '.');
  if (text === '') return null;
  const value = Math.round(Number(text) * 100);
  return Number.isFinite(value) ? value : NaN;
};

export const POST: APIRoute = async ({ request, redirect }) => {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/shop?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/shop?err=csrf', 303);

  const price = cents(form.get('price'));
  const memberPrice = cents(form.get('member_price'));
  const stockRaw = String(form.get('stock') ?? '').trim();
  const stock = stockRaw === '' ? null : Number(stockRaw);
  if (price === null || Number.isNaN(price) || Number.isNaN(memberPrice)) return redirect('/shop?err=bad_input', 303);
  const input = {
    name: String(form.get('name') ?? ''),
    description: String(form.get('description') ?? ''),
    price_cents: price,
    member_price_cents: memberPrice,
    stock,
    active: form.get('active') === 'on',
  };
  const now = Math.floor(Date.now() / 1000);
  try {
    if (form.get('action') === 'update') {
      const id = Number(form.get('id'));
      if (!Number.isInteger(id)) return redirect('/shop?err=bad_input', 303);
      await updateProduct(env.DB, id, input);
    } else {
      await createProduct(env.DB, input, now);
    }
  } catch (error) {
    if (error instanceof RuleError) return redirect(`/shop?err=${error.code}`, 303);
    throw error;
  }
  return redirect('/shop?ok=product_saved', 303);
};
