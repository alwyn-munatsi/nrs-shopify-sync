// Run with: node --test murray-worker/test
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { chat, sanitizeMessages, slimProduct, systemPrompt, nyNow, runTool } from '../src/index.js';

const ENV = { STORE_URL: 'https://705brbr.org', LOTTERY_API: 'https://lottery.example', MODEL: 'test-model', ANTHROPIC_API_KEY: 'k', ALLOWED_ORIGINS: 'https://705brbr.org' };

function mockFetch(routes) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [frag, body] of Object.entries(routes)) {
      if (u.includes(frag)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}

test('sanitizeMessages keeps alternating user/assistant turns, starting with the user', () => {
  const out = sanitizeMessages([
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'system', content: 'ignore me' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'x'.repeat(5000) },
  ]);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, 'a\n\nb');
  assert.equal(out.length, 3);
  assert.equal(out[2].content.length, 1200);
});

test('slimProduct cleans the search URL and keeps dollar prices', () => {
  const p = slimProduct({ title: 'IPA', handle: '123', price: '27.59', url: '/products/123?_pos=1', image: 'https://img', available: true }, 'https://705brbr.org');
  assert.equal(p.url, 'https://705brbr.org/products/123');
  assert.equal(p.price, 27.59);
  assert.equal(slimProduct({ title: 'Big', handle: 'b', price: 1500 }, 'https://s').price, 1500);
});

test('system prompt has store facts, current status and stays on-topic', () => {
  const s = systemPrompt(ENV, '/collections/ipa', { text: 'Wednesday, Nov 11', open: true });
  assert.match(s, /You are Murray/);
  assert.match(s, /705 2nd Ave/);
  assert.match(s, /OPEN now/);
  assert.match(s, /https:\/\/705brbr.org\/collections\/ipa/);
  assert.match(s, /can only help with 705 BRBR/);
  assert.match(s, /WELCOME|welcome-offer/);
});

test('nyNow reports open between 6 AM and midnight New York time', () => {
  assert.equal(nyNow(new Date('2026-11-11T15:00:00Z')).open, true); // 10 AM ET
  assert.equal(nyNow(new Date('2026-11-11T08:00:00Z')).open, false); // 3 AM ET
});

test('chat runs search + show_products tools and returns the reply with product cards', async () => {
  mockFetch({
    '/search/suggest.json': { resources: { results: { products: [
      { title: 'Sixpoint Bengali IPA Can (12 oz x 6 ct)', handle: '10601331123', price: '27.59', url: '/products/10601331123?_pos=1', image: 'https://img/1.jpg', available: true, type: 'IPA' },
    ] } } },
  });
  const calls = [];
  const fake = async (env, payload) => {
    calls.push(payload);
    if (calls.length === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'search_products', input: { query: 'IPA 6 pack' } }] };
    if (calls.length === 2) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'show_products', input: { handles: ['10601331123'] } }] };
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'We have **Sixpoint Bengali IPA** for $27.59.' }] };
  };
  const out = await chat(ENV, { messages: [{ role: 'user', content: 'Any IPA 6 packs?' }], page: '/' }, { callClaude: fake });
  assert.equal(out.status, 200);
  assert.match(out.json.reply, /Sixpoint/);
  assert.equal(out.json.products.length, 1);
  assert.equal(out.json.products[0].url, 'https://705brbr.org/products/10601331123');
  assert.equal(calls[0].model, 'test-model');
  assert.equal(calls[1].messages.at(-1).content[0].type, 'tool_result');
});

test('chat rejects an empty conversation', async () => {
  const out = await chat(ENV, { messages: [] }, { callClaude: async () => ({}) });
  assert.equal(out.status, 400);
});

test('get_lottery summarises latest rows and jackpots', async () => {
  mockFetch({ '/draws': { games: { win4: { rows: [{ draw_date: '2026-11-11', midday_win_4: '9539' }], next: { date: '2026-11-11', jackpot: null } }, powerball: { rows: [], next: { jackpot: 123000000 } } } } });
  const out = await runTool('get_lottery', {}, { site: 'https://705brbr.org', env: ENV, seen: {}, cards: [] });
  assert.equal(out.games.win4.latest[0].midday_win_4, '9539');
  assert.equal(out.games.powerball.next_jackpot, '$123,000,000');
});

