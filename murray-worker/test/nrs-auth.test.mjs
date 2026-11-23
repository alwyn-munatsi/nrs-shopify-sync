import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';
import { NrsTokenStore, verifyShopifyQuery, missingScopes, signTokenRequest, verifyTokenRequest, signGraphqlRequest } from '../src/nrs-auth.js';

const SECRET = 'client-secret-x';
const SHOP = 'shop-1.myshopify.com';

function makeEnv() {
  const storage = new Map();
  const env = {
    NRS_APP_CLIENT_ID: 'cid', NRS_APP_CLIENT_SECRET: SECRET, NRS_APP_SCOPES: 'read_products,write_products,read_orders',
    SHOPIFY_STORE_DOMAIN: SHOP, ALLOWED_ORIGINS: '',
  };
  const store = new NrsTokenStore({ storage: { get: async (k) => storage.get(k), put: async (k, v) => { storage.set(k, v); } } }, env);
  env.NRS_TOKENS = { idFromName: (n) => n, get: () => ({ fetch: (url, init) => store.fetch(new Request(url, init)) }) };
  return { env, storage };
}

function signQuery(params) {
  const msg = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  return new URLSearchParams({ ...params, hmac: createHmac('sha256', SECRET).update(msg).digest('hex') });
}

// Fake Shopify token endpoint
function mockShopify(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    calls.push({ url: String(url), body });
    const [status, json] = handler(body, calls.length);
    return new Response(JSON.stringify(json), { status });
  };
  return calls;
}

const get = (path, headers = {}) => new Request(`https://w.example${path}`, { headers });

async function connect(env) {
  const r = await worker.fetch(get('/nrs/install'), env);
  const state = new URL(r.headers.get('Location')).searchParams.get('state');
  const q = signQuery({ code: 'abc', shop: SHOP, state, timestamp: '1795266000' });
  return worker.fetch(get(`/nrs/callback?${q}`, { Cookie: `nrs_state=${state}` }), env);
}

test('Shopify query HMAC is checked', async () => {
  assert.equal(await verifyShopifyQuery(signQuery({ shop: SHOP, timestamp: '1' }), SECRET), true);
  const bad = signQuery({ shop: SHOP, timestamp: '1' }); bad.set('shop', 'evil.myshopify.com');
  assert.equal(await verifyShopifyQuery(bad, SECRET), false);
});

test('a write scope covers its read scope', () => {
  assert.deepEqual(missingScopes('read_products,write_products,read_orders', 'write_products'), ['read_orders']);
});

test('install redirects to Shopify with state cookie and redirect uri', async () => {
  const { env } = makeEnv();
  const r = await worker.fetch(get('/nrs/install'), env);
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('Location'));
  assert.equal(loc.origin + loc.pathname, `https://${SHOP}/admin/oauth/authorize`);
  assert.equal(loc.searchParams.get('client_id'), 'cid');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://w.example/nrs/callback');
  assert.match(r.headers.get('Set-Cookie'), new RegExp(`nrs_state=${loc.searchParams.get('state')};.*HttpOnly`));
  const other = await worker.fetch(get('/nrs/install?shop=other.myshopify.com'), env);
  assert.equal(other.status, 400);
});

test('callback rejects a missing state cookie or a bad hmac', async () => {
  const { env } = makeEnv();
  const q = signQuery({ code: 'abc', shop: SHOP, state: 's1', timestamp: '1' });
  assert.equal((await worker.fetch(get(`/nrs/callback?${q}`), env)).status, 403);
  q.set('code', 'changed');
  assert.equal((await worker.fetch(get(`/nrs/callback?${q}`, { Cookie: 'nrs_state=s1' }), env)).status, 403);
});

test('callback exchanges the code for an expiring token and never shows it', async () => {
  const { env, storage } = makeEnv();
  const calls = mockShopify(() => [200, { access_token: 'at-1', refresh_token: 'rt-1', scope: 'write_products,read_orders', expires_in: 3600, refresh_token_expires_in: 7776000 }]);
  const r = await connect(env);
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /Connected/);
  assert.doesNotMatch(html, /at-1|rt-1/);
  assert.equal(calls[0].body.expiring, '1');
  assert.equal(calls[0].body.code, 'abc');
  assert.equal(storage.get('rec').refresh_token, 'rt-1');
});

