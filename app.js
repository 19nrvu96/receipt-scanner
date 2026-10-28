/* Receipt Scanner — front end
   No credentials here. The Apps Script URL is stored on this device only. */

const LS_URL = 'rs_url';
const LS_CACHE = 'rs_cache';

let CFG = { purposes: [], stores: [], payments: [] };
let state = null;          // current receipt being reviewed
let imageData = null;      // { base64, mimeType, dataUrl }
let lastSource = 'cam';

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const views = ['vSetup','vHome','vWork','vError','vReview'];

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
  if (!j.ok) throw new Error(j.error || 'Unknown error');
  return j.data;
}

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
    buildReview(result, source);
  } catch (err) {
    showError(err.message);
  }
}

function showError(msg, canRetry) {
  $('errTitle').textContent = canRetry ? 'Gemini is busy' : "Couldn't read that";
  $('errMsg').textContent = msg;
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
    buildReview(result, lastSource);
  } catch (err) {
    showError(err.message, /busy|503|429|overload/i.test(err.message));
  }
}

$('btnRetry').onclick = retryExtract;

/* ---------- review screen ---------- */
function buildReview(result, source) {
  const rows = result.rows || [];
  const meta = result.meta || {};

  state = {
    rows: rows.map(r => Object.assign({ _sel: true }, r)),
    meta,
    channel: source === 'lib' ? 'Email' : (rows[0]?.['email or in person'] || 'In person'),
    method:  rows[0]?.method || 'Collection',
    shared:  'No'
  };

  $('fStore').value = rows[0]?.store || '';
  $('fDate').value  = rows[0]?.['purchase date'] || today();
  $('fOrder').value = rows[0]?.['order number'] || '';
  $('fPay').value   = rows[0]?.['payment method'] || '';
  $('fNotes').value = '';   $('fFees').value = state.meta.feeTotal || '';


  $('pChannel').textContent = state.channel;
  $('pMethod').textContent  = state.method;
  $('pShared').textContent  = 'Not shared';
  $('pShared').classList.remove('on');
  $('pChannel').classList.toggle('on', state.channel === 'Email');
  $('pMethod').classList.toggle('on', state.method === 'Delivery');

  if (meta.isRefund) toast('Refund detected — values are negative', false);

   
   renderItems();
  show('vReview');
}

function findDupes() {
  const groups = {};
  state.rows.forEach((r, i) => {
    const k = (r.item || '').trim().toLowerCase() + '|' + r['buy price'];
    if (!k.startsWith('|')) (groups[k] = groups[k] || []).push(i);
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
      </select>`;
    box.appendChild(card);
  });

  box.oninput = e => {
    const i = e.target.dataset.i, k = e.target.dataset.k;
    if (i === undefined) return;
    const row = state.rows[i];
    if (k === '_sel') { row._sel = e.target.checked; return; }
    row[k] = (k === 'quantity' || k === 'buy price') ? Number(e.target.value) : e.target.value;
    if (k === 'quantity' || k === 'buy price') recalc();
    if (k === 'purpose') e.target.classList.toggle('unset', !e.target.value);
    updateSave();
  };

    box.onclick = e => {
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
    state.rows.push({ _sel: true, item: '', quantity: 1, 'buy price': 0,
      'total price': 0, 'additional cost': 0, 'total cost': 0, purpose: '',
      _confidence: 'low' });
    renderItems();
  };
  box.appendChild(add);

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
  });

  const sum = r2(state.rows.reduce((s, r) => s + r['total cost'], 0));
  const expected = state.meta.receiptTotal;
  const el = $('recon');
  if (expected == null) {
    el.className = 'recon ok';
    el.textContent = 'Total ' + money(sum);
  } else if (Math.abs(sum - expected) < 0.02) {
    el.className = 'recon ok';
    el.textContent = '✅ Total ' + money(sum) + ' — matches receipt';
  } else {
    el.className = 'recon warn';
    el.textContent = '⚠️ Lines total ' + money(sum) +
                     ' but receipt says ' + money(expected) + ' — check figures';
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

  const payload = state.rows.map(r => ({
    'purchase date':      date,
    'item':               r.item,
    'buy price':          r['buy price'],
    'quantity':           r.quantity,
    'total price':        r['total price'],
    'additional cost':    r['additional cost'],
    'total cost':         r['total cost'],
    'store':              store,
    'notes':              notes,
    'purpose':            r.purpose,
    'method':             state.method,
    'email or in person': state.channel,
    'shared cost?':       state.shared,
    'order number':       order,
    'payment method':     pay
  }));

  try {
    show('vWork');
    $('workMsg').textContent = 'Saving to sheet…';
    const res = await api('append', {
      rows: payload,
      imageBase64: imageData ? imageData.base64 : null,
      mimeType: imageData ? imageData.mimeType : null
    });

    if (store && !CFG.stores.includes(store)) { CFG.stores.push(store); CFG.stores.sort(); }
    if (pay && !CFG.payments.includes(pay))   { CFG.payments.push(pay); CFG.payments.sort(); }
    saveCache(); fillStores(); fillPayPicker();

    imageData = null; state = null;
    $('homeStatus').textContent =
      '✅ ' + res.rowsAdded + ' row' + (res.rowsAdded > 1 ? 's' : '') +
      ' saved · ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    show('vHome');
    toast('Saved to sheet');
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
    $('homeStatus').textContent = 'Ready · ' + CFG.purposes.length + ' purposes';
  } catch (e) {
    $('homeStatus').textContent = '⚠️ Offline — using saved settings';
  }
}

/* ---------- wiring ---------- */
$('btnConnect').onclick = async () => {
  const url = $('scriptUrl').value.trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
    toast('That does not look like an /exec URL', true); return;
  }
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
$('btnManual').onclick    = manualEntry;
$('btnCancelErr').onclick = () => { imageData = null; show('vHome'); };
$('btnBack').onclick      = () => { if (confirm('Discard this receipt?')) { imageData = null; show('vHome'); } };

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
  state.shared = state.shared === 'No' ? 'Yes' : 'No';
  $('pShared').textContent = state.shared === 'Yes' ? 'Shared cost' : 'Not shared';
  $('pShared').classList.toggle('on', state.shared === 'Yes');
};

$('btnSelAll').onclick = selectAll;
$('fFees').oninput = () => {
  if (!state) return;
  state.meta.feeTotal = Number($('fFees').value) || 0;
  recalc();
};
$('btnBulk').onclick   = bulkPurpose;
$('btnSave').onclick   = saveToSheet;

/* ---------- boot ---------- */
loadCache();
if (localStorage.getItem(LS_URL)) { show('vHome'); refreshConfig(); }
else { show('vSetup'); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
