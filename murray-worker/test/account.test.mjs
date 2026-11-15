import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySessionToken, signToken, handleAccount, shapeMe, normalizePhone } from '../src/account.js';

const SECRET = 'test-secret';
const env = { ACCOUNT_APP_CLIENT_SECRET: SECRET, ACCOUNT_APP_CLIENT_ID: 'client-1', SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com', SIGNUP_ADMIN_TOKEN: 'shpat_x' };
const NOW = Date.parse('2026-11-15T12:00:00Z');
const tok = (over = {}) => signToken({ iss: 'https://shop.myshopify.com/admin', dest: 'https://shop.myshopify.com', aud: 'client-1', sub: 'gid://shopify/Customer/42', exp: NOW / 1000 + 300, nbf: NOW / 1000 - 5, ...over }, SECRET);

function customer(over = {}) {
  return {
    id: 'gid://shopify/Customer/42', firstName: 'Ana', lastName: 'B', defaultEmailAddress: { emailAddress: 'a@b.co' }, defaultPhoneNumber: null,
    numberOfOrders: '0', amountSpent: { amount: '0', currencyCode: 'USD' }, createdAt: '2026-11-01T00:00:00Z',
    birth: null, gender: null, ageVerified: null, orders: { nodes: [] }, ...over,
  };
}
// Fake Admin API: records calls, answers ME / UPDATE / SET
function fakeAdmin(state) {
  const calls = [];
  const f = async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push({ query, variables, token: init.headers['X-Shopify-Access-Token'] });
    let data;
    if (query.includes('query Me')) data = { customer: state.customer };
    else if (query.includes('customerUpdate')) {
      if (state.phoneTaken) data = { customerUpdate: { customer: null, userErrors: [{ field: ['phone'], message: 'Phone has already been taken' }] } };
      else { state.customer.defaultPhoneNumber = variables.input.phone ? { phoneNumber: variables.input.phone } : null; data = { customerUpdate: { customer: { id: 'x' }, userErrors: [] } }; }
    } else if (query.includes('metafieldsSet')) {
      for (const m of variables.m) {
        if (m.key === 'birth_date') state.customer.birth = { value: m.value };
        if (m.key === 'age_verified') state.customer.ageVerified = { value: m.value };
        if (m.key === 'gender') state.customer.gender = { value: m.value };
      }
      data = { metafieldsSet: { metafields: [], userErrors: [] } };
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  return { f, calls };
}

test('session token: valid token gives the customer id', async () => {
  assert.deepEqual(await verifySessionToken(await tok(), env, NOW), { customerId: '42' });
});
test('session token: rejects tampered, expired, other app, other store, signed-out', async () => {
  const good = await tok();
  const bad = good.slice(0, -2) + (good.endsWith('A') ? 'BB' : 'AA');
  await assert.rejects(verifySessionToken(bad, env, NOW), /signature/);
  await assert.rejects(verifySessionToken(await tok({ exp: NOW / 1000 - 60 }), env, NOW), /expired/);
  await assert.rejects(verifySessionToken(await tok({ aud: 'other' }), env, NOW), /Wrong app/);
  await assert.rejects(verifySessionToken(await tok({ dest: 'https://evil.myshopify.com' }), env, NOW), /Wrong store/);
  await assert.rejects(verifySessionToken(await tok({ sub: undefined }), env, NOW), /sign in/);
  await assert.rejects(verifySessionToken(await signToken({ sub: 'gid://shopify/Customer/42', exp: NOW / 1000 + 60 }, 'wrong-secret'), env, NOW), /signature/);
});

test('GET /account/me returns the shaped account; no token -> 401; not set up -> 503', async () => {
  const st = { customer: customer() };
  const { f } = fakeAdmin(st);
  const r = await handleAccount('/account/me', 'GET', env, await tok(), null, { fetch: f, now: NOW });
  assert.equal(r.status, 200);
  assert.equal(r.json.firstName, 'Ana');
  assert.equal(r.json.welcomeOffer.available, true);
  assert.equal((await handleAccount('/account/me', 'GET', env, '', null, { fetch: f, now: NOW })).status, 401);
  assert.equal((await handleAccount('/account/me', 'GET', { ...env, ACCOUNT_APP_CLIENT_SECRET: '' }, await tok(), null, { fetch: f, now: NOW })).status, 503);
});

test('phone: normalizes US numbers, rejects bad ones, reports taken numbers', async () => {
  assert.equal(normalizePhone('(917) 265-8063'), '+19172658063');
  assert.equal(normalizePhone('1 917 265 8063'), '+19172658063');
  assert.equal(normalizePhone('12345'), null);
  const st = { customer: customer() };
  const { f, calls } = fakeAdmin(st);
  const ok = await handleAccount('/account/update', 'POST', env, await tok(), { phone: '917-265-8063' }, { fetch: f, now: NOW });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.phone, '+19172658063');
  assert.equal(calls.find((c) => c.query.includes('customerUpdate')).variables.input.id, 'gid://shopify/Customer/42');
  assert.equal((await handleAccount('/account/update', 'POST', env, await tok(), { phone: '555' }, { fetch: f, now: NOW })).status, 422);
  st.phoneTaken = true;
  const taken = await handleAccount('/account/update', 'POST', env, await tok(), { phone: '9172658064' }, { fetch: f, now: NOW });
  assert.equal(taken.status, 422);
  assert.match(taken.json.error, /already linked/);
});

test('verify-age: matching 21+ date verifies; wrong date is a mismatch and changes nothing', async () => {
  const st = { customer: customer({ birth: { value: '1990-05-12' } }) };
  const { f, calls } = fakeAdmin(st);
  const wrong = await handleAccount('/account/verify-age', 'POST', env, await tok(), { dob: '1991-05-12' }, { fetch: f, now: NOW });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.json.status, 'mismatch');
  assert.equal(calls.some((c) => c.query.includes('metafieldsSet')), false);
  const right = await handleAccount('/account/verify-age', 'POST', env, await tok(), { dob: '1990-05-12' }, { fetch: f, now: NOW });
  assert.equal(right.status, 200);
  assert.equal(right.json.status, 'verified');
  assert.equal(right.json.ageVerified, true);
  // birth date on file is never overwritten
  assert.equal(calls.filter((c) => c.query.includes('metafieldsSet')).flatMap((c) => c.variables.m).some((m) => m.key === 'birth_date'), false);
});

