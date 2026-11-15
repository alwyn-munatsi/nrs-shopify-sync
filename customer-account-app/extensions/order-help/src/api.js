// Talks to the 705 BRBR Worker (/account/*). Shopify's session token proves which customer is signed in.
export const API = 'https://brbr-murray.munatsialwyn26.workers.dev';
export const STORE = 'https://705brbr.org';
export const ACCOUNT = 'https://shopify.com/85105541419/account';

export async function api(path, body) {
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
