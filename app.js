/* Receipt Scanner — front end
   No credentials here. The Apps Script URL is stored on this device only. */

const LS_URL = 'rs_url';
const LS_CACHE = 'rs_cache';

let CFG = { purposes: [], stores: [], payments: [] };
let state = null;          // current receipt being reviewed
let imageData = null;      // { base64, mimeType, dataUrl }
let lastSource = 'cam';
let lastResult = null;

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const views = ['vSetup','vHome','vWork','vError','vReview','vQueue'];

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
const money = n => '£' + r2(n).toFixed(2);
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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action }, payload))
  });
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

async function handleFile(file, source) {
  if (!file) return;
  lastSource = source;
  try {
    show('vWork');
    $('workMsg').textContent = 'Preparing image…';
    const raw = await readFile(file);
    const dataUrl = await enhance(raw);
    imageData = {
      dataUrl,
      base64: dataUrl.split(',')[1],
      mimeType: 'image/jpeg'
    };
    $('workMsg').textContent = 'Reading receipt…';
    const result = await api('extract', {
      imageBase64: imageData.base64,
      mimeType: imageData.mimeType
    });
    lastResult = result;
    showReview(result, source);
  } catch (err) {
    if (err.code === 'QUOTA_DAY') showQuotaError();
    else showError(err.message, /busy|503|429|overload/i.test(err.message));
  }
}

// The free daily allowance is used up. Keep the photo so they can come back to it.
function showQuotaError() {
  const u = usageNow() || {};
  $('errTitle').textContent = 'Free scans used up for today';
  $('errMsg').innerHTML =
    'Google\'s free allowance resets at <b>' + esc(resetText(u.resetAt)) + '</b>. Nothing was saved and nothing was charged.' +
    '<br><br>To keep scanning now, turn on billing in AI Studio, then tap Try again. It costs ' + esc(costLine()) + '. ' +
    'Or enter this one by hand.';
  $('btnRetry').textContent = '🔄 Try again';
  $('btnRetry').onclick = retryExtract;
  $('btnRetry').classList.toggle('hide', !imageData);
  $('btnRetake').classList.add('hide');
  $('btnBilling').classList.remove('hide');
  if (imageData) {
    $('errImg').src = imageData.dataUrl;
    $('errImg').classList.remove('hide');
  } else {
    $('errImg').classList.add('hide');
  }
  show('vError');
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
  $('errMsg').textContent = msg;
  $('btnBilling').classList.add('hide');
  $('btnRetry').textContent = '🔄 Try again';
  $('btnRetry').onclick = retryExtract;
  $('btnRetake').classList.remove('hide');
  $('btnRetry').classList.toggle('hide', !canRetry || !imageData);
  if (imageData) {
    $('errImg').src = imageData.dataUrl;
    $('errImg').classList.remove('hide');
  } else {
    $('errImg').classList.add('hide');
  }
  show('vError');
}

async function retryExtract() {
  if (!imageData) { toast('No image to retry', true); return; }
  try {
    show('vWork');
    $('workMsg').textContent = 'Trying again…';
    const result = await api('extract', {
      imageBase64: imageData.base64,
      mimeType: imageData.mimeType
    });
    lastResult = result;
    showReview(result, lastSource);
  } catch (err) {
    if (err.code === 'QUOTA_DAY') showQuotaError();
    else showError(err.message, /busy|503|429|overload/i.test(err.message));
  }
}

$('btnRetry').onclick = retryExtract;

/* ---------- review screen ---------- */
function buildReview(result, source) {
  const rows = result.rows || [];
  const meta = result.meta || {};

  state = {
    rows: rows.map(r => Object.assign({ _sel: true, _shared: false, _pct: 50 }, r)),
    sharePct: 50,     // your % for the next line you share; follows the last % you typed
    meta,
    channel: (source === 'lib' || source === 'email') ? 'Email' : (rows[0]?.['email or in person'] || 'In person'),
    method:  rows[0]?.method || 'Collection',
    queueId: null
  };

  $('fStore').value = rows[0]?.store || '';
  $('fDate').value  = rows[0]?.['purchase date'] || today();
  $('fOrder').value = rows[0]?.['order number'] || '';
  $('fPay').value   = rows[0]?.['payment method'] || '';
  $('fNotes').value = '';   $('fFees').value = state.meta.feeTotal || '';


  $('pChannel').textContent = state.channel;
  $('pMethod').textContent  = state.method;
  $('pChannel').classList.toggle('on', state.channel === 'Email');
  $('pMethod').classList.toggle('on', state.method === 'Delivery');

  if (meta.isRefund) toast('Refund detected — values are negative', false);

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
    state.rows.push({ _sel: true, _shared: false, _pct: state.sharePct, item: '', quantity: 1, 'buy price': 0,
      'total price': 0, 'additional cost': 0, 'total cost': 0, purpose: '',
      _confidence: 'low' });
    renderItems();
  };
  box.appendChild(add);

  updateSharedPill();
  recalc();

}