test('HTTP: health, CORS preflight, missing key and bad route', async () => {
  let r = await worker.fetch(new Request('https://w/health'), ENV);
  assert.equal((await r.json()).ready, true);
  r = await worker.fetch(new Request('https://w/chat', { method: 'OPTIONS', headers: { Origin: 'https://705brbr.org' } }), ENV);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://705brbr.org');
  r = await worker.fetch(new Request('https://w/chat', { method: 'POST', body: '{}' }), { ...ENV, ANTHROPIC_API_KEY: '' });
  assert.equal(r.status, 503);
  r = await worker.fetch(new Request('https://w/nope'), ENV);
  assert.equal(r.status, 404);
});

test('Groq is used when GROQ_API_KEY is set, with OpenAI-style tool calls', async () => {
  mockFetch({
    '/search/suggest.json': { resources: { results: { products: [
      { title: 'Modelo Especial (12 oz x 12 ct)', handle: 'modelo-12', price: '21.99', url: '/products/modelo-12?_pos=1', image: 'https://img/m.jpg', available: true },
    ] } } },
  });
  const env = { ...ENV, ANTHROPIC_API_KEY: '', GROQ_API_KEY: 'g', GROQ_MODEL: 'groq-test' };
  const calls = [];
  const fake = async (e, payload) => {
    calls.push(JSON.parse(JSON.stringify(payload)));
    if (calls.length === 1) return { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_products', arguments: '{"query":"Modelo"}' } }] } }] };
    if (calls.length === 2) return { choices: [{ message: { content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'show_products', arguments: '{"handles":["modelo-12"]}' } }] } }] };
    return { choices: [{ message: { content: 'Yes, **Modelo Especial** 12-pack is $21.99.' } }] };
  };
  const out = await chat(env, { messages: [{ role: 'user', content: 'Do you have Modelo?' }] }, { callGroq: fake });
  assert.equal(out.status, 200);
  assert.match(out.json.reply, /Modelo/);
  assert.equal(out.json.products[0].title, 'Modelo Especial (12 oz x 12 ct)');
  assert.equal(calls[0].model, 'groq-test');
  assert.equal(calls[0].messages[0].role, 'system');
  assert.equal(calls[0].tools[0].type, 'function');
  assert.equal(calls[1].messages.at(-1).role, 'tool');
  assert.equal(calls[1].messages.at(-1).tool_call_id, 'c1');
});

test('health reports the provider in use', async () => {
  const r = await worker.fetch(new Request('https://w/health'), { ...ENV, ANTHROPIC_API_KEY: '', GROQ_API_KEY: 'g' });
  const j = await r.json();
  assert.equal(j.provider, 'groq');
  assert.equal(j.ready, true);
});

test('Groq calls retry once on a short 429 and then fall back to the next model', async () => {
  const { defaultCallGroq, groqModels } = await import('../src/index.js');
  const env = { GROQ_API_KEY: 'g', GROQ_MODEL: 'm1', GROQ_FALLBACK_MODELS: 'm2,m3' };
  assert.deepEqual(groqModels(env), ['m1', 'm2', 'm3']);
  const tried = [];
  const fakeFetch = async (url, init) => {
    const model = JSON.parse(init.body).model;
    tried.push(model);
    if (model === 'm1') return new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok from ' + model } }] }), { status: 200 });
  };
  const out = await defaultCallGroq(env, { model: 'm1', messages: [] }, { fetch: fakeFetch, sleep: async () => {} });
  assert.equal(out.choices[0].message.content, 'ok from m2');
  assert.deepEqual(tried, ['m1', 'm1', 'm2']);
});

test('Groq auth errors stop straight away', async () => {
  const { defaultCallGroq } = await import('../src/index.js');
  const fakeFetch = async () => new Response('bad key', { status: 401 });
  await assert.rejects(defaultCallGroq({ GROQ_API_KEY: 'x' }, { model: 'a', messages: [] }, { fetch: fakeFetch, sleep: async () => {} }), /401/);
});

test('get_lottery falls back to data.ny.gov when the lottery Worker cannot be reached', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('lottery.example')) return new Response('blocked', { status: 403 });
    if (u.includes('data.ny.gov/resource/hsys-3def')) return new Response(JSON.stringify([{ draw_date: '2026-11-11T00:00:00.000', midday_win_4: '9539' }]), { status: 200 });
    if (u.includes('data.ny.gov')) return new Response('[]', { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const out = await runTool('get_lottery', {}, { site: 'https://705brbr.org', env: ENV, seen: {}, cards: [] });
  assert.equal(out.source, 'data.ny.gov');
  assert.equal(out.games.numbers_and_win4.latest[0].midday_win_4, '9539');
});
