// 705 BRBR website sign-up: POST /signup
// Creates a Shopify customer from the site's "Sign up" page with everything the store asked for:
//   first + last name, email, mobile, date of birth (facts.birth_date), gender (custom.gender) and a home address.
// The address is saved as the customer's DEFAULT address, so Shopify checkout offers it as the shipping address
// once they sign in. The customer is tagged welcome-offer + website-signup, so the 10% welcome code works for them.
//
// Safety:
//  - Only accepted from the store's own website (ALLOWED_ORIGINS), max 5 sign-ups per IP per hour, a hidden
//    honeypot field and a minimum fill time keep bots out.
//  - An email that already belongs to a customer is NEVER changed: the visitor is told to sign in instead,
//    so nobody can overwrite someone else's name, phone or address.
//  - The Admin token comes from the "705 BRBR Account Extras" app (client credentials grant). Its client secret
//    is the Worker secret SIGNUP_CLIENT_SECRET; nothing is sent back to the browser except a short status.

const API_VERSION = '2026-10';
const GENDERS = ['Female', 'Male', 'Non-binary', 'Prefer not to say'];
const STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR'];
// 13+: US law (COPPA) doesn't allow collecting a child's personal details without parental consent.
// Buying alcohol still needs 21+ (checked by the site's age check and at pickup/delivery).
export const MIN_AGE = 13;

const hits = new Map(); // ip -> [timestamps]
export function signupRateLimited(ip, now = Date.now()) {
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (list.length >= 5) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  return false;
}

function clean(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

export function ageOn(dob, today = new Date()) {
  const [y, m, d] = dob.split('-').map(Number);
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d)) age--;
  return age;
}

// Returns { ok: true, data } or { ok: false, errors: { field: message } }
export function validateSignup(body, today = new Date()) {
  const b = body || {};
  const errors = {};
  const data = {
    firstName: clean(b.firstName, 60),
    lastName: clean(b.lastName, 60),
    email: clean(b.email, 254).toLowerCase(),
    phone: String(b.phone || '').replace(/\D/g, ''),
    dob: clean(b.dob, 10),
    gender: clean(b.gender, 30),
    address1: clean(b.address1, 120),
    address2: clean(b.address2, 60),
    city: clean(b.city, 60),
    province: clean(b.province, 2).toUpperCase(),
    zip: clean(b.zip, 10),
    marketing: b.marketing === true,
  };
  if (!data.firstName) errors.firstName = 'Please enter your first name.';
  if (!data.lastName) errors.lastName = 'Please enter your last name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) errors.email = 'Please enter a valid email address.';
  if (data.phone.length === 11 && data.phone[0] === '1') data.phone = data.phone.slice(1);
  if (data.phone.length !== 10) errors.phone = 'Please enter a 10-digit US mobile number.';
  else data.phone = '+1' + data.phone;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.dob) || isNaN(Date.parse(data.dob + 'T00:00:00Z')) || new Date(data.dob + 'T00:00:00Z').toISOString().slice(0, 10) !== data.dob) {
    errors.dob = 'Please enter your date of birth.';
  } else {
    const age = ageOn(data.dob, today);
    if (age < MIN_AGE) errors.dob = `You must be ${MIN_AGE} or older to create an account.`;
    else if (age > 120) errors.dob = 'Please check your date of birth.';
  }
  if (!GENDERS.includes(data.gender)) errors.gender = 'Please choose an option.';
  if (!data.address1) errors.address1 = 'Please enter your street address.';
  if (!data.city) errors.city = 'Please enter your city.';
  if (!STATES.includes(data.province)) errors.province = 'Please choose your state.';
  if (!/^\d{5}(-\d{4})?$/.test(data.zip)) errors.zip = 'Please enter a 5-digit ZIP code.';
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, data };
}