function recalc() {
  const fee = state.meta.feeTotal || 0;
  const n = state.rows.length || 1;
  const per = r2(fee / n);
  const rem = r2(fee - per * n);

  state.rows.forEach((r, i) => {
    r['total price'] = r2(Number(r.quantity) * Number(r['buy price']));
    r['additional cost'] = r2(per + (i === 0 ? rem : 0));
    r['total cost'] = r2(r['total price'] + r['additional cost']);
  });

  // refresh displayed totals without rebuilding inputs (keeps keyboard focus)
  document.querySelectorAll('#items .card').forEach((c, i) => {
    const t = c.querySelector('.tot');
    if (t) t.textContent = money(state.rows[i]['total cost']);
    const f = c.querySelector('.fee');
    if (f) f.textContent = 'incl. ' + money(state.rows[i]['additional cost']) + ' fees';
    const sp = c.querySelector('.split');
    if (sp) sp.textContent = shareLabel(state.rows[i]);
  });

  // Receipt check always uses full prices; "your share" halves the shared lines
  const sum = r2(state.rows.reduce((s, r) => s + r['total cost'], 0));
  const mine = r2(state.rows.reduce((s, r) => s + (r._shared ? sharePart(r['total cost'], pctOf(r)) : r['total cost']), 0));
  const shareNote = state.rows.some(r => r._shared) ? ' · your share ' + money(mine) : '';
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

function bulkPurpose() {
  const chosen = state.rows.filter(r => r._sel);
  if (!chosen.length) { toast('Tick some items first', true); return; }

  const list = CFG.purposes.concat(['+ Add new purpose…']);
  const msg = 'Set purpose for ' + chosen.length + ' item' +
              (chosen.length > 1 ? 's' : '') + ':\n\n' +
              list.map((p, i) => (i + 1) + '. ' + p).join('\n') +
              '\n\nEnter a number:';

  const pick = prompt(msg);
  if (!pick) return;
  const idx = parseInt(pick, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= list.length) { toast('Invalid choice', true); return; }

  if (idx === list.length - 1) {
    const fresh = prompt('New purpose name:');
    if (!fresh || !fresh.trim()) return;
    const val = fresh.trim();
    api('addPurpose', { value: val })
      .then(updated => {
        CFG.purposes = updated;
        saveCache();
        applyPurpose(val);
        toast('Added "' + val + '"');
      })
      .catch(e => toast(e.message, true));
    return;
  }
  applyPurpose(list[idx]);
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
async function saveToSheet() {
  const store = $('fStore').value.trim();
  const date  = $('fDate').value.trim();
  if (!store) { toast('Store name required', true); return; }
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    toast('Date must be DD/MM/YYYY', true); return;
  }

  const pay   = $('fPay').value.trim();
  const order = $('fOrder').value.trim();
  const notes = $('fNotes').value.trim();

  // Shared lines record only your half. The full price goes in that line's notes for the audit trail.
  const payload = state.rows.map(r => {
    const s = r._shared, p = pctOf(r);
    const tp = s ? sharePart(r['total price'], p) : r['total price'];
    const ad = s ? sharePart(r['additional cost'], p) : r['additional cost'];
    const lineNote = s ? 'Shared — your ' + p + '% of full ' + money(r['total cost']) : '';
    return {
    'purchase date':      date,
    'item':               r.item,
    'buy price':          s ? sharePart(r['buy price'], p) : r['buy price'],
    'quantity':           r.quantity,
    'total price':        tp,
    'additional cost':    ad,
    'total cost':         r2(tp + ad),
    'store':              store,
    'notes':              [notes, lineNote].filter(Boolean).join(' · '),
    'purpose':            r.purpose,
    'method':             state.method,
    'email or in person': state.channel,
    'shared cost?':       r._shared ? 'Yes' : 'No',
    'order number':       order,
    'payment method':     pay
    };
  });

  const queueId = state.queueId;
  try {
    show('vWork');
    $('workMsg').textContent = 'Saving to sheet…';
    const res = await api('append', {
      rows: payload,
      imageBase64: imageData ? imageData.base64 : null,
      mimeType: imageData ? imageData.mimeType : null,
      queueId: queueId
    });

    if (store && !CFG.stores.includes(store)) { CFG.stores.push(store); CFG.stores.sort(); }
    if (pay && !CFG.payments.includes(pay))   { CFG.payments.push(pay); CFG.payments.sort(); }
    saveCache(); fillStores(); fillPayPicker();

    imageData = null; state = null;
    $('homeStatus').textContent =
      '✅ ' + res.rowsAdded + ' row' + (res.rowsAdded > 1 ? 's' : '') +
      ' saved · ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    toast('Saved to sheet');
    if (queueId) openQueue();     // straight on to the next emailed receipt
    else show('vHome');
  } catch (err) {
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
    imageData = null;
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

$('btnCam').onclick = () => $('inpCam').click();
$('btnLib').onclick = () => $('inpLib').click();
$('inpCam').onchange = e => { handleFile(e.target.files[0], 'cam'); e.target.value = ''; };
$('inpLib').onchange = e => { handleFile(e.target.files[0], 'lib'); e.target.value = ''; };

$('btnRetake').onclick    = () => { imageData = null; $('inpCam').click(); };
$('btnBilling').onclick   = () => window.open(BILLING_URL, '_blank');
$('btnManual').onclick    = manualEntry;
$('btnCancelErr').onclick = () => { imageData = null; show('vHome'); };
$('btnBack').onclick      = () => {
  if (state && state.queueId) {   // emails stay in the queue until saved or dismissed
    if (confirm('Go back to the email list? Your edits here won\'t be kept.')) openQueue();
    return;
  }
  if (confirm('Discard this receipt?')) { imageData = null; show('vHome'); }
};
$('btnEmails').onclick    = openQueue;
$('btnQBack').onclick     = () => show('vHome');
$('btnQRefresh').onclick  = openQueue;

$('pChannel').onclick = () => {
  state.channel = state.channel === 'In person' ? 'Email' : 'In person';
  $('pChannel').textContent = state.channel;
  $('pChannel').classList.toggle('on', state.channel === 'Email');
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
$('btnSave').onclick   = saveToSheet;

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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
