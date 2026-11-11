/*
  Murray: the 705 BRBR shopping assistant.

  POST /chat  { messages: [{ role: 'user' | 'assistant', content: '...' }], page?: '/collections/all-beer' }
  ->          { reply: '...markdown...', products: [{ title, price, url, image, available }] }

  Murray answers questions about 705 BRBR (products, prices, hours, pickup, delivery, the 10% welcome offer,
  NY Lottery, in-store services) using Claude with tools that read the live store:
    - search_products: the storefront's own product search (prices and links straight from Shopify)
    - get_product: full details of one product
    - show_products: picks which products appear as cards under the reply
    - get_lottery: latest NY Lottery results and next jackpots (705 BRBR lottery Worker)
  Anything unrelated to the shop is politely steered back.

  Model provider: Groq (GROQ_API_KEY, OpenAI-compatible API, model GROQ_MODEL) when that key is set,
  otherwise Anthropic Claude (ANTHROPIC_API_KEY, model MODEL).
*/

const MAX_TURNS = 16; // conversation messages kept per request
const MAX_CHARS = 1200; // per user message
const MAX_TOOL_ROUNDS = 5;
const RATE = { windowMs: 60_000, max: 20 }; // per IP, per isolate

export const STORE = {
  name: '705 BRBR',
  address: '705 2nd Ave (between E 38th & E 39th St), New York, NY 10016 (Murray Hill / Midtown East)',
  corner: 'Right on the corner of 38th Street on 2nd Avenue',
  phone: '(917) 265-8063',
  email: '705quickstop@gmail.com',
  hours: 'Open every day, 6:00 AM to 12:00 AM (midnight)',
  maps: 'https://maps.app.goo.gl/Rn9GY1jnfXuEgcM48',
  delivery: [
    ['DoorDash', 'https://www.doordash.com/store/705-brbr-new-york-26214688/'],
    ['Uber Eats', 'https://www.ubereats.com/store/705-brbr-705-2nd-avenue/8D1S_353X-G_0TRsvhGytw'],
    ['Grubhub', 'https://www.grubhub.com/restaurant/705-brbr-inc-705-2nd-ave-new-york/26214688'],
    ['delivery.com', 'https://www.order.com/glue/705-BRBR-menu/4801'],
  ],
  departments: [
    ['Beer', '/collections/all-beer'],
    ['IPA', '/collections/ipa'],
    ['Hard seltzers & canned cocktails', '/collections/all-seltzer'],
    ['Hard cider', '/collections/hard-cider'],
    ['Wine & spirits', '/collections/all-wine'],
    ['Drinks & mixers (soda, juice, water, energy drinks, iced tea & coffee)', '/collections/drink-mixers'],
    ['Snacks & chips', '/collections/snacks'],
    ['Candy & sweets', '/collections/candy-sweets'],
    ['Dairy, eggs & deli', '/collections/dairy-deli'],
    ['Grocery & pantry', '/collections/grocery-pantry'],
    ['Ice cream & frozen', '/collections/ice-cream-frozen'],
    ['Household & essentials', '/collections/household-essentials'],
    ['Pet care (dog & cat food, treats, litter, supplies)', '/collections/pet-care'],
    ['Everything', '/collections/all'],
  ],
};

export function nyNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hourCycle: 'h12',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const hour24 = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(date));
  return {
    text: `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} (New York time)`,
    open: hour24 >= 6, // open 6 AM to midnight
  };
}

