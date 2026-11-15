// 705 BRBR customer account API (used by the "705 BRBR Account Extras" blocks on the customer account pages)
//
//   GET  /account/me          -> the signed-in customer's details, welcome offer status, recent orders, favorites
//   POST /account/update      { phone?, gender? }   -> saves the mobile number / gender
//   POST /account/verify-age  { dob: "YYYY-MM-DD" } -> "Age verified" when the date matches the account (or is
//                                                      added for the first time) and is 21+
//
// Who is asking: every request carries a Shopify session token (Authorization: Bearer ...) that Shopify signs
// with the Account Extras app's client secret (Worker secret ACCOUNT_APP_CLIENT_SECRET). The token's `sub` is the
// signed-in customer, so a customer can only ever read or change their own account. Nothing is trusted from the
// browser except the values being saved, which are validated here.
// Shopify Admin calls use the same token as the website sign-up (SIGNUP_ADMIN_TOKEN).

import { ageOn } from './signup.js';

const API_VERSION = '2026-10';
const GENDERS = ['Female', 'Male', 'Non-binary', 'Prefer not to say'];
export const AGE_MIN = 21;
export const ACCOUNT_MIN_AGE = 13;

// ---------- Session token (HS256 JWT) ----------
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
}
export async function signToken(payload, secret) { // used by the tests
  const head = bytesToB64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${head}.${body}.${bytesToB64url(await hmac(secret, `${head}.${body}`))}`;
}

// Returns { customerId } (numeric string) or throws Error with .status
export async function verifySessionToken(token, env, now = Date.now()) {
  const fail = (msg) => { const e = new Error(msg); e.status = 401; return e; };
  if (!token) throw fail('Missing session token');
  const parts = token.split('.');
  if (parts.length !== 3) throw fail('Bad token');
  const [h, p, s] = parts;
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  } catch { throw fail('Bad token'); }
  if (header.alg !== 'HS256') throw fail('Bad token');
  const expected = bytesToB64url(await hmac(env.ACCOUNT_APP_CLIENT_SECRET, `${h}.${p}`));
  if (expected.length !== s.length) throw fail('Bad signature');
  let diff = 0;
  for (let i = 0; i < s.length; i++) diff |= expected.charCodeAt(i) ^ s.charCodeAt(i);
  if (diff) throw fail('Bad signature');
  const t = Math.floor(now / 1000);
  if (typeof claims.exp === 'number' && t > claims.exp + 10) throw fail('Session expired');
  if (typeof claims.nbf === 'number' && t < claims.nbf - 10) throw fail('Token not valid yet');
  if (env.ACCOUNT_APP_CLIENT_ID && claims.aud && claims.aud !== env.ACCOUNT_APP_CLIENT_ID) throw fail('Wrong app');
  const dest = String(claims.dest || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (env.SHOPIFY_STORE_DOMAIN && dest && dest !== env.SHOPIFY_STORE_DOMAIN) throw fail('Wrong store');
  const m = /^gid:\/\/shopify\/Customer\/(\d+)$/.exec(String(claims.sub || ''));
  if (!m) { const e = new Error('Please sign in.'); e.status = 401; throw e; }
  return { customerId: m[1] };
}

export function accountReady(env) {
  return Boolean(env.ACCOUNT_APP_CLIENT_SECRET && env.SHOPIFY_STORE_DOMAIN && env.SIGNUP_ADMIN_TOKEN);
}

// ---------- Admin API ----------
async function admin(env, f, query, variables) {
  const r = await f(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': env.SIGNUP_ADMIN_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error(`admin ${r.status} ${JSON.stringify(j.errors || '').slice(0, 200)}`);
  return j.data;
}

const ME = `query Me($id: ID!) {
  customer(id: $id) {
    id firstName lastName
    defaultEmailAddress { emailAddress }
    defaultPhoneNumber { phoneNumber }
    numberOfOrders
    amountSpent { amount currencyCode }
    createdAt
    birth: metafield(namespace: "facts", key: "birth_date") { value }
    gender: metafield(namespace: "custom", key: "gender") { value }
    ageVerified: metafield(namespace: "custom", key: "age_verified") { value }
    orders(first: 10, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        shippingLine { title }
        lineItems(first: 30) {
          nodes {
            title quantity
            image { url }
            variant { id price availableForSale product { handle status featuredMedia { preview { image { url } } } } }
          }
        }
      }
    }
  }
}`;
const UPDATE = `mutation($input: CustomerInput!) { customerUpdate(input: $input) { customer { id } userErrors { field message } } }`;
const SET = `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { key } userErrors { field message } } }`;

const numId = (gid) => String(gid || '').split('/').pop();

// Shapes the Admin customer into what the account blocks show (no internal IDs beyond variant numbers).
export function shapeMe(c, now = new Date()) {
  const orders = (c.orders && c.orders.nodes) || [];
  const birth = c.birth && c.birth.value ? String(c.birth.value).slice(0, 10) : '';
  const favorites = new Map();
  for (const o of orders) {
    if (o.cancelledAt) continue;
    for (const li of (o.lineItems && o.lineItems.nodes) || []) {
      const v = li.variant;
      if (!v || !v.product || v.product.status !== 'ACTIVE') continue;
      const key = numId(v.id);
      const prev = favorites.get(key) || {
        variantId: key,
        title: li.title,
        handle: v.product.handle,
        price: v.price,
        available: !!v.availableForSale,
        image: (li.image && li.image.url) || (v.product.featuredMedia && v.product.featuredMedia.preview && v.product.featuredMedia.preview.image && v.product.featuredMedia.preview.image.url) || '',
        bought: 0,
      };
      prev.bought += li.quantity || 1;
      favorites.set(key, prev);
    }
  }
  const ordersCount = Number(c.numberOfOrders || 0);
  return {
    firstName: c.firstName || '',
    lastName: c.lastName || '',
    email: (c.defaultEmailAddress && c.defaultEmailAddress.emailAddress) || '',
    phone: (c.defaultPhoneNumber && c.defaultPhoneNumber.phoneNumber) || '',
    gender: (c.gender && c.gender.value) || '',
    birthDate: birth,
    ageVerified: !!(c.ageVerified && String(c.ageVerified.value) === 'true'),
    memberSince: c.createdAt || '',
    ordersCount,
    amountSpent: c.amountSpent || { amount: '0', currencyCode: 'USD' },
    welcomeOffer: ordersCount === 0 ? { code: 'WELCOME10', percent: 10, available: true } : { code: 'WELCOME10', percent: 10, available: false },
    orders: orders.slice(0, 5).map((o) => ({
      id: numId(o.id),
      name: o.name,
      createdAt: o.createdAt,
      cancelled: !!o.cancelledAt,
      financial: o.displayFinancialStatus || '',
      fulfillment: o.displayFulfillmentStatus || '',
      total: o.totalPriceSet && o.totalPriceSet.shopMoney,
      method: o.shippingLine && o.shippingLine.title ? o.shippingLine.title : '',
      items: ((o.lineItems && o.lineItems.nodes) || []).map((li) => ({
        title: li.title,
        quantity: li.quantity,
        variantId: li.variant ? numId(li.variant.id) : '',
        available: !!(li.variant && li.variant.availableForSale && li.variant.product && li.variant.product.status === 'ACTIVE'),
      })),
    })),
    favorites: [...favorites.values()].filter((f) => f.available).sort((a, b) => b.bought - a.bought).slice(0, 8),
  };
}

// ---------- Validation ----------
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10 || /^[01]/.test(d)) return null;
  return '+1' + d;
}
export function validDob(dob) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dob || '') && !isNaN(Date.parse(dob + 'T00:00:00Z')) && new Date(dob + 'T00:00:00Z').toISOString().slice(0, 10) === dob;
}

// Wrong date-of-birth attempts per customer (per Worker instance): 5 per hour
const ageTries = new Map();
export function ageTriesLeft(id, now = Date.now(), record = false) {
  const list = (ageTries.get(id) || []).filter((t) => now - t < 3600e3);
  if (record) list.push(now);
  ageTries.set(id, list);
  if (ageTries.size > 5000) ageTries.clear();
  return Math.max(0, 5 - list.length);
}

// ---------- Handlers: each returns { status, json } ----------
export async function handleAccount(path, method, env, token, body, deps = {}) {
  const f = deps.fetch || fetch;
  const now = deps.now || Date.now();
  if (!accountReady(env)) return { status: 503, json: { error: 'Account features are not set up yet.' } };
  let who;
  try { who = await verifySessionToken(token, env, now); } catch (e) { return { status: e.status || 401, json: { error: e.message } }; }
  const gid = `gid://shopify/Customer/${who.customerId}`;
  const load = async () => {
    const d = await admin(env, f, ME, { id: gid });
    if (!d.customer) throw new Error('customer not found');
    return d.customer;
  };

  if (path === '/account/me' && method === 'GET') {
    return { status: 200, json: shapeMe(await load(), new Date(now)) };
  }

  if (path === '/account/update' && method === 'POST') {
    const b = body || {};
    const fields = {};
    if ('phone' in b) {
      if (b.phone === '' || b.phone === null) fields.phone = null;
      else {
        const p = normalizePhone(b.phone);
        if (!p) return { status: 422, json: { error: 'Please enter a 10-digit US mobile number.', field: 'phone' } };
        fields.phone = p;
      }
    }
    let gender;
    if ('gender' in b) {
      if (!GENDERS.includes(b.gender)) return { status: 422, json: { error: 'Please choose an option.', field: 'gender' } };
      gender = b.gender;
    }
    if (!('phone' in fields) && !gender) return { status: 400, json: { error: 'Nothing to save.' } };
    if ('phone' in fields) {
      const d = await admin(env, f, UPDATE, { input: { id: gid, phone: fields.phone } });
      const errs = d.customerUpdate.userErrors || [];
      if (errs.length) {
        const taken = errs.some((e) => /taken|already/i.test(e.message));
        return { status: 422, json: { error: taken ? 'That number is already linked to another account.' : 'Please check the mobile number.', field: 'phone' } };
      }
    }
    if (gender) {
      const d = await admin(env, f, SET, { m: [{ ownerId: gid, namespace: 'custom', key: 'gender', type: 'single_line_text_field', value: gender }] });
      if ((d.metafieldsSet.userErrors || []).length) throw new Error('gender: ' + JSON.stringify(d.metafieldsSet.userErrors).slice(0, 200));
    }
    return { status: 200, json: shapeMe(await load(), new Date(now)) };
  }

  if (path === '/account/verify-age' && method === 'POST') {
    const dob = String((body && body.dob) || '').trim();
    if (!validDob(dob)) return { status: 422, json: { error: 'Please enter your date of birth.', field: 'dob' } };
    if (ageTriesLeft(who.customerId, now) <= 0) return { status: 429, json: { error: 'Too many tries. Please try again in an hour, or contact us.' } };
    const c = await load();
    const onFile = c.birth && c.birth.value ? String(c.birth.value).slice(0, 10) : '';
    const today = new Date(now);
    if (onFile && onFile !== dob) {
      const left = ageTriesLeft(who.customerId, now, true);
      return { status: 422, json: { status: 'mismatch', error: "That date doesn't match the date of birth on your account.", triesLeft: left, field: 'dob' } };
    }
    const age = ageOn(dob, today);
    if (!onFile) {
      if (age < ACCOUNT_MIN_AGE || age > 120) return { status: 422, json: { error: 'Please check your date of birth.', field: 'dob' } };
    }
    const m = [];
    if (!onFile) m.push({ ownerId: gid, namespace: 'facts', key: 'birth_date', type: 'date', value: dob });
    if (age >= AGE_MIN) m.push({ ownerId: gid, namespace: 'custom', key: 'age_verified', type: 'boolean', value: 'true' });
    if (m.length) {
      const d = await admin(env, f, SET, { m });
      if ((d.metafieldsSet.userErrors || []).length) throw new Error('verify: ' + JSON.stringify(d.metafieldsSet.userErrors).slice(0, 200));
    }
    const me = shapeMe(await load(), today);
    return { status: 200, json: { status: age >= AGE_MIN ? 'verified' : 'under', ...me } };
  }

  return { status: 404, json: { error: 'Not found' } };
}
