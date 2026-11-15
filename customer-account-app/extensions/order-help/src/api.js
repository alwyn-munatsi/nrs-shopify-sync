// Talks to the 705 BRBR Worker (/account/*). Shopify's session token proves which customer is signed in.
export const API = 'https://brbr-murray.munatsialwyn26.workers.dev';
export const STORE = 'https://705brbr.org';
export const ACCOUNT = 'https://shopify.com/85105541419/account';

export async function api(path, body) {
  if (inEditor() && !body) return SAMPLE;
  const token = await shopify.sessionToken.get();
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || 'Something went wrong. Please try again.');
    e.status = r.status;
    e.data = data;
    throw e;
  }
  return data;
}

export function prettyPhone(e164) {
  const d = String(e164 || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164 || '';
}

export function prettyDate(iso, withYear = true) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}

export function money(m) {
  if (!m) return '';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currencyCode || 'USD' }).format(Number(m.amount)); }
  catch { return `$${Number(m.amount).toFixed(2)}`; }
}

/** Store hours: 6:00 AM to 12:00 AM (midnight), every day, New York time. */
export function isOpenNow(date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(date));
  return hour >= 6;
}

/** Link that adds items to the 705brbr.org cart (the site's normal age check still applies). */
export function reorderUrl(items) {
  const list = (items || []).filter((i) => i.variantId).map((i) => `${i.variantId}:${Math.max(1, Math.min(99, i.quantity || 1))}`);
  return list.length ? `${STORE}/cart?brbr_reorder=${encodeURIComponent(list.join(','))}` : `${STORE}/collections/all`;
}

/** True inside Settings > Checkout > Customize (the editor shows a sample customer, not a real sign-in). */
export function inEditor() {
  try { return Boolean(shopify.extension && shopify.extension.editor); } catch { return false; }
}

/** Example account shown only in the editor, so the layout can be previewed. */
export const SAMPLE = {
  firstName: 'Alex', lastName: 'Sample', email: 'alex@example.com', phone: '+12125550123', gender: 'Prefer not to say',
  birthDate: '1990-05-12', ageVerified: true, memberSince: '2026-11-01T12:00:00Z', ordersCount: 2,
  amountSpent: { amount: '38.47', currencyCode: 'USD' },
  welcomeOffer: { code: 'WELCOME10', percent: 10, available: false },
  orders: [
    { id: '0', name: '#1004', createdAt: '2026-11-03T16:04:00Z', cancelled: false, financial: 'PAID', fulfillment: 'FULFILLED', total: { amount: '5.98', currencyCode: 'USD' }, method: 'Pickup', items: [{ title: 'Roasted Almond Blend', quantity: 2, variantId: '', available: true }] },
  ],
  favorites: [],
};

/** Short, plain reason for a failed request (shown under the message to help fix setup problems). */
export function reason(e) {
  const m = String((e && e.message) || '');
  if (e && e.status === 401 && /signature|Wrong app/i.test(m)) return 'Setup: the app secret on the Worker does not match (ACCOUNT_APP_CLIENT_SECRET).';
  if (e && e.status === 401 && /sign in/i.test(m)) return 'Shopify did not say which customer is signed in (the app needs customer access).';
  if (e && e.status === 401) return `Sign-in check failed: ${m}`;
  if (e && e.status === 503) return 'Setup: the Worker is missing its account settings.';
  if (e && !e.status) return 'Could not reach the 705 BRBR service.';
  return m;
}