export function systemPrompt(env, page, now = nyNow()) {
  const site = env.STORE_URL || 'https://705brbr.org';
  const depts = STORE.departments.map(([n, p]) => `- ${n}: ${site}${p}`).join('\n');
  const delivery = STORE.delivery.map(([n, u]) => `- ${n}: ${u}`).join('\n');
  return `You are Murray, the friendly shopping assistant for ${STORE.name}, a neighborhood bodega and market in Murray Hill, Manhattan (you're named after the neighborhood). You chat with customers on the store's website, ${site}.

YOUR JOB
Help people shop at ${STORE.name} and answer questions about the store, thoroughly and accurately. Stay focused on the shop: products, prices, availability, ordering, pickup, delivery, hours, location, the welcome offer, NY Lottery and in-store services. If someone asks about something unrelated (homework, general trivia, coding, news, other businesses), say briefly and kindly that you can only help with ${STORE.name}, then offer something you can help with.

RIGHT NOW
It is ${now.text}. The store is ${now.open ? 'OPEN now (closes at midnight)' : 'CLOSED now (opens at 6:00 AM)'}.${page ? `\nThe customer is looking at this page: ${site}${page}` : ''}

STORE FACTS (use these; don't invent other facts)
- Address: ${STORE.address}. ${STORE.corner}. Map: ${STORE.maps}
- Hours: ${STORE.hours}, 7 days a week.
- Phone: ${STORE.phone}  Email: ${STORE.email}  Contact form: ${site}/#contact
- What we sell: cold beer (lots of craft beer and IPAs), hard seltzers and canned cocktails, ciders, wine and spirits, sodas, juices, water, energy drinks, snacks and chips, candy, dairy, eggs and deli, groceries and pantry items, ice cream and frozen treats, household essentials, and pet food, treats and supplies.
- Departments:
${depts}
- Ways to get an order:
  1. Pick up in store: order on ${site}, choose Pickup at checkout, collect at 705 2nd Ave.
  2. Shipping: order on ${site} and have it shipped (US only).
  3. Fast local delivery through partner apps:
${delivery}
  Delivery areas, fees, minimums and times are set by each app. Don't promise we deliver to a specific area; say to enter the address in the app to see if it's covered.
- In-store services: NY Lottery (Powerball, Mega Millions, Millionaire for Life, NY LOTTO, Take 5, Numbers, Win 4, Pick 10, Quick Draw and scratch-offs; tickets sold in store only, 18+; results and next draws at ${site}/pages/lottery), on-site ATM, LuggageHero luggage storage (insured, hourly or daily, near Grand Central), Vinted Go parcel drop-off and collection, Amazon Hub package pickup point.
- Welcome offer: new customers get 10% off their order by signing up with their first name, last name, email and mobile number at ${site}/#welcome-offer. The 10% code is emailed to them after they sign up. It is for online orders (enter it at checkout on ${site}), works once per customer, and only for people who signed up with that form. Everyone who signs up gets the same code by email. Don't say it works in store, never describe the code as "unique", "personal" or "one-time", and don't share the code itself; tell them to sign up to get it.
- Alcohol: you must be 21+ and show valid photo ID to buy or receive alcohol. Lottery is 18+.
- Prices on the website are the online prices.

USING YOUR TOOLS
- For ANY question about specific products, brands, prices, sizes or whether we carry something, call search_products first. Never guess a price or claim we carry something without checking. Try a second, broader search (e.g. just the brand or category) if the first one finds nothing.
- Use get_product when someone wants details about one item (size, pack, description, options).
- When you recommend or list specific products, call show_products with their handles so they appear as cards with photos and links (up to 6).
- Use get_lottery for winning numbers or jackpots.
- Website stock can differ from the shelf, so say an item is "available online" or "on our site" rather than "in stock". If someone needs to be sure it's on the shelf right now, suggest calling ${STORE.phone}.

THINGS YOU DON'T KNOW
- Returns, refunds and delivery fees/times through partner apps: say you don't have those details and give the phone number, email or contact form. Delivery app fees and times are shown in each app.
- Never make up promotions, discounts, policies, stock levels or prices. Don't promise anything the store hasn't said.
- Don't ask for or accept card numbers, passwords or other sensitive details. Orders are placed on the website.

STYLE
- Warm, upbeat, neighborly, like a helpful clerk at the counter. Light emoji are fine (one or two).
- Be thorough but easy to scan: short paragraphs, bullet points for lists, **bold** for key info, prices like $4.99. Include direct links (full URLs) to products, departments or pages when helpful.
- The chat window is small: never use tables, headings (#) or horizontal rules (---). Use simple bullet or numbered lists instead. Aim for under 160 words unless the customer asks for more detail.
- Answer the actual question first, then offer one useful next step.
- If a request is unclear, ask one short question.`;
}

// New York State open data feeds (fallback for lottery results). Numbers and Win 4 share one feed.
export const LOTTERY_FEEDS = {
  powerball: 'd6yy-54nr',
  mega_millions: '5xaw-6ayf',
  lotto: '6nbc-h7bj',
  take5: 'dg63-4siq',
  numbers_and_win4: 'hsys-3def',
  pick10: 'bycu-cw7c',
  millionaire_for_life: 'a4w9-a3tp',
};

