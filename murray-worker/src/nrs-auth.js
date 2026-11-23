// Shopify Admin access for the "NRS Inventory Sync" app on a store outside the app's organization.
//
// Why: Shopify only allows the client credentials grant on stores the app's organization owns
// ("shop_not_permitted" otherwise). 705 BRBR is owned by the merchant, so the app gets its token the normal
// way instead: the store approves the app once (authorization code grant), and this Worker keeps the token.
//
//   GET /nrs/install    starts the approval (also the app's "App URL" in the Dev Dashboard)
//   GET /nrs/callback   Shopify sends the merchant back here; the code is exchanged for an EXPIRING offline token
//                       (1 hour, with a 90-day refresh token that rotates on every refresh)
//   GET /nrs/status     connected or not, scopes, expiry times (no tokens)
//   GET /nrs/token      a fresh access token for the hourly NRS sync on GitHub Actions. Signed request:
//                       X-NRS-Timestamp: unix seconds, X-NRS-Signature: hex HMAC-SHA256(client secret, "nrs-token:<ts>")
//   POST /nrs/graphql   Admin GraphQL proxy for the sync: the app's IP allowlist accepts Cloudflare's (US) network but
//                       not GitHub's runners, so the sync sends its calls here. Signed over the exact body:
//                       HMAC-SHA256(client secret, "nrs-graphql:<ts>:<hex sha256 of body>"); X-NRS-Api-Version picks the version.
//
// Tokens live in one Durable Object (NrsTokenStore). Refreshing happens inside it, so two callers never use the
// same refresh token at once. A cron (see wrangler.toml) refreshes a few times a day so the 90-day refresh token
// never lapses even if the sync stops. Tokens are never logged or shown in a page.
//
// Config: NRS_APP_CLIENT_ID + NRS_APP_SCOPES (vars), NRS_APP_CLIENT_SECRET (secret), SHOPIFY_STORE_DOMAIN (var),
// NRS_TOKENS (Durable Object binding).

const SHOP_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
const REFRESH_EARLY_MS = 10 * 60e3; // refresh when less than 10 minutes are left
const SIGNATURE_WINDOW_S = 300;
const enc = new TextEncoder();

export function nrsReady(env) {
  return Boolean(env.NRS_APP_CLIENT_ID && env.NRS_APP_CLIENT_SECRET && env.SHOPIFY_STORE_DOMAIN && env.NRS_TOKENS);
}

function redirectUri(url) {
  return `${url.origin}/nrs/callback`;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Shopify's query HMAC: drop "hmac" (and the legacy "signature"), sort, join as k=v with &, hex HMAC-SHA256.
export async function verifyShopifyQuery(searchParams, secret) {
  const given = searchParams.get('hmac');
  if (!given) return false;
  const pairs = [...searchParams.entries()].filter(([k]) => k !== 'hmac' && k !== 'signature').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const message = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  return safeEqual(await hmacHex(secret, message), given);
}

async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signGraphqlRequest(secret, ts, bodyBytes) {
  return hmacHex(secret, `nrs-graphql:${ts}:${await sha256Hex(bodyBytes)}`);
}

export async function verifyGraphqlRequest(request, bodyBytes, secret, nowS = Math.floor(Date.now() / 1000)) {
  const ts = Number(request.headers.get('X-NRS-Timestamp'));
  const sig = request.headers.get('X-NRS-Signature') || '';
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > SIGNATURE_WINDOW_S) return false;
  return safeEqual(await signGraphqlRequest(secret, ts, bodyBytes), sig);
}

export async function signTokenRequest(secret, ts) {
  return hmacHex(secret, `nrs-token:${ts}`);
}

export async function verifyTokenRequest(request, secret, nowS = Math.floor(Date.now() / 1000)) {
  const ts = Number(request.headers.get('X-NRS-Timestamp'));
  const sig = request.headers.get('X-NRS-Signature') || '';
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > SIGNATURE_WINDOW_S) return false;
  return safeEqual(await signTokenRequest(secret, ts), sig);
}

export function missingScopes(wanted, granted) {
  const g = String(granted || '').split(',').map((s) => s.trim()).filter(Boolean);
  return String(wanted || '').split(',').map((s) => s.trim()).filter(Boolean)
    .filter((s) => !g.includes(s) && !(s.startsWith('read_') && g.includes(`write_${s.slice(5)}`)));
}

function cookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : '';
}

