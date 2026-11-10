/* Receipt Scanner — front end
   No credentials here. The Apps Script URL is stored on this device only. */

const LS_URL = 'rs_url';
const LS_CACHE = 'rs_cache';

let CFG = { purposes: [], stores: [], payments: [], vat: false, business: '' };
let state = null;          // current receipt being reviewed
let pages = [];            // photos of the receipt being captured: [{ dataUrl, blurry, dark }]
let job = null;            // the photo job being read or reviewed (see the offline queue below)
let lastSource = 'cam';
let lastResult = null;

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const views = ['vSetup','vHome','vWork','vError','vReview','vQueue','vPages','vJobs','vTrip','vRepay','vSales','vSale','vSettings','vHelp','vReport','vPerks','vNumbers','vIntro','vStock'];
const APP_VERSION = 'v32';

function show(v) {
  views.forEach(x => $(x).classList.toggle('hide', x !== v));
  if (v !== 'vReview') $('miniBar').classList.add('hide');
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
const BILLING_URL = 'https://aistudio.google.com/projects';
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
      : 'No matching purchase was found in your Sheet, so this is saved as refund lines only.');
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
function matchSelect(r, i) {
  const c = (state.matches && state.matches.candidates) || [];
  return `<div class="match">Refund for:
    <select data-k="_match" data-i="${i}">
      ${c.map((x, k) => `<option value="${k}" ${k === r._match ? 'selected' : ''}>${esc(x.date)} · ${esc(x.item)} · ${money(x.total)}${x.shared ? ' (your share)' : ''}</option>`).join('')}
      <option value="-1" ${r._match === -1 ? 'selected' : ''}>Not in the Sheet — save as a refund line only</option>
    </select></div>`;
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
      force: !!force
    }, job && jobId ? withLegacy(jobImages(job)) : {}));

    if (store && !CFG.stores.includes(store)) { CFG.stores.push(store); CFG.stores.sort(); }
    if (pay && !CFG.payments.includes(pay))   { CFG.payments.push(pay); CFG.payments.sort(); }
    rememberEmail(store, email);
    saveCache(); fillStores(); fillPayPicker();

    if (jobId) await jobDel(jobId);
    job = null; state = null;
    $('homeStatus').textContent =
      '✅ ' + res.rowsAdded + ' row' + (res.rowsAdded > 1 ? 's' : '') +
      ' saved · ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    toast(res.refundsMarked ? 'Refund saved · ' + res.refundsMarked + ' purchase' + (res.refundsMarked > 1 ? 's' : '') + ' marked returned' : 'Saved to sheet');
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