export const TOOLS = [
  {
    name: 'search_products',
    description: 'Search the 705 BRBR online catalog. Returns up to 8 matching products with title, handle, price (USD), availability, product type and URL. Use short keyword queries, e.g. "Modelo", "IPA 6 pack", "cat litter", "oat milk".',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keywords to search for' } },
      required: ['query'],
    },
  },
  {
    name: 'get_product',
    description: 'Get full details for one product by its handle: description, price, options/variants, availability.',
    input_schema: {
      type: 'object',
      properties: { handle: { type: 'string', description: 'Product handle from search_products' } },
      required: ['handle'],
    },
  },
  {
    name: 'show_products',
    description: 'Show product cards (photo, name, price, link) under your reply. Pass the handles of the products you are recommending, best first. Max 6.',
    input_schema: {
      type: 'object',
      properties: { handles: { type: 'array', items: { type: 'string' }, maxItems: 6 } },
      required: ['handles'],
    },
  },
  {
    name: 'get_lottery',
    description: 'Latest NY Lottery winning numbers (including Midday and Evening draws for Take 5, Numbers and Win 4) and next jackpots.',
    input_schema: { type: 'object', properties: {} },
  },
];

function cleanUrl(u, site) {
  const path = String(u || '').split('?')[0];
  return path.startsWith('http') ? path : site + path;
}

export function slimProduct(p, site) {
  if (!p) return null;
  const price = p.price != null ? Number(p.price) : null;
  return {
    title: p.title,
    handle: p.handle,
    price: price != null && !Number.isNaN(price) ? Math.round(price * 100) / 100 : null, // dollars
    available: p.available !== false,
    type: p.type || p.product_type || '',
    url: cleanUrl(p.url || `/products/${p.handle}`, site),
    image: p.image || p.featured_image || (p.images && p.images[0]) || null,
  };
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

async function fetchJSON(url, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'BRBR-Murray/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export async function runTool(name, input, ctx) {
  const site = ctx.site;
  try {
    if (name === 'search_products') {
      const q = String(input.query || '').slice(0, 80);
      const url = `${site}/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=8&resources[options][unavailable_products]=last&resources[options][fields]=title,product_type,variants.title,vendor,tag`;
      const data = await fetchJSON(url);
      const list = ((data.resources && data.resources.results && data.resources.results.products) || []).map((p) => slimProduct(p, site));
      list.forEach((p) => { ctx.seen[p.handle] = p; });
      return { query: q, count: list.length, products: list.map(({ image, ...rest }) => rest) };
    }
    if (name === 'get_product') {
      const handle = String(input.handle || '').replace(/[^a-z0-9\-_]/gi, '');
      const p = await fetchJSON(`${site}/products/${handle}.js`);
      const slim = slimProduct({ ...p, price: p.price / 100, image: p.featured_image ? (String(p.featured_image).startsWith('//') ? 'https:' + p.featured_image : p.featured_image) : null }, site);
      ctx.seen[slim.handle] = slim;
      return {
        ...slim,
        image: undefined,
        description: stripHtml(p.description).slice(0, 900),
        variants: (p.variants || []).slice(0, 12).map((v) => ({ title: v.title, price: v.price / 100, available: v.available })),
      };
    }
    if (name === 'show_products') {
      const handles = (input.handles || []).slice(0, 6);
      for (const h of handles) {
        let p = ctx.seen[h];
        if (!p) {
          try {
            const d = await fetchJSON(`${site}/products/${String(h).replace(/[^a-z0-9\-_]/gi, '')}.js`);
            p = slimProduct({ ...d, price: d.price / 100, image: d.featured_image ? (String(d.featured_image).startsWith('//') ? 'https:' + d.featured_image : d.featured_image) : null }, site);
          } catch {
            p = null;
          }
        }
        if (p && !ctx.cards.some((c) => c.handle === p.handle)) ctx.cards.push(p);
      }
      return { shown: ctx.cards.map((c) => c.title) };
    }
    if (name === 'get_lottery') {
      // 1) the 705 BRBR lottery Worker (official NY Lottery feed, includes jackpots)
      const base = (ctx.env.LOTTERY_API || '').replace(/\/+$/, '');
      if (base) {
        try {
          const d = ctx.env.LOTTERY && ctx.env.LOTTERY.fetch
            ? await (await ctx.env.LOTTERY.fetch('https://lottery/draws')).json()
            : await fetchJSON(`${base}/draws`);
          const games = d.games || {};
          if (Object.keys(games).length) {
            const out = {};
            for (const [k, g] of Object.entries(games)) {
              const rows = (g.rows || []).slice(0, 2);
              out[k] = { latest: rows, next_jackpot: g.next && g.next.jackpot ? `$${Math.round(g.next.jackpot).toLocaleString('en-US')}` : null, next_draw_date: g.next ? g.next.date : null };
            }
            return { source: 'NY Lottery', games: out, more: `${site}/pages/lottery` };
          }
        } catch { /* fall through to open data */ }
      }
      // 2) New York State open data (official results, published after each draw)
      const out = {};
      await Promise.all(Object.entries(LOTTERY_FEEDS).map(async ([k, id]) => {
        try {
          out[k] = { latest: await fetchJSON(`https://data.ny.gov/resource/${id}.json?$order=draw_date%20DESC&$limit=2`, 5000) };
        } catch { /* skip this game */ }
      }));
      if (!Object.keys(out).length) return { error: `Lottery results are unavailable right now. See ${site}/pages/lottery or call ${STORE.phone}.` };
      return { source: 'data.ny.gov', games: out, note: 'Jackpot amounts not included; see the lottery page.', more: `${site}/pages/lottery` };
    }
    return { error: `Unknown tool ${name}` };
  } catch (e) {
    return { error: `Could not load that right now (${e.message}). Suggest calling ${STORE.phone}.` };
  }
}

export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, m.role === 'user' ? MAX_CHARS : 4000) }))
    .slice(-MAX_TURNS);
  while (clean.length && clean[0].role !== 'user') clean.shift();
  // Merge consecutive messages from the same role (the API needs alternating turns)
  const merged = [];
  for (const m of clean) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else merged.push({ ...m });
  }
  return merged;
}

