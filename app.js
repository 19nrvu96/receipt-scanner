/* Receipt Scanner — front end
   No credentials here. The Apps Script URL is stored on this device only. */

const LS_URL = 'rs_url';
const LS_CACHE = 'rs_cache';

let CFG = { purposes: [], stores: [], payments: [], vat: false, business: '' };
let state = null;          // current receipt being reviewed
let pages = [];            // photos of the receipt being captured: [{ dataUrl, blurry, dark }]
let job = null;            // the photo job being read or reviewed (see the offline queue below)
let lastSource = 'cam';
let RETURN_FOR = null;     // a refund photo taken from a return's card: attached to that return when saved
let lastResult = null;

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const views = ['vSetup','vHome','vWork','vError','vReview','vQueue','vPages','vJobs','vTrip','vRepay','vSales','vSale','vSettings','vHelp','vReport','vPerks','vNumbers','vIntro','vStock','vBuyers','vBuyer','vMatch','vOutreach','vPurchases'];
const APP_VERSION = 'v63';

function show(v) {
  views.forEach(x => $(x).classList.toggle('hide', x !== v));
  if (v !== 'vReview') $('miniBar').classList.add('hide');
  if (v === 'vHome') { try { renderHomeColl(); } catch (e) {} }
  window.scrollTo(0, 0);
}

function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  document.querySelectorAll('.toast').forEach(x => x.remove());   // one message at a time, never on top of each other
  document.body.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 4200 : 2400);
}

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const money = n => (r2(n) < 0 ? '−£' : '£') + Math.abs(r2(n)).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TRIP_ICO = "<svg viewBox=\"0 0 24 24\" width=\"24\" height=\"24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M5 17h14M6 17v2M18 17v2M4 13l2-6h12l2 6v4H4z\"/><circle cx=\"8\" cy=\"14\" r=\"1\"/><circle cx=\"16\" cy=\"14\" r=\"1\"/></svg>";
// Your share of a shared amount, worked in pennies. Odd pennies round up (you take the extra 1p).
const sharePart = (n, pct) => Math.round(Math.round((Number(n) || 0) * 100) * pct / 100) / 100;
const clampPct = p => { p = Number(p); return p > 0 && p < 100 ? Math.round(p * 100) / 100 : 50; };
const pctOf = r => clampPct(r._pct);
const shareLabel = r => r._shared
  ? '✓ Shared · you ' + money(sharePart(r['total cost'], pctOf(r))) : 'Not shared';

function today() {
  const d = new Date();
  return String(d.getDate()).padStart(2,'0') + '/' +
         String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
}

/* ---------- API ---------- */
async function api(action, payload) {
  const url = localStorage.getItem(LS_URL);
  if (!url) throw new Error('Not connected');
  const offline = () => { const e = new Error('No signal'); e.code = 'OFFLINE'; return e; };
  if (navigator.onLine === false) throw offline();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action }, payload))
    });
  } catch (e) {
    throw offline();   // the request never reached your Sheet, so nothing was used or charged
  }
  if (!res.ok) throw new Error('Network error ' + res.status);
  const j = await res.json();
  // Any reply may carry the latest usage figures; keep the home card current.
  const u = j.usage || (j.data && j.data.usage);
  if (u) setUsage(u);
  if (!j.ok) {
    const err = new Error(j.error || 'Unknown error');
    err.code = j.code || '';
    throw err;
  }
  return j.data;
}

/* ---------- Gemini usage: free scans left, or credit left ---------- */
// The Sheet's script counts receipts and estimates spend; Google has no way
// for apps to read the real allowance or balance, so these are estimates.
const LS_USAGE = 'rs_usage';
const BILLING_URL = 'https://aistudio.google.com/billing';
const LIMITS_URL = 'https://aistudio.google.com/rate-limit';
let USAGE = null;

// Price per receipt in pence: rates double on 1 Jan 2027.
const penceNow = () => (Date.now() < Date.UTC(2027, 0, 1) ? 0.5 : 1);
const costLine = () => {
  const p = penceNow();
  return 'about ' + p + 'p a receipt' + (p < 1 ? ' (about 1p from 1 January)' : '');
};

function resetText(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return 'tomorrow morning';
  const t = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })
             .replace(':00', '').replace(/\s/g, '').toLowerCase();   // "8am", "7:30am"
  const mins = Math.max(0, Math.round((d - Date.now()) / 60000));
  const left = mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm';
  return t + ' (in ' + left + ')';
}

function setUsage(u) {
  USAGE = Object.assign({}, USAGE, u, { _at: Date.now() });
  try { localStorage.setItem(LS_USAGE, JSON.stringify(USAGE)); } catch (e) {}
  renderUsage();
}

// A day's count is stale once its reset time has passed.
function usageNow() {
  if (!USAGE) return null;
  const u = Object.assign({}, USAGE);
  if (!u.billing && u.resetAt && Date.now() >= new Date(u.resetAt)) {
    u.used = 0; u.exhausted = false; u.stale = true;
  }
  return u;
}

function renderUsage() {
  const box = $('usage');
  const u = usageNow();
  if (!box) return;
  if (!u) { box.classList.add('hide'); return; }
  box.classList.remove('hide');

  if (u.billing && u.credit) {
    // Prepaid Google credit in pounds, with Google's auto top-up (Usage.gs creditView_).
    const c = u.credit, r = c.reload;
    const warn = c.warn === 'out' ? ' out' : (c.warn === 'reload' || c.warn === 'low') ? ' warn' : '';
    box.className = 'usage' + warn;
    const head = c.receiptsLeft == null
      ? `💳 About <b>£${Number(c.gbp).toFixed(2)}</b> credit · auto top-up on`
      : `💳 About <b>${c.receiptsLeft.toLocaleString('en-GB')}</b> receipts left · £${Number(c.gbp).toFixed(2)} credit`;
    const next = r ? (c.toReload != null
      ? `Next automatic top-up (£${r.gbp}) in about <b>${c.toReload.toLocaleString('en-GB')}</b> receipts, when the credit drops under £${r.below}.`
      : `This month's auto top-up limit (£${r.monthlyGbp}) is used up.`) : 'Auto top-up is off.';
    box.innerHTML = `<div class="uhead">${head}</div>
       <div class="usub">${c.message ? '<b>' + esc(c.message) + '</b><br>' : ''}${next} About ${(c.perReceiptGbp * 100).toFixed(2)}p a receipt. Estimate from your last balance check${c.setAt ? ' (' + esc(new Date(c.setAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })) + ')' : ''}.</div>
       <div class="uact"><a class="ubtn" href="${BILLING_URL}" target="_blank" rel="noopener">Billing</a>
       <button class="ubtn" data-u="balance">Update balance</button><button class="ubtn" data-u="more">⋯</button></div>`;
    // Say it once when a warning starts (or a top-up happens), not on every screen.
    const key = c.warn ? c.warn + ':' + (c.warn === 'topped' ? c.lastReloadAt : new Date().toDateString()) : '';
    try { if (key && localStorage.getItem('rs_credit_warn') !== key) { localStorage.setItem('rs_credit_warn', key); toast(c.message, c.warn === 'out'); } } catch (e) {}
    return;
  }

  if (u.billing) {
    const hasTop = Number(u.topupUsd) > 0;
    const rem = Number(u.remainingUsd);
    const low = hasTop && rem < 1;
    const perReceipt = Number(u.avgCostUsd) || 0;
    const receiptsLeft = hasTop && perReceipt > 0 ? Math.floor(Math.max(0, rem) / perReceipt) : null;
    box.className = 'usage' + (low ? ' warn' : '');
    box.innerHTML = hasTop
      ? `<div class="uhead">💳 About <b>$${Math.max(0, rem).toFixed(2)}</b> credit left</div>
         <div class="bar2"><i style="width:${Math.max(0, Math.min(100, rem / u.topupUsd * 100))}%"></i></div>
         <div class="usub">Estimate: $${Number(u.spentUsd || 0).toFixed(2)} used of $${Number(u.topupUsd).toFixed(2)} since ${esc(u.topupDate || 'your top-up')}${receiptsLeft != null ? ' · roughly ' + receiptsLeft + ' receipts left' : ''}.
         ${low ? '<br><b>Running low.</b> If credit hits $0, scanning stops until you top up.' : ''}</div>
         <div class="uact"><a class="ubtn" href="${BILLING_URL}" target="_blank" rel="noopener">Top up</a>
         <button class="ubtn" data-u="topup">Record top-up</button><button class="ubtn" data-u="more">⋯</button></div>`
      : `<div class="uhead">💳 Billing on · ${costLine()}</div>
         <div class="usub">Spent so far (estimate): $${Number(u.spentUsd || 0).toFixed(2)}. Record your top-up to see roughly how much credit is left.</div>
         <div class="uact"><button class="ubtn" data-u="topup">Record top-up</button>
         <a class="ubtn" href="${BILLING_URL}" target="_blank" rel="noopener">Billing</a><button class="ubtn" data-u="more">⋯</button></div>`;
    return;
  }

  const limit = Math.max(1, Number(u.limit) || 20);
  const used = Math.max(0, Number(u.used) || 0);
  const left = Math.max(0, limit - used);
  const out = u.exhausted || left === 0;
  box.className = 'usage' + (out ? ' out' : left <= 3 ? ' warn' : '');
  box.innerHTML = out
    ? `<div class="uhead">⛔ Today's free scans are used up</div>
       <div class="usub">They come back at <b>${resetText(u.resetAt)}</b>. Manual entry and saving still work.
       To keep scanning now, turn on billing: ${costLine()}.</div>
       <div class="uact"><a class="ubtn" href="${BILLING_URL}" target="_blank" rel="noopener">Turn on billing</a>
       <button class="ubtn" data-u="paid">I've turned it on</button></div>`
    : `<div class="uhead">🧾 About <b>${left}</b> of ${limit} free scans left today</div>
       <div class="bar2"><i style="width:${left / limit * 100}%"></i></div>
       <div class="usub">Resets ${resetText(u.resetAt)}. Emailed receipts count too.${u.learned ? '' : ' The limit is Google\'s rough figure; the app learns yours the first time you run out.'}</div>
       <div class="uact"><button class="ubtn" data-u="more">⋯</button></div>`;
}

$('usage').onclick = async e => {
  const act = e.target.dataset.u;
  if (!act) return;
  try {
    if (act === 'paid') {
      if (!confirm('Switch the app to paid mode? Do this once billing is set up in AI Studio.')) return;
      await api('usageSet', { billing: true });
      toast('Paid mode on. Record your top-up to track credit');
    } else if (act === 'balance') {
      const v = prompt('Your credit balance in AI Studio → Billing right now, in pounds (e.g. 3.72):');
      if (v == null) return;
      const n = Number(String(v).replace(/[^\d.]/g, ''));
      if (!(n >= 0) || String(v).trim() === '') { toast('Enter an amount like 3.72', true); return; }
      await api('usageSet', { balanceGbp: n });
      toast('Balance set to £' + n.toFixed(2));
    } else if (act === 'topup') {
      const v = prompt('How much credit did you add, in US dollars? (e.g. 5)');
      if (v == null) return;
      const n = Number(String(v).replace(/[^\d.]/g, ''));
      if (!(n > 0)) { toast('Enter an amount like 5', true); return; }
      await api('usageSet', { topupUsd: n });
      toast('Top-up of $' + n.toFixed(2) + ' recorded');
    } else if (act === 'more') {
      const u = usageNow() || {};
      const pick = prompt(
        (u.billing
          ? '1. Switch back to free mode\n2. Reset credit tracking\n3. Open AI Studio billing'
          : '1. Set the daily free limit (now ' + (u.limit || 20) + ')\n2. I\'ve turned on billing\n3. See my real limits in AI Studio') +
        '\n\nEnter a number:');
      if (!pick) return;
      if (u.billing) {
        if (pick === '1') await api('usageSet', { billing: false });
        else if (pick === '2' && confirm('Clear the recorded top-ups and spend?')) await api('usageSet', { resetSpend: true });
        else if (pick === '3') window.open(BILLING_URL, '_blank');
      } else {
        if (pick === '1') {
          const v = prompt('Free receipts per day (whole number):', u.limit || 20);
          const n = parseInt(v, 10);
          if (n > 0) await api('usageSet', { limit: n });
        } else if (pick === '2') await api('usageSet', { billing: true });
        else if (pick === '3') window.open(LIMITS_URL, '_blank');
      }
    }
  } catch (err) {
    toast(/Unknown action|usageSet/i.test(err.message)
      ? 'Your Sheet\'s script needs updating for this' : err.message, true);
  }
};

/* ---------- image handling ---------- */
function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Could not read file'));
    fr.readAsDataURL(file);
  });
}

/* Downscale + light contrast boost. Keeps uploads small and helps OCR. */
function enhance(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1600;
      let { width: w, height: h } = img;
      if (Math.max(w, h) > MAX) {
        const s = MAX / Math.max(w, h);
        w = Math.round(w * s); h = Math.round(h * s);
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      try {
        const d = ctx.getImageData(0, 0, w, h);
        const p = d.data;
        for (let i = 0; i < p.length; i += 4) {
          for (let k = 0; k < 3; k++) {
            p[i+k] = Math.min(255, Math.max(0, (p[i+k] - 128) * 1.25 + 128));
          }
        }
        ctx.putImageData(d, 0, 0);
      } catch (e) { /* canvas tainted — skip enhancement */ }
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/* ---------- photo quality (free, on the phone) ---------- */
// Sharpness = how much neighbouring pixels differ (variance of the Laplacian) on a small grey copy.
// Blurry or very dark photos are flagged before anything is sent, so a bad photo never uses a scan.
const BLUR_LIMIT = 90, DARK_LIMIT = 55;
function quality(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const W = 360, H = Math.max(1, Math.round(img.height * W / img.width));
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, W, H);
        const p = ctx.getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
        let sum = 0;
        for (let i = 0; i < W * H; i++) { g[i] = p[i*4] * .299 + p[i*4+1] * .587 + p[i*4+2] * .114; sum += g[i]; }
        let n = 0, m = 0, m2 = 0;
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
          const i = y * W + x, l = g[i-1] + g[i+1] + g[i-W] + g[i+W] - 4 * g[i];
          n++; const d = l - m; m += d / n; m2 += d * (l - m);
        }
        const sharp = n ? m2 / n : 999, light = sum / (W * H);
        resolve({ sharp: Math.round(sharp), blurry: sharp < BLUR_LIMIT, dark: light < DARK_LIMIT });
      } catch (e) { resolve({ sharp: 999, blurry: false, dark: false }); }
    };
    img.onerror = () => resolve({ sharp: 999, blurry: false, dark: false });
    img.src = dataUrl;
  });
}

/* ---------- capturing one or more photos ---------- */
async function addPhotos(files) {
  files = Array.from(files || []).filter(Boolean);
  if (!files.length) { if (!pages.length) show('vHome'); return; }
  show('vWork');
  $('workMsg').textContent = 'Preparing photo' + (files.length > 1 ? 's' : '') + '…';
  for (const f of files) {
    try {
      const dataUrl = await enhance(await readFile(f));
      pages.push(Object.assign({ dataUrl }, await quality(dataUrl)));
    } catch (e) { toast('Couldn\'t open one of the photos', true); }
  }
  renderPages();
}

function renderPages() {
  if (!pages.length) { show('vHome'); return; }
  $('thumbs').innerHTML = pages.map((pg, i) => `<div class="thumb"><img src="${pg.dataUrl}" alt="Photo ${i + 1}">
    <span class="n">${i + 1}</span><button class="x" data-x="${i}" aria-label="Remove photo ${i + 1}">✕</button>
    ${pg.blurry || pg.dark ? `<div class="bad">${pg.dark ? 'Too dark' : 'Looks blurry'} — retake?</div>` : ''}</div>`).join('');
  const bad = pages.filter(pg => pg.blurry || pg.dark).length;
  $('pSub').textContent = bad
    ? 'A photo is ' + (pages.some(pg => pg.dark) ? 'too dark or blurry' : 'blurry') + '. Tap ↺ Retake last to take it again.'
    : 'Take a photo of the whole receipt. Long receipt? Add more photos. Then tap Done.';
  $('btnPagesDone').textContent = '✓ Done — read ' + (pages.length > 1 ? pages.length + ' photos' : 'receipt');
  show('vPages');
}

async function pagesDone() {
  const bad = pages.map((pg, i) => pg.blurry || pg.dark ? i + 1 : 0).filter(Boolean);
  if (bad.length && !confirm('Photo ' + bad.join(' and ') + ' looks ' + (bad.length > 1 ? 'unclear' : 'unclear') +
      ', so items may be misread. Read it anyway? (Cancel to retake.)')) return;
  const j = { id: 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), created: Date.now(),
              pages: pages.map(pg => ({ dataUrl: pg.dataUrl })), status: 'pending', tries: 0 };
  if (RETURN_FOR) { j.returnId = RETURN_FOR; RETURN_FOR = null; }
  pages = [];
  await jobPut(j);
  if (navigator.onLine === false) {
    show('vHome'); refreshJobs();
    toast('No signal — photo saved. It will be read when you\'re back online');
    return;
  }
  readJobNow(j);
}

/* ---------- offline queue: photos are kept on the phone until they're saved ---------- */
// Every photo is stored here first, so capture always works. Reading happens now if there's
// signal, otherwise automatically when signal returns (while the app is open).
const DB_NAME = 'receipts', DB_STORE = 'jobs', LABEL_STORE = 'labels';
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 2);   // v2 adds "labels": QR codes kept on the phone
    r.onupgradeneeded = () => [DB_STORE, LABEL_STORE].forEach(n => { if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n, { keyPath: 'id' }); });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function dbDo(mode, fn, store = DB_STORE) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode), st = tx.objectStore(store);
    const req = fn(st);
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const jobPut = j => dbDo('readwrite', st => st.put(j)).catch(() => {});
const jobDel = id => dbDo('readwrite', st => st.delete(id)).catch(() => {});
const jobAll = () => dbDo('readonly', st => st.getAll()).then(a => (a || []).sort((x, y) => x.created - y.created)).catch(() => []);

let busyJob = null;   // id of the job being read right now

const jobImages = j => j.pages.map(pg => ({ base64: pg.dataUrl.split(',')[1], mimeType: 'image/jpeg' }));
// Also send the first photo the old way, so a Sheet whose script isn't updated yet still reads it
const withLegacy = imgs => imgs && imgs.length ? { images: imgs, imageBase64: imgs[0].base64, mimeType: imgs[0].mimeType } : {};

// Reads a job while you watch: spinner, then the review screen.
async function readJobNow(j) {
  job = j; lastSource = 'cam';
  show('vWork');
  $('workMsg').textContent = 'Reading receipt' + (j.pages.length > 1 ? ' (' + j.pages.length + ' photos)' : '') + '…';
  busyJob = j.id;
  try {
    const result = await api('extract', withLegacy(jobImages(j)));
    j.status = 'ready'; j.result = result; j.error = '';
    await jobPut(j);
    busyJob = null;
    lastResult = result;
    openJob(j);
  } catch (err) {
    busyJob = null;
    await jobFailed(j, err, true);
  }
  refreshJobs();
}

// What a failed read means for the job. Only "busy" counts as a try: a request that never
// reached Google (no signal) or hit the daily limit isn't the photo's fault.
async function jobFailed(j, err, watching) {
  if (err.code === 'OFFLINE') {
    j.status = 'pending'; j.nextTry = 0; j.error = '';
    await jobPut(j);
    if (watching) { show('vHome'); toast('Lost signal — photo saved. It will be read automatically'); }
    return;
  }
  if (err.code === 'QUOTA_DAY') {
    const u = usageNow() || {};
    j.status = 'pending'; j.nextTry = u.resetAt ? new Date(u.resetAt).getTime() : Date.now() + 3600e3; j.error = 'Free scans used up';
    await jobPut(j);
    if (watching) showQuotaError();
    return;
  }
  const busy = /busy|503|429|overload/i.test(err.message);
  j.tries = (j.tries || 0) + 1;
  j.error = err.message;
  if (busy && j.tries < 3) { j.status = 'pending'; j.nextTry = Date.now() + 120e3 * j.tries; }
  else j.status = 'failed';
  await jobPut(j);
  if (watching) showError(err.message, busy);
}

// Background: read the next waiting photo when there's signal. One at a time.
let ticking = false;
async function jobTick() {
  if (ticking || busyJob || navigator.onLine === false || !localStorage.getItem(LS_URL)) return;
  ticking = true;
  const all = await jobAll();
  const next = all.find(j => j.status === 'pending' && (j.nextTry || 0) <= Date.now());
  if (!next || busyJob) { ticking = false; return; }
  busyJob = next.id;
  try {
    next.result = await api('extract', withLegacy(jobImages(next)));
    next.status = 'ready'; next.error = '';
    await jobPut(next);
    toast('📥 A receipt photo is ready to review');
  } catch (err) {
    await jobFailed(next, err, false);
  }
  busyJob = null; ticking = false;
  refreshJobs();
  if (!$('vJobs').classList.contains('hide')) renderJobs();
  setTimeout(jobTick, 1500);   // carry on with the next one
}

async function refreshJobs() {
  const all = await jobAll();
  const ready = all.filter(j => j.status === 'ready').length;
  $('btnJobs').classList.toggle('hide', !all.length);
  $('jobsLabel').innerHTML = 'Photos to review' + (all.length ? ' <span class="count">' + all.length + '</span>' : '');
  $('btnJobs').title = ready + ' ready';
  return all;
}

async function renderJobs() {
  const all = await refreshJobs();
  if (!all.length) { show('vHome'); return; }
  const when = t => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  $('jSub').textContent = navigator.onLine === false
    ? 'No signal right now. We will read these when you have signal. Keep the app open.'
    : 'These photos are safe on your phone. Tap Review to check one.';
  $('jList').innerHTML = all.map(j => {
    const res = j.result || {}, rows = res.rows || [];
    const stat = j.status === 'ready'
      ? `<b>${esc(rows[0]?.store || 'Receipt')}</b> · ${rows.length} item${rows.length === 1 ? '' : 's'} · ready`
      : busyJob === j.id ? 'Reading now…'
      : j.status === 'failed' ? 'Couldn\'t read: ' + esc(j.error || 'unknown error')
      : navigator.onLine === false ? 'Waiting for signal'
      : j.nextTry > Date.now() ? esc(j.error || 'Waiting') + ' · tries again ' + when(j.nextTry)
      : 'Waiting to be read';
    const btns = j.status === 'ready'
      ? `<button class="btn" data-j="review" data-id="${j.id}">Review</button>`
      : j.status === 'failed'
      ? `<button class="btn sec" data-j="retry" data-id="${j.id}">Try again</button><button class="btn sec" data-j="manual" data-id="${j.id}">Enter manually</button>`
      : `<button class="btn sec" data-j="now" data-id="${j.id}">Read now</button>`;
    return `<div class="card"><div class="jcard"><img src="${j.pages[0].dataUrl}" alt="">
      <div class="jb"><div class="qmeta">${when(j.created)} · ${j.pages.length} photo${j.pages.length === 1 ? '' : 's'}</div>
      <div class="jstat${j.status === 'failed' ? ' err' : ''}">${stat}</div>
      <div class="duo">${btns}<button class="btn sec" data-j="del" data-id="${j.id}">Delete</button></div></div></div></div>`;
  }).join('');
  show('vJobs');
}

$('jList').onclick = async e => {
  const act = e.target.dataset.j, id = e.target.dataset.id;
  if (!act) return;
  const j = (await jobAll()).find(x => x.id === id);
  if (!j) { renderJobs(); return; }
  if (act === 'review') openJob(j);
  else if (act === 'now' || act === 'retry') { j.tries = 0; j.status = 'pending'; readJobNow(j); }
  else if (act === 'manual') { job = j; manualEntry(); }
  else if (act === 'del' && confirm('Delete this photo? It hasn\'t been saved to your Sheet.')) { await jobDel(id); renderJobs(); }
};

function openJob(j) {
  job = j; lastSource = 'cam'; lastResult = j.result;
  showReview(j.result, 'cam');
  if (state) state.jobId = j.id;
}

// The free daily allowance is used up. The photo stays in "Photos to review".
function showQuotaError() {
  const u = usageNow() || {};
  $('errTitle').textContent = 'Free scans used up for today';
  $('errMsg').innerHTML =
    'Google\'s free allowance resets at <b>' + esc(resetText(u.resetAt)) + '</b>. Nothing was saved and nothing was charged. ' +
    'Your photo is kept in Photos to review and is read automatically after the reset.' +
    '<br><br>To keep scanning now, turn on billing in AI Studio, then tap Try again. It costs ' + esc(costLine()) + '. ' +
    'Or enter this one by hand.';
  $('btnRetry').textContent = '🔄 Try again';
  $('btnRetry').onclick = retryExtract;
  $('btnRetry').classList.toggle('hide', !job);
  $('btnRetake').classList.add('hide');
  $('btnBilling').classList.remove('hide');
  showErrImg();
  show('vError');
}

function showErrImg() {
  if (job && job.pages && job.pages[0]) {
    $('errImg').src = job.pages[0].dataUrl;
    $('errImg').classList.remove('hide');
  } else {
    $('errImg').classList.add('hide');
  }
}

// Review-screen failures are separate from extraction failures: the scan
// already succeeded and is kept in lastResult, so no new Gemini request is needed.
function showReview(result, source) {
  try {
    buildReview(result, source);
  } catch (err) {
    showRenderError(err);
  }
}

function showRenderError(err) {
  $('errTitle').textContent = 'Review screen failed';
  $('errMsg').textContent = 'Your scan was read and is kept. Nothing was re-sent to Gemini. Tap Retry view. (' + err.message + ')';
  $('btnRetry').textContent = '🔄 Retry view';
  $('btnRetry').onclick = () => showReview(lastResult, lastSource);
  $('btnRetry').classList.remove('hide');
  $('btnRetake').classList.add('hide');
  $('btnBilling').classList.add('hide');
  $('errImg').classList.add('hide');
  show('vError');
}

function showError(msg, canRetry) {
  $('errTitle').textContent = canRetry ? 'Gemini is busy' : "Couldn't read that";
  $('errMsg').textContent = msg + (job ? ' Your photo is kept in Photos to review.' : '');
  $('btnBilling').classList.add('hide');
  $('btnRetry').textContent = '🔄 Try again';
  $('btnRetry').onclick = retryExtract;
  $('btnRetake').classList.remove('hide');
  $('btnRetry').classList.toggle('hide', !canRetry || !job);
  showErrImg();
  show('vError');
}

function retryExtract() {
  if (!job) { toast('No photo to retry', true); return; }
  job.status = 'pending';
  readJobNow(job);
}

$('btnRetry').onclick = retryExtract;

/* ---------- review screen ---------- */
function buildReview(result, source) {
  const rows = result.rows || [];
  const meta = result.meta || {};

  state = {
    rows: rows.map((r, i) => Object.assign({ _sel: true, _shared: false, _pct: 50, _match: -1 }, r, vatSeed(r))),
    sharePct: 50,     // your % for the next line you share; follows the last % you typed
    meta,
    channel: (source === 'lib' || source === 'email') ? 'Email' : (rows[0]?.['email or in person'] || 'In person'),
    method:  rows[0]?.method || 'Collection',
    queueId: null,
    jobId: null,
    refund: !!meta.isRefund,
    matches: meta.matches || null
  };

  $('fStore').value = rows[0]?.store || '';
  $('fDate').value  = rows[0]?.['purchase date'] || today();
  $('fOrder').value = rows[0]?.['order number'] || '';
  $('fPay').value   = rows[0]?.['payment method'] || '';
  $('fNotes').value = '';   $('fFees').value = state.meta.feeTotal || '';
  $('fExtRet').checked = false; $('fRetBy').value = ''; $('fRetWrap').classList.add('hide');
  setTimeout(retLabel, 0);
  $('fEmail').value = meta.orderEmail || rememberedEmail(rows[0]?.store) || '';
  fillEmails();
  showEmailField();

  $('pChannel').textContent = state.channel;
  $('pMethod').textContent  = state.method;
  $('pChannel').classList.toggle('on', state.channel === 'Email');
  $('pMethod').classList.toggle('on', state.method === 'Delivery');

  // Already saved? (same order number, or same store, date and total) — checked by your Sheet, free
  $('dupBanner').textContent = meta.possibleDuplicate ? '⚠️ ' + meta.possibleDuplicate + '. Check before saving.' : '';
  $('dupBanner').classList.toggle('hide', !meta.possibleDuplicate);

  // Refunds: each line is matched to the purchase it refunds, which is then marked returned
  if (state.refund) {
    const m = state.matches || { candidates: [], lines: [] };
    state.rows.forEach((r, i) => { const k = m.lines ? m.lines[i] : -1; if (k > -1) applyMatch(r, k); });
    const back = rows.reduce((t, r) => t + Math.abs(Number(r['total cost']) || 0), 0);
    $('refBanner').innerHTML = '↩︎ <b>Refund — ' + money(back) + ' back.</b> ' + (m.candidates && m.candidates.length
      ? 'Check which purchase each line refunds. That purchase is marked returned and refunded in your Sheet.'
      : 'No match found automatically. Search under each line to pick the purchase it refunds, or save it as refund lines only.');
  }
  $('refBanner').classList.toggle('hide', !state.refund);

  // Check items add up to the receipt total (catches single misread prices). Free — no API call.
  if (meta.receiptTotal != null && rows.length) {
    const itemsSum = rows.reduce((s, r) => s + (Number(r['total cost']) || 0), 0);
    const expected = Number(meta.receiptTotal);
    if (Math.abs(itemsSum - expected) > 0.02) {
      toast('Items add to £' + itemsSum.toFixed(2) + ' but receipt total is £' + expected.toFixed(2) + ' — check prices', true);
    }
  }
  // Read by a back-up AI model (the main ones were used up or busy): ask for a quick look.
  if (meta.backup) toast('Read by a back-up AI model today. Give the lines and prices a quick check.', true);

   
   renderItems();
  show('vReview');
}

function findDupes() {
  const groups = {};
  state.rows.forEach((r, i) => {
    // Shared and unshared lines are never merged together
    const k = (r.item || '').trim().toLowerCase() + '|' + r['buy price'] + '|' + (r._shared ? 'S' + pctOf(r) : '');
    if (r.item && r.item.trim()) (groups[k] = groups[k] || []).push(i);
  });
  return Object.values(groups).filter(g => g.length > 1);
}

function combineAll() {
  const groups = findDupes();
  if (!groups.length) { toast('No duplicate lines found', true); return; }
  let merged = 0;
  const drop = [];
  groups.forEach(g => {
    const keep = state.rows[g[0]];
    for (let n = 1; n < g.length; n++) {
      keep.quantity = Number(keep.quantity) + Number(state.rows[g[n]].quantity);
      drop.push(g[n]);
      merged++;
    }
  });
  drop.sort((a, b) => b - a).forEach(i => state.rows.splice(i, 1));
  renderItems();
  toast('Merged ' + merged + ' duplicate line' + (merged > 1 ? 's' : ''));
}

function renderItems() {
  const box = $('items');
  box.innerHTML = '';
  const feeTotal = state.meta.feeTotal || 0;

  state.rows.forEach((r, i) => {
    const low = r._confidence === 'low' || !r['buy price'];
    const card = document.createElement('div');
    card.className = 'card' + (low ? ' low' : '');

    card.innerHTML = `
      <div class="row">
        <input class="chk" type="checkbox" ${r._sel ? 'checked' : ''} data-k="_sel" data-i="${i}">
                <input class="name" value="${esc(r.item)}" placeholder="Item name"
               data-k="item" data-i="${i}">
        <button class="rm" data-rm="${i}" aria-label="Remove">✕</button>
      </div>
      <div class="nums">
        <span>Qty</span>
        <input type="number" step="any" inputmode="decimal" value="${r.quantity}" data-k="quantity" data-i="${i}">
        <span>×</span>
        <input type="number" step="0.01" inputmode="decimal" value="${r['buy price']}" data-k="buy price" data-i="${i}">
        <span class="tot">${money(r['total cost'])}</span>
      </div>
      ${feeTotal ? `<div class="fee">incl. ${money(r['additional cost'])} fees</div>` : ''}
      ${CFG.vat ? `<div class="vat">VAT £<input type="number" step="0.01" inputmode="decimal" value="${r.VAT || 0}" data-k="VAT" data-i="${i}"></div>` : ''}
      ${state.refund ? matchSelect(r, i) : ''}
      <select data-k="purpose" data-i="${i}" class="${r.purpose ? '' : 'unset'}">
        <option value="">Select purpose…</option>
        ${CFG.purposes.map(p =>
          `<option ${p === r.purpose ? 'selected' : ''}>${esc(p)}</option>`).join('')}
      </select>
      <div class="splitrow"><button class="split${r._shared ? ' on' : ''}" data-share="${i}">${shareLabel(r)}</button>
      ${r._shared ? `<label class="pctwrap">you pay <input class="pct" type="number" inputmode="decimal" min="1" max="99"
        step="any" list="pctList" value="${pctOf(r)}" data-k="_pct" data-i="${i}"> %</label>` : ''}</div>`;
    box.appendChild(card);
  });

  box.oninput = e => {
    const i = e.target.dataset.i, k = e.target.dataset.k;
    if (i === undefined) return;
    const row = state.rows[i];
    if (k === '_sel') { row._sel = e.target.checked; return; }
    if (k === '_pct') {             // typing a % updates this line now; no re-render, so the keyboard stays open
      if (e.target.value === '') return;
      row._pct = clampPct(e.target.value);
      state.sharePct = row._pct;
      recalc();
      return;
    }
    if (k === 'VAT') { row.VAT = r2(e.target.value); row._vatRate = row['total price'] ? row.VAT / row['total price'] : null; recalc(true); return; }
    if (k === '_match') { applyMatch(row, Number(e.target.value)); renderItems(); return; }
    row[k] = (k === 'quantity' || k === 'buy price') ? Number(e.target.value) : e.target.value;
    if (k === 'quantity' || k === 'buy price') recalc();
    if (k === 'purpose') e.target.classList.toggle('unset', !e.target.value);
    updateSave();
  };

  box.onchange = e => {   // when you leave the % box, show the % actually used (e.g. 150 → 50)
    if (e.target.dataset.k === '_pct') e.target.value = pctOf(state.rows[e.target.dataset.i]);
  };

    box.onclick = e => {
    const sh = e.target.dataset.share;
    if (sh !== undefined) {
      const row = state.rows[sh];
      row._shared = !row._shared;
      if (row._shared) row._pct = state.sharePct;
      renderItems();
      return;
    }
    const rm = e.target.dataset.rm;
    if (rm === undefined) return;
    if (state.rows.length === 1) { toast('Need at least one item', true); return; }
    state.rows.splice(Number(rm), 1);
    renderItems();
  };

  if (typeof findDupes === 'function' && findDupes().length) {
    const cmb = document.createElement('button');
    cmb.className = 'btn sec';
    cmb.textContent = '⇅ Combine duplicate lines';
    cmb.onclick = combineAll;
    box.appendChild(cmb);
  }

  const add = document.createElement('button');
  add.className = 'btn sec';
  add.textContent = '+ Add another item';
  add.onclick = () => {
    state.rows.push({ _sel: true, _shared: false, _pct: state.sharePct, _match: -1, VAT: 0, _vatRate: CFG.vat ? 0.2 : null,
      item: '', quantity: 1, 'buy price': 0,
      'total price': 0, 'additional cost': 0, 'total cost': 0, purpose: '',
      _confidence: 'low' });
    renderItems();
  };
  box.appendChild(add);

  updateSharedPill();
  recalc();

}

