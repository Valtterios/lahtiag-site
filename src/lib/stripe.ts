// Stripe, without the SDK: three REST calls and the webhook signature.
// Money never touches the site; Stripe's hosted Checkout takes the card,
// the webhook tells us it went through. Off until STRIPE_SECRET_KEY and
// STRIPE_WEBHOOK_SECRET exist; callers show "payments not set up".

const API = 'https://api.stripe.com/v1';
// Pinned so the account's default version can move without changing what
// this code sees. Bump deliberately, with the changelog open.
const API_VERSION = '2026-08-26.dahlia';
// Tags Checkout sessions in the Dashboard's analytics.
const INTEGRATION_IDENTIFIER = 'lahtiag_tickets_qmzrwbtk';

export interface StripeConfig {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

export function stripeConfigured(env: StripeConfig): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

// Stripe's REST API takes form-encoded bodies with bracket notation for
// nesting: line_items[0][price_data][unit_amount]=1000.
function encode(params: Record<string, string | number | boolean | null | undefined>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    body.set(key, String(value));
  }
  return body.toString();
}

export interface CheckoutInput {
  amountCents: number;
  productName: string;
  description?: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  clientReferenceId: string;
  expiresInSeconds?: number; // Stripe: 30 minutes to 24 hours
  askName?: boolean; // door sales by QR: the buyer types their name on Stripe's page
  customerEmail?: string;
}

export async function createCheckoutSession(
  secretKey: string,
  input: CheckoutInput,
  now = Math.floor(Date.now() / 1000),
): Promise<{ id: string; url: string } | null> {
  const params: Record<string, string | number | undefined> = {
    mode: 'payment',
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': 'eur',
    'line_items[0][price_data][unit_amount]': input.amountCents,
    'line_items[0][price_data][product_data][name]': input.productName,
    'line_items[0][price_data][product_data][description]': input.description,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.clientReferenceId,
    // Stripe demands at least 30 minutes ahead; a little margin covers clock skew.
    expires_at: now + Math.max(1800 + 120, Math.min(input.expiresInSeconds ?? 1800, 86400)),
    customer_email: input.customerEmail,
    locale: 'auto',
    integration_identifier: INTEGRATION_IDENTIFIER,
  };
  for (const [k, v] of Object.entries(input.metadata)) {
    params[`metadata[${k}]`] = v;
    // Copied onto the PaymentIntent and its charge as well: refunds and
    // payment_intent.succeeded then identify the ticket on their own.
    params[`payment_intent_data[metadata][${k}]`] = v;
  }
  params['payment_intent_data[description]'] = input.productName.slice(0, 200);
  if (input.askName) {
    params['custom_fields[0][key]'] = 'holder_name';
    params['custom_fields[0][label][type]'] = 'custom';
    params['custom_fields[0][label][custom]'] = 'Name on the ticket';
    params['custom_fields[0][type]'] = 'text';
  }
  try {
    const response = await fetch(`${API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'stripe-version': API_VERSION,
      },
      body: encode(params),
    });
    if (!response.ok) {
      // Stripe's error message says what is wrong (a missing key
      // permission, a bad parameter); it goes to the Worker log, never to
      // the visitor. Read with `npx wrangler tail`.
      const text = await response.text().catch(() => '');
      console.error(`stripe checkout session failed: ${response.status} ${text.slice(0, 500)}`);
      return null;
    }
    const session = (await response.json()) as { id?: string; url?: string };
    return session.id && session.url ? { id: session.id, url: session.url } : null;
  } catch (error) {
    console.error(`stripe checkout session threw: ${String(error).slice(0, 300)}`);
    return null;
  }
}

// Stripe-Signature: t=<unix>,v1=<hex hmac of "<t>.<payload>">[,v1=...]
// HMAC-SHA256 with the endpoint's signing secret; a few minutes of
// tolerance against replay.
export async function verifyWebhookSignature(
  secret: string,
  payload: string,
  header: string | null,
  now = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!header) return false;
  const parts = new Map<string, string[]>();
  for (const piece of header.split(',')) {
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    const k = piece.slice(0, eq).trim();
    const v = piece.slice(eq + 1).trim();
    parts.set(k, [...(parts.get(k) ?? []), v]);
  }
  const t = Number(parts.get('t')?.[0]);
  const signatures = parts.get('v1') ?? [];
  if (!Number.isFinite(t) || signatures.length === 0) return false;
  if (Math.abs(now - t) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)),
  );
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  // Constant-time comparison against each candidate.
  for (const candidate of signatures) {
    if (candidate.length !== expected.length) continue;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
    if (diff === 0) return true;
  }
  return false;
}

// The subset of a Stripe event the webhook route acts on.
export interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      object: string;
      payment_intent?: string | null;
      payment_status?: 'paid' | 'unpaid' | 'no_payment_required';
      client_reference_id?: string | null;
      metadata?: Record<string, string>;
      amount_total?: number | null;
      amount?: number | null;
      amount_refunded?: number | null;
      refunded?: boolean;
      custom_fields?: { key: string; text?: { value?: string | null } }[];
      customer_details?: { email?: string | null; name?: string | null };
    };
  };
}

// The name typed on Stripe's page for door sales by QR.
export function holderNameFromSession(session: StripeEvent['data']['object']): string | null {
  const field = session.custom_fields?.find((f) => f.key === 'holder_name');
  const typed = field?.text?.value?.trim();
  if (typed) return typed.slice(0, 60);
  const cardName = session.customer_details?.name?.trim();
  return cardName ? cardName.slice(0, 60) : null;
}

// Signature-only sanity for the metadata we set ourselves.
export function metadataInt(metadata: Record<string, string> | undefined, key: string): number | null {
  const value = Number(metadata?.[key]);
  return Number.isInteger(value) ? value : null;
}
