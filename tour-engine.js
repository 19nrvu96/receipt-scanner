/* Guided tour engine, shared by FlipCheck, ListMe and Receipts (a copy lives in the Receipts repo).
   For each feature it opens the right screen, highlights the real thing on it, says step by step
   what to do, and ends with what that does across the apps and the Google Sheet (drawn previews
   with example data, so no real data is ever baked into the app).

   FlipTour.start(cfg, { menu })   cfg = { app, name, key, chapters, ready?: async () => bool }
   chapter = { id, icon, title, summary, steps: [step], effect?: [{ app, text, mock? }] }
   step    = { title, text, todo?: [..], go?: '#/hash' | async fn, target?: 'css' | fn, mock?: html, wait?: bool, missing?: text }
   Classic script (no modules) so the Receipts app can load it too. */
(function () {
  if (window.FlipTour) return;
  const css = `
.ft-ring{position:fixed;z-index:9998;pointer-events:none;border:3px solid var(--ft-accent);border-radius:12px;box-shadow:0 0 0 4000px rgba(0,0,0,.55);transition:all .25s ease;display:none}
.ft-dim{position:fixed;inset:0;z-index:9997;background:rgba(0,0,0,.55);pointer-events:none;display:none}
.ft-card{position:fixed;left:50%;transform:translateX(-50%);z-index:9999;width:min(540px,calc(100vw - 20px));max-height:min(64vh,640px);overflow:auto;
  background:var(--ft-bg);color:var(--ft-fg);border:1px solid var(--ft-line);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.45);padding:14px 16px 12px;
  font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-overflow-scrolling:touch}
.ft-card.bottom{bottom:calc(10px + env(safe-area-inset-bottom,0px))}.ft-card.top{top:calc(10px + env(safe-area-inset-top,0px))}
.ft-card.min{max-height:none;padding:8px 12px}
.ft-head{display:flex;align-items:center;gap:8px;font-size:12px;opacity:.8}
.ft-head .sp{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ft-ib{background:none;border:0;color:inherit;font-size:16px;line-height:1;padding:6px 8px;border-radius:8px;cursor:pointer;min-height:0}
.ft-ib:hover{background:rgba(127,127,127,.15)}
.ft-card h3{margin:6px 0 4px;font-size:19px;line-height:1.25}
.ft-card p{margin:6px 0}
.ft-todo{margin:8px 0;padding:10px 12px 10px 30px;background:rgba(127,127,127,.12);border-radius:10px}
.ft-todo li{margin:3px 0}
.ft-todo b,.ft-card p b{color:var(--ft-strong)}
.ft-lab{font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.7;margin:10px 0 4px}
.ft-wait{font-size:13px;background:#fff4d6;color:#6b4e00;border-radius:8px;padding:6px 10px;margin:8px 0}
.ft-miss{font-size:13px;opacity:.8;font-style:italic}
.ft-nav{display:flex;align-items:center;gap:8px;margin-top:10px}
.ft-nav .ft-dots{flex:1;display:flex;gap:4px;justify-content:center;flex-wrap:wrap}
.ft-dots i{width:7px;height:7px;border-radius:50%;background:rgba(127,127,127,.35)}.ft-dots i.on{background:var(--ft-accent)}
.ft-btn{font:inherit;font-weight:600;font-size:15px;border-radius:10px;padding:9px 14px;min-height:42px;border:1px solid var(--ft-line);background:transparent;color:inherit;cursor:pointer}
.ft-btn.pri{background:var(--ft-accent);color:var(--ft-accent-ink);border-color:var(--ft-accent)}
.ft-btn:disabled{opacity:.4;cursor:default}
.ft-menu{display:grid;gap:6px;margin:8px 0}
.ft-menu button{display:flex;gap:10px;align-items:center;text-align:left;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--ft-line);background:transparent;color:inherit;cursor:pointer}
.ft-menu button .t{flex:1}.ft-menu button small{display:block;opacity:.75;font-size:12px}
.ft-flow{display:grid;gap:4px;margin:8px 0}
.ft-flow .arrow{text-align:center;opacity:.6;font-size:18px;line-height:1}
.ft-step{border:1px solid var(--ft-line);border-radius:12px;padding:8px 10px}
.ft-chip{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;margin-right:6px;vertical-align:1px}
.ft-chip.FlipCheck{background:#1f4f8a;color:#fff}.ft-chip.ListMe{background:#f5c400;color:#1b1500}.ft-chip.Receipts{background:#0a84ff;color:#fff}.ft-chip.Sheet{background:#188038;color:#fff}.ft-chip.Email,.ft-chip.Drive{background:#5f6368;color:#fff}.ft-chip.eBay{background:#e53238;color:#fff}
/* drawn previews (example data) */
.ft-mk{margin:8px 0;border-radius:12px;overflow:hidden;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;border:1px solid rgba(127,127,127,.35)}
.ft-mk .cap{font-size:11px;padding:4px 8px;background:rgba(127,127,127,.18);display:flex;justify-content:space-between}
.ft-mk.rc{background:#f2f2f7;color:#111}.ft-mk.rc .in{padding:8px}
.ft-mk.rc .c{background:#fff;border-radius:12px;padding:10px;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.ft-mk.rc .st{font-weight:600}.ft-mk.rc .sm{color:#6b6b70;font-size:12px}
.ft-mk.rc .tag{display:inline-block;font-size:11px;padding:2px 7px;border-radius:999px;background:#eef0f4;margin:4px 4px 0 0}.ft-mk.rc .tag.soon{background:#fff1d6;color:#8a5a00}.ft-mk.rc .tag.late{background:#fde2e1;color:#b3261e}
.ft-mk.rc .b{display:inline-block;padding:7px 10px;border-radius:10px;background:#0a84ff;color:#fff;font-weight:600;margin:6px 6px 0 0;font-size:12px}.ft-mk.rc .b.s{background:#e9e9ee;color:#111}
.ft-mk.lm{background:#0a0c16;color:#eef}.ft-mk.lm .in{padding:8px}.ft-mk.lm .c{background:#161a2b;border:1px solid #2a3150;border-radius:12px;padding:10px}
.ft-mk.lm .st{font-weight:700}.ft-mk.lm .sm{color:#9aa3c7;font-size:12px}.ft-mk.lm .b{display:inline-block;padding:6px 10px;border-radius:9px;border:1px solid #2a3150;margin:6px 6px 0 0;font-size:12px;font-weight:600}.ft-mk.lm .b.p{background:#f5c400;color:#1b1500;border-color:#f5c400}
.ft-mk.lm .pill{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:#2a3150;margin-right:4px}.ft-mk.lm .pill.g{background:#1d4d33;color:#9fe3b9}.ft-mk.lm .pill.r{background:#4d1d1d;color:#ffb3ad}
.ft-mk.fc{background:#11141a;color:#e8ecf3}.ft-mk.fc .in{padding:8px}.ft-mk.fc .c{background:#1a1f28;border:1px solid #2b3240;border-radius:12px;padding:10px}
.ft-mk.fc .st{font-weight:700}.ft-mk.fc .sm{color:#9aa4b5;font-size:12px}.ft-mk.fc .b{display:inline-block;padding:6px 10px;border-radius:9px;border:1px solid #2b3240;margin:6px 6px 0 0;font-size:12px;font-weight:600}.ft-mk.fc .b.p{background:#6aa9ff;color:#0b1220;border-color:#6aa9ff}
.ft-mk.fc .pos{color:#5cc38a}.ft-mk.fc .neg{color:#f07b72}.ft-mk.fc .warn{background:#3a2a10;border-radius:8px;padding:6px 8px;margin-top:6px;color:#ffd38a}
.ft-mk.sh{background:#fff;color:#202124}.ft-mk.sh table{border-collapse:collapse;width:100%;font:12px/1.3 Arial,sans-serif;display:block;overflow-x:auto}
.ft-mk.sh th,.ft-mk.sh td{border:1px solid #e1e3e6;padding:4px 6px;white-space:nowrap;text-align:left}
.ft-mk.sh thead th{background:#f8f9fa;color:#5f6368;font-weight:400;text-align:center}.ft-mk.sh tbody tr:first-child td{font-weight:700;background:#f1f3f4}
.ft-mk.sh td.n{background:#f8f9fa;color:#5f6368;text-align:center}.ft-mk.sh td.hi{background:#fff3b0;outline:2px solid #f4b400;outline-offset:-2px}
.ft-mk.sh .tabs{display:flex;gap:2px;background:#f1f3f4;padding:4px 6px;font:12px Arial,sans-serif}.ft-mk.sh .tabs span{padding:3px 10px;border-radius:4px 4px 0 0;color:#5f6368}.ft-mk.sh .tabs span.on{background:#fff;color:#188038;font-weight:700;border-bottom:2px solid #188038}
.ft-mk.em{background:#fff;color:#202124}.ft-mk.em .in{padding:10px}.ft-mk.em .fr{font-size:12px;color:#5f6368}.ft-mk.em .qr{width:74px;height:74px;margin:8px 0;background:
  repeating-linear-gradient(90deg,#111 0 6px,#fff 6px 10px),repeating-linear-gradient(0deg,#111 0 5px,transparent 5px 9px);background-blend-mode:difference;border:4px solid #fff;outline:1px solid #ddd}
`;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Drawn previews. Example data only.
  const mock = {
    receipts: (inner, cap) => `<div class="ft-mk rc"><div class="cap"><span>Receipts app</span><span>${esc(cap || 'example')}</span></div><div class="in">${inner}</div></div>`,
    listme: (inner, cap) => `<div class="ft-mk lm"><div class="cap"><span>ListMe</span><span>${esc(cap || 'example')}</span></div><div class="in">${inner}</div></div>`,
    flipcheck: (inner, cap) => `<div class="ft-mk fc"><div class="cap"><span>FlipCheck</span><span>${esc(cap || 'example')}</span></div><div class="in">${inner}</div></div>`,
    email: (from, subject, body) => `<div class="ft-mk em"><div class="cap"><span>Gmail: forwarded to your receipts address</span><span>example</span></div><div class="in"><div class="fr">From ${esc(from)}</div><b>${esc(subject)}</b><div>${body}</div></div></div>`,
    // Google Sheet: tab name, headings, rows; hi = [[row, col], …] cells that change (0-based, rows exclude headings)
    sheet: (tab, heads, rows, hi, tabs) => {
      const H = new Set((hi || []).map(x => x.join(',')));
      const L = n => String.fromCharCode(65 + n);
      return `<div class="ft-mk sh"><div class="cap"><span>Google Sheet · ${esc(tab)} tab</span><span>example</span></div><table><thead><tr><th></th>${heads.map((_, i) => `<th>${L(i)}</th>`).join('')}</tr></thead><tbody>
        <tr><td class="n">1</td>${heads.map(h => `<td>${esc(h)}</td>`).join('')}</tr>
        ${rows.map((r, ri) => `<tr><td class="n">${ri + 2}</td>${r.map((c, ci) => `<td class="${H.has(ri + ',' + ci) ? 'hi' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}
      </tbody></table><div class="tabs">${(tabs || ['Purchases', 'Sales', 'Returns', 'To post']).map(t => `<span class="${t === tab ? 'on' : ''}">${esc(t)}</span>`).join('')}</div></div>`;
    }
  };

  let T = null;   // the running tour

  function flat(cfg) {   // every step in order, each chapter ending with its "across your apps" step
    const out = [];
    cfg.chapters.forEach((c, ci) => {
      c.steps.forEach((s, si) => out.push({ ci, si, n: c.steps.length + (c.effect ? 1 : 0), s }));
      if (c.effect) out.push({ ci, si: c.steps.length, n: c.steps.length + 1, s: { title: 'What this does across your apps', effect: c.effect, go: c.effectGo } });
    });
    return out;
  }

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return {}; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  async function findTarget(t, ms) {
    if (!t) return null;
    const end = Date.now() + (ms || 6000);
    while (Date.now() < end) {
      if (!T) return null;
      let el = null;
      try { el = typeof t === 'function' ? t() : document.querySelector(t); } catch (e) {}
      if (el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden') return el;
      await sleep(150);
    }
    return null;
  }

  function place() {   // ring around the target, card where it doesn't cover it
    if (!T) return;
    const { ring, dim, card, el } = T;
    if (!el || !document.contains(el)) { ring.style.display = 'none'; dim.style.display = T.min ? 'none' : 'block'; card.className = 'ft-card bottom' + (T.min ? ' min' : ''); return; }
    const r = el.getBoundingClientRect(), pad = 6;
    dim.style.display = 'none';
    ring.style.display = T.min ? 'none' : 'block';
    Object.assign(ring.style, { left: (r.left - pad) + 'px', top: (r.top - pad) + 'px', width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px' });
    const low = r.top + r.height / 2 > innerHeight * 0.55;
    card.className = 'ft-card ' + (low ? 'top' : 'bottom') + (T.min ? ' min' : '');
  }

  async function show(idx) {
    if (!T) return;
    T.i = Math.max(0, Math.min(T.steps.length - 1, idx));
    const st = T.steps[T.i], ch = T.cfg.chapters[st.ci], s = st.s;
    T.el = null; T.menu = false; T.min = false; T.missing = false;
    render(true);
    try {
      if (typeof s.go === 'function') await s.go();
      else if (typeof s.go === 'string' && location.hash !== s.go) location.hash = s.go;
    } catch (e) {}
    if (T.steps[T.i] !== st) return;   // moved on meanwhile
    const el = await findTarget(s.target, s.wait_ms);
    if (!T || T.steps[T.i] !== st) return;
    T.el = el; T.missing = !!s.target && !el;
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(400);
    }
    render(false);
    // Keep the target above the card if they overlap
    if (el && T) {
      const r = el.getBoundingClientRect(), c = T.card.getBoundingClientRect();
      if (T.card.classList.contains('bottom') && r.bottom > c.top - 8) window.scrollBy({ top: Math.min(r.top - 70, r.bottom - c.top + 24), behavior: 'smooth' });
      if (T.card.classList.contains('top') && r.top < c.bottom + 8) window.scrollBy({ top: -(c.bottom - r.top + 24), behavior: 'smooth' });
    }
    // Mark the chapter done on its last step
    if (st.si === st.n - 1) { const d = store.get(T.cfg.key); d.done = Object.assign({}, d.done, { [ch.id]: 1 }); store.set(T.cfg.key, d); }
  }

  function render(loading) {
    if (!T) return;
    const st = T.steps[T.i], ch = T.cfg.chapters[st.ci], s = st.s, card = T.card;
    if (T.min) {
      card.innerHTML = `<div class="ft-head"><span class="sp">Tour · ${esc(ch.title)} · ${st.si + 1}/${st.n}</span><button class="ft-ib" data-ft="max" aria-label="Show the tour card">▴ Show</button><button class="ft-ib" data-ft="close" aria-label="Close the tour">✕</button></div>`;
      place(); return;
    }
    if (T.menu) {
      const done = store.get(T.cfg.key).done || {};
      card.innerHTML = `<div class="ft-head"><span class="sp">${esc(T.cfg.name)} · guided tour</span><button class="ft-ib" data-ft="close" aria-label="Close">✕</button></div>
        <h3>What changed, feature by feature</h3><p>Pick one, or start at the top. Each one opens the screen, points at the real thing, tells you what to do, then shows what it changes in your other apps and the Sheet.</p>
        <div class="ft-menu">${T.cfg.chapters.map((c, k) => `<button data-ft="ch" data-k="${k}"><span style="font-size:22px">${c.icon}</span><span class="t"><b>${esc(c.title)}</b><small>${esc(c.summary || '')}</small></span><span>${done[c.id] ? '✓' : '›'}</span></button>`).join('')}</div>
        <div class="ft-nav"><button class="ft-btn" data-ft="close">Later</button><span class="ft-dots"></span><button class="ft-btn pri" data-ft="ch" data-k="0">Start ›</button></div>`;
      T.el = null; place(); return;
    }
    const wait = s.wait && T.ready === false;
    const effect = s.effect ? `<div class="ft-flow">${s.effect.map((x, k) => `${k ? '<div class="arrow" aria-hidden="true">↓</div>' : ''}<div class="ft-step"><span class="ft-chip ${esc(x.app)}">${esc(x.app)}</span>${x.text}${x.mock || ''}</div>`).join('')}</div>` : '';
    card.innerHTML = `<div class="ft-head"><span style="font-size:16px">${ch.icon}</span><span class="sp">${esc(ch.title)} · ${st.si + 1} of ${st.n}</span>
        <button class="ft-ib" data-ft="menu" aria-label="All features">☰</button><button class="ft-ib" data-ft="min" aria-label="Hide the card to see the screen">▾</button><button class="ft-ib" data-ft="close" aria-label="Close the tour">✕</button></div>
      <h3>${esc(s.title)}</h3>
      ${loading && s.target ? '<p class="ft-miss">Opening it…</p>' : ''}
      ${s.text ? `<p>${s.text}</p>` : ''}
      ${T.missing ? `<p class="ft-miss">${s.missing || (s.mock ? 'Not on your screen right now, so here is what it looks like.' : 'Not on your screen right now.')}</p>` : ''}
      ${s.todo && s.todo.length ? `<div class="ft-lab">What to do</div><ol class="ft-todo">${s.todo.map(x => `<li>${x}</li>`).join('')}</ol>` : ''}
      ${s.mock && (T.missing || !s.target || s.mockAlways) ? `<div class="ft-lab">${T.missing || !s.target ? 'What it looks like' : 'What you get'}</div>${s.mock}` : ''}
      ${effect}
      ${wait ? '<p class="ft-wait">Starts working once Receipts has today\'s update.</p>' : ''}
      <div class="ft-nav"><button class="ft-btn" data-ft="back" ${T.i === 0 ? 'disabled' : ''}>‹ Back</button>
        <span class="ft-dots" aria-hidden="true">${Array.from({ length: st.n }, (_, k) => `<i class="${k === st.si ? 'on' : ''}"></i>`).join('')}</span>
        <button class="ft-btn pri" data-ft="${T.i === T.steps.length - 1 ? 'close' : 'next'}">${T.i === T.steps.length - 1 ? 'Done' : st.si === st.n - 1 ? 'Next feature ›' : 'Next ›'}</button></div>`;
    place();
  }

  function close() {
    if (!T) return;
    const d = store.get(T.cfg.key); d.opened = 1; store.set(T.cfg.key, d);
    clearInterval(T.tick); removeEventListener('keydown', T.key);
    [T.ring, T.dim, T.card].forEach(x => x.remove());
    T = null;
  }

  async function start(cfg, opts) {
    if (T) close();
    if (!document.getElementById('ft-css')) { const st = document.createElement('style'); st.id = 'ft-css'; st.textContent = css; document.head.appendChild(st); }
    const ring = document.createElement('div'); ring.className = 'ft-ring';
    const dim = document.createElement('div'); dim.className = 'ft-dim';
    const card = document.createElement('div'); card.className = 'ft-card bottom'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', cfg.name + ' guided tour');
    const th = cfg.theme || {};
    [ring, dim, card].forEach(x => { x.style.setProperty('--ft-accent', th.accent || '#0a84ff'); x.style.setProperty('--ft-accent-ink', th.accentInk || '#fff'); x.style.setProperty('--ft-bg', th.bg || '#fff'); x.style.setProperty('--ft-fg', th.fg || '#111'); x.style.setProperty('--ft-line', th.line || 'rgba(127,127,127,.35)'); x.style.setProperty('--ft-strong', th.strong || 'inherit'); });
    document.body.append(dim, ring, card);
    T = { cfg, steps: flat(cfg), i: 0, ring, dim, card, el: null, menu: true, min: false, ready: null };
    T.key = e => { if (!T) return; if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight' && !T.menu) show(T.i + 1); else if (e.key === 'ArrowLeft' && !T.menu) show(T.i - 1); };
    addEventListener('keydown', T.key);
    T.tick = setInterval(place, 250);
    card.addEventListener('click', e => {
      const b = e.target.closest('[data-ft]'); if (!b || !T) return;
      const a = b.dataset.ft;
      if (a === 'close') close();
      else if (a === 'next') show(T.i + 1);
      else if (a === 'back') show(T.i - 1);
      else if (a === 'menu') { T.menu = true; render(); }
      else if (a === 'min') { T.min = true; render(); }
      else if (a === 'max') { T.min = false; render(); }
      else if (a === 'ch') show(T.steps.findIndex(x => x.ci === Number(b.dataset.k)));
    });
    if (cfg.ready) cfg.ready().then(v => { if (T) { T.ready = !!v; if (!T.menu) render(); } }).catch(() => {});
    if (opts && opts.chapter != null) show(T.steps.findIndex(x => x.ci === opts.chapter)); else render();
  }

  // Shows the tour once on this device (first time this version opens), else waits for Settings → What's new.
  function auto(cfg, delay) {
    setTimeout(() => { if (!store.get(cfg.key).opened && (!cfg.when || cfg.when())) start(cfg); }, delay || 1500);
  }

  window.FlipTour = { start, auto, mock, close: () => close() };
})();