export function provider(env) {
  if (env.GROQ_API_KEY) return 'groq';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

function prepare(env, body) {
  const site = (env.STORE_URL || 'https://705brbr.org').replace(/\/+$/, '');
  const messages = sanitizeMessages(body && body.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return null;
  const page = typeof body.page === 'string' && body.page.startsWith('/') ? body.page.slice(0, 200) : '';
  return { site, messages, page, ctx: { site, env, seen: {}, cards: [] }, system: systemPrompt(env, page) };
}

function finish(reply, ctx) {
  return {
    status: 200,
    json: {
      reply: String(reply || '').trim() || `Sorry, I couldn't come up with an answer just now. You can reach the store at ${STORE.phone}.`,
      products: ctx.cards.map(({ title, price, url, image, available }) => ({ title, price, url, image, available })),
    },
  };
}

const TOO_LONG = { status: 200, json: { reply: `Sorry, that took too long. Please try again, or call the store at ${STORE.phone}.`, products: [] } };

export async function chat(env, body, deps = {}) {
  if (provider(env) === 'groq') return chatGroq(env, body, deps);
  return chatClaude(env, body, deps);
}

// Groq (OpenAI-compatible chat completions with function tools)
export async function chatGroq(env, body, deps = {}) {
  const callGroq = deps.callGroq || defaultCallGroq;
  const prep = prepare(env, body);
  if (!prep) return { status: 400, json: { error: 'Send at least one user message.' } };
  const { ctx } = prep;
  const tools = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const convo = [{ role: 'system', content: prep.system }].concat(prep.messages.map((m) => ({ role: m.role, content: m.content })));
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const last = round === MAX_TOOL_ROUNDS;
    const res = await callGroq(env, {
      model: env.GROQ_MODEL || 'openai/gpt-oss-120b',
      max_tokens: 1200,
      temperature: 0.3,
      messages: convo,
      ...(last ? {} : { tools, tool_choice: 'auto' }),
    });
    const msg = (res.choices && res.choices[0] && res.choices[0].message) || {};
    const calls = msg.tool_calls || [];
    if (!calls.length) return finish(msg.content, ctx);
    convo.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const c of calls) {
      let args = {};
      try { args = JSON.parse((c.function && c.function.arguments) || '{}') || {}; } catch { args = {}; }
      const out = await runTool(c.function && c.function.name, args, ctx);
      convo.push({ role: 'tool', tool_call_id: c.id, name: c.function && c.function.name, content: JSON.stringify(out).slice(0, 12000) });
    }
  }
  return TOO_LONG;
}