test('token endpoint needs a fresh signature', async () => {
  const { env } = makeEnv();
  mockShopify(() => [200, { access_token: 'at-1', refresh_token: 'rt-1', scope: 'write_products,read_orders', expires_in: 3600 }]);
  await connect(env);
  const ts = Math.floor(Date.now() / 1000);
  const ok = await worker.fetch(get('/nrs/token', { 'X-NRS-Timestamp': String(ts), 'X-NRS-Signature': await signTokenRequest(SECRET, ts) }), env);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).access_token, 'at-1');
  const stale = ts - 3600;
  const old = await worker.fetch(get('/nrs/token', { 'X-NRS-Timestamp': String(stale), 'X-NRS-Signature': await signTokenRequest(SECRET, stale) }), env);
  assert.equal(old.status, 401);
  assert.equal((await worker.fetch(get('/nrs/token'), env)).status, 401);
  assert.equal(await verifyTokenRequest(get('/x', { 'X-NRS-Timestamp': String(ts), 'X-NRS-Signature': 'nope' }), SECRET), false);
});

test('an expiring token is refreshed and the refresh token rotates', async () => {
  const { env, storage } = makeEnv();
  const calls = mockShopify((body, n) => n === 1
    ? [200, { access_token: 'at-1', refresh_token: 'rt-1', scope: 'write_products,read_orders', expires_in: 60 }] // < 10 min left
    : [200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, refresh_token_expires_in: 7776000 }]);
  await connect(env);
  const ts = Math.floor(Date.now() / 1000);
  const r = await worker.fetch(get('/nrs/token', { 'X-NRS-Timestamp': String(ts), 'X-NRS-Signature': await signTokenRequest(SECRET, ts) }), env);
  assert.equal((await r.json()).access_token, 'at-2');
  assert.equal(calls[1].body.grant_type, 'refresh_token');
  assert.equal(calls[1].body.refresh_token, 'rt-1');
  assert.equal(storage.get('rec').refresh_token, 'rt-2');
});

test('a refused refresh asks for the app to be approved again', async () => {
  const { env } = makeEnv();
  mockShopify((body, n) => n === 1 ? [200, { access_token: 'at-1', refresh_token: 'rt-1', scope: 'write_products,read_orders', expires_in: 60 }] : [401, { error: 'invalid_grant' }]);
  await connect(env);
  const ts = Math.floor(Date.now() / 1000);
  const r = await worker.fetch(get('/nrs/token', { 'X-NRS-Timestamp': String(ts), 'X-NRS-Signature': await signTokenRequest(SECRET, ts) }), env);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'reauthorize');
  const status = await (await worker.fetch(get('/nrs/status'), env)).json();
  assert.equal(status.connected, true);
  assert.match(status.last_error, /refresh failed/);
  assert.equal(JSON.stringify(status).includes('rt-1'), false);
});

test('not connected yet: token endpoint says so', async () => {
  const { env } = makeEnv();
  const ts = Math.floor(Date.now() / 1000);
  const r = await worker.fetch(get('/nrs/token', { 'X-NRS-Timestamp': String(ts), 'X-NRS-Signature': await signTokenRequest(SECRET, ts) }), env);
  assert.equal(r.status, 409);
});


test('graphql proxy: signed body is forwarded to Shopify with the stored token', async () => {
  const { env } = makeEnv();
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    if (String(url).endsWith('/admin/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', scope: 'write_products,read_orders', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await connect(env);
  const body = new TextEncoder().encode(JSON.stringify({ query: '{ shop { name } }', variables: {} }));
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signGraphqlRequest(SECRET, ts, body);
  const req = (s, b = body) => new Request('https://w.example/nrs/graphql', { method: 'POST', body: b,
    headers: { 'X-NRS-Timestamp': String(ts), 'X-NRS-Signature': s, 'X-NRS-Api-Version': '2026-10' } });
  const ok = await worker.fetch(req(sig), env);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { data: { ok: true } });
  const fwd = seen[seen.length - 1];
  assert.equal(fwd.url, `https://${SHOP}/admin/api/2026-10/graphql.json`);
  assert.equal(fwd.init.headers['X-Shopify-Access-Token'], 'at-1');
  // a changed body or a bad signature is refused
  const tampered = new TextEncoder().encode(JSON.stringify({ query: 'mutation { productDelete }' }));
  assert.equal((await worker.fetch(req(sig, tampered), env)).status, 401);
  assert.equal((await worker.fetch(req('nope'), env)).status, 401);
  assert.equal((await worker.fetch(new Request('https://w.example/nrs/graphql'), env)).status, 405);
});