function recalc(keepVat) {
  const fee = state.meta.feeTotal || 0;
  const n = state.rows.length || 1;
  const per = r2(fee / n);
  const rem = r2(fee - per * n);

  state.rows.forEach((r, i) => {
    r['total price'] = r2(Number(r.quantity) * Number(r['buy price']));
    if (state.refund) r['total price'] = -Math.abs(r['total price']);   // refunds read as −1 × −£24: keep money going back negative
    r['additional cost'] = r2(per + (i === 0 ? rem : 0));
    r['total cost'] = r2(r['total price'] + r['additional cost']);
    if (CFG.vat && !keepVat && r._vatRate != null) r.VAT = r2(r['total price'] * r._vatRate);
  });

  // refresh displayed totals without rebuilding inputs (keeps keyboard focus)
  document.querySelectorAll('#items .card').forEach((c, i) => {
    const t = c.querySelector('.tot');
    if (t) t.textContent = money(state.rows[i]['total cost']);
    const f = c.querySelector('.fee');
    if (f) f.textContent = 'incl. ' + money(state.rows[i]['additional cost']) + ' fees';
    const sp = c.querySelector('.split');
    if (sp) sp.textContent = shareLabel(state.rows[i]);
    const v = c.querySelector('.vat input');
    if (v && document.activeElement !== v) v.value = state.rows[i].VAT || 0;
  });

  // Receipt check always uses full prices; "your share" halves the shared lines
  const sum = r2(state.rows.reduce((s, r) => s + r['total cost'], 0));
  const mine = r2(state.rows.reduce((s, r) => s + (r._shared ? sharePart(r['total cost'], pctOf(r)) : r['total cost']), 0));
  const shareNote = (state.rows.some(r => r._shared) ? ' · your share ' + money(mine) : '') +
    (CFG.vat ? ' · VAT ' + money(state.rows.reduce((t, r) => t + (Number(r.VAT) || 0), 0)) : '');
  const expected = state.meta.receiptTotal;
  const el = $('recon');
  if (expected == null) {
    el.className = 'recon ok';
    el.textContent = 'Total ' + money(sum) + shareNote;
  } else if (Math.abs(sum - expected) < 0.02) {
    el.className = 'recon ok';
    el.textContent = '✅ Total ' + money(sum) + ' — matches receipt' + shareNote;
  } else {
    el.className = 'recon warn';
    el.textContent = '⚠️ Lines total ' + money(sum) +
                     ' but receipt says ' + money(expected) + ' — check figures' + shareNote;
  }
  updateSave();
}

function updateSave() {
  const missing = state.rows.some(r => !r.purpose);
  $('btnSave').disabled = missing;
  $('btnSave').textContent = missing
    ? 'Set a purpose for every line'
    : 'Save to Sheet';
}

/* ---------- VAT (only for VAT-registered Sheets) ---------- */
function vatSeed(r) {
  if (!CFG.vat) return { VAT: '', _vatRate: null };
  const v = Number(r.VAT) || 0, tp = Number(r['total price']) || 0;
  return { VAT: v, _vatRate: tp ? v / tp : 0.2 };
}

/* ---------- order email: shown for emailed orders, remembered per store ---------- */
const LS_EMAILS = 'rs_emails';
function emailMap() { try { return JSON.parse(localStorage.getItem(LS_EMAILS)) || {}; } catch (e) { return {}; } }
function rememberedEmail(store) { return emailMap()[String(store || '').trim().toLowerCase()] || ''; }
function rememberEmail(store, email) {
  if (!store || !email) return;
  const m = emailMap(); m[store.trim().toLowerCase()] = email;
  try { localStorage.setItem(LS_EMAILS, JSON.stringify(m)); } catch (e) {}
}
function fillEmails() {
  const list = Array.from(new Set(Object.values(emailMap()))).sort();
  $('emailList').innerHTML = list.map(e => `<option value="${esc(e)}">`).join('');
}
function showEmailField() {
  const on = state && state.channel === 'Email';
  $('emailWrap').classList.toggle('hide', !on);
  if (on && !$('fEmail').value) $('fEmail').value = rememberedEmail($('fStore').value);
}

/* ---------- refunds ---------- */
// Pick the refunded purchase by hand: suggestions from your Sheet as you type (free, no AI)
let rfTimer = null, rfRes = {};
$('items').addEventListener('input', e => {
  const i = e.target.dataset.rfi;
  if (i === undefined) return;
  const q = e.target.value.trim();
  clearTimeout(rfTimer);
  if (q.length < 2) { $('rfres' + i).innerHTML = ''; return; }
  rfTimer = setTimeout(async () => {
    try {
      const r = await api('purchaseSearch', { q });
      rfRes[i] = (r || []).filter(x => !state.rows.some(y => y._matchRowPicked === x.row && y !== state.rows[i]));
      $('rfres' + i).innerHTML = rfRes[i].length ? rfRes[i].map((x, k) => `<button data-rfpick="${i}:${k}">${esc(x.item)}<br><small class="sub">${esc(x.date)} · ${esc(x.store)} · ${money(x.total)}</small></button>`).join('')
        : '<p class="sub">Nothing matches. Try one word, e.g. "golf".</p>';
    } catch (err) { $('rfres' + i).innerHTML = '<p class="sub">' + esc(err.message) + '</p>'; }
  }, 300);
});
$('items').addEventListener('click', e => {
  const b = e.target.closest('[data-rfpick]');
  if (!b) return;
  const [i, k] = b.dataset.rfpick.split(':').map(Number), x = (rfRes[i] || [])[k];
  if (!x) return;
  state.matches = state.matches || { candidates: [], lines: [] };
  state.matches.candidates = state.matches.candidates || [];
  let n = state.matches.candidates.findIndex(c => c.row === x.row);
  if (n < 0) { state.matches.candidates.push({ row: x.row, item: x.item, date: x.date, total: x.total, purpose: x.purpose, shared: x.shared, notes: x.notes, store: x.store }); n = state.matches.candidates.length - 1; }
  applyMatch(state.rows[i], n);
  state.rows[i]._matchRowPicked = x.row;
  renderItems();
  toast('Matched to ' + x.item);
});
function matchSelect(r, i) {
  const c = (state.matches && state.matches.candidates) || [];
  return `<div class="match">Refund for:
    <select data-k="_match" data-i="${i}">
      ${c.map((x, k) => `<option value="${k}" ${k === r._match ? 'selected' : ''}>${esc(x.date)} · ${esc(x.item)} · ${money(x.total)}${x.shared ? ' (your share)' : ''}</option>`).join('')}
      <option value="-1" ${r._match === -1 ? 'selected' : ''}>Not in the Sheet — save as a refund line only</option>
    </select>
    <div class="rfind"><input data-rfi="${i}" placeholder="${c.length ? 'Not right? ' : ''}Search your purchases, e.g. golf balls" autocomplete="off"><div class="rfres" id="rfres${i}"></div></div></div>`;
}