// Models to try in order. Each Groq model has its own rate limit, so when one is busy (429) or failing
// we wait briefly once, then move on to the next.
export function groqModels(env) {
  const list = [env.GROQ_MODEL || 'openai/gpt-oss-120b']
    .concat(String(env.GROQ_FALLBACK_MODELS || 'llama-3.3-70b-versatile,openai/gpt-oss-20b').split(','))
    .map((m) => m.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function defaultCallGroq(env, payload, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const wait = deps.sleep || sleep;
  const models = payload.model ? [payload.model].concat(groqModels(env).filter((m) => m !== payload.model)) : groqModels(env);
  let lastErr = null;
  const errs = [];
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await doFetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({ ...payload, model }),
      });
      if (r.ok) return r.json();
      const text = await r.text().catch(() => '');
      lastErr = new Error(`Groq API ${r.status} (${model}): ${text.slice(0, 160)}`);
      errs.push(lastErr.message);
      if (r.status === 429) {
        const after = Number(r.headers.get('retry-after')) || 0;
        if (attempt === 0 && after > 0 && after <= 4) { await wait(after * 1000); continue; }
        break; // try the next model
      }
      if (r.status >= 500 || r.status === 413 || r.status === 400 || r.status === 404) break; // next model
      throw lastErr; // auth or other client errors: stop
    }
  }
  throw new Error(errs.join(' | ') || 'Groq API unavailable');
}

// Anthropic Claude (Messages API with tools)
export async function chatClaude(env, body, deps = {}) {
  const callClaude = deps.callClaude || defaultCallClaude;
  const site = (env.STORE_URL || 'https://705brbr.org').replace(/\/+$/, '');
  const messages = sanitizeMessages(body && body.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return { status: 400, json: { error: 'Send at least one user message.' } };
  }
  const page = typeof body.page === 'string' && body.page.startsWith('/') ? body.page.slice(0, 200) : '';
  const ctx = { site, env, seen: {}, cards: [] };
  const system = systemPrompt(env, page);
  const convo = messages.map((m) => ({ role: m.role, content: m.content }));

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await callClaude(env, {
      model: env.MODEL || 'claude-haiku-5-5',
      max_tokens: 900,
      system,
      tools: TOOLS,
      tool_choice: round === MAX_TOOL_ROUNDS ? { type: 'none' } : { type: 'auto' },
      messages: convo,
    });
    const content = res.content || [];
    const uses = content.filter((c) => c.type === 'tool_use');
    if (!uses.length || res.stop_reason !== 'tool_use') {
      const reply = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      return {
        status: 200,
        json: {
          reply: reply || `Sorry, I couldn't come up with an answer just now. You can reach the store at ${STORE.phone}.`,
          products: ctx.cards.map(({ title, price, url, image, available }) => ({ title, price, url, image, available })),
        },
      };
    }
    convo.push({ role: 'assistant', content });
    const results = [];
    for (const u of uses) {
      const out = await runTool(u.name, u.input || {}, ctx);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 12000) });
    }
    convo.push({ role: 'user', content: results });
  }
  return { status: 200, json: { reply: `Sorry, that took too long. Please try again, or call the store at ${STORE.phone}.`, products: [] } };
}

async function defaultCallClaude(env, payload) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Claude API ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

/* ---------- HTTP ---------- */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > RATE.max;
}

function corsHeaders(env, origin) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = origin && (allowed.includes(origin) || /^https:\/\/[a-z0-9-]+\.shopifypreview\.com$/.test(origin));
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(env, origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, name: 'Murray (705 BRBR assistant)', ready: Boolean(provider(env)), provider: provider(env) }, 200, cors);
    }
    if (url.pathname === '/models' && env.GROQ_API_KEY) {
      // Lists the Groq model ids this key can use (ids only, no key or account details).
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${env.GROQ_API_KEY}` } });
      const j = await r.json().catch(() => ({}));
      return json({ status: r.status, configured: groqModels(env), available: ((j && j.data) || []).map((m) => m.id).sort() }, 200, cors);
    }
    if (url.pathname !== '/chat' || request.method !== 'POST') return json({ error: 'Not found' }, 404, cors);
    if (!provider(env)) return json({ error: 'Murray is not set up yet.' }, 503, cors);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) return json({ error: 'You are sending messages very fast. Please wait a minute and try again.' }, 429, cors);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid request.' }, 400, cors);
    }
    try {
      const out = await chat(env, body);
      return json(out.json, out.status, cors);
    } catch (e) {
      console.error('chat failed', e && e.message);
      const out = { reply: `Sorry, I'm having trouble right now. Please try again in a moment, or call the store at ${STORE.phone}.`, products: [] };
      if (body && body.debug === true) out.error_detail = String((e && e.message) || e).slice(0, 400); // troubleshooting only
      return json(out, 200, cors);
    }
  },
};