function page(title, body, status = 200, extraHeaders = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f5fb;color:#0f172a;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;max-width:520px;margin:24px;padding:32px;border-radius:20px;box-shadow:0 20px 50px -30px rgba(46,16,101,.5)}h1{font-size:22px;margin:0 0 10px}p{line-height:1.55;color:#334155}</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders } });
}

function storeStub(env) {
  return env.NRS_TOKENS.get(env.NRS_TOKENS.idFromName(env.SHOPIFY_STORE_DOMAIN));
}

async function callStore(env, path, init) {
  const r = await storeStub(env).fetch(`https://nrs-token-store${path}`, init);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

// A fresh Admin access token from the store, or null when the app isn't connected yet.
export async function nrsAccessToken(env) {
  if (!nrsReady(env)) return null;
  const out = await callStore(env, '/token');
  return out.status === 200 ? out.json.access_token : null;
}

export async function handleNrs(request, env, url) {
  if (!nrsReady(env)) return page('Not set up', '<p>The NRS app connection is not configured on this Worker yet.</p>', 503);
  const shop = env.SHOPIFY_STORE_DOMAIN;

  if (url.pathname === '/nrs/install') {
    // When Shopify opens the App URL it signs the query; a plain visit (no hmac) is fine too.
    if (url.searchParams.has('hmac') && !(await verifyShopifyQuery(url.searchParams, env.NRS_APP_CLIENT_SECRET))) {
      return page('Link not valid', '<p>This link could not be verified. Open the app again from Shopify.</p>', 403);
    }
    const asked = url.searchParams.get('shop');
    if (asked && asked !== shop) return page('Wrong store', `<p>This connection is only for ${shop}.</p>`, 400);
    const state = crypto.randomUUID().replace(/-/g, '');
    const auth = `https://${shop}/admin/oauth/authorize?` + new URLSearchParams({
      client_id: env.NRS_APP_CLIENT_ID,
      scope: env.NRS_APP_SCOPES || '',
      redirect_uri: redirectUri(url),
      state,
    });
    return new Response(null, {
      status: 302,
      headers: {
        Location: auth,
        'Set-Cookie': `nrs_state=${state}; Path=/nrs; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
        'Cache-Control': 'no-store',
      },
    });
  }

  if (url.pathname === '/nrs/callback') {
    const q = url.searchParams;
    const clear = { 'Set-Cookie': 'nrs_state=; Path=/nrs; Max-Age=0; HttpOnly; Secure; SameSite=Lax' };
    const state = q.get('state') || '';
    if (!state || !safeEqual(state, cookie(request, 'nrs_state'))) {
      return page('Please start again', '<p>This sign-in link expired or was opened in a different browser. Open the connect link again.</p>', 403, clear);
    }
    if (!(await verifyShopifyQuery(q, env.NRS_APP_CLIENT_SECRET))) return page('Could not verify', '<p>Shopify\'s response could not be verified.</p>', 403, clear);
    const qShop = q.get('shop') || '';
    if (!SHOP_RE.test(qShop) || qShop !== shop) return page('Wrong store', `<p>This connection is only for ${shop}.</p>`, 400, clear);
    const code = q.get('code');
    if (!code) return page('Not approved', '<p>The app was not approved, so nothing was connected.</p>', 400, clear);

    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: env.NRS_APP_CLIENT_ID, client_secret: env.NRS_APP_CLIENT_SECRET, code, expiring: '1' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token || !j.refresh_token) {
      console.log('nrs code exchange failed', r.status, String(j.error || j.error_description || '').slice(0, 200));
      return page('Connection failed', `<p>Shopify did not hand over access (HTTP ${r.status}). Please try again, or tell your developer.</p>`, 502, clear);
    }
    const missing = missingScopes(env.NRS_APP_SCOPES, j.scope);
    const saved = await callStore(env, '/save', { method: 'POST', body: JSON.stringify(j) });
    if (saved.status !== 200) return page('Connection failed', '<p>Access was granted but could not be saved. Please try again.</p>', 500, clear);
    const warn = missing.length ? `<p><b>Note:</b> these permissions were not granted: ${missing.join(', ')}. Some sync features may not work.</p>` : '';
    return page('Connected ✓', `<p>The NRS Inventory Sync app is connected to ${shop}. The hourly register sync and the website sign-up can use it now. You can close this page.</p>${warn}`, 200, clear);
  }

  if (url.pathname === '/nrs/status') {
    const out = await callStore(env, '/status');
    return new Response(JSON.stringify(out.json), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  if (url.pathname === '/nrs/token') {
    if (!(await verifyTokenRequest(request, env.NRS_APP_CLIENT_SECRET))) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const out = await callStore(env, '/token');
    return new Response(JSON.stringify(out.json), { status: out.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  if (url.pathname === '/nrs/graphql') {
    const json = (data, status) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const body = await request.arrayBuffer();
    if (body.byteLength > 1_000_000) return json({ error: 'too large' }, 413);
    if (!(await verifyGraphqlRequest(request, body, env.NRS_APP_CLIENT_SECRET))) return json({ error: 'unauthorized' }, 401);
    const ver = request.headers.get('X-NRS-Api-Version') || '';
    const version = /^\d{4}-\d{2}$/.test(ver) ? ver : '2026-10';
    const tok = await callStore(env, '/token');
    if (tok.status !== 200) return json(tok.json, tok.status);
    const r = await fetch(`https://${shop}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': tok.json.access_token },
      body,
    });
    const headers = { 'Content-Type': r.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' };
    if (r.headers.get('Retry-After')) headers['Retry-After'] = r.headers.get('Retry-After');
    return new Response(r.body, { status: r.status, headers });
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}

// Cron: keep the refresh token alive (it rotates on every refresh and expires 90 days after issue).
export async function nrsKeepAlive(env) {
  if (!nrsReady(env)) return;
  const out = await callStore(env, '/token?force=1');
  if (out.status !== 200) console.log('nrs keep-alive:', out.status, out.json && out.json.error);
}

export function tokenRecord(j, now = Date.now()) {
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    scope: j.scope || '',
    expires_at: now + (Number(j.expires_in) || 3600) * 1000,
    refresh_expires_at: now + (Number(j.refresh_token_expires_in) || 7776000) * 1000,
    updated_at: now,
  };
}

export class NrsTokenStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const rec = await this.state.storage.get('rec');

    if (url.pathname === '/save' && request.method === 'POST') {
      const j = await request.json();
      await this.state.storage.put('rec', tokenRecord(j));
      return reply({ ok: true });
    }
    if (url.pathname === '/status') {
      if (!rec) return reply({ connected: false });
      return reply({
        connected: true, scope: rec.scope, access_expires_at: new Date(rec.expires_at).toISOString(),
        refresh_expires_at: new Date(rec.refresh_expires_at).toISOString(), updated_at: new Date(rec.updated_at).toISOString(),
        last_error: rec.last_error || null,
      });
    }
    if (url.pathname === '/token') {
      if (!rec) return reply({ error: 'not_connected', message: 'The store has not approved the app yet. Open /nrs/install.' }, 409);
      const force = url.searchParams.get('force') === '1';
      if (!force && rec.expires_at - Date.now() > REFRESH_EARLY_MS) {
        return reply({ access_token: rec.access_token, expires_at: new Date(rec.expires_at).toISOString() });
      }
      const shop = this.env.SHOPIFY_STORE_DOMAIN;
      let r;
      try {
        r = await fetch(`https://${shop}/admin/oauth/access_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({
            client_id: this.env.NRS_APP_CLIENT_ID, client_secret: this.env.NRS_APP_CLIENT_SECRET,
            grant_type: 'refresh_token', refresh_token: rec.refresh_token,
          }),
        });
      } catch (e) {
        // Shopify unreachable: keep using the current token while it's still valid.
        if (rec.expires_at > Date.now()) return reply({ access_token: rec.access_token, expires_at: new Date(rec.expires_at).toISOString() });
        return reply({ error: 'unreachable', message: 'Could not reach Shopify to refresh the token.' }, 502);
      }
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) {
        const next = tokenRecord({ ...j, refresh_token: j.refresh_token || rec.refresh_token });
        await this.state.storage.put('rec', next);
        return reply({ access_token: next.access_token, expires_at: new Date(next.expires_at).toISOString() });
      }
      const reason = String(j.error_description || j.error || `HTTP ${r.status}`).slice(0, 200);
      await this.state.storage.put('rec', { ...rec, last_error: `${new Date().toISOString()} refresh failed: ${reason}` });
      if (r.status === 401 || r.status === 400) {
        // Refresh token expired, revoked or the app was uninstalled: the store has to approve the app again.
        return reply({ error: 'reauthorize', message: `Shopify refused the refresh (${reason}). Open /nrs/install to reconnect.` }, 401);
      }
      if (rec.expires_at > Date.now()) return reply({ access_token: rec.access_token, expires_at: new Date(rec.expires_at).toISOString() });
      return reply({ error: 'refresh_failed', message: reason }, 502);
    }
    return reply({ error: 'Not found' }, 404);
  }
}