// Takes the purpose and shared % from the purchase being refunded
function applyMatch(r, k) {
  const c = state.matches && state.matches.candidates && state.matches.candidates[k];
  r._match = c ? k : -1;
  if (!c) return;
  if (c.purpose) r.purpose = c.purpose;
  if (c.shared) {
    const m = String(c.notes).match(/your ([\d.]+)%/);
    r._shared = true; r._pct = clampPct(m ? m[1] : 50);
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- shared cost (per item) ---------- */
// Top pill: blanket switch + summary. Shows "Part shared (n/N)" when only some lines are shared.
function updateSharedPill() {
  const n = state.rows.filter(r => r._shared).length;
  const all = n === state.rows.length && n > 0;
  $('pShared').textContent = n === 0 ? 'Not shared' : all ? 'Shared cost' : 'Part shared (' + n + '/' + state.rows.length + ')';
  $('pShared').classList.toggle('on', n > 0);
}

function toggleSharedAll() {
  const all = state.rows.every(r => r._shared);
  state.rows.forEach(r => { r._shared = !all; if (r._shared) r._pct = state.sharePct; });
  renderItems();
}

function shareSelected() {
  const chosen = state.rows.filter(r => r._sel);
  if (!chosen.length) { toast('Tick some items first', true); return; }
  const allShared = chosen.every(r => r._shared);
  chosen.forEach(r => { r._shared = !allShared; if (r._shared) r._pct = state.sharePct; });
  renderItems();
  toast((allShared ? 'Unshared ' : 'Shared ') + chosen.length + ' item' + (chosen.length > 1 ? 's' : ''));
}

/* ---------- bulk actions ---------- */
function selectAll() {
  const allOn = state.rows.every(r => r._sel);
  state.rows.forEach(r => r._sel = !allOn);
  document.querySelectorAll('#items .chk').forEach((c, i) => {
    c.checked = state.rows[i]._sel;
  });
  $('btnSelAll').textContent = allOn ? 'Select all' : 'Deselect all';
}

async function bulkPurpose() {
  const chosen = state.rows.filter(r => r._sel);
  if (!chosen.length) { toast('Tick some items first', true); return; }
  const cur = chosen.every(r => r.purpose === chosen[0].purpose) ? chosen[0].purpose : '';
  const val = await pickPurpose('Purpose for ' + chosen.length + ' item' + (chosen.length > 1 ? 's' : ''), cur);
  if (val) applyPurpose(val);
}

/* ---------- purpose picker: a panel of buttons, one per purpose ---------- */
function pickPurpose(title, current) {
  return new Promise(resolve => {
    const veil = document.createElement('div');
    veil.className = 'veil';
    veil.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(title)}"><h3>${esc(title)}</h3>
      ${CFG.purposes.map((p, i) => `<button class="opt${p === current ? ' on' : ''}" data-p="${i}">${esc(p)}</button>`).join('')}
      <div class="newp hide"><input placeholder="New purpose name" maxlength="60"><button data-new="1">Add</button></div>
      <button class="opt add" data-add="1">＋ New purpose</button>
      <button class="btn ghost" data-cancel="1">Cancel</button></div>`;
    const done = v => { veil.remove(); resolve(v); };
    veil.onclick = async e => {
      const t = e.target;
      if (t === veil || t.dataset.cancel) return done(null);
      if (t.dataset.p !== undefined) return done(CFG.purposes[t.dataset.p]);
      if (t.dataset.add) {
        t.classList.add('hide');
        const box = veil.querySelector('.newp'); box.classList.remove('hide');
        box.querySelector('input').focus();
        return;
      }
      if (t.dataset.new) {
        const val = veil.querySelector('.newp input').value.trim();
        if (!val) return;
        t.disabled = true; t.textContent = 'Adding…';
        try {
          CFG.purposes = await api('addPurpose', { value: val });
          saveCache();
          toast('Added "' + val + '"');
          done(val);
        } catch (err) { toast(err.message, true); t.disabled = false; t.textContent = 'Add'; }
      }
    };
    veil.querySelector('.sheet').addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') veil.querySelector('[data-new]').click();
    });
    document.body.appendChild(veil);
  });
}

function applyPurpose(val) {
  state.rows.forEach(r => { if (r._sel) r.purpose = val; });
  renderItems();
  toast('Purpose set');
}

/* ---------- payment memory ---------- */
function fillPayPicker() {
  const sel = $('payPick');
  sel.innerHTML = '<option value="">▾</option>' +
    CFG.payments.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  sel.onchange = () => {
    if (sel.value) { $('fPay').value = sel.value; sel.value = ''; }
  };
}

function fillStores() {
  $('storeList').innerHTML =
    CFG.stores.map(s => `<option value="${esc(s)}">`).join('');
}

/* ---------- save ---------- */
async function saveToSheet(force) {
  const store = $('fStore').value.trim();
  const date  = $('fDate').value.trim();
  if (!store) { toast('Store name required', true); return; }
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    toast('Date must be DD/MM/YYYY', true); return;
  }

  const pay   = $('fPay').value.trim();
  const order = $('fOrder').value.trim();
  const notes = $('fNotes').value.trim();
  const email = state.channel === 'Email' ? $('fEmail').value.trim() : '';
  const retBy = $('fExtRet').checked ? $('fRetBy').value.trim() : '';
  if (retBy && !/^\d{2}\/\d{2}\/\d{4}$/.test(retBy)) { toast('Return by: use DD/MM/YYYY', true); $('fRetBy').focus(); return; }

  // Shared lines record only your share. The full price goes in that line's notes for the audit trail.
  const payload = state.rows.map(r => {
    const s = r._shared, p = pctOf(r);
    const tp = s ? sharePart(r['total price'], p) : r['total price'];
    const ad = s ? sharePart(r['additional cost'], p) : r['additional cost'];
    const lineNote = s ? 'Shared — your ' + p + '% of full ' + money(r['total cost']) : '';
    const c = state.refund && r._match > -1 && state.matches ? state.matches.candidates[r._match] : null;
    const row = {
    'purchase date':      date,
    'item':               r.item,
    'buy price':          s ? sharePart(r['buy price'], p) : r['buy price'],
    'quantity':           r.quantity,
    'total price':        tp,
    'additional cost':    ad,
    'total cost':         r2(tp + ad),
    'store':              store,
    'notes':              [notes, lineNote, c ? 'Refund of ' + c.item + ' bought ' + c.date : ''].filter(Boolean).join(' · '),
    'purpose':            r.purpose,
    'method':             state.method,
    'email or in person': state.channel,
    'shared cost?':       r._shared ? 'Yes' : 'No',
    'order number':       order,
    'payment method':     pay,
    'order email':        email,
    'VAT':                CFG.vat ? (s ? sharePart(r.VAT, p) : r2(r.VAT)) : '',
    'return by':          retBy
    };
    if (c) { row._matchRow = c.row; row._matchItem = c.item; }
    return row;
  });

  // Mileage and fuel for the same car can't both be claimed
  if (Number(localStorage.getItem(LS_TRIPS) || 0) > 0 &&
      state.rows.some(r => /petrol|diesel|unleaded|\bfuel\b/i.test(r.item))) {
    toast('Fuel: if this was for a car you log trips for, mark it Personal. Mileage covers fuel', true);
  }

  const queueId = state.queueId, jobId = state.jobId;
  try {
    show('vWork');
    $('workMsg').textContent = 'Saving to sheet…';
    const res = await api('append', Object.assign({
      rows: payload,
      queueId: queueId,
      force: !!force,
      returnId: (job && job.returnId) || undefined
    }, job && jobId ? withLegacy(jobImages(job)) : {}));

    if (store && !CFG.stores.includes(store)) { CFG.stores.push(store); CFG.stores.sort(); }
    if (pay && !CFG.payments.includes(pay))   { CFG.payments.push(pay); CFG.payments.sort(); }
    rememberEmail(store, email);
    saveCache(); fillStores(); fillPayPicker();

    if (jobId) await jobDel(jobId);
    if (!state.refund) matchPurchase(payload.filter(r => !/personal/i.test(r.purpose || '')).map(r => r.item).filter(Boolean));   // scans and emailed receipts alike
    job = null; state = null;
    $('homeStatus').textContent =
      '✅ ' + res.rowsAdded + ' row' + (res.rowsAdded > 1 ? 's' : '') +
      ' saved · ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    toast(res.returnsDone ? 'Refund saved and attached to the return' : res.refundsMarked ? 'Refund saved · ' + res.refundsMarked + ' purchase' + (res.refundsMarked > 1 ? 's' : '') + ' marked returned' : 'Saved to sheet');
    if (res.returnsDone) SALES = null;
    worthItLink(payload);
    refreshJobs();
    if (queueId) openQueue();     // straight on to the next emailed receipt
    else show('vHome');
  } catch (err) {
    if (err.code === 'DUPLICATE') {     // looks already saved: your call
      show('vReview');
      if (confirm(err.message)) saveToSheet(true);
      return;
    }
    if (err.code === 'OFFLINE') {
      show('vReview');
      toast('No signal — nothing saved yet. Tap Save again when you have signal' + (jobId ? '. The photo is kept' : ''), true);
      return;
    }
    showError('Save failed: ' + err.message);
  }
}

/* ---------- manual entry ---------- */
function manualEntry() {
  buildReview({
    rows: [{
      'purchase date': today(), 'item': '', 'buy price': 0, 'quantity': 1,
      'total price': 0, 'additional cost': 0, 'total cost': 0,
      'store': '', 'notes': '', 'purpose': '',
      'method': 'Collection', 'email or in person': 'In person',
      'shared cost?': 'No', 'order number': '', 'payment method': '',
      '_confidence': 'low'
    }],
    meta: { receiptTotal: null, feeTotal: 0, isRefund: false }
  }, lastSource);
  if (state && job && job.id) state.jobId = job.id;   // a photo that couldn't be read is still saved with it
  toast('Fill in the details');
}

/* ---------- emailed receipts (queue) ---------- */
// The backend reads forwarded emails every 15 minutes. Here you review them like a scan.
let queueItems = [];

function setEmailCount(n) {
  $('emailLabel').innerHTML = 'Emailed receipts' + (n ? ' <span class="count">' + n + '</span>' : '');
}

async function openQueue() {
  show('vWork');
  $('workMsg').textContent = 'Checking emails…';
  try {
    const d = await api('queue', {});
    renderQueue(d);
    show('vQueue');
    if (d.now && d.now - (d.lastRun || 0) > 120000) checkInboxNow(0, true);   // not looked for 2+ min: look now, in the background
  } catch (err) {
    show('vHome');
    toast('Couldn\'t load emails: ' + err.message, true);
  }
}

function renderQueue(d) {
  queueItems = d.items || [];
  setEmailCount(queueItems.length);
  const waiting = d.processing ? d.processing + ' more being read now. ' : '';
  $('qSub').textContent = (queueItems.length ? 'These came from your emails. Check each one, then tap Save. ' : 'Nothing to check yet. ')
    + waiting + 'We look for new emails every ' + (d.every || 15) + ' minutes. In a hurry? Tap Check inbox now. Gmail can take 1–2 minutes to pass an email on.';
  $('qLast').textContent = lastCheckText(d);
  const hd = d.handled || [];
  $('qDone').classList.toggle('hide', !hd.length);
  $('qDoneSum').textContent = 'Done for you in the last 3 days (' + hd.length + ')';
  $('qDoneList').innerHTML = hd.map(q => `<div class="skrow"><span>${esc(q.subject || '(no subject)')}<span class="sm">${esc(q.received || '')} · ${esc(q.note)}</span></span><span class="tag ok">✓</span></div>`).join('');
  const sk = d.skipped || [];
  $('qSkip').classList.toggle('hide', !sk.length);
  $('qSkipSum').textContent = 'Skipped as ads (' + sk.length + ')';
  $('qSkipList').innerHTML = sk.map(q => `<div class="skrow"><span>${esc(q.subject || '(no subject)')}<span class="sm">${esc(String(q.from || '').replace(/<.*>/, '').trim())} · ${esc(q.received || '')}</span></span>
    <button class="btn sec" style="width:auto;padding:8px 12px;margin:0" data-skq="${esc(q.id)}">Read it anyway</button></div>`).join('');

  $('qList').innerHTML = queueItems.map((q, i) => {
    const res = q.result || {};
    const rows = res.rows || [];
    const meta = res.meta || {};
    const total = meta.receiptTotal != null ? meta.receiptTotal
                : rows.reduce((s, r) => s + (Number(r['total cost']) || 0), 0);
    const sender = meta.orderEmail || q.from;
    const body = q.status === 'ready'
      ? `<div class="sum"><b>${esc(rows[0]?.store || 'Unknown store')}</b> · ${money(total)} · ${rows.length} item${rows.length === 1 ? '' : 's'}</div>
         ${meta.possibleDuplicate ? `<div class="warn">⚠️ ${esc(meta.possibleDuplicate)}</div>` : ''}
         <div class="duo"><button class="btn" data-q="review" data-i="${i}">Review</button>
         <button class="btn sec" data-q="dismiss" data-i="${i}">Dismiss</button></div>`
      : `<div class="warn">${esc(emailError(q.error))}</div>
         <div class="duo"><button class="btn sec" data-q="retry" data-i="${i}">Try again</button>
         <button class="btn sec" data-q="dismiss" data-i="${i}">Dismiss</button></div>`;
    return `<div class="card qcard"><h3>${esc(q.subject || '(no subject)')}</h3>
      <div class="qmeta">${esc(sender)} · ${esc(q.received)}</div>${body}</div>`;
  }).join('');
}

// "Last checked 4 min ago · next check in about 11 min" (uses the server's clock)
function lastCheckText(d) {
  if (!d.lastRun || !d.now) return '';
  const every = d.every || 15, ago = Math.max(0, Math.round((d.now - d.lastRun) / 60000)), next = every - (ago % every);
  return 'Last checked ' + (ago < 1 ? 'just now' : ago + ' min ago') + ' · next check in about ' + next + ' min';
}

// Check inbox now: the same check the app does every few minutes, straight away (no extra cost).
// If nothing has arrived yet, look again a few times while this screen is open, since Gmail can be slow.
let qTimer = null;
const queueSeen = new Set();   // "done for you" items already mentioned this session
async function checkInboxNow(tries = 0, auto = false) {
  clearTimeout(qTimer);
  const b = $('btnQRefresh');
  b.disabled = true; b.textContent = tries ? 'Looking again…' : 'Looking in your inbox…';
  if (auto) tries = 4;   // a look when the screen opens: no follow-ups
  let d;
  try { d = await api('checkEmails', {}); }
  catch (err) {
    if (/Unknown action/.test(err.message)) { d = await api('queue', {}).catch(() => null); }   // older script: just reload
    else { toast(err.message, true); }
  }
  b.disabled = false; b.textContent = '↻ Check inbox now';
  if (!d) return;
  renderQueue(d);
  if (d.found) { toast('Found ' + d.found + ' new email' + (d.found === 1 ? '' : 's')); return; }
  const hd = (d.handled || []).filter(q => !queueSeen.has(q.id));
  if (hd.length && !auto) {   // already picked up by the 5-minute check: say so instead of "nothing yet"
    hd.forEach(q => queueSeen.add(q.id));
    toast(hd.length + ' email' + (hd.length === 1 ? ' was' : 's were') + ' already filed for you. See "Done for you"');
    $('qDone').open = true;
    return;
  }
  if (d.ran !== undefined && tries < 4 && !$('vQueue').classList.contains('hide')) {   // up to 2 more minutes
    let left = 30;
    const tick = () => {
      if ($('vQueue').classList.contains('hide')) return;
      if (left <= 0) return checkInboxNow(tries + 1);
      b.textContent = 'Nothing yet. Looking again in ' + left + 's (tap to look now)';
      left -= 5; qTimer = setTimeout(tick, 5000);
    };
    tick();
  }
}

// Extraction errors are worded for photos; reword them for emails
function emailError(msg) {
  msg = String(msg || '');
  if (/No line items|empty response/i.test(msg)) return 'No purchases found — this may not be an order confirmation.';
  if (/QUOTA_DAY|daily free/i.test(msg)) return 'Today\'s free scans ran out before this was read. It will be read again after the reset, or tap Try again once billing is on.';
  if (/busy|503|429|overload/i.test(msg)) return 'Google was busy when this was read. Try again.';
  return 'Couldn\'t read this email: ' + (msg || 'unknown error');
}

$('qSkipList').onclick = async e => {
  const id = e.target.dataset.skq;
  if (!id) return;
  e.target.disabled = true;
  try {
    renderQueue(await api('queueSet', { id: id, queueAction: 'retry' }));
    toast('It will be read within 5 minutes');
  } catch (err) { e.target.disabled = false; toast(err.message, true); }
};

$('qList').onclick = async e => {
  const act = e.target.dataset.q;
  if (!act) return;
  const q = queueItems[e.target.dataset.i];

  if (act === 'review') {
    job = null;
    lastSource = 'email';
    showReview(q.result, 'email');
    if (state) {
      state.queueId = q.id;
      const sender = q.result.meta?.orderEmail;
      if (sender) toast('From ' + sender);
    }
    return;
  }
  if (act === 'dismiss' && !confirm('Dismiss this email? It won\'t be added to the Sheet.')) return;
  try {
    renderQueue(await api('queueSet', { id: q.id, queueAction: act }));
    toast(act === 'retry' ? 'Queued — it will be read within 15 minutes' : 'Dismissed');
  } catch (err) {
    toast(err.message, true);
  }
};

/* ---------- mileage ---------- */
const LS_TRIPS = 'rs_trips', LS_VEHICLE = 'rs_vehicle', LS_PLACES = 'rs_places';
const RATES = { 'Car or van': 0.55, 'Motorbike': 0.24, 'Bicycle': 0.20 };

function lsList(k) { try { return JSON.parse(localStorage.getItem(k)) || []; } catch (e) { return []; } }

const LS_HOME = 'rs_home', LS_RECENT = 'rs_recent_trips', LS_PENDING_TRIPS = 'rs_pending_trips';
const HOME = 'Home';
let trip = { route: null, routeKey: '', milesFromRoute: null, seq: 0 };

function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function homeAddr() { return localStorage.getItem(LS_HOME) || ''; }

function openTrip(pre) {
  $('tDate').value = today();
  $('tReason').value = ''; $('tMiles').value = ''; $('tReturn').checked = false;
  trip = { route: null, routeKey: '', milesFromRoute: null, seq: trip.seq + 1 };
  const v = localStorage.getItem(LS_VEHICLE) || 'Car or van';
  document.querySelectorAll('#tVehicle button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  fillPlaces();
  renderStops([homeAddr() ? HOME : '', '']);
  renderRepeat();
  $('homeWrap').classList.add('hide');
  $('btnHome').textContent = homeAddr() ? '🏠 ' + homeAddr() : '🏠 Set home';
  $('tSub').textContent = 'Type where you went. We work out the miles. Don\'t claim fuel for this car as well.';
  routeIdle();
  if (pre && pre.collectId) {   // a click & collect pick-up: home (or 📍 where you are) → the shop and back, linked to it
    trip.collectId = pre.collectId;
    $('tDate').value = pre.date || today();
    $('tReason').value = pre.reason || '';
    $('tReturn').checked = true;
    renderStops([homeAddr() ? HOME : '', pre.to || '']);
    $('tSub').textContent = 'Your trip to collect the order. Starts from home: tap 📍 to start from where you are. Check the miles, then save.';
    if (homeAddr() && pre.to) lookupRoute();
  }
  if (pre && (pre.saleRow || pre.saleId)) {   // drop-off for a sale: home → buyer and back, linked to that sale
    trip.saleRow = pre.saleRow; trip.saleId = pre.saleId;
    $('tDate').value = pre.date || today();
    $('tReason').value = pre.reason || '';
    $('tReturn').checked = true;
    renderStops([homeAddr() ? HOME : '', pre.to || '']);
    $('tSub').textContent = 'The drop-off for your sale. Check the route and miles, then save. It\'s linked to the sale.';
    if (homeAddr() && pre.to) lookupRoute();
  }
  if (pre && pre.journey) {   // from Trips to log, a Purchases card or ✓ Posted: home → each place (→ home), linked so it's never claimed twice
    const j = pre.journey;
    trip.labelIds = j.labelIds || []; trip.purchaseIds = j.purchaseIds || [];
    $('tDate').value = j.date || today();
    $('tReason').value = j.reason || '';
    $('tReturn').checked = j.ret !== false;
    renderStops([homeAddr() ? HOME : ''].concat(j.stops && j.stops.length ? j.stops : ['']));
    if (j.miles && !(j.stops || []).filter(Boolean).length) $('tMiles').value = j.miles;
    $('tSub').textContent = j.sub || 'Check the route and miles, then save. It\'s linked, so it\'s never claimed twice.';
    if (homeAddr() && (j.stops || []).filter(Boolean).length) lookupRoute();
  }
  tripCalc();
  show('vTrip');
  renderTripTodo(!pre);
}

function fillPlaces() {
  const list = (homeAddr() ? [HOME] : []).concat(lsList(LS_PLACES).filter(p => p !== HOME));
  $('placeList').innerHTML = list.map(p => `<option value="${esc(p)}">`).join('');
}

// Stops: start, any stops in between, end. Each is a postcode, address, "Home" or the phone's location.
function renderStops(vals, geos) {
  geos = geos || [];
  const n = vals.length;
  $('tStops').innerHTML = vals.map((v, i) => `<div class="stop">
    <span class="dot">${i === 0 ? 'A' : i === n - 1 ? String.fromCharCode(65 + i) : String.fromCharCode(65 + i)}</span>
    <input data-stop="${i}" list="placeList" value="${esc(v)}" ${geos[i] ? `data-geo="${esc(geos[i])}"` : ''}
      placeholder="${i === 0 ? 'Start: postcode or address' : i === n - 1 ? 'Where you went' : 'Stop'}" autocomplete="off">
    ${i === 0 ? '<button class="ib" data-here="1" aria-label="Use my location">📍</button>'
      : i < n - 1 ? `<button class="ib" data-del="${i}" aria-label="Remove stop">✕</button>` : '<span style="width:44px"></span>'}
  </div>`).join('');
}

function stopInputs() { return Array.from(document.querySelectorAll('#tStops input')); }
function stopValues() { return stopInputs().map(x => x.value.trim()); }

// What's sent to Google: "Home" becomes your saved postcode, the 📍 button sends coordinates
function stopsForRoute() {
  const out = stopInputs().map(x => x.dataset.geo || (x.value.trim() === HOME ? homeAddr() : x.value.trim())).filter(Boolean);
  if ($('tReturn').checked && out.length >= 2 && out[out.length - 1].toLowerCase() !== out[0].toLowerCase()) out.push(out[0]);
  return out;
}

function routeIdle(msg) {
  $('tRoute').className = 'routebox';
  $('tRoute').textContent = msg || 'Enter where you started and where you went, and the miles are worked out for you.';
}

async function lookupRoute() {
  const raw = stopValues();
  if (raw.some(v => v === HOME) && !homeAddr()) { routeIdle('Set your home postcode first: tap 🏠 Set home.'); return; }
  const stops = stopsForRoute();
  if (stops.length < 2 || raw.filter(Boolean).length < 2) { trip.route = null; routeIdle(); tripCalc(); return; }
  const key = stops.join('|').toLowerCase();
  if (key === trip.routeKey && trip.route) return;
  const seq = ++trip.seq;
  $('tRoute').className = 'routebox';
  $('tRoute').textContent = 'Working out the route…';
  try {
    const r = await api('route', { stops });
    if (seq !== trip.seq) return;          // a newer lookup has started
    trip.route = r; trip.routeKey = key; trip.milesFromRoute = r.miles;
    $('tMiles').value = r.miles;
    $('tMilesNote').textContent = '(from Google Maps — change it if you took a detour)';
    showRoute(r);
  } catch (err) {
    if (seq !== trip.seq) return;
    trip.route = null; trip.routeKey = '';
    $('tRoute').className = 'routebox' + (err.code === 'OFFLINE' ? '' : ' err');
    $('tRoute').textContent = err.code === 'OFFLINE'
      ? 'No signal. Save the trip anyway: the miles are worked out when you\'re back online.'
      : /Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for route lookups. Type the miles for now.'
      : err.message;
  }
  tripCalc();
}

function showRoute(r) {
  const hrs = r.minutes >= 60 ? Math.floor(r.minutes / 60) + ' h ' + (r.minutes % 60) + ' min' : r.minutes + ' min';
  $('tRoute').className = 'routebox';
  $('tRoute').innerHTML = `<b>${r.miles} miles</b> · ${hrs} by car
    <div class="legs">${r.legs.map(l => esc(l.from) + ' → ' + esc(l.to) + ': ' + l.miles + ' mi').join('<br>')}</div>
    <div style="margin-top:6px"><a href="${esc(r.link)}" target="_blank" rel="noopener">View route in Google Maps ›</a></div>`;
}

function renderRepeat() {
  const rec = lsList(LS_RECENT);
  $('tRepeatWrap').classList.toggle('hide', !rec.length);
  $('tRepeat').innerHTML = rec.map((t, i) => `<button class="chip" data-rep="${i}">${esc(t.label)}
    <small>${t.miles} mi${t.reason ? ' · ' + esc(t.reason) : ''}</small></button>`).join('');
}

function repeatTrip(i) {
  const t = lsList(LS_RECENT)[i];
  if (!t) return;
  renderStops(t.stops);
  $('tReturn').checked = !!t.ret;
  $('tReason').value = t.reason || '';
  document.querySelectorAll('#tVehicle button').forEach(b => b.classList.toggle('on', b.dataset.v === t.vehicle));
  $('tMiles').value = t.miles;
  trip.route = t.route || null; trip.milesFromRoute = t.route ? t.route.miles : null;
  trip.routeKey = t.route ? stopsForRoute().join('|').toLowerCase() : '';
  $('tMilesNote').textContent = t.route ? '(from Google Maps — change it if you took a detour)' : '';
  if (t.route) showRoute(t.route); else routeIdle('Same as last time: ' + t.miles + ' miles.');
  tripCalc();
}

function tripVehicle() { const b = document.querySelector('#tVehicle button.on'); return b ? b.dataset.v : 'Car or van'; }

function tripCalc() {
  const miles = Number($('tMiles').value) || 0;
  const v = tripVehicle(), rate = RATES[v];
  $('tCalc').textContent = miles
    ? miles + ' miles × ' + Math.round(rate * 100) + 'p ≈ ' + money(miles * rate) +
      (v === 'Car or van' ? '. After 10,000 car miles in a tax year it\'s 25p a mile; your Sheet works that out.' : '.')
    : 'HMRC rates: car or van 55p a mile (25p after 10,000 miles a year), motorbike 24p, bicycle 20p.';
}

// The trip as it's saved: places as Google named them (short), or as typed
function buildTrip() {
  const raw = stopValues(), r = trip.route;
  const places = r ? r.places : raw.map(v => v === HOME ? HOME : v);
  const named = places.slice();
  if ($('tReturn').checked && r && named.length > raw.filter(Boolean).length) named.pop();   // the leg back is the return
  const miles = Number($('tMiles').value) || 0;
  const edited = r && Math.abs(miles - r.miles) >= 0.05;
  return {
    date: $('tDate').value.trim(), reason: $('tReason').value.trim(), vehicle: tripVehicle(),
    from: named[0] || '', to: named[named.length - 1] || '', via: named.slice(1, -1).join(' → '),
    miles: miles, ret: false, returnIncluded: $('tReturn').checked,
    link: r ? r.link : '', source: r ? (edited ? 'Google Maps ' + r.miles + ', edited' : 'Google Maps') : 'Typed',
    _stops: raw, _route: r,
    saleRow: trip.saleRow || undefined, saleId: trip.saleId || undefined, collectId: trip.collectId || undefined,
    labelIds: trip.labelIds && trip.labelIds.length ? trip.labelIds : undefined, purchaseIds: trip.purchaseIds && trip.purchaseIds.length ? trip.purchaseIds : undefined
  };
}

function rememberTrip(t) {
  const label = [t._stops[0], t._stops[t._stops.length - 1]].join(' → ') + (t.returnIncluded ? ' ↺' : '');
  const rec = [{ label, stops: t._stops, ret: t.returnIncluded, reason: t.reason, vehicle: t.vehicle, miles: t.miles, route: t._route }]
    .concat(lsList(LS_RECENT).filter(x => x.label !== label || x.reason !== t.reason)).slice(0, 5);
  lsSet(LS_RECENT, rec);
  const places = t._stops.filter(p => p && p !== HOME).concat(lsList(LS_PLACES)).filter((p, i, a) => a.indexOf(p) === i).slice(0, 20);
  lsSet(LS_PLACES, places);
  localStorage.setItem(LS_VEHICLE, t.vehicle);
  if (t.vehicle === 'Car or van') localStorage.setItem(LS_TRIPS, String(Number(localStorage.getItem(LS_TRIPS) || 0) + 1));
}

const sendTrip = t => { const x = Object.assign({}, t); delete x._stops; delete x._route; delete x._routeStops; return api('mileage', { trip: x }); };

async function saveTrip() {
  const t = buildTrip();
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(t.date)) { toast('Date must be DD/MM/YYYY', true); return; }
  if (t._stops.filter(Boolean).length < 2 && !(t.miles > 0)) { toast('Add where you went, or type the miles', true); return; }
  const offline = navigator.onLine === false;
  if (!(t.miles > 0) && !offline) { toast('Waiting for the miles: check the route, or type them', true); return; }
  const b = $('btnTripSave'); b.disabled = true; b.textContent = 'Saving…';
  try {
    if (offline) throw Object.assign(new Error('No signal'), { code: 'OFFLINE' });
    if (t.saleId && saleOut.some(o => o.id === t.saleId)) { b.textContent = 'Saving the sale first…'; await flushSales(true); }
    const r = await sendTrip(t);
    rememberTrip(t);
    toast('Trip saved: ' + r.miles + ' miles · ' + money(r.amount) + ' (' + r.rate + ')' + (t.saleRow || t.saleId ? ' · linked to the sale' : ''));
    if (t.labelIds || t.purchaseIds) {
      TRIPS = null;
      if (t.labelIds) dropSession({ mode: 'logged', place: t._stops[t._stops.length - 1] || '', tripText: 'Mileage row ' + r.row + ' · ' + r.miles + ' miles' });
      toast('Trip saved: ' + r.miles + ' miles · ' + money(r.amount) + ' · linked to ' + [t.labelIds ? t.labelIds.length + ' parcel' + (t.labelIds.length === 1 ? '' : 's') : '', t.purchaseIds ? 'the purchase' : ''].filter(Boolean).join(' and '));
      loadTrips().then(list => { if (list.length) openTrip(); else show('vHome'); }).catch(() => show('vHome'));
    }
    else if (t.collectId) { toast('Trip saved: ' + r.miles + ' miles · ' + money(r.amount) + ' · linked to the collection'); openSales('slCollWrap'); }
    else if (t.saleRow || t.saleId) { SALES = null; openSales(); } else show('vHome');
  } catch (err) {
    if (err.code === 'OFFLINE') {          // kept on the phone; sent (and the miles worked out) when signal returns
      t._routeStops = t.miles > 0 ? null : stopsForRoute();
      lsSet(LS_PENDING_TRIPS, lsList(LS_PENDING_TRIPS).concat([t]));
      rememberTripSafe(t);
      toast('No signal — trip saved on your phone. It goes to your Sheet when you\'re back online');
      refreshTrips();
      show('vHome');
    } else {
      toast(/Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for trips' : err.message, true);
    }
  }
  b.disabled = false; b.textContent = 'Save trip';
}
function rememberTripSafe(t) { if (t.miles > 0) rememberTrip(t); }

// Background: send trips saved without signal
let tripsTicking = false;
async function tripTick() {
  if (tripsTicking || navigator.onLine === false || !localStorage.getItem(LS_URL)) return;
  const list = lsList(LS_PENDING_TRIPS);
  if (!list.length) return;
  tripsTicking = true;
  const left = [];
  let sent = 0;
  for (const t of list) {
    try {
      if (!(t.miles > 0) && t._routeStops) {
        const r = await api('route', { stops: t._routeStops });
        t.miles = r.miles; t.link = r.link; t.source = 'Google Maps';
        t.from = r.places[0]; t.to = r.places[t.returnIncluded ? r.places.length - 2 : r.places.length - 1] || t.to;
        t._route = r;
      }
      await sendTrip(t);
      rememberTrip(t);
      sent++;
    } catch (err) {
      if (err.code === 'OFFLINE' || err.code === 'QUOTA_MAPS') left.push(t);
      else { left.push(Object.assign(t, { error: err.message })); }
    }
  }
  lsSet(LS_PENDING_TRIPS, left);
  tripsTicking = false;
  refreshTrips();
  if (sent) toast('🚗 ' + sent + ' trip' + (sent > 1 ? 's' : '') + ' saved to your Sheet');
}

function refreshTrips() {
  const n = lsList(LS_PENDING_TRIPS).length;
  $('btnTrip').innerHTML = '<span class="ico">' + TRIP_ICO + '</span> <span>Log a trip</span>' + (n ? ' <span class="count">' + n + '</span>' : '');
}

/* ---------- sales ---------- */
const ALL_PLATFORMS = ['eBay', 'Vinted', 'Amazon FBA', 'Amazon FBM', 'Depop', 'Etsy', 'Facebook Marketplace', 'In person', 'Other'];
const LS_WHERE = 'rs_where';
let SALES = null;            // last list from the Sheet
let sale = null;             // the sale open in the form: { row, saleId, needs, linked }

// What a flag means, in plain words
function plainNeeds(n) {
  return String(n).split(/;\s*|,\s*(?=add|sale price|match|check)/).filter(Boolean).map(x =>
    /^add postage cost/.test(x) ? 'Who paid for postage? Tap one below.' :
    /^sale price/.test(x) ? 'Add how much it sold for.' :
    /^match/.test(x) ? 'Which sale was this? Tap it below.' :
    /^check/.test(x) ? 'We guessed which sale this is. Check it is right, then tap Save.' : x).join(' ');
}

// Each flag on a sale: what happened, what to do, and where on the form to do it
function needsList(o) {
  const out = [], amt = num(o['refund amount']), item = o.item ? ' for “' + o.item + '”' : '';
  String(o.needs || '').split(/;\s*|,\s*(?=add|sale price|match|check)/).filter(Boolean).forEach(x => {
    if (/^add postage cost/.test(x)) out.push({ to: 'saPostWrap', focus: 'saPostOut',
      text: 'Add what you paid to post it. ' + (/^ebay/i.test(o.platform || '') ? 'eBay\'s emails never show the label price, so we couldn\'t fill it in.' : 'The email didn\'t say.') + ' Until you do, the profit on this sale looks higher than it really is.' });
    else if (/^sale price/.test(x)) out.push({ to: 'saPrice', focus: 'saPrice', text: 'The email didn\'t say what it sold for. Add the sale price.' });
    else if (/^match/.test(x)) { const c = /cancel/.test(x);
      out.push({ to: 'saMatch', text: (c ? 'A cancellation email came in' : 'A refund email came in' + (amt ? ' (' + money(amt) + ')' : '')) + item +
        ', but we couldn\'t tell which of your sales it belongs to. Pick the sale below so ' + (c ? 'it comes out of your totals.' : 'the refund comes off the right sale.') }); }
    else if (/^check: cancellation/.test(x)) out.push({ to: 'saStatus',
      text: 'We marked this sale cancelled because a cancellation email had the same item name (there was no order number to be sure). If that\'s right, tap Save. If not, tap the right status.' });
    else if (/^check/.test(x)) { const r = (x.match(/row (\d+)/) || [])[1];
      out.push({ to: 'saItem', dup: r || '?', text: 'A sale email came in that might be a copy of a sale you already have' + (r ? ' (row ' + r + ' in your Sheet)' : '') +
        '. If it\'s a different sale, check the details and tap Save. If it\'s the same sale, tap “It\'s a copy” so it isn\'t counted twice.' }); }
    else out.push({ to: null, text: x });
  });
  return out;
}
function needGo(n, noFocus) {
  const t = n && n.to && $(n.to); if (!t) return;
  const call = $('saNeedHere') || Object.assign(document.createElement('div'), { id: 'saNeedHere', className: 'needcall' });
  call.innerHTML = '⚠️ ' + esc(n.text) + (n.dup ? ' <button class="btn sec" id="btnIsCopy" type="button" style="margin-top:8px">It\'s a copy: don\'t count it</button>' : '');
  const anchor = n.to === 'saPrice' ? t.closest('.duo') : n.to === 'saStatus' ? t.previousElementSibling : n.to === 'saItem' ? t.previousElementSibling : t;
  anchor.parentNode.insertBefore(call, anchor);
  call.scrollIntoView({ behavior: 'smooth', block: 'start' });
  t.classList.add('hl'); setTimeout(() => t.classList.remove('hl'), 2500);
  if (n.focus && !noFocus) setTimeout(() => { try { $(n.focus).focus({ preventScroll: true }); } catch (e) {} }, 450);
}
document.addEventListener('click', e => {
  if (e.target.id !== 'btnIsCopy') return;
  segSet('saStatus', 'Cancelled'); $('saCounts').checked = false;
  const r = (sale.needs.match(/row (\d+)/) || [])[1];
  if (!/Copy of/.test($('saNotes').value)) $('saNotes').value = ($('saNotes').value ? $('saNotes').value + '. ' : '') + 'Copy of ' + (r ? 'row ' + r : 'another sale');
  saleCalc(); toast('Marked as a copy. Tap Save sale');
  $('btnSaleSave').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

function setSalesCount(w) {
  if (w) { CFG.waiting = w; saveCache(); }   // shown at once next time, before the server answers
  const n = w ? (w.needs || 0) + (w.toPost || 0) + (w.returnsSoon || 0) + (w.toCollect || 0) : 0;
  $('salesLabel').innerHTML = 'Sales &amp; postage' + (n ? ' <span class="count">' + n + '</span>' : '');
  renderTodo(w);
}

// Home screen: the few things that need doing today. Tap one to go to Sales.
function renderTodo(w) {
  w = w || {};
  const s = n => n === 1 ? '' : 's', rows = [];
  const today = (w.postToday || 0) - (w.late || 0);
  if (w.late) rows.push(['🔴', w.late + ' parcel' + s(w.late) + ' late. Post now', 'slPostWrap']);
  if (w.collectSoon) rows.push(['🔴', w.collectSoon + ' order' + s(w.collectSoon) + ' to collect: last day' + (w.collectSoon === 1 ? ' is' : 's are') + ' today or tomorrow', 'slCollWrap']);
  else if (w.toCollect) rows.push(['🛍️', w.toCollect + ' order' + s(w.toCollect) + ' ready to collect', 'slCollWrap']);
  if (w.toPost) rows.push(['📦', w.toPost + ' parcel' + s(w.toPost) + ' to post' + (today > 0 ? ' (' + today + ' today)' : ''), 'slPostWrap']);
  if (w.pickupSoon) rows.push(['🚚', w.pickupSoon + ' return pick-up' + s(w.pickupSoon) + ' today or tomorrow: print the label and pack it', 'slToRetWrap']);
  if (w.toReturn) rows.push(['↩️', w.toReturn + ' thing' + s(w.toReturn) + ' to take back', 'slToRetWrap']);
  if (w.returnsSoon) rows.push(['⏳', w.returnsSoon + ' receipt' + s(w.returnsSoon) + ': last days to return', 'slRetWrap']);
  if (w.needs) rows.push(['⚠️', w.needs + ' sale' + s(w.needs) + ' need' + (w.needs === 1 ? 's' : '') + ' a check', 'slNeedsWrap']);
  if (w.tripsToLog) rows.push(['🚗', w.tripsToLog + ' trip' + s(w.tripsToLog) + ' to log in your mileage', 'trips']);
  $('todo').classList.toggle('hide', !rows.length);
  $('todo').innerHTML = rows.slice(0, 4).map(r => `<button data-todo="${r[2]}"><span>${r[0]}</span><span>${esc(r[1])}</span><span class="go">›</span></button>`).join('');
}
// Tapping a to-do opens Sales at that section
$('todo').onclick = e => { const b = e.target.closest('[data-todo]'); if (!b) return; if (b.dataset.todo === 'trips') openTrip(); else openSales(b.dataset.todo); };
function goTo(id) {
  const el = $(id);
  if (!el || el.classList.contains('hide')) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

// Counts from a loaded Sales screen, so home stays right after changes
function countsFrom(d) {
  const tp = d.toPost || [], tc = (d.toCollect || []).filter(c => c.status === 'To collect');
  return { needs: (d.needs || []).length, toPost: tp.length, postToday: tp.filter(l => l.daysLeft !== null && l.daysLeft <= 0).length,
           late: tp.filter(l => l.daysLeft !== null && l.daysLeft < 0).length, returnsSoon: (d.returnsClosing || []).length,
           toReturn: ((d.returns && d.returns.open) || []).filter(r => r.status === 'To return').length,
           pickupSoon: ((d.returns && d.returns.open) || []).filter(r => r.status === 'To return' && r.pickupDays !== null && r.pickupDays !== undefined && r.pickupDays <= 1).length,
           toCollect: tc.length, collectSoon: tc.filter(c => c.daysLeft !== null && c.daysLeft <= 1).length,
           tripsToLog: TRIPS ? TRIPS.length : ((CFG.waiting || {}).tripsToLog || 0) };
}
// "Post today" / "Late" / "Post by Thu"
function postTag(l) {
  if (l.daysLeft === null || l.daysLeft === undefined) return l.postBy ? '<span class="tag">post by ' + esc(l.postBy) + '</span>' : '';
  if (l.daysLeft < 0) return '<span class="tag late">Late: post now</span>';
  if (l.daysLeft === 0) return '<span class="tag late">Post today</span>';
  if (l.daysLeft === 1) return '<span class="tag soon">Post tomorrow</span>';
  const dd = toDate(l.postBy);
  return '<span class="tag ' + (l.daysLeft <= 2 ? 'soon' : '') + '">post by ' + esc(dd ? dd.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : l.postBy) + '</span>';
}
function toDate(t) { const m = String(t || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? new Date(+m[3], m[2] - 1, +m[1]) : null; }

const tagFor = st => st === 'Cancelled' || st === 'Refunded' ? 'no' : st === 'Completed' ? 'ok' : st === 'Part refunded' ? 'warn' : '';
const num = v => v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v);

const LS_SALES = 'rs_sales';
async function openSales(target) {
  show('vSales');
  if (!SALES) { try { SALES = JSON.parse(localStorage.getItem(LS_SALES)); } catch (e) {} }   // last copy, shown at once
  if (SALES) { renderSales(); if (target) setTimeout(() => goTo(target), 50); } else $('slRecent').innerHTML = '<p class="sub">Loading…</p>';
  const first = !SALES;
  try {
    SALES = await api('sales', {});
    try { localStorage.setItem(LS_SALES, JSON.stringify(SALES)); } catch (e) {}
    const y = window.scrollY;
    renderSales();
    if (target && first) setTimeout(() => goTo(target), 50); else window.scrollTo(0, y);   // don't jump while you're reading
  } catch (err) {
    if (SALES) return;   // the saved copy is already on screen
    $('slRecent').innerHTML = '<p class="sub">' + esc(err.code === 'OFFLINE' ? 'No signal: sales load when you\'re back online.'
      : /Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for sales.' : err.message) + '</p>';
  }
}

// eBay business accounts: buyers can change their mind for 14 days after it arrives
function returnTag(o) {
  const until = toDate(o.returnsUntil), today = toDate(SALES && SALES.today) || new Date();
  if (!until || until < today) return '';
  return '<span class="tag soon">buyer can return till ' + esc(dayName(o.returnsUntil)) + '</span>';
}

// Sales card shortcut: straight to the eBay order; when you come back, the sale opens at the postage box
function ebayOrderNo(ord) {
  const d = String(ord || '').replace(/\D/g, '');
  return d.length === 12 ? d.slice(0, 2) + '-' + d.slice(2, 7) + '-' + d.slice(7) : '';
}
function ebayOrderUrl(ord, item) {
  ord = ebayOrderNo(ord);
  if (ord) return 'https://www.ebay.co.uk/mesh/ord/details?mode=SH&orderid=' + ord;
  const w = String(item || '').replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
  return 'https://www.ebay.co.uk/sh/ord/?filter=status:ALL_ORDERS' + (w ? '&search=itemtitle:' + encodeURIComponent(w) : '');
}
let ebayBack = null;
document.addEventListener('click', e => {
  const a = e.target.closest('[data-ebaygo]'); if (!a) return;
  e.stopPropagation();   // follow the link; don't open the sale underneath yet
  const [list, i] = a.dataset.ebaygo.split(':'), d = SALES || {};
  const o = (list === 'rec' ? d.recent : list === 'need' ? d.needs : (d[list] || []))[+i];
  ebayBack = o ? { o, at: Date.now() } : null;
}, true);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !ebayBack || Date.now() - ebayBack.at > 30 * 60000) return;
  const o = ebayBack.o; ebayBack = null;
  openSale(o);
  if (!segGet('saPostBy')) { segSet('saPostBy', 'Seller'); try { saleWhereToggle(); postHint(); } catch (e) {} }
  try { ebayHelp(); } catch (e) {}
  setTimeout(() => { $('saPostOut').scrollIntoView({ block: 'center' }); $('saPostOut').focus(); }, 300);
  toast('Type the label price from eBay');
});

function saleCard(o, i, list) {
  const price = num(o['sale price']), net = num(o['net received']), profit = num(o.profit);
  const bits = [esc(o.platform || ''), esc(o['sale date'] || '')].filter(Boolean).join(' · ');
  return `<div class="card scard" data-${list}="${i}"><div class="sb">
    <div class="st">${esc(o.item || o['order number'] || 'Sale')}</div>
    <div class="sm">${bits}${o['order number'] ? ' · #' + esc(o['order number']) : ''}</div>
    <div class="sm">${o._saving ? '<span class="tag saving">' + (navigator.onLine === false ? 'Waiting for signal' : 'Saving…') + '</span>' : ''}<span class="tag ${tagFor(o.status)}">${esc(o.status || 'Sold')}</span>${o['counts in totals'] === 'No' ? '<span class="tag">not in totals</span>' : ''}
      ${profit !== null ? '<span class="tag ok">profit ' + money(profit) + '</span>' : ''}${o.needs ? '<span class="tag warn">' + esc(/postage/.test(o.needs) ? 'add postage' : /match/.test(o.needs) ? 'pick the sale' : /check/.test(o.needs) ? 'check match' : o.needs) + '</span>' : ''}${returnTag(o)}</div>
    ${/postage/.test(o.needs || '') && /^ebay/i.test(o.platform || '') && !o._saving ? `<div class="ouacts"><a href="${esc(ebayOrderUrl(o['order number'], o.item))}" target="_blank" rel="noopener" data-ebaygo="${list}:${i}">${ebayOrderNo(o['order number']) ? 'Open order on eBay ↗' : 'Find in eBay orders ↗'}</a><span class="sub" style="align-self:center;font-size:13px">label price is under "What you earned"</span></div>` : ''}
  </div><div class="amt">${price !== null ? money(price) : net !== null ? money(net) : '—'}</div></div>`;
}

const LS_POSTED = 'rs_posted_out';
var postedOut = lsList(LS_POSTED), postedFlushing = false, postedHeld = new Set();   // held = in the 5-second Undo window
async function flushPosted() {
  if (postedFlushing || !postedOut.length) return;
  postedFlushing = true;
  for (const id of postedOut.slice()) {
    try { await api('labelDone', Object.assign({ id }, postedTrip()[id] || {})); postedOut = postedOut.filter(x => x !== id); lsSet(LS_POSTED, postedOut); const pt = postedTrip(); delete pt[id]; lsSet(LS_POSTED_TRIP, pt); }
    catch (err) {
      if (err.code === 'OFFLINE') break;
      postedOut = postedOut.filter(x => x !== id); lsSet(LS_POSTED, postedOut);
      toast('Couldn\'t mark a parcel as posted: ' + err.message, true); SALES = null;
    }
  }
  postedFlushing = false;
}
setInterval(flushPosted, 30000);

function renderSales() {
  const d = SALES || { needs: [], recent: [], toPost: [] };
  if ((postedOut.length || postedHeld.size) && d.toPost) d.toPost = d.toPost.filter(l => postedOut.indexOf(l.id) < 0 && !postedHeld.has(l.id));   // tapped Posted, still sending
  // A courier's drop-off receipt the old script filed as a label (16 Nov): not something to post. The update files it as the drop-off.
  if (d.toPost) d.toPost = d.toPost.filter(l => !(!l.files && !l.link && !l.order && /^(your )?digital receipt$|drop-?off receipt|proof of postage/i.test(String(l.item || '').trim())));
  setSalesCount(countsFrom(d));
  $('slPostWrap').classList.toggle('hide', !d.toPost.length);
  $('slPost').innerHTML = d.toPost.map((l, i) => `<div class="card scard"><div class="sb">
    <div class="st">${l.qty > 1 ? '<span class="qtybadge">' + l.qty + ' ×</span> ' : ''}${esc(l.item || 'Postage label')}</div>
    ${l.qty > 1 ? `<div class="qtynote">📦 ${l.qty} items go in this parcel</div>` : ''}
    <div class="sm">${[l.platform, l.courier, l.order ? '#' + l.order : ''].filter(Boolean).map(esc).join(' · ')}</div>
    <div class="tags">${postTag(l)}</div>
    <div class="duo" style="margin-top:8px"><button class="btn" data-lab="${i}">${l.files ? 'Show QR code' : 'Open label'}</button>
      <button class="btn sec" data-posted="${i}">✓ Posted</button></div></div></div>`).join('');
  if (d.toPost.length) setTimeout(() => prefetchLabels(d.toPost), 300);   // codes ready before you tap
  renderCollect();
  $('slNeedsWrap').classList.toggle('hide', !d.needs.length);
  $('slNeeds').innerHTML = d.needs.map((o, i) => saleCard(o, i, 'need')).join('');
  const waiting = saleOut.map(o => o.req.sale), editing = new Set(saleOut.map(o => o.row).filter(Boolean));
  const pend = waiting.map((o, i) => saleCard(Object.assign({}, o, { _saving: true }), i, 'pend')).join('');
  const rec = d.recent.filter(o => !editing.has(o.row));
  $('slRecent').innerHTML = (rec.length || pend) ? pend + rec.map(o => saleCard(o, d.recent.indexOf(o), 'rec')).join('')
    : '<p class="sub">No sales yet. Forward a sale email, or tap ＋ Log a sale.</p>';
  renderReturns(d);
  renderReporting(d);
  renderStock(d);
  if (d.backOn) {   // an email came in from a platform that was off
    toast(d.backOn + ' is back on. You sent a ' + d.backOn + ' email.');
    api('sellerSet', { seenBackOn: true }).catch(() => {});
    d.backOn = '';
  }
}

// Things going back to the shop (the Returns tab): last day, QR code, returned, refund proof.
function renderToReturn(d) {
  const R = d.returns || { open: [], done: [] };
  const open = R.open || [], done = (R.done || []).filter(x => x.status === 'Refunded' || x.status === 'Sorted');
  $('slToRetWrap').classList.toggle('hide', !open.length && !done.length);
  if (open.length) setTimeout(() => prefetchReturnCodes(open), 400);   // the code opens with no signal at the counter
  const lastDay = r => r.daysLeft === null ? '' : r.daysLeft < 0 ? '<span class="tag late">Past the last day (' + esc(dayName(r.returnBy)) + '): ask the shop</span>'
    : '<span class="tag ' + (r.daysLeft <= 2 ? 'late' : r.daysLeft <= 7 ? 'soon' : '') + '">' + (r.daysLeft === 0 ? 'Last day today' : 'Last day ' + esc(dayName(r.returnBy))) + '</span>';
  $('slToRet').innerHTML = open.map((r, i) => `<div class="card scard"><div class="sb">
    <div class="st">${esc(r.item)}${r.qty > 1 ? ' <span class="sm">×' + r.qty + '</span>' : ''}</div>
    <div class="sm">${[esc(r.store), r.bought ? 'bought ' + esc(r.bought) : '', r.amount ? money(r.amount) : '', r.order ? '#' + esc(r.order) : '', r.from && r.from !== 'Receipts' ? 'from ' + esc(r.from) : ''].filter(Boolean).join(' · ')}</div>
    <div class="tags">${r.status === 'Sent back' ? '<span class="tag">Returned ' + esc(dayName(r.sentOn)) + ': waiting for the refund</span>' : lastDay(r)}${r.returnBy ? `<span class="tag">${r.extended ? '🎄 Extended return date' : r.online ? '🌐 Online: 14 days' : '🏬 Shop: often 28–30 days'}</span>` : ''}${r.files || r.link ? '<span class="tag">QR code saved</span>' : ''}</div>
    ${r.notes ? '<div class="sm" style="margin-top:4px">' + esc(r.notes) + '</div>' : ''}
    ${pickupHtml(r, i)}
    ${r.files || r.link ? `<button class="btn" data-rqr="${i}" style="margin-top:10px">Show return QR code</button>` : ''}
    <div class="duo" style="margin-top:8px">${r.status === 'To return' ? `<button class="btn ${r.files || r.link ? 'sec' : ''}" data-rsent="${i}">${r.method === 'Pick-up' ? '✓ Picked up' : '✓ Returned it'}</button>` : `<button class="btn sec" data-rsorted="${i}">Already sorted</button>`}
      <button class="btn ${r.status === 'Sent back' ? '' : 'sec'}" data-rscan="${i}">📷 Refund receipt</button></div>
    ${r.email ? `<a class="link" href="${esc(r.email.split('\n')[0])}" target="_blank" rel="noopener" style="margin-top:8px;display:inline-block">Open the return email</a>` : ''}
    ${r.status === 'To return' ? `<button class="link" data-rcancel="${i}" style="margin-top:8px">${r.links && r.links.cancel ? '✕ Cancel this return' : '↩︎ Not returning it after all'}</button>` : ''}</div></div>`).join('')
    + (done.length ? `<details class="more"><summary>Returned recently (${done.length})</summary>${done.map(r => `<div class="rdone">✅ ${esc(r.item)} · ${r.status === 'Refunded' ? money(r.refundAmount) + ' back ' + esc(dayName(r.refundedOn)) : 'sorted'}${r.proof ? `<a href="${esc(r.proof.split('\n')[0])}" target="_blank" rel="noopener">refund proof</a>` : ''}</div>`).join('')}</details>` : '');
}

// Pick-up returns (a courier collects it): the day with a countdown, print the label, how to pack,
// the shop's own buttons (reschedule, change method, cancel), and the order's details to copy into the shop's page.
function pickupTag(r) {
  if (!r.pickupDate) return '';
  const d = r.pickupDays, when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : d < 0 ? 'was ' + dayName(r.pickupDate) : dayName(r.pickupDate) + ' (in ' + d + ' days)';
  return `<span class="tag ${d !== null && d <= 0 ? 'late' : d === 1 ? 'soon' : ''}">🚚 ${esc(r.courier || 'Courier')} pick-up ${esc(when)}${r.pickupWindow ? ' · ' + esc(r.pickupWindow) : ''}</span>`;
}
function copyRows(r) {
  const rows = [['Order number', r.order], ['Item', r.item], ['Quantity', r.qty], ['Price paid', r.each ? money(r.each) + (r.qty > 1 ? ' each' : '') : r.amount ? money(r.amount) : ''],
    ['Bought on', r.bought], ['Shop', r.store], ['Reason', r.reason], ['Email used for the order', r.orderEmail], ['Paid with', r.payment],
    ['Estimated refund', r.refundEstimate ? money(r.refundEstimate) : ''], ['Pick-up from', r.pickupFrom]].filter(x => x[1] !== '' && x[1] !== undefined && x[1] !== null);
  return rows.map(([k, v]) => `<div class="cprow"><span class="sm">${esc(k)}</span><b>${esc(v)}</b><button type="button" class="cpbtn" data-copy="${esc(v)}" aria-label="Copy ${esc(k)}">📋</button></div>`).join('');
}
function pickupHtml(r, i) {
  const L = r.links || {}, has = r.method || Object.keys(L).length || r.pickupDate;
  if (!has || r.status !== 'To return') return r.order || r.item ? `<details class="more cpbox"><summary>📋 Order details to copy</summary>${copyRows(r)}</details>` : '';
  const link = (k, label) => L[k] ? `<a class="link" href="${esc(L[k])}" target="_blank" rel="noopener">${label}</a>` : '';
  return `<div class="pkbox">
    <div class="tags">${pickupTag(r)}${r.method && r.method !== 'Pick-up' ? '<span class="tag">📍 ' + esc(r.method) + '</span>' : ''}${r.refundEstimate ? '<span class="tag ok">About ' + money(r.refundEstimate) + ' back</span>' : ''}</div>
    ${r.pickupFrom ? `<div class="sm">📍 Collected from ${esc(r.pickupFrom)}</div>` : ''}
    <ol class="pksteps">
      <li class="${r.printedOn ? 'done' : ''}"><b>Print the label</b>${!r.labelNeeded ? '<span class="sm"> (the email says the driver can bring one)</span>' : ''}
        <div class="pkrow">${L.print ? `<a class="btn sec sm2" href="${esc(L.print)}" target="_blank" rel="noopener" data-rprint="${i}">🖨 Print label</a>` : ''}
        ${r.printedOn ? '<span class="tag ok">Printed ' + esc(dayName(r.printedOn)) + '</span>' : `<button class="btn sec sm2" data-rprinted="${i}">✓ Printed</button>`}</div></li>
      <li><b>Pack it</b>${r.instructions && r.instructions.length ? `<details><summary class="sm">How to pack it (${r.instructions.length})</summary><ul class="sm">${r.instructions.map(x => '<li>' + esc(x) + '</li>').join('')}</ul></details>` : ''}</li>
      <li><b>${r.method === 'Pick-up' ? 'Hand it to the driver' : 'Send it back'}</b>, then tap <b>${r.method === 'Pick-up' ? '✓ Picked up' : '✓ Returned it'}</b> below</li>
    </ol>
    <div class="pklinks">${L.reschedule ? `<button class="link" data-rresched="${i}">📅 Reschedule</button>` : ''}${link('change', '🔁 Change return method')}${link('share', '📤 Share label')}${link('manage', 'Return page')}
      ${r.pickupDate ? `<button class="link" data-rcal="${i}">⏰ Remind me</button>` : ''}</div>
    <details class="more cpbox"><summary>📋 Order details to copy</summary>${copyRows(r)}</details>
  </div>`;
}
const RET_OPEN = () => (SALES && SALES.returns && SALES.returns.open) || [];
async function returnUpdate(r, ch) {
  const x = await api('returnUpdate', Object.assign({ id: r.id }, ch));
  Object.assign(r, x); renderToReturn(SALES); try { localStorage.setItem(LS_SALES, JSON.stringify(SALES)); } catch (e) {}
  return x;
}
function confirmSheet(title, body, yes, no, onYes) {
  const v = sheet(`<h3>${title}</h3>${body}<button class="btn" data-y="1">${yes}</button><button class="btn ghost" data-close="1">${no}</button>`);
  v.querySelector('.sheet').addEventListener('click', e => { if (e.target.dataset.y) { v.remove(); onYes(); } });
  return v;
}
function returnReschedule(r) {
  confirmSheet('Reschedule the pick-up?', `<p>${esc(r.item)}${r.pickupDate ? ' · now ' + esc(dayName(r.pickupDate)) : ''}</p><p class="hint">This opens ${esc(r.store || 'the shop')}'s page to pick a new day. Then come back and put the new day in.</p>`,
    'Yes, open the reschedule page', 'No, keep this day', () => {
      window.open(r.links.reschedule, '_blank', 'noopener');
      const v = sheet(`<h3>New pick-up day</h3><p class="hint">Picked a new day on ${esc(r.store || 'the shop')}'s page? Put it here so the countdown is right.</p>
        <input id="rsDate" type="date"><button class="btn" data-s="1">Save the new day</button><button class="btn ghost" data-close="1">Skip</button>`);
      v.querySelector('.sheet').addEventListener('click', async e => {
        if (!e.target.dataset.s) return;
        const val = v.querySelector('#rsDate').value; if (!val) { toast('Pick the day', true); return; }
        const [y, m, d] = val.split('-');
        v.remove();
        try { await returnUpdate(r, { pickupDate: d + '/' + m + '/' + y }); toast('Pick-up moved to ' + dayName(d + '/' + m + '/' + y)); } catch (err) { toast(err.message, true); }
      });
    });
}
function returnCancelFlow(r) {
  if (!(r.links && r.links.cancel)) {   // nothing booked with the shop: just stop the return here
    return confirmSheet('Not returning it after all?', `<p>${esc(r.item)}</p><p class="hint">It goes back on your reminders as if you never decided.</p>`, 'Yes, keep it', 'No, still returning it', async () => {
      try { await api('returnCancel', { id: r.id }); SALES = null; await openSales('slToRetWrap'); toast('OK, keeping it'); } catch (err) { toast(err.message, true); }
    });
  }
  confirmSheet('Cancel this return?', `<p>${esc(r.item)}${r.order ? ' · order ' + esc(r.order) : ''}</p>
    <p class="hint">First cancel it with ${esc(r.store || 'the shop')}: this opens their cancel page. When their page says it's cancelled, come back and tap <b>It's cancelled</b>. If their "return cancelled" email arrives first, it's done for you.</p>`,
    'Yes, open the cancel page', 'No, keep the return', () => {
      window.open(r.links.cancel, '_blank', 'noopener');
      confirmSheet('Is it cancelled?', `<p class="hint">Only tap this once ${esc(r.store || 'the shop')} shows the return as cancelled.</p>`, '✓ It\'s cancelled', 'Not yet', async () => {
        try { await returnUpdate(r, { cancelled: true }); SALES = null; await openSales('slToRetWrap'); toast('Return cancelled and logged in your Sheet'); } catch (err) { toast(err.message, true); }
      });
    });
}

// The return's QR code / label, kept on the phone like postage labels (key "r:<id>").
async function fetchReturnCode(r) {
  const f = await api('returnFiles', { id: r.id });
  const images = f.images.slice();
  if (!images.length) for (const p of f.pdfs) if (p.data) { try { images.push(await pdfToPng(p.data)); } catch (e) {} }
  const o = { id: 'r:' + r.id, images, pdfs: f.pdfs.map(p => ({ url: p.url || p })), link: f.link, email: f.email, saved: Date.now() };
  if (images.length) labPut(o);
  return o;
}
let retPrefetching = false;
async function prefetchReturnCodes(open) {
  if (retPrefetching || !navigator.onLine) return;
  retPrefetching = true;
  try {
    const want = new Set(open.map(r => 'r:' + r.id));
    (await labKeys()).forEach(k => { if (String(k).startsWith('r:') && !want.has(k)) labDel(k); });
    for (const r of open) if (r.files && r.status === 'To return' && !(await labGet('r:' + r.id))) { try { await fetchReturnCode(r); } catch (e) {} }
  } finally { retPrefetching = false; }
}
async function showReturnCode(r) {
  const veil = document.createElement('div');
  veil.className = 'veil';
  veil.innerHTML = `<div class="sheet"><h3>${esc(r.item)}</h3><p class="sub">Loading…</p></div>`;
  veil.onclick = e => { if (e.target === veil || e.target.dataset.close) veil.remove(); };
  document.body.appendChild(veil);
  try {
    const cached = await labGet('r:' + r.id);
    const f = cached || await fetchReturnCode(r);
    veil.querySelector('.sheet').innerHTML = `<button class="close" data-close="1" aria-label="Close">✕</button><h3>Return: ${esc(r.item)}</h3>
      <p class="hint">Show this at ${esc(r.store || 'the shop')} or the drop-off point. Turn your screen brightness up.${cached ? ' Saved on this phone, so it works with no signal.' : ''}</p>
      <p class="sub">${[r.order ? '#' + r.order : '', r.returnBy ? 'last day ' + dayName(r.returnBy) : ''].filter(Boolean).map(esc).join(' · ')}</p>
      ${f.images.map(src => `<img class="qrimg" src="${src}" alt="Return QR code">`).join('')}
      ${f.pdfs.map(p => `<a class="btn sec" href="${esc(p.url || p)}" target="_blank" rel="noopener">Open the return label</a>`).join('')}
      ${f.link ? `<a class="btn sec" href="${esc(f.link)}" target="_blank" rel="noopener">Open the shop's return page</a>` : ''}
      ${!f.images.length && !f.pdfs.length && !f.link ? '<p class="sub">No code was in the email. Open it in your email app.</p>' : ''}
      <button class="btn ghost" data-close="1">Close</button>`;
  } catch (err) {
    veil.querySelector('.sheet').innerHTML = '<p class="sub">' + esc(err.message) + '</p><button class="btn ghost" data-close="1">Close</button>';
  }
}

// Sister apps (only if set in Settings): FlipCheck says whether a resale buy is worth keeping.
const fcUrl = () => (CFG.apps && CFG.apps.flipcheck) || '';
function renderAppSwitch() {
  const a = CFG.apps || {}, el = $('appSw');
  const links = [a.flipcheck ? `<a href="${esc(a.flipcheck)}/#/purchases" target="_blank" rel="noopener">FlipCheck</a>` : '',
                 a.fliplist ? `<a href="${esc(a.fliplist)}/list/" target="_blank" rel="noopener">ListMe</a>` : ''].filter(Boolean);
  el.classList.toggle('hide', !links.length);
  el.innerHTML = links.length ? '<a aria-current="page" style="background:#1d3a5f;color:#fff">Receipts</a>' + links.join('') : '';
}
function worthItLink(rows) {
  if (!fcUrl() || !rows.some(r => /resale|stock|resell/i.test(r.purpose || '') && Number(r['total cost']) > 0)) return;
  $('homeStatus').insertAdjacentHTML('beforeend', ` · <a href="${esc(fcUrl())}/#/purchases" target="_blank" rel="noopener">Worth it? Check in FlipCheck</a>`);
}

function renderReturns(d) {
  renderToReturn(d);
  const r = d.returnsClosing || [];   // one card per receipt (same shop and date)
  $('slRetWrap').classList.toggle('hide', !r.length);
  $('slRet').innerHTML = r.map((g, i) => {
    const one = g.items.length === 1, it = g.items[0];
    const title = one ? esc(it.item) + (it.left > 1 ? ' <span class="sm">×' + it.left + '</span>' : '') : esc(g.store || 'Receipt') + ' · ' + g.items.length + ' things';
    return `<div class="card scard" data-g="${i}"><div class="sb">
    <div class="st">${title}</div>
    <div class="sm">${one ? esc(g.store) + ' · ' : ''}bought ${esc(g.date)} · ${money(g.total)}</div>
    <div class="tags"><span class="tag ${g.daysLeft <= 2 ? 'late' : 'soon'}">${g.daysLeft === 0 ? 'Last day today' : 'Last day ' + esc(dayName(g.lastDay))}</span><span class="tag">${g.extended ? '🎄 Extended return date' : g.online ? '🌐 Online: 14 days' : '🏬 Shop: often 28–30 days'}</span>${fcUrl() && one ? `<a class="tag fctag" href="${esc(fcUrl())}/#/purchases/r${it.row}" target="_blank" rel="noopener">Worth keeping? FlipCheck ›</a>` : ''}</div>
    ${one ? '' : `<details class="picks"><summary>Pick which to return (${g.items.length})</summary>
      <button class="selall" data-all="${i}">☑︎ Select all</button>
      <div class="ritems">${g.items.map((x, j) => `<label class="ritem"><input type="checkbox" data-pick="${i}:${j}"><span>${esc(x.item)}${x.left > 1 ? ' ×' + x.left : ''}</span><span class="sm">${money(x.each * x.left)}</span></label>`).join('')}</div></details>`}
    <div class="duo" style="margin-top:10px"><button class="btn sec" data-keep="${i}">${one ? 'Keep it' : 'Keep them all'}</button>
      <button class="btn" data-ret="${i}" ${one ? '' : 'disabled'}>${one ? 'I\'ll return it' : 'Return ticked'}</button></div></div></div>`;
  }).join('');
  const w = d.returnsWaiting || [];
  $('slWaitWrap').classList.toggle('hide', !w.length);
  $('slWait').innerHTML = w.map((g, i) => `<div class="card scard"><div class="sb">
    <div class="st">${g.items.length === 1 ? esc(g.items[0].item) : esc(g.store) + ' · ' + g.items.length + ' things'}</div>
    <div class="sm">${esc(g.store)} · bought ${esc(g.date)} · ${money(g.total)} to come back</div>
    <div class="duo" style="margin-top:10px"><button class="btn" data-scanref="${i}">📷 Scan refund receipt</button>
      <button class="btn sec" data-done="${i}">Already sorted</button></div>
    <button class="link" data-undo="${i}" style="margin-top:8px">↩︎ Undo: I'm not returning ${g.items.length === 1 ? 'it' : 'these'}</button></div></div>`).join('');
}
function pickChanged(gi) {
  const n = [...document.querySelectorAll('[data-pick^="' + gi + ':"]')].filter(b => b.checked).length;
  const b = document.querySelector('[data-ret="' + gi + '"]');
  if (b) { b.disabled = !n; b.textContent = n ? 'Return ' + n + ' ticked' : 'Return ticked'; }
}
const dayName = t => { const d = toDate(t); return d ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : t; };

function renderReporting(d) {
  const r = d.reporting || [];
  $('slRep').classList.toggle('hide', !r.length);
  $('slRepList').innerHTML = r.map(x => `<div style="padding:8px 0"><div class="srow" style="border:0;padding:0">
      <b>${esc(x.platform)}</b><span class="sm">${x.sales} of 30 sales · ${money(x.value)} of £1,700</span></div>
    <div class="bar2"><i class="${x.status}" style="width:${x.pct}%"></i></div>
    <div class="sm">${x.status === 'reported' ? 'This site will tell HMRC about your sales this year.' : x.status === 'close' ? 'Nearly there. This site may tell HMRC soon.' : 'Under the limits this year.'}</div></div>`).join('');
}

function renderStock(d) {
  const s = d.stock || { count: 0, items: [] };
  $('slStockSum').textContent = 'Stock' + (s.count ? ' · ' + s.count + ' line' + (s.count === 1 ? '' : 's') + (s.value ? ' · ' + money(s.value) : '') : '');
}

/* ---------- Stock page: what's left, searchable; tap to log its sale ---------- */
let STOCK = null;
async function loadStock() {
  if (!STOCK) { try { STOCK = JSON.parse(localStorage.getItem('rs_stock')); } catch (e) {} }
  try { STOCK = await api('stock', {}); try { localStorage.setItem('rs_stock', JSON.stringify(STOCK)); } catch (e) {} }
  catch (err) { if (!STOCK) throw err; }
  return STOCK;
}
async function openStock() {
  show('vStock');
  if (STOCK) renderStockPage(); else $('skList').innerHTML = '<p class="sub">Loading…</p>';
  try { await loadStock(); renderStockPage(); loadStockMatches(); }
  catch (err) { $('skList').innerHTML = '<p class="sub">' + esc(/Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for this.' : err.message) + '</p>'; }
}
function renderStockPage() {
  const d = STOCK || { items: [] }, q = $('skSearch').value.trim().toLowerCase(), by = segGet('skSort') || 'old';
  $('skLines').textContent = d.lines || 0; $('skUnits').textContent = d.units || 0; $('skValue').textContent = money(d.value || 0);
  let list = d.items.filter(x => !q || (x.item + ' ' + x.store).toLowerCase().includes(q));
  list = list.slice().sort(by === 'value' ? (a, b) => b.left * b.each - a.left * a.each : by === 'az' ? (a, b) => a.item.localeCompare(b.item) : (a, b) => b.days - a.days);
  // Ageing stock: cash sitting on the shelf. A nudge, not a rule
  const old = d.items.filter(x => x.days >= 60 && x.decision !== 'return'), tied = old.reduce((t, x) => t + x.left * x.each, 0);
  $('skAge').classList.toggle('hide', !old.length);
  $('skAge').innerHTML = old.length ? '<b>' + money(tied) + ' is tied up in ' + old.length + ' item' + (old.length === 1 ? '' : 's') + ' you\'ve had over 2 months.</b> ' +
    'A small price drop often gets things moving, and turns that money back into stock that sells.' : '';
  const tip = x => x.decision === 'return' ? '' : x.days >= 90 ? '<span class="tip">Over 3 months: try a price drop or a bundle to free up the cash</span>'
    : x.days >= 60 ? '<span class="tip">Over 2 months: a small price drop could get it moving</span>' : '';
  $('skList').innerHTML = list.length ? list.slice(0, 200).map(x => `<button class="skrow" data-sk="${x.row}"><span>${esc(x.item)}<span class="sm">${esc(x.store)} · ${x.left} of ${x.qty} left · ${money(x.each)} each${x.decision === 'return' || x.returning ? ' · returning' : ''}${fcUrl() && !x.returning ? `<span class="mtag fctag" data-skfc="${x.row}">🔍 Worth it?</span>` : ''}${STOCK_MATCH[x.item] ? `<span class="mtag" data-skm="${esc(x.item)}">👥 ${STOCK_MATCH[x.item].buyers.length} interested</span>` : ''}</span>${tip(x)}</span>
      <span class="tag ${x.days >= 90 ? 'late' : x.days >= 45 ? 'soon' : ''}" style="align-self:center">${x.days}d</span></button>`).join('')
    : '<p class="sub" style="padding:10px 0">' + (q ? 'Nothing matches.' : 'No stock to sell. Things you buy with a resale purpose show here.') + '</p>';
}
$('skSearch').oninput = renderStockPage;
$('skSort').onclick = e => { const b = e.target.closest('button'); if (b) { segSet('skSort', b.dataset.v); renderStockPage(); } };
$('skList').onclick = e => {
  const fc = e.target.closest('[data-skfc]');
  if (fc) { e.stopPropagation(); window.open(fcUrl() + '/#/purchases/r' + fc.dataset.skfc, '_blank', 'noopener'); return; }
  const m = e.target.closest('[data-skm]');
  if (m && STOCK_MATCH[m.dataset.skm]) { e.stopPropagation(); $('vStock').dataset.fromMatch = '1'; openMatch([STOCK_MATCH[m.dataset.skm]]); return; }
  const b = e.target.closest('[data-sk]');
  if (!b) return;
  const x = STOCK.items.find(i => String(i.row) === b.dataset.sk);
  openSale(null); linkPurchase(x);
};
$('slStock').onclick = openStock;
$('btnStockBack').onclick = () => openSales();

// Link a sale to a purchase row (from the suggestions, the stock page or the purchase search)
function linkPurchase(x) {
  if (!x) return;
  $('saItem').value = x.item;
  try { autoInts(); } catch (e) {}
  sale.linked = 'Purchases row ' + x.row + ': ' + x.item;
  sale.itemCost = Number(x.each !== undefined ? x.each : x.cost) * (Number($('saQty').value) || 1);
  sale.linkEach = Number(x.each !== undefined ? x.each : x.cost);
  $('saLinked').textContent = 'Linked: ' + x.item + ' (' + x.store + ', ' + x.date + ') · cost ' + money(sale.itemCost) + (x.left !== undefined ? ' · ' + x.left + ' left before this sale' : '');
  $('saLinked').classList.remove('hide');
  $('saSuggest').classList.add('hide');
  saleCalc();
}

// "What did you sell?": suggestions from your stock as you type (no server call per key)
$('saItem').addEventListener('input', () => {
  const q = $('saItem').value.trim().toLowerCase();
  if (sale && sale.linked && !q.includes(String(sale.linked).split(': ')[1].toLowerCase().slice(0, 4))) { sale.linked = ''; sale.itemCost = null; $('saLinked').classList.add('hide'); }
  const words = q.split(/\s+/).filter(w => w.length > 1);
  const hits = q.length < 2 || !STOCK ? [] : STOCK.items.filter(x => words.every(w => (x.item + ' ' + x.store).toLowerCase().includes(w))).slice(0, 6);
  $('saSuggest').classList.toggle('hide', !hits.length);
  $('saSuggest').innerHTML = hits.map(x => `<button data-sg="${x.row}"><b>${esc(x.item)}</b><span class="sm">${esc(x.store)} · ${esc(x.date)} · ${x.left} left · ${money(x.each)} each</span></button>`).join('');
});
$('saSuggest').onclick = e => { const b = e.target.closest('[data-sg]'); if (b) linkPurchase(STOCK.items.find(i => String(i.row) === b.dataset.sg)); };

let SETTINGS = null;   // Settings screen data
function renderWhere() {
  const d = SETTINGS || SALES || {};
  const all = d.allPlatforms || ALL_PLATFORMS.filter(p => p !== 'Other'), on = d.platforms || CFG.platforms || [];
  $('slPlats').innerHTML = all.map(p => `<div class="prow"><span>${esc(p)}${/^Amazon/.test(p) ? ' <span class="sm">(not in totals)</span>' : ''}</span>
    <button class="tgl ${on.indexOf(p) > -1 ? 'on' : ''}" data-plat="${esc(p)}">${on.indexOf(p) > -1 ? 'On' : 'Off'}</button></div>`).join('');
  const ebayOn = on.indexOf('eBay') > -1;
  $('slEbayWrap').classList.toggle('hide', !ebayOn);
  segSet('slEbay', d.ebayAccount || '');
  $('slEbayHint').textContent = !d.ebayAccount ? 'Pick one. The app works with one eBay account.'
    : d.ebayAccount === 'private' && (d.business || d.type) === 'ltd' ? '⚠️ You sell as a company. eBay wants companies to use a business account.'
    : d.ebayAccount === 'private' ? 'Buyers pay eBay\'s Buyer Protection fee. It is not your money, so it is not in your sales.'
    : 'You pay eBay fees on each sale. Buyers can send things back within 14 days.';
}

$('slPlats').onclick = async e => {
  const b = e.target.closest('[data-plat]');
  if (!b) return;
  const p = b.dataset.plat, on = !b.classList.contains('on');
  b.disabled = true;
  try {
    const r = await api('sellerSet', { platform: p, on });
    CFG.platforms = r.platforms; if (SALES) SALES.platforms = r.platforms; if (SETTINGS) SETTINGS.platforms = r.platforms; saveCache(); renderWhere();
    toast(on ? p + ' is on' : p + ' is off. Old sales stay. A ' + p + ' email turns it back on.');
  } catch (err) { b.disabled = false; toast(/Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for this.' : err.message, true); }
};
$('slEbay').addEventListener('click', () => setTimeout(async () => {
  const v = segGet('slEbay');
  const d = SETTINGS || SALES || {};
  if (!v || v === d.ebayAccount) return;
  try { const r = await api('sellerSet', { ebayAccount: v }); d.ebayAccount = r.ebayAccount; if (SALES) SALES.ebayAccount = r.ebayAccount; renderWhere(); toast('Saved'); }
  catch (err) { toast(err.message, true); }
}, 0));

$('vSales').addEventListener('click', async e => {
  const t = e.target, card = t.closest('[data-need],[data-rec]');
  if (t.dataset.lab !== undefined) return showLabel(SALES.toPost[Number(t.dataset.lab)]);
  const RO = (SALES && SALES.returns && SALES.returns.open) || [];
  if (t.dataset.rqr !== undefined) return showReturnCode(RO[Number(t.dataset.rqr)]);
  if (t.dataset.rscan !== undefined) { RETURN_FOR = RO[Number(t.dataset.rscan)].id; pages = []; job = null; lastSource = 'cam'; $('inpCam').click(); return; }
  if (t.dataset.copy !== undefined) { try { await navigator.clipboard.writeText(t.dataset.copy); toast('Copied: ' + t.dataset.copy.slice(0, 40)); } catch (err) { toast('Couldn\'t copy: press and hold it instead', true); } return; }
  if (t.dataset.rprinted !== undefined) { const r = RO[+t.dataset.rprinted]; t.disabled = true; try { await returnUpdate(r, { printed: true }); toast('Label printed ✓'); } catch (err) { t.disabled = false; toast(err.message, true); } return; }
  if (t.dataset.rresched !== undefined) return returnReschedule(RO[+t.dataset.rresched]);
  if (t.dataset.rcal !== undefined) { const r = RO[+t.dataset.rcal], d = toDate(r.pickupDate); if (d) { d.setHours(8, 30, 0, 0); addToCalendar({ start: d.toISOString(), mins: 60, summary: (r.courier || 'Courier') + ' pick-up: ' + r.item, alarm: 'Pick-up today: label on, parcel by the door', spot: r.pickupFrom }); toast('Reminder added for ' + dayName(r.pickupDate)); } return; }
  if (t.dataset.rcancel !== undefined) return returnCancelFlow(RO[+t.dataset.rcancel]);
  if (t.dataset.rsent !== undefined || t.dataset.rcancel !== undefined || t.dataset.rsorted !== undefined) {
    const r = RO[Number(t.dataset.rsent ?? t.dataset.rcancel ?? t.dataset.rsorted)];
    const act = t.dataset.rsent !== undefined ? 'returnSent' : t.dataset.rcancel !== undefined ? 'returnCancel' : 'returnSorted';
    if (act === 'returnSent' && !confirm(r.method === 'Pick-up' ? 'Has ' + (r.courier || 'the courier') + ' picked up "' + r.item + '"?' : 'Handed "' + r.item + '" back or dropped it off?')) return;
    t.disabled = true;
    try {
      await api(act, { id: r.id });
      SALES = null; await openSales('slToRetWrap');
      toast(act === 'returnSent' ? (r.method === 'Pick-up' ? 'Marked picked up. ' : 'Marked returned. ') + 'Scan the refund receipt or forward the refund email when it comes.' : act === 'returnCancel' ? 'OK, keeping it' : 'Ticked off');
    } catch (err) { t.disabled = false; toast(/Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for this.' : err.message, true); }
    return;
  }
  if (t.dataset.all !== undefined) {   // select all / none
    const boxes = [...document.querySelectorAll('[data-pick^="' + t.dataset.all + ':"]')], on = boxes.some(b => !b.checked);
    boxes.forEach(b => { b.checked = on; });
    t.textContent = on ? '☐ Select none' : '☑︎ Select all';
    pickChanged(t.dataset.all);
    return;
  }
  if (t.dataset.pick !== undefined) { pickChanged(t.dataset.pick.split(':')[0]); return; }
  if (t.dataset.keep !== undefined || t.dataset.ret !== undefined) {
    const gi = t.dataset.keep ?? t.dataset.ret, g = SALES.returnsClosing[Number(gi)];
    const picked = g.items.length === 1 ? (t.dataset.ret !== undefined ? [0] : [])
      : t.dataset.keep !== undefined ? [] : [...document.querySelectorAll('[data-pick^="' + gi + ':"]')].filter(b => b.checked).map(b => Number(b.dataset.pick.split(':')[1]));
    const ref = x => ({ row: x.row, item: x.item });
    const ret = g.items.filter((x, j) => picked.indexOf(j) > -1), keep = g.items.filter((x, j) => picked.indexOf(j) < 0);
    t.disabled = true;
    try {
      await api('returnDecide', { keep: keep.map(ref), ret: ret.map(ref) });
      SALES.returnsClosing = SALES.returnsClosing.filter(y => y !== g);
      if (ret.length) (SALES.returnsWaiting = SALES.returnsWaiting || []).unshift(Object.assign({}, g, { items: ret, total: Math.round(ret.reduce((s, x) => s + x.each * x.left, 0) * 100) / 100 }));
      g.items.forEach(x => { const st = SALES.stock && SALES.stock.items.find(y => y.row === x.row); if (st) st.decision = ret.indexOf(x) > -1 ? 'return' : 'keep'; });
      renderSales();
      toast(!ret.length ? 'OK. We won\'t remind you again.' : 'OK. When you get the refund, scan it or forward the email.');
    } catch (err) { t.disabled = false; toast(/Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for this.' : err.message, true); }
    return;
  }
  if (t.dataset.scanref !== undefined) { pages = []; job = null; lastSource = 'cam'; $('inpCam').click(); return; }   // the refund is matched when you save it
  if (t.dataset.undo !== undefined) {   // changed your mind: back to "last days to return"
    const g = SALES.returnsWaiting[Number(t.dataset.undo)];
    t.disabled = true;
    try { await api('returnDecide', { items: g.items.map(x => ({ row: x.row, item: x.item })), choice: 'undo' }); SALES = null; toast('Undone'); openSales(); }
    catch (err) { t.disabled = false; toast(err.message, true); }
    return;
  }
  if (t.dataset.done !== undefined) {
    const g = SALES.returnsWaiting[Number(t.dataset.done)];
    t.disabled = true;
    try {
      await api('returnDecide', { items: g.items.map(x => ({ row: x.row, item: x.item })), choice: 'done' });
      SALES.returnsWaiting = SALES.returnsWaiting.filter(y => y !== g); renderSales(); toast('Ticked off');
    } catch (err) { t.disabled = false; toast(err.message, true); }
    return;
  }
  if (t.dataset.posted !== undefined) {   // instant: off the list now, saved in the background (kept on the phone if no signal)
    const l = SALES.toPost[Number(t.dataset.posted)];
    if (!l) return;
    postedHeld.add(l.id);
    SALES.toPost = SALES.toPost.filter(x => x.id !== l.id);
    renderSales();
    let tripSheet = null;
    undoBar('✓ Marked as posted', UNDO_SECS,
      () => { postedHeld.delete(l.id); SALES.toPost = SALES.toPost.concat([l]); renderSales(); toast('Back on your list'); if (tripSheet) tripSheet.remove(); delete postedTrip()[l.id]; },
      () => { postedHeld.delete(l.id); postedOut = postedOut.filter(x => x !== l.id).concat([l.id]); lsSet(LS_POSTED, postedOut); labDel(l.id); flushPosted(); });
    tripSheet = offerDropTrip(l);
    return;
  }
  if (card) openSale(card.dataset.need !== undefined ? SALES.needs[Number(card.dataset.need)] : SALES.recent[Number(card.dataset.rec)]);
});

/* ---------- To collect: click & collect orders ---------- */
function collectTitle(c) {
  const it = c.items || [];
  return it.length === 1 ? it[0].qty + ' × ' + it[0].name : it.length ? (c.qty || it.length) + ' items from ' + (c.retailer || c.store) : 'Order ' + (c.order || '') + (c.retailer ? ' from ' + c.retailer : '');
}
function collectTag(c) {
  if (c.status === 'Collected') return '<span class="tag ok">Collected ' + esc(c.collectedOn || '') + '</span>';
  if (c.daysLeft === null || c.daysLeft === undefined) return c.collectBy ? '<span class="tag">collect by ' + esc(c.collectBy) + '</span>' : '';
  if (c.daysLeft < 0) return '<span class="tag late">Collection date passed</span>';
  if (c.daysLeft === 0) return '<span class="tag late">Last day: collect today</span>';
  if (c.daysLeft === 1) return '<span class="tag late">Collect by tomorrow</span>';
  const dd = toDate(c.collectBy);
  return '<span class="tag ' + (c.daysLeft <= 3 ? 'soon' : '') + '">collect by ' + esc(dd ? dd.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : c.collectBy) + ' · ' + c.daysLeft + ' days</span>';
}
function renderCollect() {
  const list = (SALES && SALES.toCollect) || [];
  $('slCollWrap').classList.toggle('hide', !list.length);
  $('slColl').innerHTML = list.map((c, i) => `<div class="card scard" data-cview="${i}"><div class="sb">
    <div class="st">${c.qty > 1 ? '<span class="qtybadge">' + c.qty + ' ×</span> ' : ''}${esc(c.items && c.items.length === 1 ? c.items[0].name : collectTitle(c))}</div>
    <div class="sm">📍 ${esc([c.store || c.retailer, c.order ? '#' + c.order : ''].filter(Boolean).join(' · '))}</div>
    ${c.total ? `<div class="sm">${money(c.total)}${c.qty > 1 && c.items.length === 1 ? ' · ' + money(c.items[0].each) + ' each' : ''}${c.purpose ? ' · for ' + esc(c.purpose) : ''}</div>` : ''}
    <div class="tags">${collectTag(c)}</div>
    ${c.status === 'Collected' ? `<div class="duo" style="margin-top:8px">${c.mileage ? '<span class="sub">🚗 trip logged</span>' : `<button class="btn sec" data-ctrip="${i}">🚗 Log the trip</button>`}
      ${c.receipt ? '<span class="sub">🧾 receipt saved</span>' : `<button class="btn sec" data-crec="${i}">🧾 Add receipt</button>`}</div>`
    : `<div class="duo" style="margin-top:8px"><button class="btn" data-cview="${i}">Details &amp; code</button><button class="btn sec" data-cdone="${i}">✓ Collected</button></div>`}
  </div></div>`).join('');
}
$('slColl').onclick = e => {
  const t = e.target.closest('[data-cview],[data-cdone],[data-ctrip],[data-crec]'); if (!t) return;
  const L = SALES.toCollect, d = t.dataset;
  if (d.cdone !== undefined) return collectDone(L[+d.cdone]);
  if (d.ctrip !== undefined) return collectTrip(L[+d.ctrip]);
  if (d.crec !== undefined) return collectReceipt(L[+d.crec]);
  showCollect(L[+d.cview]);
};

// Code 128 barcode drawn from the order number (the email's own barcode image doesn't survive forwarding)
const C128 = '11011001100,11001101100,11001100110,10010011000,10010001100,10001001100,10011001000,10011000100,10001100100,11001001000,11001000100,11000100100,10110011100,10011011100,10011001110,10111001100,10011101100,10011100110,11001110010,11001011100,11001001110,11011100100,11001110100,11101101110,11101001100,11100101100,11100100110,11101100100,11100110100,11100110010,11011011000,11011000110,11000110110,10100011000,10001011000,10001000110,10110001000,10001101000,10001100010,11010001000,11000101000,11000100010,10110111000,10110001110,10001101110,10111011000,10111000110,10001110110,11101110110,11010001110,11000101110,11011101000,11011100010,11011101110,11101011000,11101000110,11100010110,11101101000,11101100010,11100011010,11101111010,11001000010,11110001010,10100110000,10100001100,10010110000,10010000110,10000101100,10000100110,10110010000,10110000100,10011010000,10011000010,10000110100,10000110010,11000010010,11001010000,11110111010,11000010100,10001111010,10100111100,10010111100,10010011110,10111100100,10011110100,10011110010,11110100100,11110010100,11110010010,11011011110,11011110110,11110110110,10101111000,10100011110,10001011110,10111101000,10111100010,11110101000,11110100010,10111011110,10111101110,11101011110,11110101110,11010000100,11010010000,11010011100'.split(',');
function barcodeSvg(text) {
  text = String(text || '').trim(); if (!text) return '';
  const digits = /^\d+$/.test(text) && text.length % 2 === 0;
  const vals = digits ? [105].concat(text.match(/\d\d/g).map(Number)) : [104].concat([...text].map(ch => ch.charCodeAt(0) - 32).filter(v => v >= 0 && v < 95));
  const chk = vals.reduce((s, v, i) => s + v * (i || 1), 0) % 103;
  const bits = vals.concat([chk]).map(v => C128[v]).join('') + '1100011101011';
  const q = 10, w = bits.length + q * 2;
  let x = q, rects = '';
  for (const b of bits) { if (b === '1') rects += `<rect x="${x}" y="0" width="1" height="60"/>`; x++; }
  return `<svg class="barcode" viewBox="0 0 ${w} 60" preserveAspectRatio="none" role="img" aria-label="Barcode ${esc(text)}"><rect width="${w}" height="60" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
const DAYS3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function hoursHtml(c) {
  const q = encodeURIComponent([c.store || c.retailer, c.address].filter(Boolean).join(' ') + ' opening times');
  if (!c.hours || !c.hours.length) return `<a class="btn sec" href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">🕘 Find opening times ↗</a>`;
  const today = DAYS3[new Date().getDay()];
  return '<div class="hours">' + c.hours.map(h => { const d = h.slice(0, 3); return `<div class="${d === today ? 'today' : ''}"><span>${d === today ? 'Today' : d}</span><span>${esc(h.slice(4))}</span></div>`; }).join('') + '</div>';
}
function collectSheetHtml(c) {
  const maps = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent([c.store, c.address].filter(Boolean).join(', '));
  return `<button class="close" data-close="1" aria-label="Close">✕</button>
    <h3>${esc(collectTitle(c))}</h3>
    ${c.qty ? `<div class="qtynote big">📦 Collect ${c.qty} item${c.qty === 1 ? '' : 's'}${c.items && c.items.length > 1 ? ' (' + c.items.length + ' products)' : ''}. Check you get them all.</div>` : ''}
    <div class="tags" style="margin-bottom:8px">${collectTag(c)}</div>
    ${(c.items || []).map(x => `<div class="crow"><b>${x.qty} × ${esc(x.name)}</b><br><span class="sub">${money(x.each)} each · ${money(x.total)}</span></div>`).join('')}
    <p class="sub">${c.total ? 'Total ' + money(c.total) : ''}${c.purpose ? ' · for ' + esc(c.purpose) : ''}${c.order ? ' · order ' + esc(c.order) : ''}</p>
    ${!c.inSheet && c.order ? '<p class="hint">This order isn\'t in your Sheet yet. Its email is waiting in Emailed receipts to check and save.</p>' : ''}
    <h4 class="sech">Where</h4>
    <p><b>${esc(c.store || c.retailer || '')}</b>${c.address ? '<br>' + esc(c.address) : ''}</p>
    <div class="duo"><a class="btn sec" href="${maps}" target="_blank" rel="noopener">🧭 Directions</a><button class="btn sec" data-cal="1">📅 Remind me</button></div>
    <h4 class="sech">Opening times</h4>${hoursHtml(c)}
    ${c.status === 'To collect' ? `<h4 class="sech">Show at the counter</h4>
    ${c.order ? barcodeSvg(c.order) + `<p class="ordbig">${esc(c.order)}</p><p class="hint">Barcode made from your order number. If it won't scan, read the number out or type it at the kiosk.</p>` : ''}
    ${c.link ? '<a class="btn ghost" href="' + esc(c.link) + '" target="_blank" rel="noopener">Open the original email</a>' : ''}
    <button class="btn" data-cdone2="1">✓ Collected</button>
    <button class="btn ghost danger" data-ccancel="1">Cancel collection</button>` : ''}`;
}
function sheet(html) {
  const veil = document.createElement('div');
  veil.className = 'veil';
  veil.innerHTML = '<div class="sheet">' + html + '</div>';
  veil.onclick = e => { if (e.target === veil || e.target.dataset.close) veil.remove(); };
  document.body.appendChild(veil);
  return veil;
}
function showCollect(c) {
  const v = sheet(collectSheetHtml(c));
  v.querySelector('.sheet').addEventListener('click', e => {
    const d = e.target.dataset;
    if (d.cdone2) { v.remove(); collectDone(c); }
    else if (d.ccancel) { v.remove(); collectCancel(c); }
    else if (d.cal) collectReminder(c);
  });
}
function collectReminder(c) {
  const by = toDate(c.collectBy) || new Date(Date.now() + 864e5);
  const st = new Date(by); st.setDate(st.getDate() - 1); st.setHours(10, 0, 0, 0);
  if (st < new Date()) { st.setTime(Date.now() + 3600e3); }
  addToCalendar({ start: st.toISOString(), mins: 30, summary: 'Collect from ' + (c.retailer || c.store || 'the shop') + ': ' + collectTitle(c), alarm: 'Last day to collect is ' + dayName(c.collectBy), spot: c.store, addr: c.address });
  toast('Reminder added for ' + st.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }));
}
async function collectSet(c, status) {
  const r = await api('collectSet', { id: c.id, status });
  SALES.toCollect = r; try { localStorage.setItem(LS_SALES, JSON.stringify(SALES)); } catch (e) {}
  setSalesCount(countsFrom(SALES)); renderCollect();
  return r;
}
async function collectDone(c) {
  try { await collectSet(c, 'Collected'); }
  catch (err) { toast(/Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for collections' : err.message, true); return; }
  const now = (SALES.toCollect || []).find(x => x.id === c.id) || c;
  const v = sheet(`<h3>✓ Collected</h3><p class="sub">${esc(collectTitle(c))} is marked collected in your Sheet ("To collect" tab).</p>
    <button class="btn" data-t="1">🚗 Log the trip there and back</button>
    <button class="btn sec" data-r="1">🧾 Add the collection receipt</button>
    <button class="btn ghost" data-u="1">Undo</button><button class="btn ghost" data-close="1">Later</button>`);
  v.querySelector('.sheet').addEventListener('click', async e => {
    const d = e.target.dataset;
    if (d.t) { v.remove(); collectTrip(now); }
    else if (d.r) { v.remove(); collectReceipt(now); }
    else if (d.u) { v.remove(); try { await collectSet(c, 'To collect'); toast('Back on your list'); } catch (err) { toast(err.message, true); } }
  });
}
function collectCancel(c) {
  const v = sheet(`<h3>Cancel this collection?</h3><p>${esc(collectTitle(c))}${c.store ? ' at ' + esc(c.store) : ''}.</p>
    <p class="hint">This marks it Cancelled in your Sheet. It doesn't cancel the order with ${esc(c.retailer || 'the shop')}: do that with them if you need to.</p>
    <button class="btn danger" data-y="1">Yes, cancel it</button><button class="btn ghost" data-close="1">No, keep it</button>`);
  v.querySelector('.sheet').addEventListener('click', async e => {
    if (!e.target.dataset.y) return;
    v.remove();
    try { await collectSet(c, 'Cancelled'); toast('Collection cancelled and logged'); } catch (err) { toast(err.message, true); }
  });
}
function collectTrip(c) {
  openTrip({ collectId: c.id, date: c.collectedOn || today(), reason: 'Collected ' + (c.retailer ? c.retailer + ' ' : '') + 'order' + (c.order ? ' ' + c.order : '') + ': ' + collectTitle(c),
    to: c.address || c.store || '' });
}
function collectReceipt(c) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.setAttribute('capture', 'environment');
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    toast('Saving the receipt…');
    try {
      const img = await enhance(await readFile(f));
      const r = await api('collectReceipt', { id: c.id, image: img });
      SALES.toCollect = r.list; renderCollect();
      toast('🧾 Receipt saved to Drive and linked in your Sheet');
    } catch (err) { toast(err.message, true); }
  };
  inp.click();
}

// Full-screen QR code for the drop-off counter
/* Postage labels are kept on the phone (IndexedDB) once fetched, so the code opens at once and
   works with no signal at the counter. PDFs (Vinted) are turned into a picture once, so pdf.js is
   only loaded the first time. Fetching happens in the background when Sales opens. */
const labGet = id => dbDo('readonly', st => st.get(id), LABEL_STORE).catch(() => null);
const labPut = o => dbDo('readwrite', st => st.put(o), LABEL_STORE).catch(() => {});
const labDel = id => dbDo('readwrite', st => st.delete(id), LABEL_STORE).catch(() => {});
const labKeys = () => dbDo('readonly', st => st.getAllKeys(), LABEL_STORE).catch(() => []);

async function fetchLabel(l) {
  const f = await api('labelFile', { id: l.id });
  const images = f.images.slice();
  if (!images.length) for (const p of f.pdfs) if (p.data) { try { images.push(await pdfToPng(p.data)); } catch (e) {} }
  const o = { id: l.id, images, pdfs: f.pdfs.map(p => ({ url: p.url || p })), link: f.link, saved: Date.now() };
  if (images.length) labPut(o);   // only keep it once there's something to show
  return o;
}

let prefetching = false;
async function prefetchLabels(list) {
  if (prefetching || !navigator.onLine) return;
  prefetching = true;
  try {
    const want = new Set(list.map(l => l.id));
    (await labKeys()).forEach(k => { if (!want.has(k) && !String(k).startsWith('r:')) labDel(k); });   // posted or gone: free the space (return codes are tidied by prefetchReturnCodes)
    for (const l of list) if (l.files && !(await labGet(l.id))) { try { await fetchLabel(l); } catch (e) {} }   // one at a time, in the background
  } finally { prefetching = false; }
}

async function showLabel(l) {
  const veil = document.createElement('div');
  veil.className = 'veil';
  veil.innerHTML = `<div class="sheet"><h3>${l.qty > 1 ? l.qty + ' × ' : ''}${esc(l.item || 'Postage label')}</h3><p class="sub">Loading…</p></div>`;
  veil.onclick = e => { if (e.target === veil || e.target.dataset.close) veil.remove(); };
  document.body.appendChild(veil);
  try {
    const cached = await labGet(l.id);
    const f = cached || await fetchLabel(l);
    veil.querySelector('.sheet').innerHTML = `<button class="close" data-close="1" aria-label="Close">✕</button><h3>${l.qty > 1 ? l.qty + ' × ' : ''}${esc(l.item || 'Postage label')}</h3>
      ${l.qty > 1 ? `<div class="qtynote big">📦 Pack ${l.qty} items in this parcel. One code covers them all.</div>` : ''}
      <p class="hint">Show this code at the shop. Turn your screen brightness up.${cached ? ' Saved on this phone, so it works with no signal.' : ''}</p>
      <p class="sub">${[l.courier, l.order ? '#' + l.order : '', l.tracking ? 'tracking ' + l.tracking : ''].filter(Boolean).map(esc).join(' · ')}</p>
      ${f.images.map(src => `<img class="qrimg" src="${src}" alt="Postage QR code">`).join('')}
      ${f.pdfs.map(p => `<a class="btn sec" href="${esc(p.url || p)}" target="_blank" rel="noopener">Open the label PDF</a>`).join('')}
      ${f.link ? `<a class="btn sec" href="${esc(f.link)}" target="_blank" rel="noopener">Open in ${esc(l.platform || 'the app')}</a>` : ''}
      ${!f.images.length && !f.pdfs.length && !f.link ? '<p class="sub">This email had no code or label link. Open it in your email app.</p>' : ''}
      <button class="btn ghost" data-close="1">Close</button>`;
  } catch (err) {
    veil.querySelector('.sheet').innerHTML = '<p class="sub">' + esc(err.message) + '</p><button class="btn ghost" data-close="1">Close</button>';
  }
}

function segSet(id, v) { document.querySelectorAll('#' + id + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); }
function segGet(id) { const b = document.querySelector('#' + id + ' button.on'); return b ? b.dataset.v : ''; }
['saPay', 'saStatus', 'saPostBy', 'slEbay'].forEach(id => { $(id).onclick = e => { const b = e.target.closest('button'); if (b) { segSet(id, b.classList.contains('on') && (id === 'saPay' || id === 'saPostBy') ? '' : b.dataset.v); saleCalc(); if (id === 'saPay') cardToggle(); } }; });

function platformOptions(current) {
  const list = (CFG.platforms && CFG.platforms.length ? CFG.platforms : ALL_PLATFORMS).slice();   // turned-off platforms aren't offered
  if (list.indexOf('Other') < 0) list.push('Other');
  if (current && list.indexOf(current) < 0) list.unshift(current);
  return list.map(p => `<option ${p === current ? 'selected' : ''}>${esc(p)}</option>`).join('');
}

// How the buyer got it: only asked where it can be more than posting
const HAND = {
  'Facebook Marketplace': [['Posted', 'Posted', 'I sent it'], ['Collected', 'Collected', 'they came to me'], ['Delivered', 'I dropped it off', 'log the miles']],
  'In person': [['Collected', 'They came to me', 'or bought at my stall'], ['Delivered', 'I dropped it off', 'log the miles']]
};
function handToggle() {
  const hand = HAND[$('saPlatform').value];
  const del = !!hand && segGet('saHand') === 'Delivered';
  $('saDelWrap').classList.toggle('hide', !del);
  const done = !!(sale && sale.trip);
  $('saTripDone').classList.toggle('hide', !done);
  $('saTripDone').textContent = done ? '🚗 Trip logged: ' + sale.trip + '. It\'s in your mileage.' : '';
  $('saTripAsk').classList.toggle('hide', done);
  $('saDropWrap').classList.toggle('hide', !$('saLogTrip').checked);
  if (typeof crmToggle === 'function') crmToggle();
  try { ebayHelp(); } catch (e) {}
}
function saleWhereToggle() {
  const plat = $('saPlatform').value, inPerson = plat === 'In person', hand = HAND[plat];
  $('saWhereWrap').classList.toggle('hide', !inPerson);
  $('saPayWrap').classList.toggle('hide', !inPerson);
  $('saHandWrap').classList.toggle('hide', !hand);
  if (hand) {
    const cur = segGet('saHand') || (sale && sale.hand) || '';
    $('saHand').className = 'seg two';
    $('saHand').innerHTML = hand.map(h => `<button data-v="${h[0]}"><b>${h[1]}</b><small>${h[2]}</small></button>`).join('');
    segSet('saHand', hand.some(h => h[0] === cur) ? cur : '');
  }
  // Postage only when it was posted (in person never is; Marketplace only if you picked Posted; Amazon FBA posts its own)
  $('saPostWrap').classList.toggle('hide', inPerson || plat === 'Amazon FBA' || (plat === 'Facebook Marketplace' && segGet('saHand') !== 'Posted'));
  handToggle();
  // In person there's usually no order number: "n/a", which you can change
  if (inPerson && !$('saOrder').value.trim()) $('saOrder').value = 'n/a';
  if (!inPerson && /^n\/?a$/i.test($('saOrder').value.trim())) $('saOrder').value = '';
  cardToggle();
  postHint();
}

// Card reader: fee per tap + % of the sale, remembered for next time
function cardToggle() {
  const on = $('saPlatform').value === 'In person' && segGet('saPay') === 'Card reader';
  $('saCardWrap').classList.toggle('hide', !on);
  if (!on && sale && sale.autoFee && $('saFees').value === sale.autoFee) { $('saFees').value = ''; sale.autoFee = ''; saleCalc(); }   // no card, no card fee
  if (on && $('saTap').value === '' && $('saPct').value === '') {
    const f = CFG.cardFee || {};
    if (f.perTap) $('saTap').value = f.perTap;
    if (f.pct) $('saPct').value = f.pct;
  }
  cardCalc();
}
function cardCalc() {
  const on = !$('saCardWrap').classList.contains('hide');
  if (!on) return;
  const tap = Number($('saTap').value) || 0, pct = Number($('saPct').value) || 0, price = Number($('saPrice').value) || 0;
  const fee = Math.round((tap / 100 + price * pct / 100) * 100) / 100;
  if (tap || pct) { $('saFees').value = price ? fee.toFixed(2) : ''; if (sale) sale.autoFee = $('saFees').value; }
  $('saCardCalc').textContent = (tap || pct)
    ? 'Card fee ' + money(fee) + (tap ? ' (' + tap + 'p' + (pct ? ' + ' + pct + '%' : '') + ')' : ' (' + pct + '%)') + '. It goes in fees. HMRC still counts the full ' + money(price) + ' as your sales.'
    : 'Put in your card reader\'s fees. We save them for next time.';
  saleCalc();
}
['saTap', 'saPct'].forEach(id => { $(id).oninput = cardCalc; });

// Postage: who paid decides what comes off your money
// eBay never emails the label price. Link straight to the order (or a title search) on eBay, and offer
// the last price you paid for an eBay label as a one-tap fill.
const LS_POSTCOST = 'rs_postcost';
function ebayHelp() {
  const on = /^ebay/i.test($('saPlatform').value) && !$('saPostWrap').classList.contains('hide');
  $('saEbayWrap').classList.toggle('hide', !on);
  if (!on) return;
  const ord = $('saOrder').value.trim(), item = $('saItem').value.trim();
  const byOrder = !!ebayOrderNo(ord);
  const words = item.replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
  $('btnEbayFind').href = ebayOrderUrl(ord, item);
  $('btnEbayFind').textContent = byOrder ? 'Open order ' + ebayOrderNo(ord) + ' on eBay ↗' : words ? 'Find "' + words + '" in your eBay orders ↗' : 'Open your eBay orders ↗';
  let last = null; try { last = JSON.parse(localStorage.getItem(LS_POSTCOST) || 'null'); } catch (e) {}
  const show_ = !!(last && last.cost && !$('saPostOut').value);
  $('btnLastPost').classList.toggle('hide', !show_);
  if (show_) $('btnLastPost').textContent = 'Use ' + money(last.cost) + ' (your last eBay label' + (last.courier ? ', ' + last.courier : '') + ')';
}
$('btnLastPost').onclick = () => { let last = null; try { last = JSON.parse(localStorage.getItem(LS_POSTCOST)); } catch (e) {} if (last) { $('saPostOut').value = last.cost; $('saPostOut').dispatchEvent(new Event('input')); ebayHelp(); } };
['saOrder', 'saItem', 'saPostOut'].forEach(id => $(id).addEventListener('input', () => { try { ebayHelp(); } catch (e) {} }));

function postHint() {
  const plat = $('saPlatform').value, by = segGet('saPostBy');
  const vinted = plat === 'Vinted';
  const own = $('saOwn').checked;
  $('saPostBy').classList.toggle('hide', vinted);
  $('saOwnWrap').classList.toggle('hide', !own);
  // The buyer paid: it doesn't change what you made, so no amounts are needed (unless you used your own courier)
  const needCost = by === 'Seller' || own || vinted || (!by && !/^eBay/.test(plat));
  $('saPostOutWrap').classList.toggle('hide', !needCost);
  $('saPostOutLbl').textContent = by === 'Buyer' && own ? 'Extra you paid the courier (£, if any)' : vinted ? 'Extra you paid (£, if any)' : 'You paid to send it (£)';
  $('saPostHint').textContent = vinted ? 'On Vinted the buyer pays postage. Only add a cost if you paid extra.'
    : by === 'Buyer' ? 'The buyer paid. Nothing comes off your money, so nothing to add.'
    : by === 'Seller' ? 'Free postage comes out of your money. Put what it cost you to send it.'
    : /^eBay/.test(plat) ? 'eBay does not tell us who paid. Tap one.'
    : 'Tap who paid. Then put in what it cost you to send it.';
}
$('saPostBy').addEventListener('click', () => setTimeout(() => {
  $('saPostIn').value = '';   // the buyer's postage money isn't tracked: it cancels out the label
  if (segGet('saPostBy') === 'Buyer' && !$('saOwn').checked) $('saPostOut').value = '';
  postHint(); saleCalc();
}, 0));
$('saOwn').onchange = postHint;
$('saHand').onclick = e => { const b = e.target.closest('button'); if (!b) return; segSet('saHand', b.dataset.v); if (sale) sale.hand = b.dataset.v; saleWhereToggle(); saleCalc(); };
$('saLogTrip').onchange = handToggle;

function openSale(o) {
  o = o || {};
  const isNew = !o.row;
  sale = { row: o.row || null, saleId: o._sale_id || null, needs: o.needs || '', linked: o['linked purchase'] || '',
           hand: o.handover || '', trip: o['delivery trip'] || '' };
  $('saHand').innerHTML = ''; $('saLogTrip').checked = true; $('saDropTo').value = '';
  $('saTitle').textContent = isNew ? 'Log a sale' : 'Sale';
  const plat = o.platform || (CFG.platforms && CFG.platforms.indexOf('In person') > -1 ? 'In person' : (CFG.platforms && CFG.platforms[0]) || 'In person');
  $('saPlatform').innerHTML = platformOptions(plat);
  $('saWhere').value = o.where || '';
  $('whereList').innerHTML = lsList(LS_WHERE).map(w => `<option value="${esc(w)}">`).join('');
  $('saDate').value = o['sale date'] || today();
  $('saItem').value = o.item || '';
  $('saQty').value = o.quantity || 1;
  $('saPrice').value = num(o['sale price']) ?? '';
  $('saPostIn').value = num(o['postage charged']) ?? '';
  $('saFees').value = num(o['platform fees']) ?? '';
  $('saPostOut').value = num(o['postage cost']) ?? '';
  const pc = num(o['postage charged']);
  segSet('saPostBy', o['postage paid by'] || (pc > 0 ? 'Buyer' : pc === 0 && num(o['postage cost']) > 0 ? 'Seller' : ''));
  $('saOwn').checked = !!o.courier;
  $('saCourier').value = o.courier || '';
  $('saTrack').value = o.tracking || '';
  $('saTap').value = ''; $('saPct').value = '';
  $('saIns').value = num(o['insured for']) ?? '';
  $('saOther').value = num(o['other costs']) ?? '';
  $('saRefund').value = num(o['refund amount']) ?? '';
  $('saPayout').value = o['payout date'] || '';
  $('saOrder').value = o['order number'] || o['transaction id'] || '';
  $('saBuyer').value = o.buyer || '';
  $('saNotes').value = o.notes || '';
  crmFill(o);
  segSet('saPay', o['payment method'] || (isNew ? 'Cash' : ''));
  segSet('saStatus', o.status || (isNew ? 'Completed' : 'Sold'));
  $('saCounts').checked = o['counts in totals'] ? o['counts in totals'] === 'Yes' : !/^Amazon/.test(plat);
  $('saFind').value = ''; $('saFound').innerHTML = '';
  $('saFindStore').innerHTML = '<option value="">Any shop</option>' + (CFG.stores || []).map(x => `<option>${esc(x)}</option>`).join('');
  $('saLinked').classList.toggle('hide', !sale.linked);
  $('saLinked').textContent = sale.linked ? 'Linked: ' + sale.linked + (num(o['item cost']) !== null ? ' · cost ' + money(o['item cost']) : '') : '';
  sale.itemCost = num(o['item cost']);
  $('saMore').open = num(o['other costs']) > 0 || num(o['refund amount']) > 0;
  feesSum();
  const nl = needsList(o); sale.needList = nl;
  { const old = $('saNeedHere'); if (old) old.remove(); }
  $('saNeeds').classList.toggle('hide', !nl.length);
  $('saNeeds').innerHTML = nl.length ? '<b>This sale needs a check</b>' + nl.map((n, i) => `<button class="needgo" type="button" data-ng="${i}">⚠️ ${esc(n.text)}${n.to && n.to !== 'saMatch' ? ' <u>Take me there ›</u>' : ''}</button>`).join('') : '';
  sale.photo = null; $('saPhoto').classList.add('hide');
  $('btnSalePhoto').textContent = o['document link'] ? '📷 Replace the receipt photo' : '📷 Add a photo of the receipt';
  $('saMatch').classList.add('hide'); $('saMatch').innerHTML = '';
  if (/^match/.test(o.needs || '')) loadMatches(o);
  saleWhereToggle();
  saleCalc();
  show('vSale');
  // Opened from "Needs your input": go straight to the first thing to fix (the banner at the top says why)
  const first = nl.find(n => n.to && n.to !== 'saMatch');
  if (first) setTimeout(() => needGo(first, true), 350);
}
$('saNeeds').onclick = e => { const b = e.target.closest('[data-ng]'); if (b && sale && sale.needList) needGo(sale.needList[+b.dataset.ng]); };

// A cancellation or refund that couldn't be matched: pick the sale it belongs to
async function loadMatches(o) {
  try {
    const c = await api('saleCands', { row: o.row });
    $('saMatch').classList.remove('hide');
    const what = /cancel/.test(o.needs) ? 'cancelled' : 'refunded';
    $('saMatch').innerHTML = (c.length ? '<label>Is it one of these?</label>' + c.map(x =>
      `<button class="found" data-to="${x.row}"><b>${esc(x.item || '')}</b><br><span class="sm">${esc(x.platform || '')} · ${esc(x['sale date'] || '')}${num(x['sale price']) !== null ? ' · ' + money(x['sale price']) : ''}${x['order number'] ? ' · #' + esc(x['order number']) : ''}</span></button>`).join('')
      : `<div class="empty">We can't find the sale this was ${what} for. It was probably sold before you used the app. That's fine.</div>`) +
      `<button class="btn sec" id="btnOwnRow" style="margin-top:10px">${c.length ? 'None of these: keep it on its own' : 'OK, keep it on its own'}</button>`;
  } catch (err) { toast(err.message, true); }
}

$('saMatch').onclick = async e => {
  if (e.target.id === 'btnOwnRow') {   // nothing to match: keep the row (not counted) and clear the flag
    try { await api('saleSave', { sale: { needs: '' }, row: sale.row, saleId: sale.saleId }); SALES = null; toast('Done'); openSales(); }
    catch (err) { toast(err.message, true); }
    return;
  }
  const b = e.target.closest('[data-to]');
  if (!b || !confirm('Apply this ' + (/cancel/.test(sale.needs) ? 'cancellation' : 'refund') + ' to that sale?')) return;
  try { SALES = await api('saleMatch', { from: sale.row, to: Number(b.dataset.to) }); toast('Matched'); renderSales(); show('vSales'); }
  catch (err) { toast(err.message, true); }
};

let findTimer = null;
function findPurchases() {
  clearTimeout(findTimer);
  const q = $('saFind').value.trim(), store = $('saFindStore').value;
  if (q.length < 3 && !store) { $('saFound').innerHTML = ''; return; }
  findTimer = setTimeout(async () => {
    try {
      const r = await api('purchaseSearch', { q: q.length >= 3 ? q : '', store });
      $('saFound').innerHTML = r.length ? (store && !q ? '<p class="sub">Most recent from ' + esc(store) + ' first</p>' : '') + r.map(x => `<button class="found" data-pr="${x.row}" data-cost="${x.cost}" data-item="${esc(x.item)}">
        <b>${esc(x.item)}</b><br><span class="sm">${esc(x.store)} · ${esc(x.date)} · ${money(x.cost)} each${x.left !== undefined ? ' · ' + x.left + ' left' : ''}</span></button>`).join('')
        : '<p class="sub">' + (store ? 'Nothing from ' + esc(store) + (q ? ' matches that' : '') + '. Try another word or shop.' : 'No purchases match. Try another word, or pick the shop.') + '</p>';
    } catch (err) { $('saFound').innerHTML = '<p class="sub">' + esc(err.message) + '</p>'; }
  }, 350);
}
$('saFind').oninput = findPurchases;
$('saFindStore').onchange = findPurchases;
$('saFound').onclick = e => {
  const b = e.target.closest('[data-pr]');
  if (!b) return;
  sale.linked = 'Purchases row ' + b.dataset.pr + ': ' + b.dataset.item;
  sale.linkEach = Number(b.dataset.cost);
  sale.itemCost = sale.linkEach * (Number($('saQty').value) || 1);
  $('saLinked').textContent = 'Linked: ' + sale.linked + ' · cost ' + money(sale.itemCost);
  $('saLinked').classList.remove('hide');
  $('saFound').innerHTML = ''; $('saFind').value = ''; $('saFindStore').value = '';
  saleCalc();
};
$('saQty').addEventListener('input', () => { if (sale && sale.linkEach) { sale.itemCost = sale.linkEach * (Number($('saQty').value) || 1); saleCalc(); } });

function feesSum() {
  const p = [], v = id => num($(id).value);
  if (v('saFees') > 0) p.push('fees ' + money(v('saFees')));
  if (v('saOther') > 0) p.push('promoted/other ' + money(v('saOther')));
  if (v('saRefund') > 0) p.push('refunded ' + money(v('saRefund')));
  if ($('saPayout').value.trim()) p.push('paid out ' + $('saPayout').value.trim());
  $('saMoreSum').textContent = p.length ? '· ' + p.join(' · ') : '· tap to add';
}
['saFees', 'saOther', 'saRefund', 'saPayout'].forEach(id => $(id).addEventListener('input', feesSum));

function saleCalc() {
  const n = id => Number($(id).value) || 0;
  const price = $('saPrice').value === '' ? null : n('saPrice');
  if (price === null) { $('saCalc').textContent = ''; return; }
  const net = price + n('saPostIn') - n('saFees') - n('saPostOut') - n('saOther') - n('saRefund');
  $('saCalc').textContent = 'You keep ' + money(net) + (sale && sale.itemCost !== null && sale.itemCost !== undefined ? ' · profit ' + money(net - sale.itemCost) : '') +
    ($('saFees').value === '' && $('saPlatform').value !== 'In person' ? ' (fees not added yet)' : '');
}
['saPrice', 'saPostIn', 'saFees', 'saPostOut', 'saOther', 'saRefund', 'saQty'].forEach(id => { $(id).oninput = saleCalc; });
$('saPrice').addEventListener('input', cardCalc);
$('saPlatform').onchange = () => { saleWhereToggle(); if (!sale.row) $('saCounts').checked = !/^Amazon/.test($('saPlatform').value); saleCalc(); };

/* ---------- sales save in the background ----------
   Tap Save: you're back on Sales at once, the sale shows as "Saving…", and an Undo bar counts down 5 seconds.
   Only then is it sent. No signal or Google slow? It stays on the phone and is sent again by itself.
   Each new sale carries its own id, so sending it twice never makes two rows. */
const LS_SALE_OUT = 'rs_sale_outbox', UNDO_SECS = 5;
let saleOut = lsList(LS_SALE_OUT), saleFlushing = null, undoTimer = null;
const saleOutSave = () => {   // photos can be big: keep them in memory if the phone is out of room
  try { localStorage.setItem(LS_SALE_OUT, JSON.stringify(saleOut)); }
  catch (e) { lsSet(LS_SALE_OUT, saleOut.map(o => Object.assign({}, o, { req: Object.assign({}, o.req, { image: null }) }))); }
};
const newId = () => 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

function undoBar(text, secs, onUndo, onDone) {
  document.querySelectorAll('.undobar,.toast').forEach(x => x.remove());
  clearInterval(undoTimer);
  const bar = document.createElement('div'), C = 2 * Math.PI * 9;
  bar.className = 'undobar';
  bar.innerHTML = `<span>${esc(text)}</span><button>Undo <svg viewBox="0 0 22 22"><circle cx="11" cy="11" r="9" stroke-dasharray="${C}" stroke-dashoffset="0"/></svg></button>`;
  document.body.appendChild(bar);
  const ring = bar.querySelector('circle'), t0 = Date.now();
  const end = undone => { clearInterval(undoTimer); bar.remove(); undone ? onUndo() : onDone(); };
  undoTimer = setInterval(() => {
    const f = Math.min(1, (Date.now() - t0) / (secs * 1000));
    ring.setAttribute('stroke-dashoffset', String(C * f));
    if (f >= 1) end(false);
  }, 100);
  bar.querySelector('button').onclick = () => end(true);
}

function queueSale(req, label, hold) {
  const item = { id: req.clientId || ('e-' + req.row + '-' + Date.now()), req, label, row: req.row || null, holdUntil: hold ? Date.now() + hold : 0, tries: 0 };
  saleOut = saleOut.filter(o => !(o.row && o.row === item.row)).concat([item]);   // a newer edit of the same row replaces the older one
  saleOutSave();
  return item;
}
function unqueueSale(id) { saleOut = saleOut.filter(o => o.id !== id); saleOutSave(); }

// Sends what's waiting. Returns when done (trips wait for their sale this way).
function flushSales(force) {
  if (saleFlushing) return saleFlushing;
  saleFlushing = (async () => {
    await null;   // so saleFlushing is set before this can finish
    let changed = false;
    for (const o of saleOut.slice()) {
      if (!force && o.holdUntil > Date.now()) continue;
      try {
        const r = await api('saleSave', o.req) || {};
        unqueueSale(o.id); changed = true;
        if (o.onSaved) o.onSaved(r);
      } catch (err) {
        if (err.code === 'OFFLINE') break;   // try again when signal's back
        o.tries = (o.tries || 0) + 1;
        if (o.tries >= 3 || /moved in the Sheet|Add the item/.test(err.message)) {
          unqueueSale(o.id);
          toast('"' + o.label + '" wasn\'t saved: ' + err.message, true);
          changed = true;
        } else saleOutSave();
      }
    }
    if (changed) { SALES = null; if (!$('vSales').classList.contains('hide')) openSales(); }
  })().finally(() => { saleFlushing = null; });
  return saleFlushing;
}
setInterval(() => { if (saleOut.length) flushSales(); }, 30000);

async function saveSaleForm() {
  const date = $('saDate').value.trim(), payout = $('saPayout').value.trim();
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) { toast('Date must be DD/MM/YYYY', true); return; }
  if (payout && !/^\d{2}\/\d{2}\/\d{4}$/.test(payout)) { toast('Payout date must be DD/MM/YYYY', true); return; }
  if (!$('saItem').value.trim() && !$('saOrder').value.trim()) { toast('Add what you sold', true); return; }
  const v = id => $(id).value.trim();
  const s = {
    'sale date': date, platform: $('saPlatform').value, where: $('saPlatform').value === 'In person' ? v('saWhere') : '',
    item: v('saItem'), quantity: Number($('saQty').value) || 1,
    'sale price': v('saPrice'), 'postage charged': v('saPostIn'), 'platform fees': v('saFees'), 'postage cost': v('saPostOut'),
    'other costs': v('saOther'), 'refund amount': v('saRefund'), 'payout date': payout,
    'order number': v('saOrder'), buyer: v('saBuyer'), notes: v('saNotes'),
    'payment method': $('saPlatform').value === 'In person' ? segGet('saPay') : '',
    status: segGet('saStatus') || 'Sold', 'counts in totals': $('saCounts').checked ? 'Yes' : 'No',
    'linked purchase': sale.linked || '', 'item cost': sale.itemCost !== null && sale.itemCost !== undefined ? sale.itemCost : '',
    'postage paid by': $('saPostWrap').classList.contains('hide') ? '' : (segGet('saPostBy') || ''),
    courier: $('saOwn').checked ? v('saCourier') : '',
    tracking: $('saOwn').checked ? v('saTrack') : '',
    'insured for': v('saIns'),
    handover: $('saHandWrap').classList.contains('hide') ? '' : segGet('saHand'),
    // Saving it yourself clears the flag, except eBay postage while it's still blank
    needs: /^match/.test(sale.needs || '') ? sale.needs
      : /^eBay/.test($('saPlatform').value) && !segGet('saPostBy') && v('saPostOut') === '' && segGet('saStatus') !== 'Cancelled' ? 'add postage cost' : ''
  };
  if (s['sale price'] === '' && !/^Amazon/.test(s.platform) && s.status !== 'Cancelled') { toast('Add the sale price', true); return; }
  if (!$('saCardWrap').classList.contains('hide')) {   // remember the card reader's fees
    const f = { perTap: Number($('saTap').value) || 0, pct: Number($('saPct').value) || 0 }, c = CFG.cardFee || {};
    if (f.perTap !== (c.perTap || 0) || f.pct !== (c.pct || 0)) { CFG.cardFee = f; saveCache(); api('settingsSet', { settings: { cardFee: f } }).catch(() => {}); }
  }
  if (s.where) lsSet(LS_WHERE, [s.where].concat(lsList(LS_WHERE).filter(w => w !== s.where)).slice(0, 15));
  if (!sale.row && !sale.clientId) sale.clientId = newId();
  if (/^ebay/i.test(s.platform) && Number(s['postage cost']) > 0 && segGet('saPostBy') === 'Seller') { try { localStorage.setItem(LS_POSTCOST, JSON.stringify({ cost: Number(s['postage cost']), courier: s.courier || '' })); } catch (e) {} }
  const req = { sale: s, row: sale.row, saleId: sale.saleId, clientId: sale.row ? undefined : sale.clientId,
                image: sale.photo ? { base64: sale.photo.split(',')[1], mimeType: 'image/jpeg' } : null };
  const buyerInfo = crmPayload(s);
  if (buyerInfo) req.buyerInfo = buyerInfo;
  const label = s.item || s['order number'] || 'Sale';

  if (s.handover === 'Delivered' && !sale.trip && $('saLogTrip').checked) {   // straight on to the drop-off trip: send now, the trip waits for it
    queueSale(req, label, 0);
    flushSales();
    toast('Sale saved. Now check the trip miles');
    openTrip({ date: s['sale date'], reason: 'Delivered sale: ' + label, to: v('saDropTo'),
               saleRow: sale.row || null, saleId: sale.saleId || sale.clientId });
    return;
  }
  const item = queueSale(req, label, UNDO_SECS * 1000);
  const back = sale;
  openSales('slRecent');   // straight to the sale you just added
  undoBar(sale.row ? 'Changes saved' : 'Sale saved', UNDO_SECS,
    () => { unqueueSale(item.id); sale = back; show('vSale'); renderSales(); toast('Not saved. Change anything, then Save again'); },
    () => flushSales());
}

$('btnSales').onclick = openSales;
$('btnSlBack').onclick = () => show('vHome');
$('btnNewSale').onclick = () => { openSale(null); loadStock().catch(() => {}); };
$('btnSaBack').onclick = () => show('vSales');
$('btnSaleSave').onclick = saveSaleForm;
$('btnSalePhoto').onclick = () => $('inpSale').click();
$('inpSale').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { sale.photo = await enhance(await readFile(f)); $('saPhoto').src = sale.photo; $('saPhoto').classList.remove('hide'); $('btnSalePhoto').textContent = '📷 Retake the photo'; }
  catch (err) { toast('Couldn\'t open that photo', true); }
};

// Draws page 1 of a label PDF on screen (Vinted sends the QR code only as a PDF). pdf.js loads only when needed.
let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) pdfjsP = new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; resolve(window.pdfjsLib); };
    sc.onerror = () => { pdfjsP = null; reject(new Error('Could not load the PDF viewer')); };
    document.head.appendChild(sc);
  });
  return pdfjsP;
}
// Page 1 of a label PDF as a PNG picture, sharp enough for the shop's scanner
async function pdfToPng(base64) {
  const lib = await pdfjs();
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const page = await (await lib.getDocument({ data: bytes }).promise).getPage(1);
  const v1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: 1200 / v1.width });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  return c.toDataURL('image/png');
}