let tokenCache = null; // { token, exp }
async function adminToken(env, f) {
  if (env.SIGNUP_ADMIN_TOKEN) return env.SIGNUP_ADMIN_TOKEN; // optional: a fixed shpat_ token instead
  if (tokenCache && tokenCache.exp > Date.now() + 60e3) return tokenCache.token;
  const r = await f(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.SIGNUP_CLIENT_ID, client_secret: env.SIGNUP_CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  const raw = await r.text();
  let j = {};
  try { j = JSON.parse(raw); } catch {}
  if (!r.ok || !j.access_token) throw new Error(`token ${r.status} ${raw.replace(/\s+/g, ' ').slice(0, 240)}`.trim());
  tokenCache = { token: j.access_token, exp: Date.now() + ((j.expires_in || 3600) * 1000) };
  return tokenCache.token;
}
async function gql(env, f, query, variables) {
  const token = await adminToken(env, f);
  const r = await f(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error(`admin ${r.status} ${JSON.stringify(j.errors || '').slice(0, 200)}`);
  return j.data;
}

const FIND = `query($q: String!) { customers(first: 1, query: $q) { nodes { id } } }`;
const CREATE = `mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`;
const ADDRESS = `mutation($id: ID!, $address: MailingAddressInput!) { customerAddressCreate(customerId: $id, address: $address, setAsDefault: true) { address { id } userErrors { field message } } }`;

export function signupReady(env) {
  return Boolean(env.SHOPIFY_STORE_DOMAIN && (env.SIGNUP_ADMIN_TOKEN || (env.SIGNUP_CLIENT_ID && env.SIGNUP_CLIENT_SECRET)));
}

// Returns { status, json }
export async function signup(env, body, deps = {}) {
  const f = deps.fetch || fetch;
  const now = deps.now || Date.now();
  if (!signupReady(env)) return { status: 503, json: { error: 'Sign-up is not set up yet. Please try again later.' } };
  if (body && body.website) return { status: 200, json: { status: 'created' } }; // honeypot: pretend success
  if (!body || !(Number(body.elapsed) >= 2500)) return { status: 400, json: { error: 'Please take a moment to fill in the form and try again.' } };
  const v = validateSignup(body, new Date(now));
  if (!v.ok) return { status: 422, json: { error: 'Please check the highlighted fields.', fields: v.errors } };
  const d = v.data;

  const found = await gql(env, f, FIND, { q: `email:"${d.email.replace(/"/g, '')}"` });
  if (found.customers.nodes.length) return { status: 409, json: { status: 'exists', error: 'You already have an account with this email. Sign in to continue.' } };

  const input = {
    firstName: d.firstName,
    lastName: d.lastName,
    email: d.email,
    phone: d.phone,
    tags: ['welcome-offer', 'website-signup'],
    note: 'Signed up on the website sign-up page.',
    metafields: [
      { namespace: 'facts', key: 'birth_date', type: 'date', value: d.dob },
      { namespace: 'custom', key: 'gender', type: 'single_line_text_field', value: d.gender },
    ],
  };
  if (d.marketing) input.emailMarketingConsent = { marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: new Date(now).toISOString() };

  let created = await gql(env, f, CREATE, { input });
  let errs = created.customerCreate.userErrors || [];
  if (errs.some((e) => /phone/i.test((e.field || []).join(' ') + ' ' + e.message))) {
    return { status: 422, json: { error: 'That mobile number is already linked to another account.', fields: { phone: 'This number is already linked to another account. Sign in, or use a different number.' } } };
  }
  if (errs.some((e) => /email/i.test((e.field || []).join(' ') + ' ' + e.message) && /taken|exists/i.test(e.message))) {
    return { status: 409, json: { status: 'exists', error: 'You already have an account with this email. Sign in to continue.' } };
  }
  if (errs.length || !created.customerCreate.customer) throw new Error('create: ' + JSON.stringify(errs).slice(0, 200));
  const id = created.customerCreate.customer.id;

  const addr = await gql(env, f, ADDRESS, {
    id,
    address: { firstName: d.firstName, lastName: d.lastName, address1: d.address1, address2: d.address2 || null, city: d.city, provinceCode: d.province, zip: d.zip, countryCode: 'US', phone: d.phone },
  });
  const addrErrs = addr.customerAddressCreate.userErrors || [];
  return { status: 200, json: { status: 'created', addressSaved: addrErrs.length === 0 } };
}
