/*
  705 BRBR — NY Lottery
  - Games come from Shopify admin (Content > Metaobjects > Lottery Game), printed into the page as JSON.
  - Live data from the 705 BRBR Cloudflare Worker (official NY Lottery feeds): winning numbers minutes after each draw,
    next jackpots, and game details (price, odds, top prize, draw days/times, how to play) override the admin entries.
  - Older results and date lookups come from the New York State open data site (data.ny.gov), also the fallback.
  - Next-draw countdowns use each game's draw schedule in New York (Eastern) time.
  - Twice-daily games (Take 5, Numbers, Win 4) show the latest Midday AND Evening results side by side, and an
    open page re-checks for new results (every minute right after a draw, otherwise every 5 minutes).
*/
(function () {
  'use strict';
  if (window.BRBRLottery) return;

  var FEEDS = {
    powerball: { id: 'd6yy-54nr' },
    mega_millions: { id: '5xaw-6ayf' },
    lotto: { id: '6nbc-h7bj' },
    take5: { id: 'dg63-4siq' },
    numbers: { id: 'hsys-3def' },
    win4: { id: 'hsys-3def' },
    pick10: { id: 'bycu-cw7c' },
    quickdraw: { id: '7sqk-ycpk', order: 'draw_date DESC, draw_number DESC' },
    millionaire_for_life: { id: 'a4w9-a3tp' }
  };
  var API = 'https://data.ny.gov/resource/';
  var CACHE_MIN = 10;
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function lines(s) { return String(s || '').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean); }

  /* ---------- Live NY Lottery data (705 BRBR Cloudflare Worker) ---------- */
  var LIVE = null;
  function liveBase() {
    var el = document.getElementById('brbr-lottery-live'), u = '';
    try { u = el ? JSON.parse(el.textContent) : ''; } catch (e) { u = ''; }
    return String(u || '').trim().replace(/\/+$/, '');
  }
  function loadLive(force) {
    if (loadLive.p && !force) return loadLive.p;
    var base = liveBase();
    if (!base) return (loadLive.p = Promise.resolve(null));
    var key = 'brbr-lt-live:' + base;
    if (!force) try {
      var c = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (c && Date.now() - c.t < 120000) { LIVE = c.v; return (loadLive.p = Promise.resolve(c.v)); }
    } catch (e) {}
    function get(path) {
      return fetch(base + path + (force ? (path.indexOf('?') > -1 ? '&' : '?') + 't=' + Date.now() : ''), force ? { cache: 'no-store' } : undefined).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).catch(function () { return null; });
    }
    loadLive.p = Promise.all([get('/games'), get('/draws')]).then(function (res) {
      var v = { games: (res[0] && res[0].games) || {}, draws: (res[1] && res[1].games) || {} };
      if (!Object.keys(v.games).length && !Object.keys(v.draws).length) return null;
      LIVE = v;
      try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v: v })); } catch (e) {}
      return v;
    });
    return loadLive.p;
  }
  function withTimeout(p, ms) { return Promise.race([p, new Promise(function (r) { setTimeout(function () { r(null); }, ms); })]); }
  function applyLive(games) {
    if (!LIVE) return games;
    games.forEach(function (g) {
      var k = g.data_key, d = k && LIVE.games[k], dr = k && LIVE.draws[k];
      if (d) ['tagline', 'price', 'odds', 'top_prize', 'schedule', 'schedule_label', 'how_to_play', 'add_ons'].forEach(function (f) { if (d[f]) g[f] = d[f]; });
      g.jackpot = (dr && dr.next && dr.next.jackpot) || null;
      g.cash = (dr && dr.next && dr.next.cash) || null;
    });
    return games;
  }
  function money(n) {
    if (!n) return '';
    if (n >= 1e9) return '$' + (Math.round(n / 1e7) / 100) + ' Billion';
    if (n >= 1e6) return '$' + (Math.round(n / 1e5) / 10) + ' Million';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  (function css() {
    if (document.getElementById('brbr-lt-live-css')) return;
    var st = document.createElement('style');
    st.id = 'brbr-lt-live-css';
    st.textContent = '.lt-chip-jackpot{display:block;margin-top:3px;font-size:16px;font-weight:900;color:#059669;letter-spacing:-.01em;line-height:1.15}' +
      '.lt-chip-jackpot small{display:block;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#64748B}' +
      '.lt-facts dd.lt-jp{color:#059669;font-weight:900}' +
      '.lt-quick .lt-quick-jp b{color:#059669}.lt-quick .lt-quick-jp em{display:block;font-style:normal;font-size:12px;color:#64748B;font-weight:600;margin-top:2px}' +
      '.lt-twice{display:grid;grid-template-columns:1fr 1fr;gap:10px}.lt-twice .lt-draw{margin:0;padding:10px 12px;border:1px solid #E2E8F0;border-radius:12px;background:#F8FAFC}' +
      '.lt-twice .lt-draw-label{display:block;margin-bottom:6px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#6D28D9}' +
      '.lt-twice--card{gap:6px;margin-top:4px}.lt-twice--card .lt-draw{padding:6px 8px;border-radius:10px}.lt-twice--card .lt-draw-label{margin-bottom:4px;font-size:10px}' +
      '.lt-draw--pending .lt-muted{font-size:13px}@media (max-width:420px){.lt-twice{grid-template-columns:1fr}}';
    document.head.appendChild(st);
  })();

  /* ---------- Games ---------- */
  function readGames() {
    var el = document.getElementById('brbr-lottery-games');
    if (!el) return [];
    var list;
    try { list = JSON.parse(el.textContent); } catch (e) { return []; }
    return applyLive(list.filter(function (g) { return g && g.active !== false && g.name; })
      .sort(function (a, b) { return (a.sort || 99) - (b.sort || 99); }));
  }

  /* ---------- New York time + schedules ---------- */
  var etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
  var WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  function etNow() {
    var p = {};
    etFmt.formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    return { dow: WD[p.weekday], min: Number(p.hour) % 24 * 60 + Number(p.minute) + Number(p.second) / 60 };
  }

  function parseSchedule(s) {
    s = String(s || '').trim();
    if (!s) return null;
    if (/^every\s*4/i.test(s)) return { every: 4 };
    var slots = [];
    s.split('|').forEach(function (seg) {
      var m = seg.trim().match(/^([\d,\-]+)@(\d{1,2}):(\d{2})$/);
      if (!m) return;
      var days = [];
      m[1].split(',').forEach(function (part) {
        var r = part.split('-').map(Number);
        if (r.length === 2) { for (var d = r[0]; d <= r[1]; d++) days.push(d); } else days.push(r[0]);
      });
      slots.push({ days: days, t: Number(m[2]) * 60 + Number(m[3]) });
    });
    return slots.length ? { slots: slots } : null;
  }

  function fmtTime(t) {
    var h = Math.floor(t / 60), m = t % 60;
    return ((h + 11) % 12 + 1) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  function nextDraw(game) {
    var sched = parseSchedule(game.schedule);
    if (!sched) return null;
    var now = etNow();
    if (sched.every) {
      // Quick Draw runs roughly 4:04 AM to 3:24 AM; closed in between
      if (now.min >= 204 && now.min < 244) return { inMin: 244 - now.min, when: 'Today ' + fmtTime(244), every: true };
      var left = 4 - (now.min % 4);
      return { inMin: left, when: 'Every 4 minutes', every: true };
    }
    var best = null;
    for (var d = 0; d <= 7; d++) {
      var dow = (now.dow + d) % 7;
      sched.slots.forEach(function (sl) {
        if (sl.days.indexOf(dow) === -1) return;
        var diff = d * 1440 + sl.t - now.min;
        if (diff <= 0) return;
        if (!best || diff < best.inMin) best = { inMin: diff, d: d, t: sl.t, dow: dow };
      });
      if (best && best.d === d) break;
    }
    if (!best) return null;
    var day = best.d === 0 ? (best.t >= 17 * 60 ? 'Tonight' : 'Today') : best.d === 1 ? 'Tomorrow' : DAYS[best.dow];
    best.when = day + ' ' + fmtTime(best.t);
    return best;
  }

  function countdown(min) {
    if (min == null) return '';
    min = Math.max(0, Math.round(min));
    if (min < 1) return 'drawing now';
    if (min < 60) return 'in ' + min + 'm';
    var h = Math.floor(min / 60), m = min % 60;
    if (h < 24) return 'in ' + h + 'h ' + m + 'm';
    return 'in ' + Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }

  /* ---------- Results (data.ny.gov) ---------- */
  function cacheGet(key) {
    try {
      var raw = sessionStorage.getItem(key);
      if (!raw) return null;
      var o = JSON.parse(raw);
      return Date.now() - o.t < CACHE_MIN * 60000 ? o.v : null;
    } catch (e) { return null; }
  }
  function cacheSet(key, v) { try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v: v })); } catch (e) {} }

  var inflight = {};
  function query(feedKey, params) {
    var f = FEEDS[feedKey];
    if (!f) return Promise.resolve([]);
    var qs = '$order=' + encodeURIComponent(f.order || 'draw_date DESC') + '&' + params;
    var url = API + f.id + '.json?' + qs;
    var key = 'brbr-lt:' + url;
    var hit = cacheGet(key);
    if (hit) return Promise.resolve(hit);
    if (inflight[url]) return inflight[url];
    inflight[url] = fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (rows) { cacheSet(key, rows); delete inflight[url]; return rows; })
      .catch(function (e) { delete inflight[url]; throw e; });
    return inflight[url];
  }
  // Newest draws come from the live NY Lottery feed; older ones are filled in from data.ny.gov
  function latest(feedKey, n) {
    n = n || 1;
    var lr = (LIVE && LIVE.draws[feedKey] && LIVE.draws[feedKey].rows) || [];
    if (lr.length >= n) return Promise.resolve(lr.slice(0, n));
    return query(feedKey, '$limit=' + n).then(function (rows) {
      if (!lr.length) return rows;
      var seen = {};
      lr.forEach(function (r) { seen[String(r.draw_date).slice(0, 10)] = 1; });
      return lr.concat(rows.filter(function (r) { return !seen[String(r.draw_date).slice(0, 10)]; })).slice(0, n);
    }, function (e) { if (lr.length) return lr.slice(0, n); throw e; });
  }
  function onDate(feedKey, ymd) {
    return query(feedKey, '$where=' + encodeURIComponent("draw_date='" + ymd + "T00:00:00.000'") + '&$limit=' + (feedKey === 'quickdraw' ? 30 : 5));
  }

  function nums(s) { return String(s || '').trim().split(/\s+/).filter(Boolean); }
  function balls(list, cls) { return list.map(function (n) { return { n: n, c: cls || '' }; }); }

  // Turn one data row into one or more draws: [{label, balls:[{n,c}], notes:[]}]
  function parseRow(feedKey, r) {
    var n, out = [];
    switch (feedKey) {
      case 'powerball':
        n = nums(r.winning_numbers);
        out.push({ label: '', balls: balls(n.slice(0, 5)).concat(balls(n.slice(5, 6), 'red')), notes: r.multiplier ? ['Power Play ' + Number(r.multiplier) + 'X'] : [] });
        if (r.double_play_winning_numbers) {
          var dp = nums(r.double_play_winning_numbers);
          out.push({ label: 'Double Play', balls: balls(dp.slice(0, 5)).concat(balls(dp.slice(5, 6), 'red')), notes: [] });
        }
        break;
      case 'mega_millions':
        out.push({ label: '', balls: balls(nums(r.winning_numbers)).concat(balls([r.mega_ball], 'gold')), notes: r.megaplier ? ['Multiplier ' + Number(r.megaplier) + 'X'] : [] });
        break;
      case 'millionaire_for_life':
        out.push({ label: '', balls: balls(nums(r.winning_numbers)).concat(balls([r.mill_ball], 'green')), notes: [] });
        break;
      case 'lotto':
        out.push({ label: '', balls: balls(nums(r.winning_numbers)).concat(r.bonus ? balls([r.bonus], 'bonus') : []), notes: r.bonus ? ['Bonus ' + r.bonus] : [] });
        break;
      case 'take5':
        if (r.evening_winning_numbers) out.push({ label: 'Evening', balls: balls(nums(r.evening_winning_numbers)), notes: [] });
        if (r.midday_winning_numbers) out.push({ label: 'Midday', balls: balls(nums(r.midday_winning_numbers)), notes: [] });
        break;
      case 'numbers':
        if (r.evening_daily) out.push({ label: 'Evening', balls: balls(String(r.evening_daily).split(''), 'digit'), notes: [] });
        if (r.midday_daily) out.push({ label: 'Midday', balls: balls(String(r.midday_daily).split(''), 'digit'), notes: [] });
        break;
      case 'win4':
        if (r.evening_win_4) out.push({ label: 'Evening', balls: balls(String(r.evening_win_4).split(''), 'digit'), notes: [] });
        if (r.midday_win_4) out.push({ label: 'Midday', balls: balls(String(r.midday_win_4).split(''), 'digit'), notes: [] });
        break;
      case 'pick10':
        out.push({ label: '', small: true, balls: balls(nums(r.winning_numbers)), notes: [] });
        break;
      case 'quickdraw':
        var notes = [];
        if (r.draw_number) notes.push('Draw #' + r.draw_number);
        if (r.extra_multiplier && Number(r.extra_multiplier) > 1) notes.push('Extra ' + Number(r.extra_multiplier) + 'X');
        if (r.money_dots_winning_number) notes.push('Money Dot ' + r.money_dots_winning_number);
        out.push({ label: '', small: true, balls: balls(nums(r.winning_numbers)), notes: notes });
        break;
    }
    return out;
  }

  // Twice-daily games: newest Midday draw and newest Evening draw, each with its own date (they can differ:
  // in the afternoon the Midday is today's while the Evening is still last night's).
  var TWICE = /^(take5|numbers|win4)$/;
  function twiceDaily(feedKey, rows) {
    var out = { midday: null, evening: null };
    (rows || []).forEach(function (r) {
      parseRow(feedKey, r).forEach(function (dr) {
        var k = dr.label === 'Midday' ? 'midday' : dr.label === 'Evening' ? 'evening' : null;
        if (k && !out[k]) out[k] = { date: r.draw_date, draw: dr };
      });
    });
    return out;
  }
  function twiceHtml(feedKey, rows, opts) {
    var t = twiceDaily(feedKey, rows);
    return [['midday', 'Midday'], ['evening', 'Evening']].map(function (x) {
      var hit = t[x[0]];
      if (!hit) return '<div class="lt-draw lt-draw--pending"><span class="lt-draw-label">' + x[1] + '</span><span class="lt-muted">Not drawn yet</span></div>';
      var dr = { label: x[1] + ' · ' + fmtDate(hit.date), balls: hit.draw.balls, notes: [], small: hit.draw.small };
      return drawsHtml([dr], opts);
    }).join('');
  }
  function newestDate(rows) { return rows && rows[0] ? rows[0].draw_date : ''; }

  function fmtDate(iso, long) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return (long ? DAYS[d.getDay()] : DAYS[d.getDay()].slice(0, 3)) + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + (long ? ', ' + d.getFullYear() : '');
  }

  function drawsHtml(draws, opts) {
    opts = opts || {};
    return draws.map(function (dr) {
      var b = '<div class="lt-balls' + (dr.small || opts.small ? ' small' : '') + '">' +
        dr.balls.map(function (x) { return '<span class="lt-ball ' + x.c + '">' + esc(x.n) + '</span>'; }).join('') + '</div>';
      var notes = (opts.hideNotes ? [] : dr.notes).map(function (t) { return '<span class="lt-note">' + esc(t) + '</span>'; }).join('');
      return '<div class="lt-draw">' + (dr.label ? '<span class="lt-draw-label">' + esc(dr.label) + '</span>' : '') + b + notes + '</div>';
    }).join('');
  }

  /* ---------- Shared bits ---------- */
  var ICON_X = '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  function chipsHtml(games, limit, keepOrder) {
    var list = games.map(function (g) { return { g: g, nd: nextDraw(g) }; })
      .filter(function (x) { return x.nd; });
    if (!keepOrder) list.sort(function (a, b) { return (a.nd.every ? 1e9 : a.nd.inMin) - (b.nd.every ? 1e9 : b.nd.inMin); });
    if (limit) list = list.slice(0, limit);
    return list.map(function (x) {
      return '<button type="button" class="lt-chip" data-lt-game="' + esc(x.g.handle) + '" style="--c:' + esc(x.g.color || '#7C3AED') + '">' +
        (x.g.logo ? '<span class="lt-chip-logo"><img src="' + esc(x.g.logo) + '" alt="' + esc(x.g.name) + '" loading="lazy"></span>' : '<span class="lt-chip-name">' + esc(x.g.name) + '</span>') +
        '<span class="lt-chip-when">' + esc(x.nd.when) + (x.nd.every ? '' : ' ET') + '</span>' +
        (x.g.jackpot ? '<span class="lt-chip-jackpot"><small>Jackpot</small>' + esc(money(x.g.jackpot)) + '</span>' : '') +
        '<span class="lt-chip-count" data-lt-count="' + esc(x.g.handle) + '">' + (x.nd.every ? 'next ' : '') + esc(countdown(x.nd.inMin)) + '</span>' +
      '</button>';
    }).join('');
  }

  function tickCounts(root, games) {
    root.querySelectorAll('[data-lt-count]').forEach(function (el) {
      var g = games.filter(function (x) { return x.handle === el.dataset.ltCount; })[0];
      var nd = g && nextDraw(g);
      if (nd) el.textContent = (nd.every ? 'next ' : '') + countdown(nd.inMin);
    });
  }

  /* ---------- Game pop-up ---------- */
  var modal, lastFocus;
  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'lt-modal';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = '<div class="lt-modal-bg" data-lt-close></div><div class="lt-modal-box" id="ltBox"></div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function (e) {
      if (e.target.closest('[data-lt-close]')) closeGame();
    });
    modal.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeGame(); });
    return modal;
  }

  function closeGame() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.documentElement.classList.remove('lt-lock');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function openGame(g, focusResults) {
    ensureModal();
    lastFocus = document.activeElement;
    var nd = nextDraw(g);
    var box = document.getElementById('ltBox');
    box.style.setProperty('--c', g.color || '#7C3AED');
    var steps = lines(g.how_to_play), adds = lines(g.add_ons);
    var today = new Date();
    var ymdMax = today.getFullYear() + '-' + ('0' + (today.getMonth() + 1)).slice(-2) + '-' + ('0' + today.getDate()).slice(-2);
    box.innerHTML =
      '<div class="lt-modal-head">' +
        (g.logo ? '<img src="' + esc(g.logo) + '" alt="' + esc(g.name) + '">' : '<h2 id="ltTitle">' + esc(g.name) + '</h2>') +
        (g.logo ? '<h2 id="ltTitle" style="font-size:20px">' + esc(g.name) + '</h2>' : '') +
        (g.tagline ? '<p>' + esc(g.tagline) + '</p>' : '') +
        '<button type="button" class="lt-close" data-lt-close aria-label="Close">' + ICON_X + '</button>' +
      '</div>' +
      '<div class="lt-modal-body">' +
        '<div class="lt-quick">' +
          (g.jackpot ? '<div class="lt-quick-jp"><small>Next jackpot</small><b>' + esc(money(g.jackpot)) + '</b>' + (g.cash ? '<em>Cash option ' + esc(money(g.cash)) + '</em>' : '') + '</div>' : '') +
          (g.price ? '<div><small>Price</small><b>' + esc(g.price) + '</b></div>' : '') +
          (g.top_prize ? '<div><small>Top prize</small><b>' + esc(g.top_prize) + '</b></div>' : '') +
          (g.schedule_label ? '<div><small>Draws</small><b>' + esc(g.schedule_label) + '</b></div>' : '') +
          (g.odds ? '<div><small>Odds</small><b>' + esc(g.odds) + '</b></div>' : '') +
        '</div>' +
        (nd ? '<div class="lt-nextbox"><span>Next draw: <strong>' + esc(nd.when) + (nd.every ? '' : ' ET') + '</strong></span><span data-lt-count="' + esc(g.handle) + '">' + (nd.every ? 'next ' : '') + esc(countdown(nd.inMin)) + '</span></div>' : '') +
        (g.data_key ? '<div class="lt-block" id="ltLatest"><h3>Latest winning numbers</h3><p class="lt-muted">Loading results…</p></div>' : '') +
        (steps.length ? '<div class="lt-block"><h3>How to play</h3><ol class="lt-steps">' + steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div>' : '') +
        (adds.length ? '<div class="lt-block"><h3>Ways to play &amp; add-ons</h3><ul class="lt-list">' + adds.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></div>' : '') +
        (g.data_key ?
          '<div class="lt-block" id="ltHistory"><h3>Past results</h3>' +
            '<form class="lt-lookup" id="ltLookup"><label for="ltDate" class="lt-muted">Look up a date</label><input type="date" id="ltDate" max="' + ymdMax + '" min="2010-01-01" required><button type="submit">Show results</button></form>' +
            '<div id="ltHistoryBody"><p class="lt-muted">Loading recent draws…</p></div>' +
          '</div>' : '') +
        '<div class="lt-modal-foot"><span>Tickets are sold in store only. Must be 18 or older to play.</span>' +
          (g.official_url ? '<a href="' + esc(g.official_url) + '" target="_blank" rel="noopener">Official prizes, odds &amp; jackpots &rarr;</a>' : '') +
        '</div>' +
      '</div>';
    box.setAttribute('aria-labelledby', 'ltTitle');
    modal.hidden = false;
    document.documentElement.classList.add('lt-lock');
    setTimeout(function () { var c = box.querySelector('.lt-close'); if (c) c.focus(); }, 30);

    if (!g.data_key) return;
    var multi = /^(take5|numbers|win4)$/.test(g.data_key);
    latest(g.data_key, 10).then(function (rows) {
      var latestEl = document.getElementById('ltLatest');
      var hist = document.getElementById('ltHistoryBody');
      if (!rows.length) {
        if (latestEl) latestEl.innerHTML = '<h3>Latest winning numbers</h3><p class="lt-muted">No results published yet.</p>';
        if (hist) hist.innerHTML = '';
        return;
      }
      if (latestEl) latestEl.innerHTML = multi
        ? '<h3>Latest winning numbers</h3><div class="lt-twice">' + twiceHtml(g.data_key, rows) + '</div>'
        : '<h3>Latest winning numbers <span class="lt-muted" style="font-weight:600">· ' + esc(fmtDate(rows[0].draw_date, true)) + '</span></h3>' + drawsHtml(parseRow(g.data_key, rows[0]));
      if (hist) hist.innerHTML = historyTable(g.data_key, rows.slice(g.data_key === 'quickdraw' ? 0 : 1), multi);
      if (focusResults && latestEl) latestEl.scrollIntoView({ block: 'start' });
    }).catch(function () {
      var latestEl = document.getElementById('ltLatest');
      if (latestEl) latestEl.innerHTML = '<h3>Latest winning numbers</h3><p class="lt-muted">Results are unavailable right now. Please try again shortly.</p>';
    });

    var form = document.getElementById('ltLookup');
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = document.getElementById('ltDate').value;
      var hist = document.getElementById('ltHistoryBody');
      if (!v || !hist) return;
      hist.innerHTML = '<p class="lt-muted">Loading…</p>';
      onDate(g.data_key, v).then(function (rows) {
        hist.innerHTML = rows.length
          ? historyTable(g.data_key, rows, multi)
          : '<p class="lt-muted">No ' + esc(g.name) + ' draw on ' + esc(fmtDate(v, true)) + '. Check the draw days: ' + esc(g.schedule_label || '') + '.</p>';
      }).catch(function () { hist.innerHTML = '<p class="lt-muted">Could not load that date. Please try again.</p>'; });
    });
  }

  function historyTable(feedKey, rows, multi) {
    if (!rows.length) return '';
    return '<table class="lt-table"><thead><tr><th>Date</th><th>Winning numbers</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var label = fmtDate(r.draw_date) + (feedKey === 'quickdraw' && r.draw_number ? '<br><span class="lt-muted">#' + esc(r.draw_number) + '</span>' : '');
        return '<tr><td>' + label + '</td><td>' + drawsHtml(parseRow(feedKey, r), { small: true, hideNotes: !multi && feedKey !== 'powerball' && feedKey !== 'lotto' }) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  /* ---------- Page ---------- */
  function mountPage(root) {
    var games = readGames();
    var next = root.querySelector('[data-lt-next]');
    var grid = root.querySelector('[data-lt-grid]');
    var board = root.querySelector('[data-lt-board]');
    if (!games.length) {
      if (grid) grid.innerHTML = '<p class="lt-muted">Lottery games will appear here once they are added in Shopify admin (Content &gt; Metaobjects &gt; Lottery Game).</p>';
      return;
    }

    if (next) next.innerHTML = chipsHtml(games);

    if (grid) grid.innerHTML = games.map(function (g) {
      var nd = nextDraw(g);
      return '<article class="lt-card" tabindex="0" role="button" data-lt-game="' + esc(g.handle) + '" style="--c:' + esc(g.color || '#7C3AED') + '" aria-label="' + esc(g.name) + ': how to play and results">' +
        '<div class="lt-card-top"><span class="lt-instore">In store only</span>' +
          (g.logo ? '<img src="' + esc(g.logo) + '" alt="' + esc(g.name) + '" loading="lazy">' : '<span class="lt-card-name">' + esc(g.name) + '</span>') +
        '</div>' +
        '<div class="lt-card-body">' +
          (g.tagline ? '<p class="lt-card-tag">' + esc(g.tagline) + '</p>' : '') +
          '<dl class="lt-facts">' +
            (g.jackpot ? '<dt>Next jackpot</dt><dd class="lt-jp">' + esc(money(g.jackpot)) + '</dd>' : '') +
            (g.price ? '<dt>Price</dt><dd>' + esc(g.price) + '</dd>' : '') +
            (g.top_prize ? '<dt>Top prize</dt><dd>' + esc(g.top_prize) + '</dd>' : '') +
            (g.schedule_label ? '<dt>Draws</dt><dd>' + esc(g.schedule_label) + '</dd>' : '') +
          '</dl>' +
          (nd ? '<div class="lt-card-next">Next draw: <strong>' + esc(nd.when) + '</strong> · <span data-lt-count="' + esc(g.handle) + '">' + (nd.every ? 'next ' : '') + esc(countdown(nd.inMin)) + '</span></div>' : '') +
          (g.data_key ? '<div class="lt-card-latest" data-lt-latest="' + esc(g.handle) + '"><small>Latest numbers</small><span class="lt-muted">Loading…</span></div>' : '') +
          '<button type="button" class="lt-btn" tabindex="-1">How to play &amp; results</button>' +
        '</div>' +
      '</article>';
    }).join('');

    if (board) board.innerHTML = games.filter(function (g) { return g.data_key; }).map(function (g) {
      return '<div class="lt-row" style="--c:' + esc(g.color || '#7C3AED') + '" data-lt-row="' + esc(g.handle) + '">' +
        '<div class="lt-row-head">' + (g.logo ? '<span class="lt-row-logo"><img src="' + esc(g.logo) + '" alt="' + esc(g.name) + '" loading="lazy"></span>' : '<strong>' + esc(g.name) + '</strong>') + '<span data-lt-date>Loading…</span></div>' +
        '<div data-lt-draws></div>' +
        '<button type="button" class="lt-link" data-lt-game="' + esc(g.handle) + '" data-lt-results>Past results &amp; how to play &rarr;</button>' +
      '</div>';
    }).join('');

    renderResults(root, games);

    bindOpen(root, games);
    setInterval(function () {
      if (next) next.innerHTML = chipsHtml(games);
      tickCounts(root, games);
      if (modal && !modal.hidden) tickCounts(modal, games);
    }, 30000);
    autoRefresh(root, games);

    // Open a game straight from a link like /pages/lottery#powerball
    var hash = decodeURIComponent(location.hash.replace('#', ''));
    var fromHash = games.filter(function (g) { return g.handle === hash; })[0];
    if (fromHash) openGame(fromHash);
  }

  // Latest numbers on the game cards and the "Latest winning numbers" board
  function renderResults(root, games) {
    games.forEach(function (g) {
      if (!g.data_key) return;
      var twice = TWICE.test(g.data_key);
      latest(g.data_key, twice ? 3 : 1).then(function (rows) {
        var r = rows[0];
        var cardEl = root.querySelector('[data-lt-latest="' + g.handle + '"]');
        var rowEl = root.querySelector('[data-lt-row="' + g.handle + '"]');
        if (!r) {
          if (cardEl) cardEl.innerHTML = '<small>Latest numbers</small><span class="lt-muted">Not published yet</span>';
          if (rowEl) rowEl.querySelector('[data-lt-date]').textContent = 'No results yet';
          return;
        }
        if (twice) {
          if (cardEl) cardEl.innerHTML = '<small>Latest numbers</small><div class="lt-twice lt-twice--card">' + twiceHtml(g.data_key, rows, { small: true, hideNotes: true }) + '</div>';
          if (rowEl) {
            rowEl.querySelector('[data-lt-date]').textContent = 'Midday & Evening';
            rowEl.querySelector('[data-lt-draws]').innerHTML = '<div class="lt-twice">' + twiceHtml(g.data_key, rows) + '</div>';
          }
          return;
        }
        var draws = parseRow(g.data_key, r);
        if (cardEl) cardEl.innerHTML = '<small>Latest numbers · ' + esc(fmtDate(r.draw_date)) + '</small>' + drawsHtml(draws.slice(0, 1), { small: true, hideNotes: true });
        if (rowEl) {
          rowEl.querySelector('[data-lt-date]').textContent = fmtDate(r.draw_date, true);
          rowEl.querySelector('[data-lt-draws]').innerHTML = drawsHtml(draws);
        }
      }).catch(function () {
        var cardEl = root.querySelector('[data-lt-latest="' + g.handle + '"]');
        if (cardEl && /Loading/.test(cardEl.textContent)) cardEl.innerHTML = '<small>Latest numbers</small><span class="lt-muted">Unavailable right now</span>';
        var rowEl = root.querySelector('[data-lt-row="' + g.handle + '"]');
        if (rowEl && /Loading/.test(rowEl.textContent)) rowEl.querySelector('[data-lt-date]').textContent = 'Results unavailable right now';
      });
    });
  }

  // Keep an open page current: re-check every minute for an hour after the Midday (2:30 PM) and Evening
  // (10:30 PM) draws, otherwise every 5 minutes. Paused while the tab is hidden; checks again when it comes back.
  function autoRefresh(root, games) {
    var lastRun = Date.now();
    function busyWindow() {
      var m = etNow().min;
      return (m >= 14 * 60 + 25 && m < 15 * 60 + 35) || (m >= 22 * 60 + 25 && m < 23 * 60 + 35);
    }
    function refresh() {
      lastRun = Date.now();
      try {
        Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf('brbr-lt:') === 0) sessionStorage.removeItem(k); });
      } catch (e) {}
      withTimeout(loadLive(true), 8000).then(function () {
        applyLive(games);
        renderResults(root, games);
      });
    }
    setInterval(function () {
      if (document.hidden) return;
      var gap = busyWindow() ? 60000 : 300000;
      if (Date.now() - lastRun >= gap - 1000) refresh();
    }, 60000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() - lastRun > 60000) refresh();
    });
  }

  function bindOpen(root, games) {
    root.addEventListener('click', function (e) {
      var el = e.target.closest('[data-lt-game]');
      if (!el) return;
      var g = games.filter(function (x) { return x.handle === el.dataset.ltGame; })[0];
      if (g) openGame(g, el.hasAttribute('data-lt-results'));
    });
    root.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.lt-card[data-lt-game]')) {
        e.preventDefault();
        e.target.click();
      }
    });
  }

  /* ---------- Homepage strip ---------- */
  function mountStrip(root) {
    var games = readGames();
    var next = root.querySelector('[data-lt-next]');
    if (!games.length || !next) { root.hidden = true; return; }
    var limit = Number(root.dataset.limit) || 4;
    // Homepage shows the headline games in their sort order (Powerball, Mega Millions, ...)
    next.innerHTML = chipsHtml(games, limit, true);
    bindOpen(root, games);
    setInterval(function () { next.innerHTML = chipsHtml(games, limit, true); }, 30000);
  }

  window.BRBRLottery = { mountPage: mountPage, mountStrip: mountStrip, nextDraw: nextDraw, openGame: openGame };

  function boot() {
    // Wait briefly for live NY Lottery data; if it is slow or unavailable, use the admin entries and data.ny.gov
    withTimeout(loadLive(), 3000).then(function () {
      document.querySelectorAll('[data-lt-page]').forEach(function (el) { if (!el.dataset.ready) { el.dataset.ready = '1'; mountPage(el); } });
      document.querySelectorAll('[data-lt-strip]').forEach(function (el) { if (!el.dataset.ready) { el.dataset.ready = '1'; mountStrip(el); } });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  document.addEventListener('shopify:section:load', boot);
})();