/* ---------- paying back personal spending ---------- */
function owedHtml(o) {
  if (o.owed != null) {
    return 'Still owed to the company this year<br><b>' + money(o.owed) + '</b><br>' +
      '<span class="usub">' + money(o.personal) + ' personal spending, less ' + money(o.repaid) + ' paid back' +
      (o.mileage ? ' and ' + money(o.mileage) + ' mileage the company owes you' : '') + '.</span>';
  }
  return 'Personal spending this year<br><b>' + money(o.personal) + '</b><br><span class="usub">' + money(o.repaid) +
    ' paid back into the business account. As a sole trader you don\'t have to pay this back: it just isn\'t claimed.</span>';
}

async function openRepay() {
  $('rDate').value = today(); $('rAmount').value = ''; $('rNote').value = '';
  try { const a = JSON.parse(localStorage.getItem('rcpt_repay_acc') || '{}'); $('rFrom').value = a.from || ''; $('rTo').value = a.to || ''; } catch (e) {}
  $('rOwed').textContent = 'Loading…';
  show('vRepay');
  try {
    const o = await api('owed', {});
    $('rOwed').innerHTML = owedHtml(o);
    if (o.owed) $('rAmount').value = o.owed.toFixed(2);
  } catch (err) {
    $('rOwed').textContent = err.code === 'OFFLINE' ? 'No signal: can\'t load what\'s owed right now.'
      : /Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for this.' : err.message;
  }
}

