import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSignup, signup, ageOn, signupRateLimited } from '../src/signup.js';

const TODAY = new Date('2026-11-14T12:00:00Z');
const GOOD = { firstName: ' Ana ', lastName: 'Diaz', email: 'Ana@Example.com', phone: '(917) 555-0123', dob: '1990-05-10', gender: 'Female',
  address1: '705 2nd Ave', address2: 'Apt 4', city: 'New York', province: 'ny', zip: '10016', marketing: true, elapsed: 9000 };
const ENV = { SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com', SIGNUP_CLIENT_ID: 'id', SIGNUP_CLIENT_SECRET: 'secret' };

test('validateSignup cleans and accepts a full form', () => {
  const v = validateSignup(GOOD, TODAY);
  assert.equal(v.ok, true);
  assert.equal(v.data.firstName, 'Ana');
  assert.equal(v.data.email, 'ana@example.com');
  assert.equal(v.data.phone, '+19175550123');
  assert.equal(v.data.province, 'NY');
});

test('validateSignup flags every missing or bad field', () => {
  const v = validateSignup({ dob: '2020-01-01', gender: 'x', zip: '1', province: 'ZZ' }, TODAY);
  assert.equal(v.ok, false);
  for (const k of ['firstName', 'lastName', 'email', 'phone', 'dob', 'gender', 'address1', 'city', 'province', 'zip']) assert.ok(v.errors[k], k);
  assert.match(v.errors.dob, /13 or older/);
  assert.match(validateSignup({ ...GOOD, dob: '1990-02-31' }, TODAY).errors.dob, /date of birth/);
});

test('ageOn counts birthdays correctly; 13-year-olds can sign up, 12-year-olds cannot', () => {
  assert.equal(ageOn('2008-11-14', TODAY), 18);
  assert.equal(ageOn('2008-11-15', TODAY), 17);
  assert.equal(validateSignup({ ...GOOD, dob: '2013-11-14' }, TODAY).ok, true);
  assert.match(validateSignup({ ...GOOD, dob: '2013-11-15' }, TODAY).errors.dob, /13 or older/);
});

function fakeShopify(opts = {}) {
  const calls = [];
  const f = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ url, body });
    if (url.endsWith('/admin/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 86399 }), { status: 200 });
    if (/customers\(first/.test(body.query)) return new Response(JSON.stringify({ data: { customers: { nodes: opts.exists ? [{ id: 'gid://shopify/Customer/1' }] : [] } } }), { status: 200 });
    if (/customerCreate/.test(body.query)) return new Response(JSON.stringify({ data: { customerCreate: opts.phoneTaken
      ? { customer: null, userErrors: [{ field: ['phone'], message: 'Phone has already been taken' }] }
      : { customer: { id: 'gid://shopify/Customer/9' }, userErrors: [] } } }), { status: 200 });
    if (/customerAddressCreate/.test(body.query)) return new Response(JSON.stringify({ data: { customerAddressCreate: { address: { id: 'a' }, userErrors: [] } } }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  return { f, calls };
}

test('signup creates the customer with metafields, tags, consent and a default address', async () => {
  const { f, calls } = fakeShopify();
  const out = await signup(ENV, GOOD, { fetch: f, now: TODAY.getTime() });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'created');
  const create = calls.find((c) => /customerCreate/.test(c.body.query)).body.variables.input;
  assert.deepEqual(create.tags, ['welcome-offer', 'website-signup']);
  assert.equal(create.metafields.find((m) => m.key === 'birth_date').value, '1990-05-10');
  assert.equal(create.metafields.find((m) => m.key === 'gender').value, 'Female');
  assert.equal(create.emailMarketingConsent.marketingState, 'SUBSCRIBED');
  const addr = calls.find((c) => /customerAddressCreate/.test(c.body.query)).body;
  assert.match(addr.query, /setAsDefault: true/);
  assert.equal(addr.variables.address.provinceCode, 'NY');
  assert.equal(addr.variables.address.countryCode, 'US');
});

test('signup never touches an existing customer', async () => {
  const { f, calls } = fakeShopify({ exists: true });
  const out = await signup(ENV, GOOD, { fetch: f, now: TODAY.getTime() });
  assert.equal(out.status, 409);
  assert.equal(out.json.status, 'exists');
  assert.equal(calls.some((c) => /customerCreate|customerAddressCreate/.test(c.body.query || '')), false);
});

test('signup reports a taken phone number on the phone field', async () => {
  const { f } = fakeShopify({ phoneTaken: true });
  const out = await signup(ENV, GOOD, { fetch: f, now: TODAY.getTime() });
  assert.equal(out.status, 422);
  assert.ok(out.json.fields.phone);
});

test('bots: honeypot pretends success, too-fast forms are refused, not configured -> 503', async () => {
  const { f, calls } = fakeShopify();
  assert.equal((await signup(ENV, { ...GOOD, website: 'spam' }, { fetch: f })).json.status, 'created');
  assert.equal((await signup(ENV, { ...GOOD, elapsed: 500 }, { fetch: f })).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await signup({}, GOOD, { fetch: f })).status, 503);
});

test('sign-up rate limit: 5 per IP per hour', () => {
  for (let i = 0; i < 5; i++) assert.equal(signupRateLimited('1.2.3.4', 1000 + i), false);
  assert.equal(signupRateLimited('1.2.3.4', 2000), true);
  assert.equal(signupRateLimited('1.2.3.4', 1000 + 3600e3 + 10), false);
});
