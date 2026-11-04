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
const views = ['vSetup','vHome','vWork','vError','vReview','vQueue','vPages','vJobs','vTrip','vRepay'];

function show(v) {
  views.forEach(x => $(x).classList.toggle('hide', x !== v));
  window.scrollTo(0, 0);
}

function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 4200 : 2400);
}

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const money = n => (r2(n) < 0 ? '−£' : '£') + Math.abs(r2(n)).toFixed(2);
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
    ? 'A photo looks ' + (pages.some(pg => pg.dark) ? 'too dark or blurry' : 'blurry') + '. Retake it for a better read: nothing has been sent yet.'
    : 'Long receipt? Add a photo for each part. All photos are read together as one receipt.';
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
const DB_NAME = 'receipts', DB_STORE = 'jobs';
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(DB_STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function dbDo(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(DB_STORE, mode), st = tx.objectStore(DB_STORE);
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

// Reads a job while you watch: spinner, then the review screen.
async function readJobNow(j) {
  job = j; lastSource = 'cam';
  show('vWork');
  $('workMsg').textContent = 'Reading receipt' + (j.pages.length > 1 ? ' (' + j.pages.length + ' photos)' : '') + '…';
  busyJob = j.id;
  try {
    const result = await api('extract', { images: jobImages(j) });
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
    next.result = await api('extract', { images: jobImages(next) });
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
    ? 'No signal. Photos are kept on this phone and read when you\'re back online, while the app is open.'
    : 'Photos are kept on this phone until you save or delete them.';
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
    'VAT':                CFG.vat ? (s ? sharePart(r.VAT, p) : r2(r.VAT)) : ''
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
    const res = await api('append', {
      rows: payload,
      images: job && jobId ? jobImages(job) : null,
      queueId: queueId,
      force: !!force
    });

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
    renderQueue(await api('queue', {}));
    show('vQueue');
  } catch (err) {
    show('vHome');
    toast('Couldn\'t load emails: ' + err.message, true);
  }
}

function renderQueue(d) {
  queueItems = d.items || [];
  setEmailCount(queueItems.length);
  const waiting = d.processing
    ? d.processing + ' more being read — check back within 15 minutes.' : '';
  $('qSub').textContent = queueItems.length
    ? queueItems.length + ' to review. ' + waiting
    : (waiting || 'Nothing to review. Forwarded emails appear here within 15 minutes.');

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

function openTrip() {
  $('tDate').value = today();
  ['tFrom', 'tTo', 'tReason', 'tMiles'].forEach(id => { $(id).value = ''; });
  $('tReturn').checked = false;
  const v = localStorage.getItem(LS_VEHICLE) || 'Car or van';
  document.querySelectorAll('#tVehicle button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('placeList').innerHTML = lsList(LS_PLACES).map(p => `<option value="${esc(p)}">`).join('');
  $('tSub').textContent = CFG.business === 'ltd'
    ? 'The company owes you this at HMRC\'s rates, and it\'s a business expense. Don\'t also claim fuel for the same car.'
    : 'Claimed at HMRC\'s rates instead of fuel and running costs for this vehicle.';
  tripCalc();
  show('vTrip');
}

function tripVehicle() { const b = document.querySelector('#tVehicle button.on'); return b ? b.dataset.v : 'Car or van'; }

function tripCalc() {
  const miles = (Number($('tMiles').value) || 0) * ($('tReturn').checked ? 2 : 1);
  const v = tripVehicle(), rate = RATES[v];
  $('tCalc').textContent = miles
    ? miles + ' miles × ' + Math.round(rate * 100) + 'p ≈ ' + money(miles * rate) +
      (v === 'Car or van' ? '. After 10,000 car miles in a tax year it\'s 25p a mile; your Sheet works that out.' : '.')
    : 'HMRC rates: car or van 55p a mile (25p after 10,000 miles a year), motorbike 24p, bicycle 20p.';
}

async function saveTrip() {
  const trip = { date: $('tDate').value.trim(), from: $('tFrom').value.trim(), to: $('tTo').value.trim(),
                 reason: $('tReason').value.trim(), miles: Number($('tMiles').value) || 0,
                 ret: $('tReturn').checked, vehicle: tripVehicle() };
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(trip.date)) { toast('Date must be DD/MM/YYYY', true); return; }
  if (!(trip.miles > 0)) { toast('Enter the miles', true); return; }
  const b = $('btnTripSave'); b.disabled = true; b.textContent = 'Saving…';
  try {
    const r = await api('mileage', { trip });
    localStorage.setItem(LS_VEHICLE, trip.vehicle);
    if (trip.vehicle === 'Car or van') localStorage.setItem(LS_TRIPS, String(Number(localStorage.getItem(LS_TRIPS) || 0) + 1));
    const places = [trip.from, trip.to].concat(lsList(LS_PLACES)).filter((p, i, a) => p && a.indexOf(p) === i).slice(0, 20);
    try { localStorage.setItem(LS_PLACES, JSON.stringify(places)); } catch (e) {}
    toast('Trip saved: ' + r.miles + ' miles · ' + money(r.amount) + ' (' + r.rate + ')');
    show('vHome');
  } catch (err) {
    toast(err.code === 'OFFLINE' ? 'No signal — trip not saved yet. Try again when you have signal'
          : /Unknown action/.test(err.message) ? 'Your Sheet\'s script needs updating for trips' : err.message, true);
  }
  b.disabled = false; b.textContent = 'Save trip';
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
  const repayment = { date: $('rDate').value.trim(), amount: Number($('rAmount').value) || 0, note: $('rNote').value.trim() };
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
    show('vHome');
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

$('btnCam').onclick = () => { pages = []; job = null; lastSource = 'cam'; $('inpCam').click(); };
$('btnLib').onclick = () => { pages = []; job = null; lastSource = 'lib'; $('inpLib').click(); };
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
$('tMiles').oninput = tripCalc;
$('tReturn').onchange = tripCalc;
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
$('btnQRefresh').onclick  = openQueue;

$('pChannel').onclick = () => {
  state.channel = state.channel === 'In person' ? 'Email' : 'In person';
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
if (localStorage.getItem(LS_URL)) { show('vHome'); refreshConfig(); }
else { show('vSetup'); }

// Offline queue: a photo left "reading" when the app closed is waiting again
jobAll().then(all => Promise.all(all.filter(j => j.status === 'reading').map(j => { j.status = 'pending'; return jobPut(j); })))
  .then(refreshJobs).then(() => setTimeout(jobTick, 2000));
window.addEventListener('online', () => { refreshJobs(); jobTick(); });
window.addEventListener('offline', refreshJobs);
setInterval(jobTick, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') jobTick(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