async function saveRepay() {
  const repayment = { date: $('rDate').value.trim(), amount: Number($('rAmount').value) || 0, note: $('rNote').value.trim(),
                      from: $('rFrom').value.trim(), to: $('rTo').value.trim() };
  try { localStorage.setItem('rcpt_repay_acc', JSON.stringify({ from: repayment.from, to: repayment.to })); } catch (e) {}
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(repayment.date)) { toast('Date must be DD/MM/YYYY', true); return; }
  if (!(repayment.amount > 0)) { toast('Enter the amount you paid back', true); return; }
  const b = $('btnRepaySave'); b.disabled = true; b.textContent = 'Saving…';
  try {
    const o = await api('repayment', { repayment });
    $('rOwed').innerHTML = owedHtml(o);
    toast('Repayment of ' + money(repayment.amount) + ' recorded');
    show('vHome');
  } catch (err) {
    toast(err.code === 'OFFLINE' ? 'No signal — not saved yet' : err.message, true);
  }
  b.disabled = false; b.textContent = 'Record repayment';
}

/* ---------- config cache ---------- */
function saveCache() { localStorage.setItem(LS_CACHE, JSON.stringify(CFG)); }

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_CACHE));
    if (c) CFG = Object.assign(CFG, c);
  } catch (e) {}
}

async function refreshConfig() {
  try {
    const d = await api('bootstrap', {});
    CFG.purposes = d.purposes || [];
    CFG.stores   = d.stores   || [];
    CFG.payments = d.payments || [];
    CFG.vat      = !!d.vat;
    CFG.business = d.business || '';
    CFG.platforms = d.platforms || [];
    CFG.cardFee = d.cardFee || CFG.cardFee || { perTap: 0, pct: 0 };
    CFG.crm = !!d.crm; try { crmSync(); renderHomeMatch(); } catch (e) {}
    CFG.apps = d.apps || CFG.apps || {}; renderAppSwitch();
    CFG.newReturns = 'apps' in d;   // the Sheet's script has the Returns update (whatsnew.js)
    setSalesCount(d.salesWaiting);
    saveCache(); fillStores(); fillPayPicker();
    setEmailCount(d.emails || 0);
    $('homeStatus').textContent = 'Ready · ' + CFG.purposes.length + ' purposes';
  } catch (e) {
    $('homeStatus').textContent = '⚠️ Offline — using saved settings';
  }
}

/* ---------- wiring ---------- */
$('btnConnect').onclick = async () => {
  // Tidy what phones paste: invisible characters, spaces, auto-capitalised "Https",
  // trailing slash or ?query. The script ID itself is case-sensitive, so only the prefix is normalised.
  const url = $('scriptUrl').value
    .replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/^https?:\/\/script\.google\.com/i, 'https://script.google.com');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    const hint = /\/dev$/.test(url) ? ' — that is the /dev test URL; use the /exec one from Deploy → Manage deployments'
               : !/\/exec$/i.test(url) ? ' — it should end in /exec' : '';
    toast('That does not look like an /exec URL' + hint, true); return;
  }
  $('scriptUrl').value = url;
  localStorage.setItem(LS_URL, url);
  $('btnConnect').textContent = 'Connecting…';
  $('btnConnect').disabled = true;
  try {
    await refreshConfig();
    if (!CFG.purposes.length) throw new Error('Connected but no purposes found');
    if (localStorage.getItem('rs_intro')) show('vHome'); else showIntro();
    toast('Connected');
  } catch (e) {
    localStorage.removeItem(LS_URL);
    toast(e.message, true);
  }
  $('btnConnect').textContent = 'Connect';
  $('btnConnect').disabled = false;
};

$('btnReset').onclick = () => {
  if (confirm('Disconnect this sheet?')) {
    localStorage.removeItem(LS_URL);
    show('vSetup');
  }
};

