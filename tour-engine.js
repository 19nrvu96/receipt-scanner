/* Guided tour engine, shared by FlipCheck, ListMe and Receipts (a copy lives in the Receipts repo).
   For each feature it opens the right screen, highlights the real thing on it, says step by step
   what to do, and ends with what that does across the apps and the Google Sheet (drawn previews
   with example data, so no real data is ever baked into the app).

   FlipTour.start(cfg, { menu })   cfg = { app, name, key, chapters, ready?: async () => bool }
   chapter = { id, icon, title, summary, day?, steps: [step], effect?: [{ app, text, mock? }] }   (day groups the menu, newest first)
   step    = { title, text, todo?: [..], go?: '#/hash' | async fn, target?: 'css' | fn, mock?: html, wait?: bool, missing?: text }
   Classic script (no modules) so the Receipts app can load it too. */
(function () {
  if (window.FlipTour) return;
  const css = `
.ft-ring.tap{animation:ftpulse 1.3s ease-in-out infinite}
@keyframes ftpulse{0%,100%{border-width:3px}50%{border-width:6px}}
.ft-tap{margin:8px 0;padding:10px 12px;border-radius:10px;background:var(--ft-accent);color:var(--ft-accent-ink);font-weight:600}
.ft-tap small{display:block;font-weight:400;opacity:.85;margin-top:2px}
.ft-iv{position:fixed;inset:0;z-index:10000;background:var(--ft-bg);color:var(--ft-fg);display:flex;flex-direction:column;
  font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:calc(18px + env(safe-area-inset-top,0px)) 20px calc(18px + env(safe-area-inset-bottom,0px));transition:opacity .35s ease}
.ft-iv .bar{height:4px;border-radius:4px;background:rgba(127,127,127,.2);overflow:hidden}.ft-iv .bar i{display:block;height:100%;background:var(--ft-accent);transition:width .35s ease}
.ft-iv .ivtop{display:flex;justify-content:space-between;align-items:center;font-size:13px;opacity:.75;margin:10px 0 0}
.ft-iv .ivtop button{background:none;border:0;color:inherit;font:inherit;padding:6px;cursor:pointer}
.ft-iv .q{flex:1;display:flex;flex-direction:column;justify-content:center;max-width:520px;width:100%;margin:0 auto;animation:ftin .35s ease}
@keyframes ftin{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.ft-iv h2{font-size:24px;line-height:1.25;margin:0 0 6px}.ft-iv .sub{opacity:.75;margin:0 0 18px;font-size:15px}
.ft-iv .opts{display:grid;gap:10px}
.ft-iv .opt{display:flex;align-items:center;gap:12px;text-align:left;font:inherit;font-size:17px;padding:15px 16px;border-radius:14px;border:1.5px solid var(--ft-line);background:transparent;color:inherit;cursor:pointer;transition:transform .12s ease,background .2s,border-color .2s}
.ft-iv .opt:active{transform:scale(.98)}.ft-iv .opt .e{font-size:22px;width:28px;text-align:center}
.ft-iv .opt.on{border-color:var(--ft-accent);background:color-mix(in srgb,var(--ft-accent) 14%,transparent)}
.ft-iv .go{margin-top:16px;width:100%;display:block;text-align:center;font:inherit;font-weight:700;font-size:17px;padding:14px;border-radius:14px;border:0;background:var(--ft-accent);color:var(--ft-accent-ink);cursor:pointer}
.ft-iv .go:disabled{opacity:.35}
.ft-iv .done{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:18px}
.ft-iv .spin{width:64px;height:64px;border-radius:50%;border:5px solid rgba(127,127,127,.2);border-top-color:var(--ft-accent);animation:ftspin .8s linear infinite}
@keyframes ftspin{to{transform:rotate(360deg)}}
.ft-iv .line{min-height:22px;opacity:.75;font-size:15px;transition:opacity .3s}
.ft-iv svg.tick{width:84px;height:84px;animation:ftpop .45s cubic-bezier(.2,1.6,.4,1) both}
.ft-iv svg.tick circle{fill:none;stroke:var(--ft-accent);stroke-width:5;stroke-dasharray:252;stroke-dashoffset:252;animation:ftdraw .5s ease-out forwards}
.ft-iv svg.tick path{fill:none;stroke:var(--ft-accent);stroke-width:6;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:60;stroke-dashoffset:60;animation:ftdraw .35s .45s ease-out forwards}
@keyframes ftdraw{to{stroke-dashoffset:0}}@keyframes ftpop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
@media (prefers-reduced-motion:reduce){.ft-iv *,.ft-ring.tap{animation-duration:.01s!important}}
.ft-ring{position:fixed;z-index:9998;pointer-events:none;border:3px solid var(--ft-accent);border-radius:12px;box-shadow:0 0 0 4000px rgba(0,0,0,.55);transition:all .25s ease;display:none}
.ft-dim{position:fixed;inset:0;z-index:9997;background:rgba(0,0,0,.55);pointer-events:none;display:none}
.ft-card{position:fixed;left:50%;transform:translateX(-50%);z-index:9999;width:min(540px,calc(100vw - 20px));max-height:min(64vh,640px);overflow:auto;
  background:var(--ft-bg);color:var(--ft-fg);border:1px solid var(--ft-line);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.45);padding:14px 16px 12px;
  font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-overflow-scrolling:touch}
/* ft-at-top / ft-at-bottom, not top / bottom: ListMe's header is class "top" and its styles would land on the card */
.ft-card.ft-at-bottom{bottom:calc(10px + env(safe-area-inset-bottom,0px))}.ft-card.ft-at-top{top:calc(10px + env(safe-area-inset-top,0px))}
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
.ft-day{font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;opacity:.75;margin:12px 0 0}
.ft-day.new{opacity:1;color:var(--ft-accent)}
.ft-mk .ch{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;color:#fff;font-weight:800;font-size:11px;margin:4px 4px 0 0;vertical-align:middle}
.ft-mk .ch.wa{background:#25d366}.ft-mk .ch.sms{background:#34c759}.ft-mk .ch.call{background:#0a84ff}.ft-mk .ch.mail{background:#ea4335}.ft-mk .ch.fbm{background:#0084ff}.ft-mk .ch.ig{background:#d6249f}.ft-mk .ch.v{background:#09b1ba}.ft-mk .ch.e{background:#e53238}
.ft-mk .bell{display:inline-block;padding:1px 6px;border-radius:6px;background:#2f230b;color:#ffbe3d;font-weight:700;font-size:11px}
.ft-mk .why{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;margin:3px 3px 0 0;background:#2a3150}.ft-mk .why.w{background:#0f2a1c;color:#4fe08a}.ft-mk .why.i{background:#2f230b;color:#ffbe3d}
.ft-mk .ta{white-space:pre-wrap;background:#0e1124;border:1px solid #2a3150;border-radius:8px;padding:6px 8px;margin-top:6px;font-size:12px}
.ft-mk .dot{display:inline-grid;place-items:center;width:22px;height:18px;border-radius:5px;font-size:10px;font-weight:700;background:#1d2238;color:#9aa3c7;margin-left:3px}.ft-mk .dot.g{background:#0f2a1c;color:#4fe08a}
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
  let T_BASE = '#ffffff';   // solid colour under the card
  const light = c => { const m = String(c || '').match(/\d+/g); if (/rgb/.test(c) && m && m.length >= 3) return +m[0] + +m[1] + +m[2] > 380; const h = String(c || '').replace('#', ''); return h.length >= 6 && parseInt(h.slice(0, 2), 16) + parseInt(h.slice(2, 4), 16) + parseInt(h.slice(4, 6), 16) > 380; };
  const solidBase = th => (light(th.fg) ? '#12141f' : '#ffffff');   // light text means a dark app

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
    const end = Date.now() + (ms || 4000);
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
    // The page redrew under the tour (fresh data came in): find the same thing again
    if (T.el && !document.contains(T.el) && !T.menu) {
      const t = T.steps[T.i] && (T.steps[T.i].s.target || T.steps[T.i].s.tap); let n = null;
      try { n = typeof t === 'function' ? t() : t ? document.querySelector(t) : null; } catch (e) {}
      if (n) T.el = n;
    }
    const { ring, dim, card, el } = T;
    if (!el || !document.contains(el)) { ring.style.display = 'none'; dim.style.display = T.min ? 'none' : 'block'; card.className = 'ft-card ft-at-bottom' + (T.min ? ' min' : ''); return; }
    const r = el.getBoundingClientRect(), pad = 6;
    dim.style.display = 'none';
    ring.style.display = T.min ? 'none' : 'block'; ring.classList.toggle('tap', !!(T.steps[T.i] && T.steps[T.i].s.tap && T.waiting));
    Object.assign(ring.style, { left: (r.left - pad) + 'px', top: (r.top - pad) + 'px', width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px' });
    // Put the card where it covers least of the target (top or bottom of the screen)
    if (!T.side) T.side = 'bottom';   // show() scrolls the page so the target sits above the card
    card.className = 'ft-card ft-at-' + T.side + (T.min ? ' min' : '');
  }

  async function show(idx) {
    if (!T) return;
    T.i = Math.max(0, Math.min(T.steps.length - 1, idx));
    const st = T.steps[T.i], ch = T.cfg.chapters[st.ci], s = st.s;
    T.el = null; T.menu = false; T.min = false; T.missing = false; T.side = null; T.waiting = false;
    clearInterval(T.untilTick);
    render(true);
    T.card.scrollTop = 0;
    try {
      if (typeof s.go === 'function') await s.go();
      else if (typeof s.go === 'string' && location.hash !== s.go) location.hash = s.go;
    } catch (e) {}
    if (T.steps[T.i] !== st) return;   // moved on meanwhile
    // prep: put the example in place (paste the message, open the chat) so they only have to tap
    if (s.prep) { try { await s.prep(); } catch (e) {} if (!T || T.steps[T.i] !== st) return; }
    const el = await findTarget(s.tap || s.target, s.wait_ms);
    if (!T || T.steps[T.i] !== st) return;
    T.el = el; T.missing = !!(s.target || s.tap) && !el;
    // until: they tap the real button; when what it does shows up, move on by itself
    if (s.until) {
      T.waiting = true;
      T.untilTick = setInterval(() => {
        if (!T || T.steps[T.i] !== st) return;
        let ok = false; try { ok = !!s.until(); } catch (e) {}
        if (ok) { clearInterval(T.untilTick); T.waiting = false; setTimeout(() => { if (T && T.steps[T.i] === st) show(T.i + 1); }, s.pause || 700); }
      }, 300);
    }
    // The card sits at the bottom; scroll the page so the thing to look at (or tap) is in the space above it.
    T.side = 'bottom';
    render(false);
    T.card.scrollTop = 0;
    if (el && T) {
      await sleep(40);
      const c = T.card.getBoundingClientRect();
      // In a pop-up sheet (ListMe's buyer messages): lift the sheet above the card, then scroll inside it
      // The pop-up is the nearest fixed-position box round the target (ListMe's .sheet, Receipts' .veil); its card is the child holding the target
      let sh = null;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).position === 'fixed') { sh = p; break; }
      let shc = null; if (sh) for (let p = el; p && p !== sh; p = p.parentElement) shc = p;
      // A small fixed bar (FlipCheck's bottom dock): leave it alone and put the card at the top instead
      if (sh && sh.getBoundingClientRect().height < innerHeight * 0.4) {
        const br = sh.getBoundingClientRect();
        if (br.top > innerHeight / 2) { T.side = 'top'; render(false); }
        sh = null; shc = null; T.fixedBar = true;
      } else T.fixedBar = false;
      if (sh && shc) {
        sh.style.alignItems = 'flex-start'; shc.style.maxHeight = Math.max(200, c.top - 14) + 'px'; shc.style.overflowY = 'auto'; shc.style.borderRadius = '0 0 16px 16px';
        const bg = getComputedStyle(shc).backgroundColor;
        if (!bg || /rgba\(.*,\s*0(\.\d+)?\)$|transparent/.test(bg)) { const sf = (getComputedStyle(document.documentElement).getPropertyValue('--surface') || '').trim(); shc.style.background = sf ? `linear-gradient(${sf}, ${sf}), ${T_BASE}` : T_BASE; }
        await sleep(30);
      }
      let sc = null;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight + 2) { sc = p; break; } }
      const r = el.getBoundingClientRect();
      let top0, bot0;
      if (sc) { const b = sc.getBoundingClientRect(); top0 = b.top + 8; bot0 = Math.min(b.bottom, c.top) - 8; }
      else { const hd = document.querySelector('header'), hb = hd ? hd.getBoundingClientRect().bottom : 0; top0 = Math.min(160, Math.max(0, hb)) + 10; bot0 = c.top - 12; }
      const want = r.height > bot0 - top0 ? r.top - top0 : (r.top + r.height / 2) - (top0 + bot0) / 2;
      if (Math.abs(want) > 4 && !T.fixedBar) (sc || window).scrollBy({ top: want, behavior: 'smooth' });
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
      // Grouped by the day each change came in, newest first
      const groups = [];
      T.cfg.chapters.forEach((c, k) => { let g = groups.find(x => x.d === (c.day || '')); if (!g) groups.push(g = { d: c.day || '', list: [] }); g.list.push([c, k]); });
      card.innerHTML = `<div class="ft-head"><span class="sp">${esc(T.cfg.name)} · guided tour</span><button class="ft-ib" data-ft="close" aria-label="Close">✕</button></div>
        <h3>${T.cfg.menuTitle || 'What changed, feature by feature'}</h3><p>${T.cfg.menuIntro || 'Newest first. Pick one, or start at the top. Each one opens the screen, points at the real thing, tells you what to do, then shows what it changes in your other apps and the Sheet.'}</p>
        ${groups.map((g, gi) => `${g.d ? `<div class="ft-day${gi === 0 && groups.length > 1 ? ' new' : ''}">${esc(g.d)}</div>` : ''}<div class="ft-menu">${g.list.map(([c, k]) => `<button data-ft="ch" data-k="${k}"><span style="font-size:22px">${c.icon}</span><span class="t"><b>${esc(c.title)}</b><small>${esc(c.summary || '')}</small></span><span>${done[c.id] ? '✓' : '›'}</span></button>`).join('')}</div>`).join('')}
        <div class="ft-nav"><button class="ft-btn" data-ft="close">Later</button><span class="ft-dots"></span><button class="ft-btn pri" data-ft="ch" data-k="0">Start ›</button></div>`;
      T.el = null; place(); return;
    }
    const wait = s.wait && T.ready === false;
    const effect = s.effect ? `<div class="ft-flow">${s.effect.map((x, k) => `${k ? '<div class="arrow" aria-hidden="true">↓</div>' : ''}<div class="ft-step"><span class="ft-chip ${esc(x.app)}">${esc(x.app)}</span>${x.text}${x.mock || ''}</div>`).join('')}</div>` : '';
    card.innerHTML = `<div class="ft-head"><span style="font-size:16px">${ch.icon}</span><span class="sp">${ch.day ? esc(ch.day.split('·').pop().trim()) + ' · ' : ''}${esc(ch.title)} · ${st.si + 1} of ${st.n}</span>
        <button class="ft-ib" data-ft="menu" aria-label="All features">☰</button><button class="ft-ib" data-ft="min" aria-label="Hide the card to see the screen">▾</button><button class="ft-ib" data-ft="close" aria-label="Close the tour">✕</button></div>
      <h3>${esc(s.title)}</h3>
      ${loading && s.target ? '<p class="ft-miss">Opening it…</p>' : ''}
      ${s.text ? `<p>${s.text}</p>` : ''}
      ${T.missing ? `<p class="ft-miss">${s.missing || (s.mock ? 'Not on your screen right now, so here is what it looks like.' : 'Not on your screen right now.')}</p>` : ''}
      ${s.tap && T.waiting && !T.missing ? `<div class="ft-tap">👆 ${s.tapText || 'Tap the highlighted button'}${s.tapNote ? `<small>${s.tapNote}</small>` : ''}</div>` : ''}
      ${s.todo && s.todo.length ? `<div class="ft-lab">What to do</div><ol class="ft-todo">${s.todo.map(x => `<li>${x}</li>`).join('')}</ol>` : ''}
      ${s.mock && (T.missing || !s.target || s.mockAlways) ? `<div class="ft-lab">${T.missing || !s.target ? 'What it looks like' : 'What you get'}</div>${s.mock}` : ''}
      ${effect}
      ${wait ? '<p class="ft-wait">Starts working once Receipts has today\'s update.</p>' : ''}
      <div class="ft-nav"><button class="ft-btn" data-ft="back" ${T.i === 0 ? 'disabled' : ''}>‹ Back</button>
        <span class="ft-dots" aria-hidden="true">${Array.from({ length: st.n }, (_, k) => `<i class="${k === st.si ? 'on' : ''}"></i>`).join('')}</span>
        <button class="ft-btn ${T.waiting ? '' : 'pri'}" data-ft="${T.i === T.steps.length - 1 ? 'close' : 'next'}">${T.i === T.steps.length - 1 ? 'Done' : T.waiting ? 'Skip ›' : st.si === st.n - 1 ? 'Next feature ›' : 'Next ›'}</button></div>`;
    place();
  }

  function close() {
    if (!T) return;
    const d = store.get(T.cfg.key); d.opened = 1; store.set(T.cfg.key, d);
    clearInterval(T.tick); clearInterval(T.untilTick); removeEventListener('keydown', T.key);
    [T.ring, T.dim, T.card, T.spacer].forEach(x => x && x.remove());
    T = null;
  }

  async function start(cfg, opts) {
    if (T) close();
    if (!document.getElementById('ft-css')) { const st = document.createElement('style'); st.id = 'ft-css'; st.textContent = css; document.head.appendChild(st); }
    const ring = document.createElement('div'); ring.className = 'ft-ring';
    const dim = document.createElement('div'); dim.className = 'ft-dim';
    const card = document.createElement('div'); card.className = 'ft-card ft-at-bottom'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', cfg.name + ' guided tour');
    const th = cfg.theme || {};
    // An opaque card even when the app's surface colour is see-through (ListMe's glass cards)
    T_BASE = solidBase(th);
    card.style.background = `linear-gradient(var(--ft-bg), var(--ft-bg)), ${T_BASE}`;
    [ring, dim, card].forEach(x => { x.style.setProperty('--ft-accent', th.accent || '#0a84ff'); x.style.setProperty('--ft-accent-ink', th.accentInk || '#fff'); x.style.setProperty('--ft-bg', th.bg || '#fff'); x.style.setProperty('--ft-fg', th.fg || '#111'); x.style.setProperty('--ft-line', th.line || 'rgba(127,127,127,.35)'); x.style.setProperty('--ft-strong', th.strong || 'inherit'); });
    document.body.append(dim, ring, card);
    const spacer = document.createElement('div'); spacer.className = 'ft-spacer'; spacer.style.height = '75vh'; document.body.append(spacer);
    T = { cfg, steps: flat(cfg), i: 0, ring, dim, card, spacer, el: null, menu: true, min: false, ready: null };
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

  // Types an example into a box, a few letters at a time, so they see it go in (then the app's own input handlers run).
  async function typeInto(el, text, ms) {
    if (!el) return;
    el.focus({ preventScroll: true }); el.value = '';
    const n = Math.max(1, Math.ceil(text.length / 24)), wait = (ms || 700) / 24;
    for (let i = 0; i < text.length; i += n) { el.value = text.slice(0, i + n); el.dispatchEvent(new Event('input', { bubbles: true })); await sleep(wait); }
    el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.blur();
  }
  async function waitFor(t, ms) {
    const end = Date.now() + (ms || 6000);
    while (Date.now() < end) { let el = null; try { el = typeof t === 'function' ? t() : document.querySelector(t); } catch (e) {} if (el) return el; await sleep(150); }
    return null;
  }

  // The welcome questions before the tour: one question a screen, tap an answer (or several, then Next),
  // then "Customising your experience" and a tick. Resolves with { question: answer } (null if they skip).
  // cfg = { title, intro, questions: [{ q, sub?, multi?, opts: [[emoji, label], …] }], lines?: (answers) => [text], theme }
  function interview(cfg) {
    return new Promise(resolve => {
      if (!document.getElementById('ft-css')) { const st = document.createElement('style'); st.id = 'ft-css'; st.textContent = css; document.head.appendChild(st); }
      const th = cfg.theme || {}, box = document.createElement('div');
      box.className = 'ft-iv'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', cfg.title || 'A few questions');
      [['--ft-accent', th.accent || '#0a84ff'], ['--ft-accent-ink', th.accentInk || '#fff'], ['--ft-bg', th.bg || '#fff'], ['--ft-fg', th.fg || '#111'], ['--ft-line', th.line || 'rgba(127,127,127,.35)']].forEach(([k, v]) => box.style.setProperty(k, v));
      box.style.background = `linear-gradient(var(--ft-bg), var(--ft-bg)), ${solidBase(th)}`;
      document.body.appendChild(box);
      const Q = cfg.questions, ans = {};
      let i = -1;
      const finish = async skipped => {
        if (skipped) { box.style.opacity = '0'; setTimeout(() => box.remove(), 350); resolve(null); return; }
        const lines = (cfg.lines ? cfg.lines(ans) : []).concat(['Picking the best examples for you', 'Nearly there']);
        box.innerHTML = `<div class="done"><div class="spin" aria-hidden="true"></div><h2>Customising your experience</h2><div class="line" aria-live="polite">${esc(lines[0])}</div></div>`;
        const ln = box.querySelector('.line');
        for (let k = 1; k < Math.min(lines.length, 4); k++) { await sleep(850); ln.style.opacity = '0'; await sleep(250); ln.textContent = lines[k]; ln.style.opacity = '.75'; }
        await sleep(700);
        box.querySelector('.done').innerHTML = `<svg class="tick" viewBox="0 0 90 90" aria-hidden="true"><circle cx="45" cy="45" r="40"/><path d="M27 46 l12 12 l24 -26"/></svg><h2>All set</h2><div class="line">${esc(cfg.ready || 'Here’s your tour')}</div>`;
        try { navigator.vibrate && navigator.vibrate(12); } catch (e) {}
        await sleep(1500);
        box.style.opacity = '0'; await sleep(350); box.remove(); resolve(ans);
      };
      const draw = () => {
        if (i === -1) {
          box.innerHTML = `<div class="q"><h2>${esc(cfg.title || 'Before we start')}</h2><p class="sub">${cfg.intro || ''}</p>
            <button class="go" data-iv="start">Let’s go</button><div class="ivtop" style="justify-content:center"><button data-iv="skip">Skip, show me the app</button></div></div>`;
          return;
        }
        const q = Q[i], cur = ans[q.q], sel = new Set(Array.isArray(cur) ? cur : cur ? [cur] : []);
        box.innerHTML = `<div class="bar"><i style="width:${(i / Q.length) * 100}%"></i></div>
          <div class="ivtop"><button data-iv="back" aria-label="Back">‹ Back</button><span>${i + 1} of ${Q.length}</span><button data-iv="skip">Skip</button></div>
          <div class="q"><h2>${esc(q.q)}</h2><p class="sub">${esc(q.sub || (q.multi ? 'Pick all that fit.' : 'Pick one.'))}</p>
          <div class="opts">${q.opts.map(([e, l]) => `<button class="opt ${sel.has(l) ? 'on' : ''}" data-opt="${esc(l)}" aria-pressed="${sel.has(l)}"><span class="e" aria-hidden="true">${e}</span><span>${esc(l)}</span></button>`).join('')}</div>
          ${q.multi ? `<button class="go" data-iv="next" ${sel.size ? '' : 'disabled'}>${i === Q.length - 1 ? 'Done' : 'Next'}</button>` : ''}</div>`;
        requestAnimationFrame(() => { const b = box.querySelector('.bar i'); if (b) b.style.width = `${((i + (sel.size ? 1 : 0)) / Q.length) * 100}%`; });
      };
      const next = () => { if (i >= Q.length - 1) { const b = box.querySelector('.bar i'); if (b) b.style.width = '100%'; finish(false); } else { i++; draw(); } };
      box.addEventListener('click', e => {
        const o = e.target.closest('[data-opt]'), a = e.target.closest('[data-iv]');
        if (o) {
          const q = Q[i], l = o.dataset.opt;
          if (q.multi) { const s2 = new Set(ans[q.q] || []); s2.has(l) ? s2.delete(l) : s2.add(l); ans[q.q] = [...s2]; o.classList.toggle('on'); o.setAttribute('aria-pressed', String(s2.has(l))); const g = box.querySelector('.go'); if (g) g.disabled = !s2.size; }
          else { ans[q.q] = l; box.querySelectorAll('.opt').forEach(x => x.classList.toggle('on', x === o)); setTimeout(next, 260); }
          return;
        }
        if (!a) return;
        if (a.dataset.iv === 'start' || a.dataset.iv === 'next') next();
        else if (a.dataset.iv === 'back') { i = Math.max(-1, i - 1); draw(); }
        else if (a.dataset.iv === 'skip') finish(true);
      });
      draw();
    });
  }

  window.FlipTour = { start, auto, mock, interview, typeInto, waitFor, close: () => close(), get running() { return !!T; } };
})();