test('verify-age: no date on file -> saved once; under 21 is not verified; under 13 refused', async () => {
  const st = { customer: customer({ id: 'gid://shopify/Customer/43' }) };
  const { f } = fakeAdmin(st);
  const t = await tok({ sub: 'gid://shopify/Customer/43' });
  const young = await handleAccount('/account/verify-age', 'POST', env, t, { dob: '2015-01-01' }, { fetch: f, now: NOW });
  assert.equal(young.status, 422);
  const under = await handleAccount('/account/verify-age', 'POST', env, t, { dob: '2008-01-01' }, { fetch: f, now: NOW });
  assert.equal(under.json.status, 'under');
  assert.equal(under.json.ageVerified, false);
  assert.equal(under.json.birthDate, '2008-01-01');
});

test('verify-age: 5 wrong tries per hour, then locked', async () => {
  const st = { customer: customer({ id: 'gid://shopify/Customer/44', birth: { value: '1990-05-12' } }) };
  const { f } = fakeAdmin(st);
  const t = await tok({ sub: 'gid://shopify/Customer/44' });
  for (let i = 0; i < 5; i++) await handleAccount('/account/verify-age', 'POST', env, t, { dob: '1980-01-01' }, { fetch: f, now: NOW });
  const locked = await handleAccount('/account/verify-age', 'POST', env, t, { dob: '1990-05-12' }, { fetch: f, now: NOW });
  assert.equal(locked.status, 429);
});

test('shapeMe: favorites come from past orders, skip cancelled/unavailable, most bought first', () => {
  const li = (id, title, qty, avail = true) => ({ title, quantity: qty, image: { url: 'u' }, variant: { id: `gid://shopify/ProductVariant/${id}`, price: '2.00', availableForSale: avail, product: { handle: title.toLowerCase(), status: 'ACTIVE', featuredMedia: null } } });
  const me = shapeMe(customer({
    numberOfOrders: '3',
    orders: { nodes: [
      { id: 'gid://shopify/Order/1', name: '#1001', createdAt: 'x', cancelledAt: null, lineItems: { nodes: [li(1, 'Chips', 1), li(2, 'Soda', 4)] } },
      { id: 'gid://shopify/Order/2', name: '#1002', createdAt: 'x', cancelledAt: null, lineItems: { nodes: [li(1, 'Chips', 2), li(3, 'Gone', 9, false)] } },
      { id: 'gid://shopify/Order/3', name: '#1003', createdAt: 'x', cancelledAt: 'y', lineItems: { nodes: [li(4, 'Beer', 20)] } },
    ] },
  }));
  assert.deepEqual(me.favorites.map((x) => [x.title, x.bought]), [['Soda', 4], ['Chips', 3]]);
  assert.equal(me.welcomeOffer.available, false);
  assert.equal(me.orders[0].name, '#1001');
});