// Home: one "Add receipt" button that opens two choices in place
function setAddOpen(open) { $('addBox').classList.toggle('open', open); $('btnAdd').setAttribute('aria-expanded', open); }
$('btnAdd').onclick = () => setAddOpen(!$('addBox').classList.contains('open'));
$('btnCam').onclick = () => { setAddOpen(false); pages = []; job = null; RETURN_FOR = null; lastSource = 'cam'; $('inpCam').click(); };
$('btnLib').onclick = () => { setAddOpen(false); pages = []; job = null; RETURN_FOR = null; lastSource = 'lib'; $('inpLib').click(); };
$('homeDate').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
$('inpCam').onchange = e => { addPhotos(e.target.files); e.target.value = ''; };
$('inpLib').onchange = e => { addPhotos(e.target.files); e.target.value = ''; };
$('btnAddPage').onclick    = () => $('inpCam').click();
$('btnRetakeLast').onclick = () => { pages.pop(); $('inpCam').click(); };
$('btnPagesDone').onclick  = pagesDone;
$('btnPBack').onclick      = () => { if (!pages.length || confirm('Discard ' + (pages.length > 1 ? 'these photos' : 'this photo') + '?')) { pages = []; show('vHome'); } };
$('thumbs').onclick = e => { const i = e.target.dataset.x; if (i !== undefined) { pages.splice(Number(i), 1); renderPages(); } };
$('btnJobs').onclick  = renderJobs;
$('btnJBack').onclick = () => show('vHome');
$('btnTrip').onclick  = () => openTrip();
$('btnTBack').onclick = () => show('vHome');
$('btnTripSave').onclick = saveTrip;
$('tMiles').oninput = () => {
  $('tMilesNote').textContent = trip.route && Math.abs((Number($('tMiles').value) || 0) - trip.route.miles) >= 0.05
    ? '(changed from Google\'s ' + trip.route.miles + ')' : trip.route ? '(from Google Maps — change it if you took a detour)' : '';
  tripCalc();
};
$('tReturn').onchange = lookupRoute;
$('tStops').addEventListener('change', e => { if (e.target.dataset.stop !== undefined) { delete e.target.dataset.geo; lookupRoute(); } });
$('tStops').onclick = e => {
  const t = e.target;
  if (t.dataset.del) {
    const v = stopValues(); v.splice(Number(t.dataset.del), 1);
    renderStops(v); lookupRoute();
  } else if (t.dataset.here) {
    if (!navigator.geolocation) { toast('Location isn\'t available on this phone', true); return; }
    t.textContent = '…';
    navigator.geolocation.getCurrentPosition(pos => {
      const inp = stopInputs()[0];
      inp.value = 'Current location';
      inp.dataset.geo = pos.coords.latitude.toFixed(5) + ',' + pos.coords.longitude.toFixed(5);
      t.textContent = '📍';
      lookupRoute();
    }, () => { t.textContent = '📍'; toast('Couldn\'t get your location. Type a postcode instead', true); },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }
};
$('btnAddStop').onclick = () => {
  const v = stopValues(), geos = stopInputs().map(x => x.dataset.geo || '');
  if (v.length >= 10) { toast('Up to 8 stops', true); return; }
  v.splice(v.length - 1, 0, ''); geos.splice(geos.length - 1, 0, '');
  renderStops(v, geos);
  stopInputs()[v.length - 2].focus();
};
$('btnHome').onclick = () => { $('homeWrap').classList.toggle('hide'); $('tHome').value = homeAddr(); $('tHome').focus(); };
$('btnHomeSave').onclick = () => {
  const h = $('tHome').value.trim().toUpperCase();
  if (!h) { localStorage.removeItem(LS_HOME); } else localStorage.setItem(LS_HOME, h);
  $('homeWrap').classList.add('hide');
  $('btnHome').textContent = h ? '🏠 ' + h : '🏠 Set home';
  fillPlaces();
  const first = stopInputs()[0];
  if (h && first && !first.value) first.value = HOME;
  toast(h ? 'Home saved on this phone' : 'Home removed');
  trip.routeKey = ''; lookupRoute();
};
$('tRepeat').onclick = e => { const c = e.target.closest('.chip'); if (c) repeatTrip(Number(c.dataset.rep)); };
$('tVehicle').onclick = e => {
  const v = e.target.closest('button'); if (!v) return;
  document.querySelectorAll('#tVehicle button').forEach(b => b.classList.toggle('on', b === v));
  tripCalc();
};
$('btnRepay').onclick = openRepay;
$('btnRBack').onclick = () => show('vHome');
$('btnRepaySave').onclick = saveRepay;

// Retake from the error screen: the old photo is deleted and you start again
$('btnRetake').onclick    = async () => { if (job) await jobDel(job.id); job = null; pages = []; refreshJobs(); $('inpCam').click(); };
$('btnBilling').onclick   = () => window.open(BILLING_URL, '_blank');
$('btnManual').onclick    = manualEntry;
$('btnCancelErr').onclick = () => { job = null; show('vHome'); refreshJobs(); };
$('btnBack').onclick      = () => {
  if (state && state.queueId) {   // emails stay in the queue until saved or dismissed
    if (confirm('Go back to the email list? Your edits here won\'t be kept.')) openQueue();
    return;
  }
  if (state && state.jobId) {       // photos stay on the phone until saved or deleted
    if (confirm('Leave this receipt? The photo stays in Photos to review.')) { job = null; show('vHome'); refreshJobs(); }
    return;
  }
  if (confirm('Discard this receipt?')) { job = null; show('vHome'); }
};
$('btnEmails').onclick    = openQueue;
$('btnQBack').onclick     = () => show('vHome');
$('btnQRefresh').onclick  = () => checkInboxNow(0);

// "Longer returns" says what the usual time is for this kind of purchase
function retLabel() {
  const online = state && (state.channel === 'Email' || /deliver/i.test(state.method || ''));
  $('fExtRetLbl').textContent = 'This shop gives longer than the usual ' + (online ? '14 days (online)' : '28 days (in store)') + ' to return';
}
$('pChannel').onclick = () => {
  state.channel = state.channel === 'In person' ? 'Email' : 'In person';
  setTimeout(retLabel, 0);
  $('pChannel').textContent = state.channel;
  $('pChannel').classList.toggle('on', state.channel === 'Email');
  showEmailField();
};
$('pMethod').onclick = () => {
  state.method = state.method === 'Collection' ? 'Delivery' : 'Collection';
  $('pMethod').textContent = state.method;
  $('pMethod').classList.toggle('on', state.method === 'Delivery');
};
$('pShared').onclick = () => {
  toggleSharedAll();
};

$('btnSelAll').onclick = selectAll;
$('fFees').oninput = () => {
  if (!state) return;
  state.meta.feeTotal = Number($('fFees').value) || 0;
  recalc();
};
$('btnBulk').onclick   = bulkPurpose;
$('btnShareSel').onclick = shareSelected;
$('btnSave').onclick   = () => saveToSheet(false);

/* ---------- boot ---------- */
loadCache();
try { USAGE = JSON.parse(localStorage.getItem(LS_USAGE)) || null; } catch (e) {}
renderUsage();
// Keep the reset countdown honest while the app sits open
setInterval(() => { if (!$('vHome').classList.contains('hide')) renderUsage(); }, 60000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && localStorage.getItem(LS_URL)) refreshConfig();
});
if (localStorage.getItem(LS_URL)) {
  show('vHome'); if (CFG.waiting) renderTodo(CFG.waiting); renderAppSwitch(); refreshConfig();
  if (location.hash === '#returns') { history.replaceState(null, '', location.pathname); openSales('slToRetWrap'); }   // from FlipList / FlipCheck
  if (location.hash === '#purchases') { history.replaceState(null, '', location.pathname); openPurchases(); }   // from FlipCheck's Bought it box
}
else { show('vSetup'); }
setTimeout(() => { try { if (localStorage.getItem(LS_URL) && !localStorage.getItem('rs_intro')) showIntro(); } catch (e) {} }, 0);

// Offline queue: a photo left "reading" when the app closed is waiting again
jobAll().then(all => Promise.all(all.filter(j => j.status === 'reading').map(j => { j.status = 'pending'; return jobPut(j); })))
  .then(refreshJobs).then(() => setTimeout(jobTick, 2000));
window.addEventListener('online', () => { refreshJobs(); jobTick(); tripTick(); flushSales(true); flushPosted(); });
refreshTrips(); setTimeout(tripTick, 3000); setInterval(tripTick, 60000);
window.addEventListener('offline', refreshJobs);
setInterval(jobTick, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') jobTick(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}


/* ---------- Settings ---------- */
const MONTHS_UK = ['January','February','March','April','May','June','July','August','September','October','November','December'];
async function openSettings() {
  show('vSettings');
  try { renderColl(); renderAv(); } catch (e) {}
  $('stYe').innerHTML = MONTHS_UK.map((m, i) => `<option value="${i + 1}">End of ${m}</option>`).join('');
  try {
    SETTINGS = await api('settings', {});
    const d = SETTINGS;
    segSet('stType', d.type || ''); $('stVat').checked = !!d.vat; $('stYe').value = String(d.yearEnd || 3); $('stInc').value = d.income || '';
    $('stTap').value = d.cardFee && d.cardFee.perTap ? d.cardFee.perTap : ''; $('stPct').value = d.cardFee && d.cardFee.pct ? d.cardFee.pct : '';
    const a = d.account || {};
    SETTINGS.sheetUrl = a.sheetUrl || '';
    $('stEmail').textContent = a.email || '—'; $('stGoogle').textContent = a.email || '—';
    $('stFwd').textContent = a.forwardTo || '—';
    $('stEmailsOn').textContent = a.emailsOn ? 'On, every 5 minutes' : 'Not set up yet';
    $('stSrc').value = d.emailSource || ''; $('stOrderEmail').value = d.orderEmail || ''; $('stMonthly').checked = !!d.monthlyEmail;
    $('stCrm').checked = !!d.crm; if (CFG.crm !== !!d.crm) { CFG.crm = !!d.crm; saveCache(); crmSync(); }
    $('stSaver').checked = d.readMode === 'saver';
    try { renderColl(); } catch (e) {}
    syncTpls();
    srcSync();
    $('stHist').innerHTML = (d.history || []).map(h => `<p class="hist">Before ${esc(h.until)}: ${esc(h.label)}${h.tab ? ' · saved in the "' + esc(h.tab) + '" tab' : ''}</p>`).join('');
    stSync(); renderWhere();
  } catch (err) { toast(/Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for Settings.' : err.message, true); }
}
function stSync() {
  const t = segGet('stType'), d = SETTINGS || {};
  $('stIncWrap').classList.toggle('hide', t !== 'sole');
  $('stYeWrap').classList.toggle('hide', t !== 'ltd');
  const changed = d.type && (t !== d.type || $('stVat').checked !== !!d.vat);
  $('stChangeHint').classList.toggle('hide', !changed);
}
$('stType').onclick = e => { const b = e.target.closest('button'); if (b) { segSet('stType', b.dataset.v); stSync(); } };
$('stVat').onchange = stSync;
$('btnSettings').onclick = openSettings;
$('btnSlSettings').onclick = openSettings;
$('btnStBack').onclick = () => show('vHome');
$('stSheetName').textContent = (localStorage.getItem(LS_URL) || '').replace(/^https:\/\/script\.google\.com\/macros\/s\//, '').replace(/\/exec$/, '').slice(0, 10) + '…';
$('stVersion').textContent = 'App ' + APP_VERSION;

/* ---------- Help: searchable topics (help.js) ---------- */
let helpFrom = 'vSettings';
function openHelp(id) {
  helpFrom = views.find(v => !$(v).classList.contains('hide')) || 'vSettings';
  show('vHelp'); $('helpSearch').value = ''; renderHelp('', id);
}
function renderHelp(q, openId) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = t => !words.length || words.every(w => (t.title + ' ' + t.keys + ' ' + t.body.replace(/<[^>]+>/g, ' ')).toLowerCase().includes(w));
  const list = HELP.filter(hit);
  $('helpList').innerHTML = list.length ? list.map(t => `<details class="card help" id="help-${t.id}"${t.id === openId ? ' open' : ''}><summary>${esc(t.title)}</summary><div class="body">${t.body}</div></details>`).join('')
    : '<div class="empty">No match. Try another word, or <button class="link" id="helpAsk">report it</button>.</div>';
  if (openId) { const el = $('help-' + openId); if (el) el.scrollIntoView({ block: 'start' }); }
}
$('helpSearch').oninput = () => renderHelp($('helpSearch').value);
$('helpList').onclick = e => { if (e.target.id === 'helpAsk') openReport(); };
$('btnHelp').onclick = () => openHelp();
$('btnHelpBack').onclick = () => show(helpFrom === 'vHelp' ? 'vSettings' : helpFrom);

/* ---------- Report a bug or idea ---------- */
let reportFrom = 'vSettings';
function openReport() { reportFrom = views.find(v => !$(v).classList.contains('hide')) || 'vSettings'; show('vReport'); segSet('repType', 'bug'); $('repText').value = ''; }
$('btnReport').onclick = openReport;
$('repType').onclick = e => { const b = e.target.closest('button'); if (b) { segSet('repType', b.dataset.v); $('repText').placeholder = b.dataset.v === 'idea' ? 'e.g. It would help if the app could…' : 'e.g. On the Sales page the QR code took a long time to open'; } };
$('btnRepBack').onclick = () => show(reportFrom === 'vReport' ? 'vSettings' : reportFrom);
$('btnRepSend').onclick = async () => {
  const text = $('repText').value.trim();
  if (!text) { toast('Tell us what happened', true); return; }
  const b = $('btnRepSend'); b.disabled = true; b.textContent = 'Sending…';
  try {
    await api('report', { report: { type: segGet('repType') || 'bug', text, screen: reportFrom, version: APP_VERSION } });
    toast('Thank you. We read every report.'); show('vSettings');
  } catch (err) { toast(/Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for this.' : err.message, true); }
  finally { b.disabled = false; b.textContent = 'Send'; }
};

/* ---------- Make your money go further (links to be filled in) ---------- */
const PERKS = [
  { name: 'TopCashback', col: '#1a9e5c', what: 'Cashback on most big UK shops, paid to your bank. Use it when buying stock online.', url: '' },
  { name: 'Quidco', col: '#7b3fe4', what: 'The other big UK cashback site. Check both: rates differ by shop.', url: '' },
  { name: 'Honey', col: '#f5a623', what: 'Browser extension that tries coupon codes at checkout for you.', url: '' },
  { name: 'Coupert', col: '#ff5a5f', what: 'Coupons plus cashback in one extension.', url: '' },
  { name: 'Capital One Shopping', col: '#0a4b9c', what: 'Compares prices and applies codes while you shop.', url: '' },
  { name: 'JamDoughnut', col: '#e8335a', what: 'Buy gift cards at a discount for shops you use anyway (Argos, Tesco, Amazon).', url: '' },
  { name: 'Shoppix', col: '#2bb673', what: 'Points for snapping receipts you already have. Small, but free.', url: '' },
  { name: 'Everup', col: '#6c47ff', what: 'Savings and rewards app with prize draws.', url: '' }
];
$('btnPerks').onclick = () => {
  show('vPerks');
  $('perksList').innerHTML = PERKS.map(p => `<div class="perk"><div class="pl" style="background:${p.col}">${esc(p.name[0])}</div>
    <div><b>${esc(p.name)}</b><span class="sm">${esc(p.what)}</span>${p.url ? `<a class="btn sec" style="display:inline-block;width:auto;padding:8px 14px;font-size:14px" href="${esc(p.url)}" target="_blank" rel="noopener">Get it</a>` : '<span class="tag">link coming soon</span>'}</div></div>`).join('');
};
$('btnPerksBack').onclick = () => show('vSettings');

/* ---------- Photo check: tap a photo to see it full size ---------- */
$('thumbs').addEventListener('click', e => {
  const img = e.target.closest('img');
  if (!img || e.target.dataset.x !== undefined) return;
  const i = [...$('thumbs').querySelectorAll('img')].indexOf(img);
  const z = document.createElement('div'); z.className = 'zoom';
  z.innerHTML = `<img src="${img.src}" alt="Photo ${i + 1}"><button class="close" aria-label="Close">✕</button><div class="cap">Pinch to zoom. Can you read the lines? If not, retake it.</div>`;
  z.onclick = ev => { if (ev.target.tagName !== 'IMG') z.remove(); };
  document.body.appendChild(z);
});

/* ---------- Splash: name and logo while the home screen loads behind it ---------- */
setTimeout(() => { const sp = $('splash'); if (sp) { sp.classList.add('gone'); setTimeout(() => sp.remove(), 300); } }, 700);
$('btnOpenSheet').onclick = () => {
  const u = SETTINGS && SETTINGS.sheetUrl;
  if (u) window.open(u, '_blank', 'noopener'); else toast('Your Sheet\'s script needs updating to show this link.', true);
};
$('stSrc').onchange = srcSync;
const SRC_EG = { 'gmail-other': 'you@gmail.com', outlook: 'you@outlook.com', icloud: 'you@icloud.com', yahoo: 'you@yahoo.co.uk', other: 'you@yourbusiness.co.uk' };
const SRC_GUIDE = { gmail: 'fwd-gmail', 'gmail-other': 'fwd-gmail-other', outlook: 'fwd-outlook', icloud: 'fwd-icloud', yahoo: 'fwd-yahoo', other: 'fwd-manual' };
function srcSync() {
  const v = $('stSrc').value;
  $('stOrderEmail').placeholder = 'e.g. ' + (SRC_EG[v] || 'you@example.com');
  const g = typeof HELP !== 'undefined' && HELP.find(t => t.id === SRC_GUIDE[v]);
  $('stGuide').classList.toggle('hide', !g);
  $('stGuide').innerHTML = g ? '<b>' + esc(g.title) + '</b>' + g.body : '';
  $('stOrderWrap').classList.toggle('hide', !v || v === 'gmail');
  $('stSrcHint').textContent = v === 'gmail' ? 'Your orders arrive here already. Forward any from other shops to this address.'
    : v ? 'Set up forwarding once and new orders arrive by themselves. Tap the guide below.'
    : 'Forward order and sale emails to this address. They show up in the app within a few minutes.';
}
$('btnCopyFwd').onclick = async () => {
  const t = $('stFwd').textContent;
  try { await navigator.clipboard.writeText(t); toast('Copied: ' + t); } catch (e) { prompt('Copy this address', t); }
};
$('btnStSave').onclick = async () => {
  const d = SETTINGS || {}, type = segGet('stType');
  if (!type) { toast('Pick your business type', true); return; }
  const settings = { type, vat: $('stVat').checked, yearEnd: Number($('stYe').value) || 3, income: $('stInc').value,
                     cardFee: { perTap: Number($('stTap').value) || 0, pct: Number($('stPct').value) || 0 },
                     emailSource: $('stSrc').value, orderEmail: $('stSrc').value === 'gmail' ? '' : $('stOrderEmail').value.trim(),
                     monthlyEmail: $('stMonthly').checked };
  if (d.type && (type !== d.type || settings.vat !== !!d.vat) &&
      !confirm('Change your business details from today? Your old records stay as they are, and we keep a copy of your old tax summary.')) return;
  const b = $('btnStSave'); b.disabled = true; b.textContent = 'Saving…';
  try {
    SETTINGS = await api('settingsSet', { settings });
    CFG.business = SETTINGS.type; CFG.vat = SETTINGS.vat; CFG.cardFee = SETTINGS.cardFee; saveCache();
    toast(SETTINGS.note || 'Settings saved');
    openSettings();
  } catch (err) { toast(err.message, true); }
  finally { b.disabled = false; b.textContent = 'Save settings'; }
};

$('fExtRet').onchange = () => { $('fRetWrap').classList.toggle('hide', !$('fExtRet').checked); if ($('fExtRet').checked) $('fRetBy').focus(); };
$('btnSaveMini').onclick = () => $('btnSave').click();
$('btnBulkMini').onclick = () => $('btnBulk').click();   // works on the ticked lines, like the main button
// The slim Save strip shows only while the real button bar is off-screen (long receipts)
if ('IntersectionObserver' in window) new IntersectionObserver(es => {
  $('miniBar').classList.toggle('hide', es[0].isIntersecting || $('vReview').classList.contains('hide'));
}, { threshold: 0 }).observe($('reviewBar'));


/* ---------- Your numbers: progress, tax pot, stock (Insights.gs numbers_) ---------- */
async function openNumbers() {
  show('vNumbers');
  let d = null;
  try { d = JSON.parse(localStorage.getItem('rs_numbers')); } catch (e) {}
  if (d) renderNumbers(d);
  try {
    d = await api('numbers', {});
    try { localStorage.setItem('rs_numbers', JSON.stringify(d)); } catch (e) {}
    renderNumbers(d);
  } catch (err) {
    if (!d) $('numBody').innerHTML = '<p class="sub">' + esc(/Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for this.' : err.message) + '</p>';
  }
}
function renderNumbers(d) {
  $('numPeriod').textContent = 'This ' + (d.type === 'ltd' ? 'company year' : 'tax year') + ' so far: ' + d.from + ' to ' + d.to;
  const max = Math.max(1, ...d.months.map(m => Math.max(m.sales, m.spent)));
  const soldPct = d.stock.bought ? Math.round((d.stock.bought - d.stock.left) / d.stock.bought * 100) : 0;
  $('numBody').innerHTML = `
    <div class="ncard"><h3>Profit so far</h3><div class="nbig">${money(d.profit)}</div>
      <div class="nrow"><span>Sales</span><b>${money(d.sales)}</b></div>
      <div class="nrow"><span>Selling costs (fees, postage)</span><b>−${money(d.sellingCosts)}</b></div>
      <div class="nrow"><span>Business spending${d.mileage ? ' (incl. mileage)' : ''}</span><b>−${money(d.spent)}</b></div></div>
    <div class="ncard"><h3>Tax pot: set this aside</h3><div class="nbig">${money(d.taxPot)}</div>
      <p class="sub" style="margin:4px 0 0">${esc(d.taxLabel)} on your profit.</p>
      <div class="warnnote">A rough guide only. It's only as right as what you've recorded${d.unset ? ' (' + d.unset + ' line' + (d.unset === 1 ? ' has' : 's have') + ' no purpose yet)' : ''}, and it ignores your personal allowance and other income, so it usually errs high. Check with an accountant before you pay HMRC.</div></div>
    <div class="ncard"><h3>Last 6 months</h3>
      <div class="mchart">${d.months.map(m => `<div class="mcol"><div class="mbars"><i class="s" style="height:${Math.round(m.sales / max * 100)}%" title="Sales ${money(m.sales)}"></i><i class="p" style="height:${Math.round(m.spent / max * 100)}%" title="Spent ${money(m.spent)}"></i></div>${esc(m.label)}</div>`).join('')}</div>
      <div class="legend"><span><i style="background:#0a84ff"></i>Sales</span><span><i style="background:#b8c0cc"></i>Spent</span></div></div>
    <div class="ncard"><h3>Stock bought this year</h3>
      <div class="nrow"><span>Sold</span><b>${soldPct}%</b></div>
      <div class="nbar"><i style="width:${soldPct}%"></i></div>
      <div class="nrow"><span>Still to sell</span><b>${d.stock.left} · ${money(d.stock.value)}</b></div>
      ${d.avgDaysToSell !== null ? `<div class="nrow"><span>Average days to sell</span><b>${d.avgDaysToSell}</b></div>` : ''}</div>
    ${d.streak > 1 ? `<div class="ncard"><h3>Records up to date</h3><div class="nbig">${d.streak} weeks</div><p class="sub" style="margin:4px 0 0">in a row with something logged. Nice.</p></div>` : ''}`;
}
$('btnNumbers').onclick = openNumbers;
$('btnNumBack').onclick = () => show('vHome');

/* ---------- First run: four short screens, once ---------- */
const INTRO = [
  { ico: "<svg viewBox=\"0 0 24 24\" width=\"24\" height=\"24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M4 8h3l2-3h6l2 3h3v11H4z\"/><circle cx=\"12\" cy=\"13\" r=\"3.5\"/></svg>", h: 'Snap a receipt', p: 'Take a photo. We read every line and file it in your Google Sheet.' },
  { ico: "<svg viewBox=\"0 0 24 24\" width=\"24\" height=\"24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6z\"/></svg>", h: 'Forward your emails', p: 'Order, sale and refund emails file themselves. No typing.' },
  { ico: "<svg viewBox=\"0 0 24 24\" width=\"24\" height=\"24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z\"/><circle cx=\"7.5\" cy=\"7.5\" r=\"1.5\"/></svg>", h: 'Show the code at the shop', p: 'Postage labels wait in the app, ready to scan. Even with no signal.' },
  { ico: "<svg viewBox=\"0 0 24 24\" width=\"24\" height=\"24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M4 20V10M10 20V4M16 20v-7M22 20H2\"/></svg>", h: 'Your tax builds as you go', p: 'Profit, a tax pot to set aside, and tidy records for HMRC.' }
];
let introAt = 0;
function showIntro() { introAt = 0; show('vIntro'); drawIntro(); }
function drawIntro() {
  const c = INTRO[introAt];
  $('introDots').innerHTML = INTRO.map((x, i) => `<i class="${i === introAt ? 'on' : ''}"></i>`).join('');
  $('introCard').innerHTML = `<div class="pic">${c.ico}</div><h2>${esc(c.h)}</h2><p>${esc(c.p)}</p>`;
  $('btnIntroNext').textContent = introAt === INTRO.length - 1 ? 'Scan my first receipt' : 'Next';
}
function endIntro(scan) {
  try { localStorage.setItem('rs_intro', '1'); } catch (e) {}
  show('vHome');
  if (scan) { setAddOpen(true); }
}
$('btnIntroNext').onclick = () => { if (introAt < INTRO.length - 1) { introAt++; drawIntro(); } else endIntro(true); };
$('btnIntroSkip').onclick = () => endIntro(false);

/* ---------- Buyers (CRM): notes on each buyer, contacts, and who might want what you buy ----------
   Turned on in Settings → Selling. Lives on the "Buyers" tab of the Sheet. No AI, so no cost. */
const LS_BUYERS = 'rs_buyers', LS_MATCH = 'rs_match';
var BUYERS = (() => { try { return JSON.parse(localStorage.getItem(LS_BUYERS)) || null; } catch (e) { return null; } })();
var bpKey = null, bpFrom = 'vBuyers', BP = null;
const bKey = s => String(s || '').trim().replace(/^@/, '').replace(/\s+/g, ' ').toLowerCase();
const bName = b => b.name || b.username || b.key;
const findBuyer = s => (BUYERS && BUYERS.buyers || []).find(b => b.key === bKey(s) || bKey(b.name) === bKey(s) || bKey(b.username) === bKey(s));
async function loadBuyers() {
  BUYERS = await api('buyers', {});
  try { localStorage.setItem(LS_BUYERS, JSON.stringify(BUYERS)); } catch (e) {}
  fillBuyerLists();
  return BUYERS;
}
function fillBuyerLists() {
  const bs = (BUYERS && BUYERS.buyers) || [], tags = new Set();
  bs.forEach(b => String(b['interested in'] || '').split(',').map(t => t.trim()).filter(Boolean).forEach(t => tags.add(t)));
  $('tagList').innerHTML = [...tags].map(t => `<option value="${esc(t)}">`).join('');
  let dl = $('buyerList');
  if (dl) dl.remove();   // the phone showed every buyer as a suggestion: the app's own search replaces it
}
const buyerChips = b => {
  const c = [];
  if (b.experience) c.push(`<span class="bchip ${b.experience === 'Good' ? 'good' : b.experience === 'Bad' ? 'bad' : ''}">${{ Good: '👍', Fine: '👌', Bad: '👎' }[b.experience] || ''} ${esc(b.experience)}</span>`);
  if (b['sell again']) c.push(`<span class="bchip ${b['sell again'] === 'No' ? 'bad' : b['sell again'] === 'Yes' ? 'good' : ''}">Sell again: ${esc(b['sell again'])}</span>`);
  if (b['buying style']) c.push(`<span class="bchip">${esc(b['buying style'])}</span>`);
  if (Number(b['avg off asking %']) > 0) c.push(`<span class="bchip">~${esc(b['avg off asking %'])}% off asking</span>`);
  if (Number(b['no-shows']) > 0) c.push(`<span class="bchip bad">${esc(b['no-shows'])} no-show${b['no-shows'] > 1 ? 's' : ''}</span>`);
  String(b['interested in'] || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 5).forEach(t => c.push(`<span class="bchip int">${esc(t)}</span>`));
  return c.length ? '<span class="bchips">' + c.join('') + '</span>' : '';
};
const buyerLine = b => [b['times bought'] ? b['times bought'] + ' sale' + (b['times bought'] > 1 ? 's' : '') : '', b['total spent'] ? money(b['total spent']) : '',
  b['last bought'] ? 'last ' + b['last bought'] : '', b.platforms].filter(Boolean).join(' · ');

// A rough category from the item's name: fills in "interested in" (same list as Sales.gs CATEGORIES_)
const CATEGORIES = [
  ['golf', /\b(golf|titleist|callaway|taylormade|putter|pro v1)/],
  ['trainers', /\b(trainers?|sneakers?|air max|air force|jordans?|yeezy|new balance)\b/],
  ['collectibles', /\b(funko|pokemon|pokémon|trading cards?|tcg|one piece card|yu-?gi-?oh|collectibles?|figurines?)\b/],
  ['gaming', /\b(ps5|ps4|playstation|xbox|nintendo|switch|controller|video games?)\b/],
  ['phones and tech', /\b(iphone|ipad|samsung|galaxy|phones?|tablets?|laptops?|macbook|airpods|headphones|earbuds|speakers?|chargers?|cameras?|smart ?watch)\b/],
  ['cleaning', /\b(mops?|hoover|vacuum|steam cleaner|cleaner|cleaning|duster|vileda|dettol|bleach|carpet cleaner)\b/],
  ['kitchen appliances', /\b(kettles?|toasters?|blenders?|air ?fryers?|microwaves?|coffee machine|nespresso|food processor|stand mixer|slow cooker|ninja)\b/],
  ['cookware', /\b(pans?|saucepans?|woks?|tefal|cookware|knives|knife|baking|casserole)\b/],
  ['tools and DIY', /\b(drills?|saws?|screwdrivers?|makita|dewalt|ryobi|spanners?|tool ?kit|tools?)\b/],
  ['toys', /\b(lego|toys?|dolls?|puzzles?|board games?|nerf|playmobil|barbie)\b/],
  ['sports and fitness', /\b(football|dumbbells?|kettlebells?|yoga|bikes?|cycling|tennis|rackets?|gym|fitness|running)\b/],
  ['health and beauty', /\b(perfume|aftershave|fragrance|eau de|make-?up|skincare|shampoo|hair ?dryer|straighteners|dyson airwrap)\b/],
  ['clothing', /\b(hoodies?|jackets?|coats?|dress(es)?|jeans|shirts?|t-?shirts?|jumpers?|sweaters?|skirts?|trousers|shorts|tops?)\b/],
  ['bags and accessories', /\b(bags?|backpacks?|handbags?|wallets?|purses?|watches|sunglasses|rucksacks?)\b/],
  ['home and garden', /\b(garden|plants?|lamps?|cushions?|bedding|duvets?|towels?|rugs?|mirrors?|candles?|curtains?)\b/],
  ['books and media', /\b(books?|dvds?|blu-?ray|vinyl|cds?)\b/],
  ['baby and kids', /\b(baby|pram|buggy|car seat|nappies)\b/],
  ['pet supplies', /\b(dogs?|cats?|pets?|puppy)\b/]
];
const categoryOf = item => { const t = String(item || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); const c = CATEGORIES.find(x => x[1].test(t)); return c ? c[0] : ''; };
function autoInts() {
  if (!CFG.crm || !sale || !sale.intsAuto) return;
  const c = categoryOf($('saItem').value);
  $('saInts').value = c;
  $('saIntsHint').textContent = c ? 'Filled in from what they bought. Change it, or add more with commas.' : 'Separate with commas. When you buy something that matches, the app tells you.';
}
$('saItem').addEventListener('input', autoInts);
$('saInts').addEventListener('input', () => { if (sale) sale.intsAuto = !$('saInts').value.trim(); });

// Mobile numbers: country code picker + number. Saved as "+44 7700 900123"; UK numbers shown as 07…
function phoneSet(ccId, inId, val) {
  const v = String(val || '').trim(), sel = $(ccId);
  let cc = '+44', nat = v;
  if (v.startsWith('+')) {
    const codes = [...sel.options].map(o => o.value).sort((a, b) => b.length - a.length);
    const hit = codes.find(c => v.replace(/\s/g, '').startsWith(c));
    if (hit) { cc = hit; nat = v.replace(/\s/g, '').slice(hit.length); }
    if (hit === '+44' && nat && !nat.startsWith('0')) nat = '0' + nat;
  }
  sel.value = cc; $(inId).value = nat;
}
function phoneGet(ccId, inId) {
  const n = $(inId).value.trim();
  if (n.replace(/\D/g, '').length < 6) return '';
  if (n.startsWith('+')) return n;
  return $(ccId).value + ' ' + n.replace(/^0+/, '');
}
[['saBCc', 'saBMobile'], ['beCc', 'beMobile']].forEach(([c, i]) => {
  $(i).addEventListener('focus', () => { if (!$(i).value && $(c).value === '+44') $(i).value = '07'; });
  $(c).addEventListener('change', () => { if (/^0?7?$/.test($(i).value)) $(i).value = $(c).value === '+44' ? '07' : ''; });
});

// Meeting spots and saved messages: kept on this phone
const LS_SPOTS = 'rs_spots', LS_TPLS = 'rs_tpls';
const DEF_TPLS = [
  { name: 'Where to meet', text: "Hi [Name], for security I don't meet people at my door. Please meet me at [Spot].\n[Directions]\nWhen you set off, can you message me your ETA from your maps so I know when you'll arrive? Thanks!" },
  { name: 'Still available', text: "Hi [Name], yes the [Item] is still available at £[Price]. I can do [Times]. Which suits you?" }
];
const getSpots = () => { try { return JSON.parse(localStorage.getItem(LS_SPOTS)) || []; } catch (e) { return []; } };
const getTpls = () => { try { return JSON.parse(localStorage.getItem(LS_TPLS)) || DEF_TPLS; } catch (e) { return DEF_TPLS; } };
// Saved messages are shared with ListMe: they live on the Sheet's Messages tab, and this phone keeps a copy
// for when there's no signal. Messages saved on this phone before are moved to the Sheet once.
const LS_TPLS_SHARED = 'rs_tpls_shared', LS_TPLS_MOVED = 'rs_tpls_moved';
var tplsShared = localStorage.getItem(LS_TPLS_SHARED) === '1';
async function syncTpls() {
  try {
    let r = await api('templates', {});
    if (!localStorage.getItem(LS_TPLS_MOVED)) {
      let mine = null; try { mine = JSON.parse(localStorage.getItem(LS_TPLS)); } catch (e) {}
      if (mine && mine.length) r = await api('templatesImport', { templates: mine.map(t => ({ name: t.name, text: t.text })) });
      try { localStorage.setItem(LS_TPLS_MOVED, '1'); } catch (e) {}
    }
    putList(LS_TPLS, (r.templates || []).map(t => ({ id: t.id, name: t.name, text: t.text })));
    tplsShared = true; try { localStorage.setItem(LS_TPLS_SHARED, '1'); } catch (e) {}
    try { renderColl(); } catch (e) {}
    return true;
  } catch (err) {
    if (/Unknown action/.test(err.message)) { tplsShared = false; try { localStorage.removeItem(LS_TPLS_SHARED); } catch (e) {} }
    return false;
  }
}
const putList = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
let spEdit = -1, tpEdit = -1;
function renderColl() {
  $('stHome').value = homeAddr();
  const sp = getSpots(), tp = getTpls();
  $('stSpots').innerHTML = sp.length ? sp.map((x, i) => `<div class="sitem"><span><b>${esc(x.name)}</b>${x.addr ? '<br><small class="sub">' + esc(x.addr) + '</small>' : ''}${x.dir ? '<br><small class="sub">' + esc(x.dir) + '</small>' : ''}</span><button data-spe="${i}">Edit</button><button data-spd="${i}">✕</button></div>`).join('') : '<p class="sub">None yet.</p>';
  $('stTplNote').textContent = tplsShared ? 'Shared with ListMe (the Messages tab in your Sheet): change one here or in ListMe and it changes in both.' : '';
  $('stTpls').innerHTML = tp.map((x, i) => `<div class="sitem"><span><b>${esc(x.name)}</b><br><small class="sub">${esc(x.text.slice(0, 90))}${x.text.length > 90 ? '…' : ''}</small></span><button data-tpe="${i}">Edit</button><button data-tpd="${i}">✕</button></div>`).join('');
}
$('stHome').addEventListener('change', () => { const h = $('stHome').value.trim(); try { h ? localStorage.setItem(LS_HOME, h) : localStorage.removeItem(LS_HOME); } catch (e) {} toast(h ? 'Home saved' : 'Home cleared'); });
$('btnSpSave').onclick = () => {
  const x = { name: $('spName').value.trim(), addr: $('spAddr').value.trim(), dir: $('spDir').value.trim() };
  if (!x.name) { toast('Give the spot a name', true); return; }
  const sp = getSpots(); spEdit > -1 ? sp[spEdit] = x : sp.push(x); putList(LS_SPOTS, sp);
  spEdit = -1; $('spName').value = $('spAddr').value = $('spDir').value = ''; $('stSpotAdd').open = false; renderColl(); toast('Spot saved');
};
$('btnTpSave').onclick = async () => {
  const x = { name: $('tpName').value.trim(), text: $('tpText').value.trim() };
  if (!x.name || !x.text) { toast('Add a name and the message', true); return; }
  const tp = getTpls();
  if (tplsShared) {   // to the Sheet, so ListMe has it too
    const b = $('btnTpSave'); b.disabled = true;
    try { const r = await api('templateSave', { template: Object.assign({ id: tpEdit > -1 ? tp[tpEdit].id : undefined }, x) }); putList(LS_TPLS, r.templates.map(t => ({ id: t.id, name: t.name, text: t.text }))); }
    catch (err) { b.disabled = false; toast(err.message, true); return; }
    b.disabled = false;
  } else { tpEdit > -1 ? tp[tpEdit] = x : tp.push(x); putList(LS_TPLS, tp); }
  tpEdit = -1; $('tpName').value = $('tpText').value = ''; $('stTplAdd').open = false; renderColl(); toast(tplsShared ? 'Message saved here and in ListMe' : 'Message saved');
};
$('stSpots').onclick = e => {
  const ed = e.target.dataset.spe, del = e.target.dataset.spd, sp = getSpots();
  if (ed !== undefined) { spEdit = +ed; $('spName').value = sp[ed].name; $('spAddr').value = sp[ed].addr || ''; $('spDir').value = sp[ed].dir || ''; $('stSpotAdd').open = true; }
  if (del !== undefined) { sp.splice(+del, 1); putList(LS_SPOTS, sp); renderColl(); }
};
$('stTpls').onclick = e => {
  const ed = e.target.dataset.tpe, del = e.target.dataset.tpd, tp = getTpls();
  if (ed !== undefined) { tpEdit = +ed; $('tpName').value = tp[ed].name; $('tpText').value = tp[ed].text; $('stTplAdd').open = true; }
  if (del !== undefined) {
    if (tplsShared && tp[del] && tp[del].id) {
      api('templateDelete', { id: tp[del].id }).then(r => { putList(LS_TPLS, r.templates.map(t => ({ id: t.id, name: t.name, text: t.text }))); renderColl(); toast('Deleted here and in ListMe'); }).catch(err => toast(err.message, true));
      return;
    }
    tp.splice(+del, 1); putList(LS_TPLS, tp); renderColl();
  }
};

/* ---------- Collection times ----------
   You set your usual free hours once (e.g. weekdays 6:15–8:30pm). The app offers your next free times in
   messages ([Times]); when a buyer picks one you book it here: it stops being offered, goes into your phone's
   calendar (a calendar file, free, no connection needed) and shows on Home on the day. Kept on this phone. */
const LS_AVAIL = 'rs_avail', LS_BOOKED = 'rs_booked';
const getAv = () => { try { return Object.assign({ days: {}, slot: 30, off: [] }, JSON.parse(localStorage.getItem(LS_AVAIL)) || {}); } catch (e) { return { days: {}, slot: 30, off: [] }; } };
const getBooked = () => { try { return (JSON.parse(localStorage.getItem(LS_BOOKED)) || []).filter(x => new Date(x.start).getTime() > Date.now() - 864e5); } catch (e) { return []; } };
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const hm = d => { let h = d.getHours(), m = d.getMinutes(); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return h + (m ? ':' + String(m).padStart(2, '0') : '') + ap; };
const dayLabel = d => { const t = new Date(); t.setHours(0, 0, 0, 0); const x = new Date(d); x.setHours(0, 0, 0, 0); const n = Math.round((x - t) / 864e5);
  return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()]; };
function freeSlots(daysAhead) {
  const av = getAv(), booked = getBooked(), out = [], mins = Number(av.slot) || 30, soon = Date.now() + 60 * 60000;
  for (let i = 0; i < (daysAhead || 14); i++) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + i);
    const w = av.days[String(d.getDay())];
    if (!w || !w[0] || !w[1] || av.off.indexOf(ymd(d)) > -1) continue;
    const [fh, fm] = w[0].split(':').map(Number), [th, tm] = w[1].split(':').map(Number);
    for (let t = fh * 60 + fm; t + mins <= th * 60 + tm; t += mins) {
      const st = new Date(d); st.setMinutes(t);
      if (st.getTime() < soon) continue;
      const en = st.getTime() + mins * 60000;
      if (booked.some(b => { const bs = new Date(b.start).getTime(); return bs < en && bs + b.mins * 60000 > st.getTime(); })) continue;
      out.push(st);
    }
  }
  return out;
}
// Three choices on different days reads better than three back-to-back slots
function timesText() {
  const f = freeSlots(14), pick = [], days = new Set();
  f.forEach(d => { if (pick.length < 3 && !days.has(ymd(d))) { days.add(ymd(d)); pick.push(d); } });
  if (!pick.length) return 'whenever suits you';
  const s = pick.map(d => dayLabel(d) + ' ' + hm(d));
  return s.length === 1 ? s[0] : s.slice(0, -1).join(', ') + ' or ' + s[s.length - 1];
}
function renderAv() {
  const av = getAv();
  document.querySelectorAll('[data-av]').forEach(i => { const w = av.days[i.dataset.av] || []; i.value = i.dataset.k === 'from' ? (w[0] || '') : (w[1] || ''); });
  $('avSlot').value = String(av.slot || 30);
  $('avOffList').innerHTML = av.off.filter(x => x >= ymd(new Date())).sort().map(x => `<div class="sitem"><span>${esc(dayLabel(new Date(x + 'T12:00')))}</span><button data-avoff="${x}">✕</button></div>`).join('');
}
const putAv = av => { try { localStorage.setItem(LS_AVAIL, JSON.stringify(av)); } catch (e) {} };
$('avDays').addEventListener('change', () => {
  const av = getAv(); av.days = {};
  document.querySelectorAll('[data-av][data-k="from"]').forEach(f => { const t = document.querySelector(`[data-av="${f.dataset.av}"][data-k="to"]`); if (f.value && t.value && t.value > f.value) av.days[f.dataset.av] = [f.value, t.value]; });
  putAv(av);
});
$('avSlot').onchange = () => { const av = getAv(); av.slot = Number($('avSlot').value); putAv(av); };
$('btnAvOff').onclick = () => { const v = $('avOffDate').value; if (!v) return; const av = getAv(); if (av.off.indexOf(v) < 0) av.off.push(v); putAv(av); $('avOffDate').value = ''; renderAv(); toast('Not offering that day'); };
$('avOffList').onclick = e => { const x = e.target.dataset.avoff; if (!x) return; const av = getAv(); av.off = av.off.filter(o => o !== x); putAv(av); renderAv(); };

let slotFor = null;
function openSlotPick(b) {
  const f = freeSlots(14);
  if (!Object.keys(getAv().days).length) { toast('Set your collection times in Settings first', true); return; }
  slotFor = b;
  $('slotTitle').textContent = 'Book ' + firstName(b);
  let last = '';
  $('slotList').innerHTML = f.length ? f.slice(0, 60).map((d, i) => { const h = ymd(d) !== last ? '<h4>' + esc(dayLabel(d)) + '</h4>' : ''; last = ymd(d); return h + `<button data-slot="${d.toISOString()}">${hm(d)}</button>`; }).join('')
    : '<p class="sub">No free times in the next 2 weeks. Check your collection times in Settings.</p>';
  $('slotPick').classList.remove('hide');
}
$('slotClose').onclick = () => $('slotPick').classList.add('hide');
$('slotList').onclick = e => {
  const x = e.target.dataset.slot; if (!x || !slotFor) return;
  const b = slotFor, sp = getSpots()[+$('ouSpot').value], mins = Number(getAv().slot) || 30;
  const bk = { start: x, mins, key: b.key, name: bName(b), item: $('ouItem').value.trim(), spot: sp ? sp.name : '', addr: sp ? sp.addr || '' : '', mobile: b.mobile || '' };
  const all = getBooked(); all.push(bk); try { localStorage.setItem(LS_BOOKED, JSON.stringify(all)); } catch (e2) {}
  $('slotPick').classList.add('hide');
  const d = new Date(x);
  OU.done[b.key] = Object.assign(OU.done[b.key] || {}, { book: dayLabel(d) + ' ' + hm(d) });
  renderOutreach();
  addToCalendar(bk);
  toast('Booked ' + bk.name + ': ' + dayLabel(d) + ' ' + hm(d));
};
// A standard calendar file: your phone offers "Add to calendar". Nothing is connected or shared.
function addToCalendar(bk) {
  const st = new Date(bk.start), en = new Date(st.getTime() + bk.mins * 60000);
  const f = d => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + 'T' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + '00';
  const esc2 = t => String(t || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Receipts//Collections//EN', 'BEGIN:VEVENT', 'UID:' + Date.now() + '@receipts', 'DTSTAMP:' + f(new Date()),
    'DTSTART:' + f(st), 'DTEND:' + f(en), 'SUMMARY:' + esc2(bk.summary || ('Collection: ' + bk.name + (bk.item ? ' – ' + bk.item : ''))),
    'LOCATION:' + esc2([bk.spot, bk.addr].filter(Boolean).join(', ')), 'DESCRIPTION:' + esc2((bk.mobile ? 'Mobile: ' + bk.mobile + '\n' : '') + 'Booked in Receipts'),
    'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:' + esc2(bk.alarm || 'Collection in 30 minutes'), 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })); a.download = 'collection.ics';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  } catch (e) {}
}
// Home: today's and upcoming collections, with "running late" and "I'm here" ready to send
function renderHomeColl() {
  const b = getBooked().filter(x => new Date(x.start).getTime() > Date.now() - 2 * 3600e3).sort((a, c) => new Date(a.start) - new Date(c.start)).slice(0, 4);
  $('homeColl').classList.toggle('hide', !b.length);
  if (!b.length) return;
  const link = (x, t, label) => `<a href="https://wa.me/${telUK(x.mobile)}?text=${encodeURIComponent(t)}" target="_blank" rel="noopener">${label}</a>`;
  $('homeColl').innerHTML = '<b>📅 Collections</b>' + b.map((x, i) => { const d = new Date(x.start), fn = String(x.name).split(/\s+/)[0];
    return `<div class="crow"><b>${esc(dayLabel(d))} ${hm(d)}</b> · ${esc(x.name)}${x.item ? ' · ' + esc(x.item) : ''}${x.spot ? '<br><small class="sub">📍 ' + esc(x.spot) + '</small>' : ''}
      <div class="ouacts">${x.mobile ? link(x, 'Hi ' + fn + ", I'm running about 10 minutes late, sorry!", 'Running late') + link(x, 'Hi ' + fn + ", I'm here" + (x.spot ? ' at ' + x.spot : '') + ' now.', "I'm here") : ''}<button data-collx="${esc(x.start)}|${esc(x.key)}">Cancel</button></div></div>`; }).join('');
}
$('homeColl').onclick = e => {
  const c = e.target.dataset.collx; if (!c) return;
  const [st, key] = c.split('|');
  try { localStorage.setItem(LS_BOOKED, JSON.stringify(getBooked().filter(x => !(x.start === st && x.key === key)))); } catch (e2) {}
  renderHomeColl(); toast('Cancelled. That time is free again');
};