function openTrip() {
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
  tripCalc();
  show('vTrip');
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
    _stops: raw, _route: r
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
    const r = await sendTrip(t);
    rememberTrip(t);
    toast('Trip saved: ' + r.miles + ' miles · ' + money(r.amount) + ' (' + r.rate + ')');
    show('vHome');
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

function setSalesCount(w) {
  if (w) { CFG.waiting = w; saveCache(); }   // shown at once next time, before the server answers
  const n = w ? (w.needs || 0) + (w.toPost || 0) + (w.returnsSoon || 0) : 0;
  $('salesLabel').innerHTML = 'Sales &amp; postage' + (n ? ' <span class="count">' + n + '</span>' : '');
  renderTodo(w);
}

// Home screen: the few things that need doing today. Tap one to go to Sales.
function renderTodo(w) {
  w = w || {};
  const s = n => n === 1 ? '' : 's', rows = [];
  const today = (w.postToday || 0) - (w.late || 0);
  if (w.late) rows.push(['🔴', w.late + ' parcel' + s(w.late) + ' late. Post now', 'slPostWrap']);
  if (w.toPost) rows.push(['📦', w.toPost + ' parcel' + s(w.toPost) + ' to post' + (today > 0 ? ' (' + today + ' today)' : ''), 'slPostWrap']);
  if (w.returnsSoon) rows.push(['↩️', w.returnsSoon + ' receipt' + s(w.returnsSoon) + ': last days to return', 'slRetWrap']);
  if (w.needs) rows.push(['⚠️', w.needs + ' sale' + s(w.needs) + ' need' + (w.needs === 1 ? 's' : '') + ' a check', 'slNeedsWrap']);
  $('todo').classList.toggle('hide', !rows.length);
  $('todo').innerHTML = rows.slice(0, 4).map(r => `<button data-todo="${r[2]}"><span>${r[0]}</span><span>${esc(r[1])}</span><span class="go">›</span></button>`).join('');
}
// Tapping a to-do opens Sales at that section
$('todo').onclick = e => { const b = e.target.closest('[data-todo]'); if (b) openSales(b.dataset.todo); };
function goTo(id) {
  const el = $(id);
  if (!el || el.classList.contains('hide')) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

// Counts from a loaded Sales screen, so home stays right after changes
function countsFrom(d) {
  const tp = d.toPost || [];
  return { needs: (d.needs || []).length, toPost: tp.length, postToday: tp.filter(l => l.daysLeft !== null && l.daysLeft <= 0).length,
           late: tp.filter(l => l.daysLeft !== null && l.daysLeft < 0).length, returnsSoon: (d.returnsClosing || []).length };
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

function saleCard(o, i, list) {
  const price = num(o['sale price']), net = num(o['net received']), profit = num(o.profit);
  const bits = [esc(o.platform || ''), esc(o['sale date'] || '')].filter(Boolean).join(' · ');
  return `<div class="card scard" data-${list}="${i}"><div class="sb">
    <div class="st">${esc(o.item || o['order number'] || 'Sale')}</div>
    <div class="sm">${bits}${o['order number'] ? ' · #' + esc(o['order number']) : ''}</div>
    <div class="sm"><span class="tag ${tagFor(o.status)}">${esc(o.status || 'Sold')}</span>${o['counts in totals'] === 'No' ? '<span class="tag">not in totals</span>' : ''}
      ${profit !== null ? '<span class="tag ok">profit ' + money(profit) + '</span>' : ''}${o.needs ? '<span class="tag warn">' + esc(/postage/.test(o.needs) ? 'add postage' : /match/.test(o.needs) ? 'pick the sale' : /check/.test(o.needs) ? 'check match' : o.needs) + '</span>' : ''}${returnTag(o)}</div>
  </div><div class="amt">${price !== null ? money(price) : net !== null ? money(net) : '—'}</div></div>`;
}

function renderSales() {
  const d = SALES || { needs: [], recent: [], toPost: [] };
  setSalesCount(countsFrom(d));
  $('slPostWrap').classList.toggle('hide', !d.toPost.length);
  $('slPost').innerHTML = d.toPost.map((l, i) => `<div class="card scard"><div class="sb">
    <div class="st">${esc(l.item || 'Postage label')}</div>
    <div class="sm">${[l.platform, l.courier, l.order ? '#' + l.order : ''].filter(Boolean).map(esc).join(' · ')}</div>
    <div class="tags">${postTag(l)}</div>
    <div class="duo" style="margin-top:8px"><button class="btn" data-lab="${i}">${l.files ? 'Show QR code' : 'Open label'}</button>
      <button class="btn sec" data-posted="${i}">✓ Posted</button></div></div></div>`).join('');
  if (d.toPost.length) setTimeout(() => prefetchLabels(d.toPost), 300);   // codes ready before you tap
  $('slNeedsWrap').classList.toggle('hide', !d.needs.length);
  $('slNeeds').innerHTML = d.needs.map((o, i) => saleCard(o, i, 'need')).join('');
  $('slRecent').innerHTML = d.recent.length ? d.recent.map((o, i) => saleCard(o, i, 'rec')).join('')
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

function renderReturns(d) {
  const r = d.returnsClosing || [];   // one card per receipt (same shop and date)
  $('slRetWrap').classList.toggle('hide', !r.length);
  $('slRet').innerHTML = r.map((g, i) => {
    const one = g.items.length === 1, it = g.items[0];
    const title = one ? esc(it.item) + (it.left > 1 ? ' <span class="sm">×' + it.left + '</span>' : '') : esc(g.store || 'Receipt') + ' · ' + g.items.length + ' things';
    return `<div class="card scard" data-g="${i}"><div class="sb">
    <div class="st">${title}</div>
    <div class="sm">${one ? esc(g.store) + ' · ' : ''}bought ${esc(g.date)} · ${money(g.total)}</div>
    <div class="tags"><span class="tag ${g.daysLeft <= 2 ? 'late' : 'soon'}">${g.daysLeft === 0 ? 'Last day today' : 'Last day ' + esc(dayName(g.lastDay))}</span><span class="tag">${g.online ? '🌐 Online: 14 days' : '🏬 Shop: often 28–30 days'}</span></div>
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
  try { await loadStock(); renderStockPage(); }
  catch (err) { $('skList').innerHTML = '<p class="sub">' + esc(/Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for this.' : err.message) + '</p>'; }
}
function renderStockPage() {
  const d = STOCK || { items: [] }, q = $('skSearch').value.trim().toLowerCase(), by = segGet('skSort') || 'old';
  $('skLines').textContent = d.lines || 0; $('skUnits').textContent = d.units || 0; $('skValue').textContent = money(d.value || 0);
  let list = d.items.filter(x => !q || (x.item + ' ' + x.store).toLowerCase().includes(q));
  list = list.slice().sort(by === 'value' ? (a, b) => b.left * b.each - a.left * a.each : by === 'az' ? (a, b) => a.item.localeCompare(b.item) : (a, b) => b.days - a.days);
  $('skList').innerHTML = list.length ? list.slice(0, 200).map(x => `<button class="skrow" data-sk="${x.row}"><span>${esc(x.item)}<span class="sm">${esc(x.store)} · ${x.left} of ${x.qty} left · ${money(x.each)} each${x.decision === 'return' ? ' · returning' : ''}</span></span>
      <span class="tag ${x.days >= 90 ? 'late' : x.days >= 45 ? 'soon' : ''}" style="align-self:center">${x.days}d</span></button>`).join('')
    : '<p class="sub" style="padding:10px 0">' + (q ? 'Nothing matches.' : 'No stock to sell. Things you buy with a resale purpose show here.') + '</p>';
}
$('skSearch').oninput = renderStockPage;
$('skSort').onclick = e => { const b = e.target.closest('button'); if (b) { segSet('skSort', b.dataset.v); renderStockPage(); } };
$('skList').onclick = e => {
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
  if (t.dataset.posted !== undefined) {
    const l = SALES.toPost[Number(t.dataset.posted)];
    t.disabled = true;
    try { SALES.toPost = await api('labelDone', { id: l.id }); labDel(l.id); renderSales(); toast('Posted. We saved today\'s date.'); }
    catch (err) { t.disabled = false; toast(err.message, true); }
    return;
  }
  if (card) openSale(card.dataset.need !== undefined ? SALES.needs[Number(card.dataset.need)] : SALES.recent[Number(card.dataset.rec)]);
});

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
    (await labKeys()).forEach(k => { if (!want.has(k)) labDel(k); });   // posted or gone: free the space
    for (const l of list) if (l.files && !(await labGet(l.id))) { try { await fetchLabel(l); } catch (e) {} }   // one at a time, in the background
  } finally { prefetching = false; }
}

async function showLabel(l) {
  const veil = document.createElement('div');
  veil.className = 'veil';
  veil.innerHTML = `<div class="sheet"><h3>${esc(l.item || 'Postage label')}</h3><p class="sub">Loading…</p></div>`;
  veil.onclick = e => { if (e.target === veil || e.target.dataset.close) veil.remove(); };
  document.body.appendChild(veil);
  try {
    const cached = await labGet(l.id);
    const f = cached || await fetchLabel(l);
    veil.querySelector('.sheet').innerHTML = `<button class="close" data-close="1" aria-label="Close">✕</button><h3>${esc(l.item || 'Postage label')}</h3>
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

function saleWhereToggle() {
  const plat = $('saPlatform').value, inPerson = plat === 'In person';
  $('saWhereWrap').classList.toggle('hide', !inPerson);
  $('saPayWrap').classList.toggle('hide', !inPerson);
  $('saPostWrap').classList.toggle('hide', inPerson || plat === 'Amazon FBA');   // Amazon posts FBA orders itself
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

function openSale(o) {
  o = o || {};
  const isNew = !o.row;
  sale = { row: o.row || null, saleId: o._sale_id || null, needs: o.needs || '', linked: o['linked purchase'] || '' };
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
  segSet('saPay', o['payment method'] || (isNew ? 'Cash' : ''));
  segSet('saStatus', o.status || (isNew ? 'Completed' : 'Sold'));
  $('saCounts').checked = o['counts in totals'] ? o['counts in totals'] === 'Yes' : !/^Amazon/.test(plat);
  $('saFind').value = ''; $('saFound').innerHTML = '';
  $('saLinked').classList.toggle('hide', !sale.linked);
  $('saLinked').textContent = sale.linked ? 'Linked: ' + sale.linked + (num(o['item cost']) !== null ? ' · cost ' + money(o['item cost']) : '') : '';
  sale.itemCost = num(o['item cost']);
  $('saMore').open = !isNew && (num(o['platform fees']) === null || !!o.needs);
  $('saNeeds').classList.toggle('hide', !o.needs);
  $('saNeeds').textContent = o.needs ? '⚠️ ' + plainNeeds(o.needs) : '';
  sale.photo = null; $('saPhoto').classList.add('hide');
  $('btnSalePhoto').textContent = o['document link'] ? '📷 Replace the receipt photo' : '📷 Add a photo of the receipt';
  $('saMatch').classList.add('hide'); $('saMatch').innerHTML = '';
  if (/^match/.test(o.needs || '')) loadMatches(o);
  saleWhereToggle();
  saleCalc();
  show('vSale');
}

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
$('saFind').oninput = () => {
  clearTimeout(findTimer);
  const q = $('saFind').value.trim();
  if (q.length < 3) { $('saFound').innerHTML = ''; return; }
  findTimer = setTimeout(async () => {
    try {
      const r = await api('purchaseSearch', { q });
      $('saFound').innerHTML = r.length ? r.map(x => `<button class="found" data-pr="${x.row}" data-cost="${x.cost}" data-item="${esc(x.item)}">
        <b>${esc(x.item)}</b><br><span class="sm">${esc(x.store)} · ${esc(x.date)} · ${money(x.cost)} each</span></button>`).join('')
        : '<p class="sub">No purchases match. Try another word.</p>';
    } catch (err) { $('saFound').innerHTML = '<p class="sub">' + esc(err.message) + '</p>'; }
  }, 350);
};
$('saFound').onclick = e => {
  const b = e.target.closest('[data-pr]');
  if (!b) return;
  sale.linked = 'Purchases row ' + b.dataset.pr + ': ' + b.dataset.item;
  sale.linkEach = Number(b.dataset.cost);
  sale.itemCost = sale.linkEach * (Number($('saQty').value) || 1);
  $('saLinked').textContent = 'Linked: ' + sale.linked + ' · cost ' + money(sale.itemCost);
  $('saLinked').classList.remove('hide');
  $('saFound').innerHTML = ''; $('saFind').value = '';
  saleCalc();
};
$('saQty').addEventListener('input', () => { if (sale && sale.linkEach) { sale.itemCost = sale.linkEach * (Number($('saQty').value) || 1); saleCalc(); } });

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
    // Saving it yourself clears the flag, except eBay postage while it's still blank
    needs: /^match/.test(sale.needs || '') ? sale.needs
      : /^eBay/.test($('saPlatform').value) && !segGet('saPostBy') && v('saPostOut') === '' && segGet('saStatus') !== 'Cancelled' ? 'add postage cost' : ''
  };
  if (s['sale price'] === '' && !/^Amazon/.test(s.platform) && s.status !== 'Cancelled') { toast('Add the sale price', true); return; }
  const b = $('btnSaleSave'); b.disabled = true; b.textContent = 'Saving…';
  try {
    if (!$('saCardWrap').classList.contains('hide')) {   // remember the card reader's fees
      const f = { perTap: Number($('saTap').value) || 0, pct: Number($('saPct').value) || 0 }, c = CFG.cardFee || {};
      if (f.perTap !== (c.perTap || 0) || f.pct !== (c.pct || 0)) { CFG.cardFee = f; saveCache(); api('settingsSet', { settings: { cardFee: f } }).catch(() => {}); }
    }
    await api('saleSave', { sale: s, row: sale.row, saleId: sale.saleId,
      image: sale.photo ? { base64: sale.photo.split(',')[1], mimeType: 'image/jpeg' } : null });
    if (s.where) lsSet(LS_WHERE, [s.where].concat(lsList(LS_WHERE).filter(w => w !== s.where)).slice(0, 15));
    toast(sale.row ? 'Sale updated' : 'Sale saved');
    SALES = null;
    openSales();
  } catch (err) {
    toast(err.code === 'OFFLINE' ? 'No signal — not saved yet. Try again when you have signal' : err.message, true);
  }
  b.disabled = false; b.textContent = 'Save sale';
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
$('btnCam').onclick = () => { setAddOpen(false); pages = []; job = null; lastSource = 'cam'; $('inpCam').click(); };
$('btnLib').onclick = () => { setAddOpen(false); pages = []; job = null; lastSource = 'lib'; $('inpLib').click(); };
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
$('btnTrip').onclick  = openTrip;
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
if (localStorage.getItem(LS_URL)) { show('vHome'); if (CFG.waiting) renderTodo(CFG.waiting); refreshConfig(); }
else { show('vSetup'); }
setTimeout(() => { try { if (localStorage.getItem(LS_URL) && !localStorage.getItem('rs_intro')) showIntro(); } catch (e) {} }, 0);

// Offline queue: a photo left "reading" when the app closed is waiting again
jobAll().then(all => Promise.all(all.filter(j => j.status === 'reading').map(j => { j.status = 'pending'; return jobPut(j); })))
  .then(refreshJobs).then(() => setTimeout(jobTick, 2000));
window.addEventListener('online', () => { refreshJobs(); jobTick(); tripTick(); });
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