// Choose a buyer for a sale: search and scroll everyone you've sold to
function renderPick() {
  const q = $('bpickQ').value.trim().toLowerCase();
  const all = (BUYERS && BUYERS.buyers) || [], hit = q ? new Set(buyerSearch(q, all).map(h => h.b)) : null;
  const bs = all.filter(b => !q || hit.has(b) || String(b['interested in'] || '').toLowerCase().includes(q))
    .sort((a, b) => dayNum(b['last bought']) - dayNum(a['last bought']));
  $('bpickList').innerHTML = bs.length ? bs.map(b => `<button class="skrow" data-pk="${esc(b.key)}"><span>${esc(bName(b))}<span class="sm">${esc(buyerLine(b)) || 'Not bought yet (lead)'}</span></span></button>`).join('') : '<p class="sub">Nobody yet. Type their name in the box instead.</p>';
}
$('btnPickBuyer').onclick = async () => { $('bpick').classList.remove('hide'); $('bpickQ').value = ''; renderPick(); if (!BUYERS) { try { await loadBuyers(); renderPick(); } catch (e) {} } };
$('bpickQ').oninput = renderPick;
$('bpickClose').onclick = () => $('bpick').classList.add('hide');
$('bpickList').onclick = e => { const b = e.target.closest('[data-pk]'); if (!b) return; const x = findBuyer(b.dataset.pk); $('saBuyer').value = bName(x); $('bpick').classList.add('hide'); buyerHint(true); };

// Settings toggles
// Look: automatic (follows the phone), light or dark. Set before the page draws (index.html).
segSet('stTheme', window.getTheme ? window.getTheme() : 'auto');
$('stTheme').onclick = e => { const b = e.target.closest('button'); if (!b || !window.setTheme) return; window.setTheme(b.dataset.v); segSet('stTheme', b.dataset.v); };
$('stSaver').onchange = async () => {
  const on = $('stSaver').checked;
  try { await api('settingsSet', { settings: { readMode: on ? 'saver' : 'best' } }); toast(on ? 'Saver on: Flash-Lite first, checked against the total' : 'Saver off: the main model reads every receipt'); }
  catch (err) { $('stSaver').checked = !on; toast(err.message, true); }
};
$('stCrm').onchange = async () => {
  const on = $('stCrm').checked;
  try { await api('settingsSet', { settings: { crm: on } }); CFG.crm = on; saveCache(); crmSync(); toast(on ? 'Buyers turned on' : 'Buyers turned off. Your notes stay in the Sheet'); }
  catch (err) { $('stCrm').checked = !on; toast(err.message, true); }
};

// Sale form
const saBuyerHome = $('saBuyer').parentNode, saBuyerNext = $('saBuyer').nextSibling;
function crmSync() {
  const on = !!CFG.crm;
  $('slBuyers').classList.toggle('hide', !on);
  $('saCrm').classList.toggle('hide', !on);
  const inp = $('saBuyer'), lbl = inp.previousElementSibling;
  if (on && inp.parentNode !== $('saBuyerSlot')) { $('saBuyerSlot').appendChild(inp); if (lbl && /Buyer/.test(lbl.textContent)) lbl.classList.add('hide'); }
  if (!on && inp.parentNode === $('saBuyerSlot')) { saBuyerHome.insertBefore(inp, saBuyerNext); saBuyerHome.querySelectorAll('label.hide').forEach(l => l.classList.remove('hide')); }
  inp.removeAttribute('list');
  inp.placeholder = on ? 'Search name, username, number or email' : '';
}
function crmToggle() {
  if (!CFG.crm) return;
  const plat = $('saPlatform').value, hand = $('saHandWrap').classList.contains('hide') ? '' : segGet('saHand');
  $('saTurnWrap').classList.toggle('hide', !(plat === 'In person' || hand === 'Collected' || hand === 'Delivered'));
}
function buyerHint(prefill) {
  const b = findBuyer($('saBuyer').value);
  $('saBuyerHint').classList.toggle('hide', !b);
  if (!b) return;
  const warn = b.experience === 'Bad' || b['sell again'] === 'No' || Number(b['no-shows']) > 0;
  $('saBuyerHint').innerHTML = (warn ? '⚠️ ' : '') + `<b>${esc(bName(b))}</b>: ${esc(buyerLine(b)) || 'no sales yet'} ${buyerChips(b)} <button class="lnk" data-bk="${esc(b.key)}" style="background:none;border:0;color:#0a58ca;font:inherit;padding:4px 0;text-decoration:underline">View profile</button>`;
  if (prefill) {
    const put = (id, v) => { if (!$(id).value && v) $(id).value = v; };
    if (!$('saBMobile').value || $('saBMobile').value === '07') phoneSet('saBCc', 'saBMobile', b.mobile);
    put('saBEmail', b.email); put('saBOther', b['other contact']);
    if (!$('saBPref').value && b['preferred contact']) $('saBPref').value = b['preferred contact'];
    if (String(b['happy to hear about similar items']) === 'Yes') $('saBOpt').checked = true;
  }
}
$('saBuyer').addEventListener('input', () => { buyerHint(true); buyerSuggest(); });
$('saBuyer').addEventListener('blur', () => setTimeout(() => $('saBuyerSug').classList.add('hide'), 250));
// Find a buyer by anything you know about them: name, username, mobile (07… or +44…), email, Snapchat etc.
const digits = s => String(s || '').replace(/\D/g, '').replace(/^(44|0)/, '');
function buyerSearch(q, bs) {
  q = String(q || '').trim().toLowerCase(); const d = digits(q);
  if (!q) return [];
  return bs.map(b => {
    const f = [['name', b.name], ['username', b.username], ['email', b.email], ['other contact', b['other contact']], ['postcode', b.postcode]]
      .find(([, v]) => v && String(v).toLowerCase().includes(q));
    const byPhone = d.length >= 4 && b.mobile && digits(b.mobile).includes(d);
    return f || byPhone ? { b, via: byPhone && !f ? 'mobile ' + b.mobile : f[0] === 'name' || f[0] === 'username' ? '' : f[0] + ' ' + f[1] } : null;
  }).filter(Boolean);
}
function buyerSuggest() {
  const box = $('saBuyerSug'), q = $('saBuyer').value.trim();
  const hits = CFG.crm && q && !findBuyer(q) ? buyerSearch(q, (BUYERS && BUYERS.buyers) || []).slice(0, 6) : [];
  box.classList.toggle('hide', !hits.length);
  box.innerHTML = hits.map(h => `<button type="button" data-pk="${esc(h.b.key)}"><b>${esc(bName(h.b))}</b>${h.b.name && h.b.username ? ' <span class="sub">@' + esc(h.b.username) + '</span>' : ''}<span class="sm">${h.via ? 'Matched ' + esc(h.via) + ' · ' : ''}${esc(buyerLine(h.b)) || 'No sales yet'}</span></button>`).join('');
}
$('saBuyerSug').onclick = e => { const b = e.target.closest('[data-pk]'); if (!b) return; const x = findBuyer(b.dataset.pk); $('saBuyer').value = bName(x); $('saBuyerSug').classList.add('hide'); buyerHint(true); };
$('saBuyerHint').onclick = e => { const b = e.target.closest('[data-bk]'); if (b) { e.preventDefault(); openBuyer(b.dataset.bk, 'vSale'); } };
function listedHint() {
  const L = Number($('saListed').value), P = Number($('saPrice').value);
  $('saSoldFor').value = $('saPrice').value;
  const off = L > 0 && P > 0 ? Math.round((L - P) / L * 100) : null;
  $('saListedHint').innerHTML = off === null ? 'Listed at is what you first asked. Sold for comes from the sale price above.'
    : off <= 0 ? '<b>Paid the asking price</b>' : '<b>' + off + '% off asking</b> (' + money(L - P) + ' less). We save this so you can see how much buyers knock you down.';
  if (off !== null && !sale.styleSet) segSet('saStyle', off <= 0 ? 'Paid asking price' : off <= 12 ? 'Fair haggle' : off <= 30 ? 'Hard haggler' : 'Lowballer');
}
$('saListed').addEventListener('input', listedHint);
$('saPrice').addEventListener('input', () => { if (CFG.crm) listedHint(); });
['saExp', 'saAgain', 'saStyle', 'saTurn'].forEach(id => $(id).addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  segSet(id, segGet(id) === b.dataset.v ? '' : b.dataset.v);   // tap again to clear
  if (id === 'saStyle') sale.styleSet = true;
}));
function crmFill(o) {
  crmSync();
  $('saListed').value = num(o['listed at']) ?? '';
  segSet('saExp', o['buyer experience'] || ''); segSet('saAgain', o['sell again'] || ''); segSet('saStyle', o['buying style'] || ''); segSet('saTurn', o['turned up'] || '');
  sale.styleSet = !!o['buying style'];
  $('saInts').value = o['buyer interests'] || ''; $('saBNote').value = o['buyer note'] || '';
  sale.intsAuto = !o['buyer interests'];
  ['saBEmail', 'saBOther'].forEach(id => { $(id).value = ''; }); phoneSet('saBCc', 'saBMobile', ''); $('saBPref').value = ''; $('saBOpt').checked = false;
  $('saContact').open = false; $('saBuyerSug').classList.add('hide');
  listedHint();
  if (CFG.crm) { buyerHint(true); crmToggle(); autoInts(); if (!BUYERS) loadBuyers().catch(() => {}); }
}
function crmPayload(s) {
  if (!CFG.crm) return null;
  const v = id => $(id).value.trim();
  Object.assign(s, { 'listed at': v('saListed'), 'buyer experience': segGet('saExp') || '', 'sell again': segGet('saAgain') || '',
    'buying style': segGet('saStyle') || '', 'turned up': $('saTurnWrap').classList.contains('hide') ? '' : (segGet('saTurn') || ''),
    'buyer interests': v('saInts'), 'buyer note': v('saBNote') });
  if (!s.buyer) return null;
  return { postcode: s.handover === 'Delivered' ? v('saDropTo').toUpperCase() : undefined, home: homeAddr() || undefined,
    email: v('saBEmail'), mobile: phoneGet('saBCc', 'saBMobile'), preferred: $('saBPref').value, other: v('saBOther'), optIn: $('saBOpt').checked };
}

// Buyers list
async function openBuyers() {
  show('vBuyers');
  renderBuyers();
  try { await loadBuyers(); renderBuyers(); }
  catch (err) { if (!BUYERS) $('byList').innerHTML = '<p class="sub">' + esc(/Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for this.' : err.message) + '</p>'; }
}
var byFilter = '', bySelecting = false, byPicked = new Set();
// eBay/Amazon buyers can be picked, with a warning: their policy forbids it, so it's at your own risk.
const canPick = b => !!(b.canMessage || b.marketOnly || b.ebayOnly);
const mkt = b => b.marketOnly || (b.ebayOnly ? 'eBay' : '');
const EBAY_QUOTE = 'eBay\'s policy says members must not "contact other members to make offers to buy or sell items outside of eBay, or use information obtained on eBay to solicit sales outside of eBay."';
const dayNum = s => { const m = String(s || '').match(/(\d+)\/(\d+)\/(\d+)/); return m ? new Date(+m[3], m[2] - 1, +m[1]).getTime() : 0; };
const howTag = b => b['usually buys by'] ? `<span class="bchip ${b['usually buys by'] === 'Collects' ? 'good' : ''}">${{ Collects: '💷 Collects', 'Drop-off': '🚗 Drop-off', Online: '📦 Online', Mixed: 'Mixed' }[b['usually buys by']] || esc(b['usually buys by'])}${b['miles from home'] !== '' && b['miles from home'] !== undefined ? ' · ' + esc(b['miles from home']) + ' mi' : ''}</span>` : (b['miles from home'] ? `<span class="bchip">${esc(b['miles from home'])} mi</span>` : '');
function buyersShown() {
  const q = $('byQ').value.trim().toLowerCase(), bs = (BUYERS && BUYERS.buyers) || [];
  const list = bs.filter(b => (!q || [b.name, b.username, b['interested in'], b.notes, b.email, b.platforms, b.postcode].join(' ').toLowerCase().includes(q))
    && (!byFilter || (byFilter === 'msg' ? b.canMessage : byFilter === 'lead' ? !(Number(b['times bought']) > 0) : b['usually buys by'] === byFilter)));
  const by = $('bySort').value, n = x => Number(x) || 0;
  return list.sort(by === 'spent' ? (a, b) => n(b['total spent']) - n(a['total spent']) : by === 'times' ? (a, b) => n(b['times bought']) - n(a['times bought'])
    : by === 'near' ? (a, b) => { const m = x => x['miles from home'] === '' || x['miles from home'] == null ? 1e9 : n(x['miles from home']); return m(a) - m(b); }
    : by === 'az' ? (a, b) => bName(a).localeCompare(bName(b)) : (a, b) => dayNum(b['last bought']) - dayNum(a['last bought']));
}
function renderBuyers() {
  const list = buyersShown();
  $('byList').innerHTML = !BUYERS ? '<p class="sub">Loading…</p>' : list.length ? list.map(b => `<button class="skrow${bySelecting && !canPick(b) ? ' off' : ''}" data-bk="${esc(b.key)}">${bySelecting ? `<input type="checkbox" class="pick" ${byPicked.has(b.key) ? 'checked' : ''} ${canPick(b) ? '' : 'disabled'} tabindex="-1">` : ''}<span style="flex:1">${esc(bName(b))}${b.name && b.username ? ' <small class="sub">@' + esc(b.username) + '</small>' : ''}<span class="sm">${esc(buyerLine(b)) || 'Not bought yet (lead)'}${bySelecting && !b.canMessage ? ' · ' + (mkt(b) ? '⚠️ ' + mkt(b) + ' policy: contact at your own risk' : 'hasn\'t said yes to messages') : ''}</span><span class="bchips">${howTag(b)}</span>${buyerChips(b)}</span>${bySelecting ? '' : '<span class="go" style="align-self:center">›</span>'}</button>`).join('')
    : '<p class="sub" style="padding:10px 0">' + ($('byQ').value || byFilter ? 'Nobody matches.' : 'No buyers yet. Add a name when you log a sale, or tap ＋ Add (also for someone you spoke to who hasn\'t bought yet).') + '</p>';
  $('bySelBar').classList.toggle('hide', !bySelecting);
  $('bySelN').textContent = byPicked.size + ' picked';
  $('btnBySelect').textContent = bySelecting ? 'Done' : 'Select';
}
$('byFilter').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; byFilter = b.dataset.f; $('byFilter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); renderBuyers(); };
$('bySort').onchange = renderBuyers;
$('btnBySelect').onclick = () => { bySelecting = !bySelecting; if (!bySelecting) byPicked.clear(); renderBuyers(); };
$('bySelAll').onclick = () => { buyersShown().filter(b => b.canMessage).forEach(b => byPicked.add(b.key)); renderBuyers(); };   // eBay/Amazon buyers: tick them yourself
$('btnByMsg').onclick = () => { const bs = ((BUYERS && BUYERS.buyers) || []).filter(b => byPicked.has(b.key)); if (!bs.length) { toast('Tick who to message', true); return; } openOutreach(bs, '', 'vBuyers'); };
$('byQ').oninput = renderBuyers;
$('byList').onclick = e => {
  const b = e.target.closest('[data-bk]'); if (!b) return;
  if (bySelecting) { e.preventDefault(); const x = findBuyer(b.dataset.bk); if (!x || !canPick(x)) { toast('Only people who said they\'re happy to hear from you', true); return; }
    if (!x.canMessage && !byPicked.has(x.key)) toast('⚠️ ' + mkt(x) + ' buyer: their policy doesn\'t allow this. At your own risk.', true);
    byPicked.has(x.key) ? byPicked.delete(x.key) : byPicked.add(x.key); renderBuyers(); return; }
  openBuyer(b.dataset.bk, 'vBuyers');
};
$('slBuyers').onclick = openBuyers;
$('btnBuyersBack').onclick = () => openSales();
$('btnBuyerAdd').onclick = () => openBuyer(null, 'vBuyers');

// One buyer
const telUK = m => { const d = String(m || '').replace(/[^\d+]/g, ''); return d.startsWith('+') ? d.slice(1) : d.startsWith('0') ? '44' + d.slice(1) : d; };
async function openBuyer(key, from) {
  bpKey = key; bpFrom = from || 'vBuyers'; BP = key ? findBuyer(key) || null : null;
  show('vBuyer');
  $('bpEdit').classList.toggle('hide', !!key); $('bpView').classList.toggle('hide', !key); $('btnBuyerEdit').classList.toggle('hide', !key);
  if (!key) { $('bpName').textContent = 'Add a buyer'; fillBuyerEdit({}); return; }
  renderBuyer();
  try { BP = await api('buyer', { key }); renderBuyer(); } catch (err) { if (!BP) $('bpView').innerHTML = '<p class="sub">' + esc(err.message) + '</p>'; }
}
function renderBuyer() {
  const b = BP;
  if (!b) { $('bpView').innerHTML = '<p class="sub">Loading…</p>'; return; }
  $('bpName').textContent = bName(b);
  const keepW = [($('wItem') || {}).value || '', ($('wMax') || {}).value || ''];   // don't lose what's being typed when fresh data arrives
  const pref = String(b['preferred contact'] || ''), acts = [];
  const act = (label, href, kind) => acts.push(`<a href="${esc(href)}" ${/^https/.test(href) ? 'target="_blank" rel="noopener"' : ''} class="${pref === kind ? 'pref' : ''}">${label}</a>`);
  if (b.mobile) { act('WhatsApp', 'https://wa.me/' + telUK(b.mobile), 'WhatsApp'); act('Text', 'sms:' + b.mobile, 'Text'); act('Call', 'tel:' + b.mobile, 'Phone call'); }
  if (b.email) act('Email', 'mailto:' + b.email, 'Email');
  const warn = [];
  const mk = b.marketOnly || (b.ebayOnly ? 'eBay' : '');
  if (mk) warn.push(mk + ' buyer. ' + (/eBay/.test(mk) ? EBAY_QUOTE : 'Amazon\'s rules also don\'t allow contacting buyers about sales outside Amazon.') + ' You can still message them here, at your own risk: ' + mk + ' can remove listings or restrict or suspend your account.');
  else if (!b.canMessage) warn.push('They haven\'t said they\'re happy to hear about new items. Only message them about things they\'ve asked for.');
  if (b.experience === 'Bad' || b['sell again'] === 'No') warn.push('You marked: ' + [b.experience === 'Bad' ? 'bad experience' : '', b['sell again'] === 'No' ? 'don\'t sell to them again' : ''].filter(Boolean).join(', ') + '.');
  if (Number(b['no-shows']) > 0) warn.push(b['no-shows'] + ' no-show' + (b['no-shows'] > 1 ? 's' : '') + '.');
  const row = (k, v) => v === '' || v === undefined || v === null ? '' : `<div class="nrow"><span>${k}</span><b>${esc(v)}</b></div>`;
  $('bpView').innerHTML =
    (b.username && b.name ? `<p class="sub">@${esc(b.username)}</p>` : '') +
    (warn.length ? `<div class="warn">${warn.map(esc).join('<br>')}</div>` : (b.canMessage ? '<p class="sub">✓ Happy to hear about similar items</p>' : '')) +
    (acts.length ? `<div class="bpacts">${acts.join('')}</div>` : '') +
    (pref || b['other contact'] ? `<p class="sub">Best way to reach them: <b>${esc(pref || 'not sure')}</b>${b['other contact'] ? ' · ' + esc(b['other contact']) : ''}</p>` : '') +
    `<span class="bchips">${howTag(b)}</span>` + buyerChips(b) +
    `<div class="ncard" style="margin-top:10px">${row('Times bought', b['times bought'] || 0)}${row('Total spent', b['total spent'] ? money(b['total spent']) : '')}${row('Last bought', b['last bought'])}${row('Average off your asking price', b['avg off asking %'] !== '' ? b['avg off asking %'] + '%' : '')}${row('Usually buys by', b['usually buys by'] ? b['usually buys by'] + ' (' + [b.collects ? b.collects + ' collected' : '', b['drop-offs'] ? b['drop-offs'] + ' dropped off' : '', b.online ? b.online + ' online' : ''].filter(Boolean).join(', ') + ')' : '')}${row('Postcode', b.postcode)}${row('Miles from home', b['miles from home'] !== '' ? b['miles from home'] + ' miles' : '')}${row('Last contacted', b['last contacted'])}${row('Turned up', b['turned up'])}${row('Refunds', b.refunds || '')}${row('Where they buy', b.platforms)}${row('First seen', b['first seen'])}</div>` +
    `<h3 class="sech">Wanted</h3><div class="card" style="padding:6px 14px">${wantedParse(b.wanted).map((w, i) => `<div class="wrow"><span>${esc(w.item)}${w.max ? ' · up to ' + money(w.max) : ''}${w.date ? ' <small class="sub">' + esc(w.date) + '</small>' : ''}</span><button class="lnk" data-wd="${i}" style="background:none;border:0;color:#0a58ca;font:inherit">✕</button></div>`).join('') || '<p class="sub">Nothing specific yet. Something they asked for that you haven\'t got?</p>'}
      <div class="duo" style="margin-top:6px"><div><input id="wItem" placeholder="e.g. Ninja air fryer" autocomplete="off"></div><div class="telrow"><input id="wMax" type="number" inputmode="decimal" placeholder="Up to £"><button class="btn sec" id="btnWAdd" style="width:auto;margin:0;padding:8px 12px">Add</button></div></div>
      <p class="hint">When you buy something that matches, they're shown first.</p></div>` +
    (b.notes ? `<h3 class="sech">Notes</h3><div class="card" style="white-space:pre-wrap">${esc(b.notes)}</div>` : '') +
    (b.sales && b.sales.length ? `<h3 class="sech">What they bought</h3><div class="card" style="padding:4px 14px">${b.sales.map(x => `<div class="skrow"><span>${esc(x.item)}<span class="sm">${esc(x.date)} · ${esc(x.platform)}${x.listed ? ' · listed ' + money(x.listed) : ''}${x.note ? ' · ' + esc(x.note) : ''}</span></span><b>${money(x.price)}</b></div>`).join('')}</div>` : '');
  if ($('wItem')) { $('wItem').value = keepW[0]; $('wMax').value = keepW[1]; }
}
// Wanted: same readable format as the Sheet: "Ninja air fryer (up to £60, 13/11/2026); …"
function wantedParse(t) {
  return String(t || '').split(/;\s*/).map(x => x.trim()).filter(Boolean).map(x => {
    const m = x.match(/^(.*?)\s*\((.*)\)\s*$/), inner = m ? m[2] : '';
    return { item: (m ? m[1] : x).trim(), max: (inner.match(/up to £\s*([\d.]+)/i) || [])[1] || '', date: (inner.match(/(\d{1,2}\/\d{1,2}\/\d{4})/) || [])[1] || '' };
  });
}
const wantedText = list => list.map(w => w.item + ' (' + [w.max ? 'up to £' + w.max : '', w.date].filter(Boolean).join(', ') + ')').join('; ');
async function saveWanted(list) {
  try { BP = await api('buyerSave', { key: BP.key, buyer: { wanted: wantedText(list) } }); renderBuyer(); loadBuyers().catch(() => {}); }
  catch (err) { toast(err.message, true); }
}
$('bpView').addEventListener('click', e => {
  if (!BP) return;
  if (e.target.id === 'btnWAdd') {
    const item = $('wItem').value.trim(); if (!item) { toast('What do they want?', true); return; }
    const d = new Date(), date = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
    const max = $('wMax').value.trim(); $('wItem').value = ''; $('wMax').value = '';
    saveWanted(wantedParse(BP.wanted).concat([{ item, max, date }])); toast('Added to their wanted list');
  }
  const wd = e.target.dataset.wd;
  if (wd !== undefined) { const l = wantedParse(BP.wanted); l.splice(+wd, 1); saveWanted(l); }
});

function fillBuyerEdit(b) {
  $('beName').value = b.name || ''; $('beUser').value = b.username || ''; phoneSet('beCc', 'beMobile', b.mobile); $('beEmail').value = b.email || '';
  $('bePref').value = b['preferred contact'] || ''; $('beOther').value = b['other contact'] || '';
  $('beOpt').checked = String(b['happy to hear about similar items']) === 'Yes';
  segSet('beExp', b.experience || ''); segSet('beAgain', b['sell again'] || ''); segSet('beStyle', b['buying style'] || '');
  $('beInts').value = b['interested in'] || ''; $('beNotes').value = b.notes || ''; $('bePostcode').value = b.postcode || '';
}
['beExp', 'beAgain', 'beStyle'].forEach(id => $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (b) segSet(id, segGet(id) === b.dataset.v ? '' : b.dataset.v); }));
$('btnBuyerMsg').onclick = () => { if (BP) openOutreach([BP], '', 'vBuyer'); };
$('btnBuyerEdit').onclick = () => { fillBuyerEdit(BP || {}); $('bpView').classList.add('hide'); $('bpEdit').classList.remove('hide'); $('btnBuyerEdit').classList.add('hide'); };
$('btnBuyerBack').onclick = () => { if (bpFrom === 'vSale') show('vSale'); else if (bpFrom === 'vMatch') show('vMatch'); else if (bpFrom === 'vHome') show('vHome'); else openBuyers(); };
$('btnBuyerSave').onclick = async () => {
  const v = id => $(id).value.trim();
  const buyer = { name: v('beName'), username: v('beUser'), mobile: phoneGet('beCc', 'beMobile'), email: v('beEmail'), 'preferred contact': $('bePref').value,
    'other contact': v('beOther'), 'happy to hear about similar items': $('beOpt').checked, experience: segGet('beExp') || '', 'sell again': segGet('beAgain') || '',
    'buying style': segGet('beStyle') || '', 'interested in': v('beInts'), notes: $('beNotes').value.trim(), postcode: v('bePostcode').toUpperCase() };
  if (!buyer.name && !buyer.username) { toast('Add a name or username', true); return; }
  const b = $('btnBuyerSave'); b.disabled = true; b.textContent = 'Saving…';
  try {
    BP = await api('buyerSave', { key: bpKey || undefined, buyer, home: homeAddr() || undefined });
    bpKey = BP.key;
    loadBuyers().catch(() => {});
    $('bpEdit').classList.add('hide'); $('bpView').classList.remove('hide'); $('btnBuyerEdit').classList.remove('hide');
    renderBuyer(); toast('Saved');
  } catch (err) { toast(err.message, true); }
  b.disabled = false; b.textContent = 'Save';
};

// Who might want it: after saving a purchase, and on the Stock page
var MT = [], mtPicked = new Set();
function renderMatchList(matches) {
  return matches.map((m, mi) => `<h3 class="sech">${esc(m.item)}</h3><div class="card" style="padding:4px 14px">${m.buyers.map(b => `<button class="skrow${canPick(b) ? '' : ' off'}" data-bk="${esc(b.key)}" data-mi="${mi}"><input type="checkbox" class="pick" data-pick="${mi}|${esc(b.key)}" ${mtPicked.has(mi + '|' + b.key) ? 'checked' : ''} ${canPick(b) ? '' : 'disabled'}><span style="flex:1">${esc(bName(b))}<span class="sm">${b.wanted ? '<b>Asked for ' + esc(b.tag) + (b.wantMax ? ' (up to ' + money(b.wantMax) + ')' : '') + '</b>' : 'Interested in ' + esc(b.tag)}${b['preferred contact'] ? ' · best by ' + esc(b['preferred contact']) : ''}</span><span class="bchips">${howTag(b)}</span><span class="sm">${mkt(b) ? '⚠️ ' + mkt(b) + ' buyer: their policy forbids this. Tick at your own risk' : b.canMessage ? '✓ Happy to hear about similar items' : '⚠️ Hasn\'t said they\'re happy to hear from you'}</span></span><span class="go" style="align-self:center">›</span></button>`).join('')}</div>`).join('');
}
function openMatch(matches) {
  show('vMatch');
  if (matches) { MT = matches; mtPicked = new Set(); MT.forEach((m, mi) => m.buyers.forEach(b => { if (b.canMessage) mtPicked.add(mi + '|' + b.key); })); }
  renderMatch();
}
function renderMatch() {
  $('mtList').innerHTML = '<p class="hint">These buyers said they\'re after something like this. Cash buyers who collect are usually the quickest sale. Tick who to message, or tap a name for their details.</p>' + renderMatchList(MT);
  $('mtSelN').textContent = mtPicked.size + ' picked';
}
$('mtList').onclick = e => {
  const p = e.target.closest('[data-pick]');
  if (p) { e.stopPropagation(); p.checked ? mtPicked.add(p.dataset.pick) : mtPicked.delete(p.dataset.pick); $('mtSelN').textContent = mtPicked.size + ' picked'; return; }
  const b = e.target.closest('[data-bk]'); if (b) openBuyer(b.dataset.bk, 'vMatch');
};
$('btnMtMsg').onclick = () => {
  const pick = [...mtPicked].map(k => k.split('|')), items = [...new Set(pick.map(x => +x[0]))];
  const seen = new Set(), bs = [];
  pick.forEach(([mi, key]) => { const b = MT[+mi] && MT[+mi].buyers.find(x => x.key === key); if (b && !seen.has(key)) { seen.add(key); bs.push(b); } });
  if (!bs.length) { toast('Tick who to message', true); return; }
  openOutreach(bs, items.length === 1 ? MT[items[0]].item : '', 'vMatch');
};
$('btnMatchBack').onclick = () => show(STOCK && $('vStock').dataset.fromMatch ? 'vStock' : 'vHome');
// Message buyers: one personalised message each (WhatsApp / text / email). Free: WhatsApp and texts open
// with the message ready (one tap to send each, no group chats); emails go one by one from your Gmail.
const LS_OUTMSG = 'rs_out_msg';
const DEF_MSG = "Hi [Name],\nI've got this new [Item]. Here are the key features:\n[Features]\nThe price is £[Price]. Would you be interested?\nLet me know soon as it's in demand.";
var OU = { list: [], from: 'vBuyers', done: {} };
function openOutreach(buyers, item, from) {
  OU = { list: buyers, from: from || 'vBuyers', done: {} };
  $('ouItem').value = item || ''; $('ouPrice').value = ''; $('ouFeat').value = '';
  $('ouMsg').value = localStorage.getItem(LS_OUTMSG) || DEF_MSG;
  ouPhoto = null; $('ouPhoto').value = ''; $('ouPhotoName').textContent = '';
  $('ouTpl').innerHTML = '<option value="">Your last message</option>' + getTpls().map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('');
  $('ouSpot').innerHTML = '<option value="">None</option>' + getSpots().map((x, i) => `<option value="${i}">${esc(x.name)}</option>`).join('');
  show('vOutreach'); renderOutreach(); loadGuide();
  // The latest saved messages (they may have been changed in ListMe)
  syncTpls().then(ok => { if (ok && $('vOutreach') && !$('vOutreach').classList.contains('hide')) { const v = $('ouTpl').value; $('ouTpl').innerHTML = '<option value="">Your last message</option>' + getTpls().map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join(''); $('ouTpl').value = v; } });
}
// The photo stays in this page's memory only: it goes straight from your phone to the app you share to.
var ouPhoto = null;
$('ouPhoto').onchange = () => { ouPhoto = $('ouPhoto').files[0] || null; $('ouPhotoName').textContent = ouPhoto ? '✓ ' + ouPhoto.name : ''; renderOutreach(); };
$('ouTpl').onchange = () => { const t = getTpls()[+$('ouTpl').value]; $('ouMsg').value = t ? t.text : (localStorage.getItem(LS_OUTMSG) || DEF_MSG); renderOutreach(); };
$('ouSpot').onchange = renderOutreach;
// Price guide: same title only for the average; near titles listed for you to judge
let guideTimer = null;
function loadGuide() {
  clearTimeout(guideTimer);
  const item = $('ouItem').value.trim();
  if (item.length < 3) { $('ouGuide').classList.add('hide'); return; }
  guideTimer = setTimeout(async () => {
    try {
      const g = await api('priceGuide', { item });
      if (item !== $('ouItem').value.trim()) return;
      const h = [];
      if (g.exact) h.push(`<b>Sold ${g.exact.n} before with this exact title:</b> average ${money(g.exact.avg)}` + (g.exact.n > 1 ? ` (${money(g.exact.min)}–${money(g.exact.max)})` : '') + (g.exact.days !== '' ? `, about ${g.exact.days} days to sell` : '') + `. <button data-gp="${g.exact.avg}">Use ${money(g.exact.avg)}</button>`);
      if (g.similar && g.similar.length) h.push('<b>Similar titles</b> (not in the average):<br>' + g.similar.map(x => `${esc(x.item)}: ${money(x.price)} · ${esc(x.date)}${x.days !== '' ? ' · ' + x.days + ' days' : ''}`).join('<br>'));
      $('ouGuide').innerHTML = h.join('<br>') || 'You haven\'t sold this exact item before.';
      $('ouGuide').classList.remove('hide');
    } catch (e) { $('ouGuide').classList.add('hide'); }
  }, 400);
}
$('ouItem').addEventListener('input', loadGuide);
$('ouGuide').onclick = e => { const b = e.target.closest('[data-gp]'); if (b) { $('ouPrice').value = b.dataset.gp; renderOutreach(); } };
const firstName = b => String(b.name || b.username || '').trim().split(/\s+/)[0] || 'there';
function personal(b) {
  const feats = $('ouFeat').value.trim().split('\n').map(x => x.trim()).filter(Boolean).map(x => '• ' + x).join('\n');
  const sp = getSpots()[+$('ouSpot').value];
  return $('ouMsg').value.replace(/\[Times\]/g, timesText()).replace(/\[Name\]/g, firstName(b)).replace(/\[Item\]/g, $('ouItem').value.trim() || 'item')
    .replace(/\[Spot\]/g, sp ? sp.name + (sp.addr ? ' (' + sp.addr + ')' : '') : 'my usual spot').replace(/\[Directions\]/g, sp ? sp.dir || '' : '')
    .replace(/\[Features\]/g, feats || '').replace(/\[Price\]/g, $('ouPrice').value.trim() || '?').replace(/\n{3,}/g, '\n\n');
}
function renderOutreach() {
  const L = OU.list, risky = L.filter(b => mkt(b));
  $('ouWarn').classList.toggle('hide', !risky.length);
  if (risky.length) $('ouWarn').innerHTML = '<b>⚠️ ' + risky.length + ' of these ' + (risky.length === 1 ? 'is an' : 'are') + ' eBay or Amazon buyer' + (risky.length === 1 ? '' : 's') + '.</b> ' + esc(EBAY_QUOTE) +
    ' Amazon has similar rules. You can still contact them, but <b>it\'s at your own risk</b>: they can remove listings, restrict or suspend your account.';
  $('ouCount').textContent = L.length + ' ' + (L.length === 1 ? 'person' : 'people');
  const withEmail = L.filter(b => b.email).length;
  $('btnOuEmailAll').classList.toggle('hide', !withEmail); $('ouGmailNote').classList.toggle('hide', !withEmail);
  $('btnOuEmailAll').textContent = 'Email ' + (withEmail === 1 ? 'the 1 person' : 'all ' + withEmail) + ' with an email';
  $('ouList').innerHTML = L.map((b, i) => {
    const t = encodeURIComponent(personal(b)), d = OU.done[b.key] || {};
    const acts = [];
    if (b.mobile) {
      acts.push(`<a href="https://wa.me/${telUK(b.mobile)}?text=${t}" target="_blank" rel="noopener" data-ou="${i}|WhatsApp" class="${d.WhatsApp ? 'done' : ''}">${d.WhatsApp ? '✓ ' : ''}WhatsApp</a>`);
      acts.push(`<a href="sms:${String(b.mobile).replace(/\s/g, '')}?&body=${t}" data-ou="${i}|text" class="${d.text ? 'done' : ''}">${d.text ? '✓ ' : ''}Text</a>`);
    }
    if (b.email) acts.push(`<button data-oue="${i}" class="${d.email ? 'done' : ''}">${d.email ? '✓ Emailed' : 'Email'}</button>`);
    if (navigator.share) acts.push(`<button data-oushare="${i}" class="${d.share ? 'done' : ''}">${d.share ? '✓ ' : ''}Share${ouPhoto ? ' with photo' : ''}</button>`);
    acts.push(`<button data-oubook="${i}" class="${d.book ? 'done' : ''}">${d.book ? '✓ ' + esc(d.book) : 'Book a time'}</button>`);
    acts.push(`<button data-ousold="${i}">Sold to ${esc(firstName(b))}</button>`);
    return `<div class="skrow" style="display:block"><b>${esc(bName(b))}</b> <span class="bchips" style="display:inline-flex">${howTag(b)}${mkt(b) ? '<span class="bchip bad">⚠️ ' + esc(mkt(b)) + ' buyer: own risk</span>' : ''}</span>
      <span class="sm">${b['preferred contact'] ? 'Best by ' + esc(b['preferred contact']) : ''}${b['other contact'] ? ' · ' + esc(b['other contact']) : ''}${!b.mobile && !b.email ? 'No number or email saved: message them where you usually do' : ''}</span>
      <div class="ouacts">${acts.join('')}</div></div>`;
  }).join('');
}
['ouItem', 'ouPrice', 'ouFeat', 'ouMsg'].forEach(id => $(id).addEventListener('input', () => { if (id === 'ouMsg') { try { localStorage.setItem(LS_OUTMSG, $('ouMsg').value); } catch (e) {} } renderOutreach(); }));
$('ouList').addEventListener('click', e => {
  const a = e.target.closest('[data-ou]');
  if (a) {   // the link opens WhatsApp / Messages; we note it as done
    const [i, how] = a.dataset.ou.split('|'), b = OU.list[+i];
    OU.done[b.key] = Object.assign(OU.done[b.key] || {}, { [how]: true });
    api('buyerContacted', { keys: [b.key], how, item: $('ouItem').value.trim() }).catch(() => {});
    setTimeout(renderOutreach, 300);
    return;
  }
  const m = e.target.closest('[data-oue]');
  if (m) sendOutEmails([OU.list[+m.dataset.oue]]);
  const sh = e.target.closest('[data-oushare]');
  if (sh) shareTo(OU.list[+sh.dataset.oushare]);
  const bk = e.target.closest('[data-oubook]');
  if (bk) openSlotPick(OU.list[+bk.dataset.oubook]);
  const so = e.target.closest('[data-ousold]');
  if (so) soldTo(OU.list[+so.dataset.ousold], $('ouItem').value.trim(), $('ouPrice').value.trim());
});
// Your phone's share sheet: photo + message to WhatsApp, Messages, Instagram… You pick the person there.
async function shareTo(b) {
  const text = personal(b);
  try { await navigator.clipboard.writeText(text); } catch (e) {}   // some apps drop the text when a photo is shared: it's ready to paste
  const data = { text };
  if (ouPhoto && navigator.canShare && navigator.canShare({ files: [ouPhoto] })) data.files = [ouPhoto];
  try {
    await navigator.share(data);
    OU.done[b.key] = Object.assign(OU.done[b.key] || {}, { share: true });
    api('buyerContacted', { keys: [b.key], how: 'shared', item: $('ouItem').value.trim() }).catch(() => {});
    renderOutreach();
    if (data.files) toast('If the message didn\'t go with the photo, paste it: it\'s copied');
  } catch (e) { if (e.name !== 'AbortError') toast('Couldn\'t open sharing: ' + e.message, true); }
}
// "Sold to John": the sale form, already filled in with them, the item and price (and the stock it came from)
function soldTo(b, item, price) {
  openSale(null);
  const plats = String(b.platforms || '');
  const want = /facebook/i.test(plats) ? 'Facebook Marketplace' : 'In person';
  if ([...$('saPlatform').options].some(o => o.value === want || o.textContent === want)) $('saPlatform').value = want;
  saleWhereToggle();
  if (item) {
    const st = (STOCK && STOCK.items || []).find(x => bKey(x.item) === bKey(item));
    if (st) linkPurchase(st); else { $('saItem').value = item; try { autoInts(); } catch (e) {} }
  }
  if (price) $('saPrice').value = price;
  $('saBuyer').value = bName(b); buyerHint(true);
  saleCalc();
  toast('Check the details, then Save sale');
}

async function sendOutEmails(list) {
  list = list.filter(b => b.email && !(OU.done[b.key] || {}).email);
  if (!list.length) { toast('Already emailed'); return; }
  const item = $('ouItem').value.trim();
  const risky = list.filter(b => mkt(b)).length;
  if (!confirm('Send ' + list.length + ' email' + (list.length > 1 ? 's' : '') + ' from your Gmail, one to each person?\n\nGmail lets you send about 100 emails a day.' + (risky ? '\n\n⚠️ ' + risky + ' ' + (risky === 1 ? 'is an eBay/Amazon buyer' : 'are eBay/Amazon buyers') + ': their policy forbids this. Sending is at your own risk.' : ''))) return;
  try {
    const r = await api('buyerEmail', { item, acceptRisk: true, messages: list.map(b => ({ key: b.key, subject: item ? item + ' – are you interested?' : 'Something you might like', body: personal(b) })) });
    list.forEach(b => { if (!(r.skipped || []).some(x => x.key === b.key)) OU.done[b.key] = Object.assign(OU.done[b.key] || {}, { email: true }); });
    toast('Sent ' + r.sent + ' email' + (r.sent === 1 ? '' : 's') + ((r.skipped || []).length ? ' · ' + r.skipped.length + ' skipped' : ''));
    renderOutreach();
  } catch (err) { toast(err.message, true); }
}
$('btnOuEmailAll').onclick = () => sendOutEmails(OU.list);
$('btnOutBack').onclick = () => { if (OU.from === 'vMatch') show('vMatch'); else if (OU.from === 'vBuyer') show('vBuyer'); else openBuyers(); };

function renderHomeMatch() {
  let m = null; try { m = JSON.parse(localStorage.getItem(LS_MATCH)); } catch (e) {}
  const show_ = !!(CFG.crm && m && m.matches && m.matches.length);
  $('homeMatch').classList.toggle('hide', !show_);
  if (!show_) return;
  const people = new Set(); m.matches.forEach(x => x.buyers.forEach(b => people.add(b.key)));
  $('homeMatch').innerHTML = `<b>👥 ${people.size} buyer${people.size > 1 ? 's' : ''} might want what you just bought</b>
    <p class="sub" style="margin:4px 0">${m.matches.slice(0, 3).map(x => esc(x.item) + ': ' + x.buyers.slice(0, 3).map(b => esc(bName(b))).join(', ')).join('<br>')}</p>
    <button class="lnk" id="hmOpen">See who</button> &nbsp; <button class="lnk" id="hmClose" style="color:#666">Dismiss</button>`;
  $('hmOpen').onclick = () => { delete $('vStock').dataset.fromMatch; openMatch(m.matches); };
  $('hmClose').onclick = () => { try { localStorage.removeItem(LS_MATCH); } catch (e) {} renderHomeMatch(); };
}
async function matchPurchase(items) {
  if (!CFG.crm || !items.length) return;
  try {
    const r = await api('buyerMatch', { items });
    if (r.matches && r.matches.length) {
      localStorage.setItem(LS_MATCH, JSON.stringify({ when: Date.now(), matches: r.matches })); renderHomeMatch();
      const n = new Set(); r.matches.forEach(x => x.buyers.forEach(b => n.add(b.key)));
      if ($('vHome').classList.contains('hide')) toast('👥 ' + n.size + ' buyer' + (n.size > 1 ? 's' : '') + ' might want this. See your home screen');   // e.g. straight on to the next emailed receipt
    }
  } catch (e) {}
}
var STOCK_MATCH = {};
async function loadStockMatches() {
  if (!CFG.crm || !STOCK || !STOCK.items.length) { STOCK_MATCH = {}; return; }
  try {
    const r = await api('buyerMatch', { items: [...new Set(STOCK.items.map(x => x.item))] });
    STOCK_MATCH = {}; (r.matches || []).forEach(m => { STOCK_MATCH[m.item] = m; });
    renderStockPage();
  } catch (e) {}
}
try { if (BUYERS) fillBuyerLists(); crmSync(); renderHomeMatch(); } catch (e) {}

/* ---------- Trips to log: drop-offs (✓ Posted, drop-off receipt emails) and FlipCheck collections ---------- */
var TRIPS = null;
const LS_POSTED_TRIP = 'rs_posted_trip', LS_DROP_SESSION = 'rs_drop_session', LS_DROP_PLACES = 'rs_drop_places';
function postedTrip() { try { return JSON.parse(localStorage.getItem(LS_POSTED_TRIP) || '{}') || {}; } catch (e) { return {}; } }
function setPostedTrip(id, v) { const pt = postedTrip(); pt[id] = v; lsSet(LS_POSTED_TRIP, pt); }
// Several parcels in one go: the first one asks, the rest join the same trip for 3 hours
function dropSession(v) {
  if (v) { lsSet(LS_DROP_SESSION, Object.assign({ at: Date.now() }, v)); return; }
  try { const d = JSON.parse(localStorage.getItem(LS_DROP_SESSION) || 'null'); return d && Date.now() - d.at < 3 * 3600e3 ? d : null; } catch (e) { return null; }
}
const DROP_TYPES = [['Locker', '🔐 Locker'], ['ParcelShop', '🏪 ParcelShop'], ['Post Office', '📮 Post Office'], ['Pickup point', '📍 Pickup point'], ['Home', '🏠 Collected from home']];
const dropGuess = courier => /inpost/i.test(courier || '') ? 'Locker' : /evri|hermes/i.test(courier || '') ? 'ParcelShop' : /royal mail|parcelforce/i.test(courier || '') ? 'Post Office' : /dpd|yodel|ups/i.test(courier || '') ? 'Pickup point' : '';
async function loadTrips() {
  TRIPS = await api('tripsToLog', {});
  if (CFG.waiting) { CFG.waiting.tripsToLog = TRIPS.length; renderTodo(CFG.waiting); }
  return TRIPS;
}
function offerDropTrip(l) {
  const ses = dropSession();
  if (ses) {   // same outing as the parcel before
    if (ses.mode === 'logged') { setPostedTrip(l.id, { trip: 'linked', tripText: ses.tripText, dropType: ses.type || '', dropAt: ses.place || '' }); toast('Part of the trip you just logged'); }
    else if (ses.mode === 'later') { setPostedTrip(l.id, { trip: 'later', dropType: ses.type || '', dropAt: ses.place || '' }); toast('Added to the same trip, saved for later'); }
    else if (ses.mode === 'none') setPostedTrip(l.id, { trip: 'none', dropType: ses.type || '' });
    return null;
  }
  const places = lsList(LS_DROP_PLACES);
  let type = dropGuess(l.courier);
  const v = sheet(`<h3>Log the trip to drop it off?</h3>
    <p class="hint">Driving to post a sale counts as business miles. ${esc(l.courier || 'Where')}${l.courier ? ': where' : ''} did it go?</p>
    <div class="chips" id="dtType">${DROP_TYPES.map(t => `<button data-dt="${t[0]}" class="${t[0] === type ? 'on' : ''}">${t[1]}</button>`).join('')}</div>
    <div id="dtWhere"><p class="sub" style="margin:8px 0 4px">Where (optional)</p><input id="dtPlace" class="search" list="dtPlaces" placeholder="e.g. InPost locker, Tesco Shirley" autocomplete="off">
      <datalist id="dtPlaces">${places.map(p => `<option value="${esc(p)}">`).join('')}</datalist></div>
    <button class="btn" data-dtnow="1">🚗 Log the trip now</button>
    <button class="btn sec" data-dtlater="1">Save it for later</button>
    <button class="btn ghost" data-dtnone="1">No trip for this one</button>
    <p class="hint">Posting a few today? Save it for later and log one trip at the end. Forward the drop-off receipt email (InPost, Evri, Post Office) to your receipts address and the place fills itself in.</p>`);
  const sh = v.querySelector('.sheet');
  const home = () => type === 'Home';
  const sync = () => { sh.querySelectorAll('[data-dt]').forEach(b => b.classList.toggle('on', b.dataset.dt === type)); sh.querySelector('#dtWhere').classList.toggle('hide', home()); sh.querySelector('[data-dtnow]').classList.toggle('hide', home()); sh.querySelector('[data-dtlater]').classList.toggle('hide', home()); sh.querySelector('[data-dtnone]').textContent = home() ? 'Done: no trip needed' : 'No trip for this one'; };
  sync();
  sh.addEventListener('click', e => {
    const d = e.target.closest('button') && e.target.closest('button').dataset; if (!d) return;
    const place = (sh.querySelector('#dtPlace').value || '').trim();
    if (place) lsSet(LS_DROP_PLACES, [place].concat(places.filter(p => p !== place)).slice(0, 12));
    const dropType = home() ? '' : type;
    if (d.dt) { type = d.dt; sync(); return; }
    if (d.dtnone) { v.remove(); setPostedTrip(l.id, { trip: 'none', dropType }); dropSession({ mode: 'none', type: dropType }); return; }
    if (d.dtlater) { v.remove(); setPostedTrip(l.id, { trip: 'later', dropType, dropAt: place }); dropSession({ mode: 'later', type: dropType, place }); TRIPS = null; toast('Saved for later: it\'s on Trips to log'); return; }
    if (d.dtnow) {
      v.remove(); setPostedTrip(l.id, { dropType, dropAt: place });
      openTrip({ journey: { labelIds: [l.id], date: today(), stops: [place], reason: 'Dropping off ' + (l.qty > 1 ? l.qty + ' × ' : '') + (l.item || 'a parcel') + (dropType ? ' (' + dropType.toLowerCase() + ')' : ''),
        sub: 'Your trip to drop off the parcel. Starts from home: tap 📍 to start from where you are. Posting more on the way? Add a stop.' } });
    }
  });
  return v;
}
// The list on the mileage page (only when it's opened plain, not for a particular trip)
async function renderTripTodo(plain) {
  const box = $('tTodo');
  if (!plain) { box.classList.add('hide'); return; }
  const draw = list => {
    if (!list || !list.length) { box.classList.add('hide'); return; }
    const byDay = {};
    list.forEach(x => { (byDay[x.date] = byDay[x.date] || []).push(x); });
    box.classList.remove('hide');
    box.innerHTML = `<div class="ttodo"><h3 class="sech">Trips to log <span class="count">${list.length}</span></h3>
      ${Object.keys(byDay).map(day => { const g = byDay[day]; return `<div class="ttday"><div class="ttdh"><b>${esc(dayName(day) || day)}</b>${g.length > 1 ? `<button class="btn sm2" data-tjall="${esc(day)}">Log these ${g.length} as one trip</button>` : ''}</div>
        ${g.map(x => `<div class="ttrow"><div><div class="st">${x.kind === 'buy' ? '🛍️ Collected: ' + esc(x.items.slice(0, 3).join(', ')) + (x.items.length > 3 ? ' +' + (x.items.length - 3) : '') : '📦 Drop-off: ' + esc(x.items.join(', '))}</div>
          <div class="sm">${x.kind === 'buy' ? esc(x.store || '') + (x.place ? ' · ' + esc(x.place) : '') + (x.miles ? ' · about ' + x.miles + ' miles each way' : '') + ' · from FlipCheck'
            : (x.place ? esc(x.type ? x.type + ': ' : '') + esc(x.place) : esc(x.type || x.courier || '') + ' · place not known yet: forward the drop-off receipt, or type it') + (x.time ? ' · ' + esc(x.time) : '')}</div></div>
          <div class="ttbtns"><button class="btn sm2" data-tj="${esc(x.key)}">Log it</button><button class="btn ghost sm2" data-tjskip="${esc(x.key)}">Not needed</button></div></div>`).join('')}</div>`; }).join('')}</div>`;
  };
  draw(TRIPS);
  try { draw(await loadTrips()); } catch (e) { if (!/Unknown action/.test(e.message)) console.warn(e); }
}
function journeyFor(list) {
  const stops = [], labelIds = [], purchaseIds = [], why = [];
  list.forEach(x => {
    const stop = x.postcode && x.place && x.place.indexOf(x.postcode) < 0 ? x.place + ', ' + x.postcode : x.place;
    if (stop && stops.indexOf(stop) < 0) stops.push(stop);
    labelIds.push(...(x.labelIds || [])); if (x.purchaseId) purchaseIds.push(x.purchaseId);
    why.push(x.kind === 'buy' ? 'collecting ' + (x.items[0] || 'stock') + (x.items.length > 1 ? ' + ' + (x.items.length - 1) + ' more' : '') : 'dropping off ' + x.items.length + ' parcel' + (x.items.length === 1 ? '' : 's'));
  });
  const one = list.length === 1 ? list[0] : null;
  return { date: list[0].date, stops, labelIds, purchaseIds, miles: one && one.kind === 'buy' && !stops.length ? one.miles : null,
    reason: why.join(' and ').replace(/^./, c => c.toUpperCase()), sub: list.length > 1 ? 'One trip for all of these. Check the order of the stops, then save.' : '' };
}
$('tTodo').onclick = async e => {
  const b = e.target.closest('button'); if (!b || !TRIPS) return;
  if (b.dataset.tj) { const x = TRIPS.find(t => t.key === b.dataset.tj); if (x) openTrip({ journey: journeyFor([x]) }); return; }
  if (b.dataset.tjall) { const g = TRIPS.filter(t => t.date === b.dataset.tjall); if (g.length) openTrip({ journey: journeyFor(g) }); return; }
  if (b.dataset.tjskip) {
    const key = b.dataset.tjskip;
    TRIPS = TRIPS.filter(t => t.key !== key); renderTripTodo(true);
    try { TRIPS = await api('tripSkip', { keys: key.split(',') }); if (CFG.waiting) { CFG.waiting.tripsToLog = TRIPS.length; renderTodo(CFG.waiting); } renderTripTodo(true); toast('Taken off the list'); }
    catch (err) { toast(err.message, true); }
  }
};

/* ---------- Purchases: everything logged, newest first, and where it came from ---------- */
var PURCH = null, PU_FROM = '';
const PU_ICON = { 'Receipt photo': '📷', 'Email': '✉️', 'Typed in': '✍️', 'FlipCheck': '📊', 'ListMe': '🏷️' };
async function openPurchases() {
  show('vPurchases');
  if (!PURCH) { try { PURCH = JSON.parse(localStorage.getItem('rs_purchases')); } catch (e) {} }
  if (PURCH) renderPurchases(); else $('puList').innerHTML = '<p class="sub">Loading…</p>';
  try { PURCH = await api('purchases', { limit: 200 }); try { localStorage.setItem('rs_purchases', JSON.stringify(PURCH)); } catch (e) {} renderPurchases(); }
  catch (err) { if (!PURCH) $('puList').innerHTML = '<p class="sub">' + esc(/Unknown action/.test(err.message) ? 'This page needs your Sheet\'s script update (due tomorrow morning). Your purchases are all safe in the Sheet.' : err.message) + '</p>'; }
}
function renderPurchases() {
  const d = PURCH || { items: [], counts: {} }, q = $('puSearch').value.trim().toLowerCase();
  const froms = Object.keys(d.counts || {}).sort((a, b) => d.counts[b] - d.counts[a]);
  $('puFrom').innerHTML = froms.length > 1 ? [['', 'All']].concat(froms.map(f => [f, (PU_ICON[f] || '') + ' ' + f + ' ' + d.counts[f]])).map(f => `<button data-pf="${esc(f[0])}" class="${PU_FROM === f[0] ? 'on' : ''}">${esc(f[1])}</button>`).join('') : '';
  const list = d.items.filter(g => (!PU_FROM || g.from === PU_FROM) &&
    (!q || (g.store + ' ' + g.notes + ' ' + g.order + ' ' + g.lines.map(l => l.item).join(' ')).toLowerCase().includes(q)));
  const docLabel = g => /#\/a\//.test(g.doc) ? 'FlipCheck analysis' : /mail\.|outlook|live\.com/.test(g.doc) ? 'Email' : 'Receipt';
  const listing = g => (String(g.notes).match(/Listing: (https?:\/\/\S+)/) || [])[1];
  $('puList').innerHTML = list.length ? list.slice(0, 120).map((g, i) => `<div class="card pucard">
    <div class="puhead"><div><div class="st">${esc(g.store || 'Purchase')}</div><div class="sm">${esc(g.date)}${g.logged ? ' · logged ' + esc(g.logged.slice(0, 10) === g.date ? g.logged.slice(11) : g.logged) : ''}</div></div>
      <div class="amt">${money(g.total)}</div></div>
    <div class="tags"><span class="tag pufrom">${PU_ICON[g.from] || ''} ${esc(g.from)}</span>${g.refund ? '<span class="tag ok">refund</span>' : ''}${g.payment ? '<span class="tag">' + esc(g.payment) + '</span>' : ''}${g.order ? '<span class="tag">#' + esc(g.order) + '</span>' : ''}</div>
    <ul class="pulines">${g.lines.slice(0, 8).map(l => `<li><span>${l.qty > 1 ? l.qty + ' × ' : ''}${esc(l.item)}${l.refunded ? ' <span class="tag ok">refunded</span>' : ''}</span><b>${money(l.total)}</b></li>`).join('')}${g.lines.length > 8 ? `<li class="sub">+ ${g.lines.length - 8} more</li>` : ''}</ul>
    <div class="ouacts">${g.doc ? `<a href="${esc(g.doc.split('\n')[0])}" target="_blank" rel="noopener">${docLabel(g)} ↗</a>` : ''}${listing(g) ? `<a href="${esc(listing(g))}" target="_blank" rel="noopener">Listing ↗</a>` : ''}
      ${g.trip ? (g.tripLogged ? '<span class="done">🚗 Trip logged</span>' : `<button data-putrip="${i}">🚗 Log the trip${g.trip.miles ? ' (' + g.trip.miles + ' mi each way)' : ''}</button>`) : ''}</div>
  </div>`).join('') : '<p class="sub" style="padding:10px 0">' + (q || PU_FROM ? 'Nothing matches.' : 'Nothing logged yet.') + '</p>';
  $('puList').dataset.n = String(list.length);
  PU_SHOWN = list;
}
var PU_SHOWN = [];
$('puSearch').oninput = renderPurchases;
$('puFrom').onclick = e => { const b = e.target.closest('[data-pf]'); if (!b) return; PU_FROM = b.dataset.pf; renderPurchases(); };
$('puList').onclick = e => {
  const b = e.target.closest('[data-putrip]'); if (!b) return;
  const g = PU_SHOWN[Number(b.dataset.putrip)]; if (!g) return;
  openTrip({ journey: { date: g.date, stops: [g.trip.to].filter(Boolean), purchaseIds: [g.id], miles: g.trip.miles,
    reason: 'Collecting ' + (g.lines[0] ? g.lines[0].item : 'stock') + (g.lines.length > 1 ? ' + ' + (g.lines.length - 1) + ' more' : '') + ' (' + g.store + ')',
    sub: 'Your trip to collect it. Dropped off parcels on the way? Add a stop, and log those from Trips to log.' } });
};
$('btnPurchases').onclick = openPurchases;
$('btnPuBack').onclick = () => show('vHome');

