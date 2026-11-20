// End-to-end (fake data): gift cards, notes for your books and Check my books, in the real app against the real backend code.
//   node tests/e2e_books.js            SHOTS=dir also saves screenshots (phone, light and dark)
const path = require('path'), http = require('http'), fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright');
const BACKEND = path.resolve(__dirname, '..', process.env.BACKEND || '../receipt-scanner-backend');
const { makeEnv } = require(path.join(BACKEND, 'tests/fake_gas.cjs'));
const ROOT = path.resolve(__dirname, '..'), SHOTS = process.env.SHOTS || '';
const RX = 'https://script.google.com/macros/s/FAKE_TEST_ID/exec';
let pass = 0, fail = 0;
const ok = (v, m) => { if (!v) throw new Error(m || 'not ok'); };
async function t(name, fn) { try { await fn(); pass++; console.log('✓ ' + name); } catch (e) { fail++; console.log('✗ ' + name + '\n   ' + String(e.stack || e).split('\n').slice(0, 4).join('\n   ')); } }

function seed() {
  const g = makeEnv(), ss = g.SpreadsheetApp.getActiveSpreadsheet();
  ss.insertSheet('_Config').getRange(1, 1, 3, 2).setValues([['purpose', 'category'], ['Resale stock', ''], ['Personal', 'Not a business expense']]);
  const pu = ss.insertSheet('Purchases'), C = g.__g('COLUMNS').slice(0, 25);
  pu.maxCols = 26; pu.strict = true;   // as wide as a Sheet made before this build
  pu.getRange(1, 2, 1, 25).setValues([C]);
  const row = o => C.map(c => o[c] !== undefined ? o[c] : '');
  const ago = n => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
  pu.getRange(2, 2, 3, 25).setValues([
    row({ 'purchase date': ago(30), item: 'Example streaming stick', quantity: 3, 'total cost': 104.97, store: 'Example Shop', purpose: 'Resale stock', 'payment method': 'Example Bank ••1111' }),
    row({ 'purchase date': ago(20), item: 'Example binder (estimate, no receipt)', quantity: 3, 'total cost': 114, store: 'Example Store', purpose: 'Resale stock' }),
    row({ 'purchase date': ago(10), item: 'Example ring light', quantity: 1, 'total cost': 25, store: 'Example Shop', purpose: 'Resale stock', 'payment method': 'Personal card ••2222' })
  ]);
  g.props.BUSINESS_PROFILE = JSON.stringify({ type: 'ltd', yearEnd: 11, cards: [{ name: 'Example Bank', nums: ['1111'], business: true }, { name: 'My own card', nums: ['2222'], business: false }] });
  g.call('saleSave', { clientId: 'e2e-sale-0001', sale: { 'sale date': '01/11/2026', platform: 'eBay', item: 'Example streaming stick', quantity: 1, 'sale price': 45, status: 'Completed', 'linked purchase': 'Purchases row 2: Example streaming stick' } });
  return g;
}

(async () => {
  const g = seed();
  const srv = await new Promise(res => { const x = http.createServer((q, r) => {
    const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : f.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    fs.createReadStream(f).pipe(r);
  }).listen(0, () => res(x)); });
  const base = `http://localhost:${srv.address().port}/`, server = srv;
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: process.env.DARK ? 'dark' : 'light', serviceWorkers: 'block' });
  await ctx.addInitScript(([rx]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('rs_url', rx); localStorage.setItem('rs_intro', '1');
    localStorage.setItem('tour:receipts:1117b', '{"opened":true}');
  }, [RX]);
  await ctx.route('https://script.google.com/**', async route => {
    const req = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(g.call(req.action, req)) });
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(base);
  await page.waitForSelector('#vHome:not(.hide)');
  await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => typeof CFG !== 'undefined' && CFG.business === 'ltd', null, { timeout: 15000 });
  const shot = async name => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + (process.env.DARK ? '-dark' : '') + '.png') }); } };
  const P = (row, col) => g.sheets.Purchases.getRange(row, 2 + g.__g('COLUMNS').indexOf(col)).getValue();

  await t('Settings: add a gift card bought at a discount', async () => {
    await page.evaluate(() => openSettings());
    await page.waitForFunction(() => /No gift cards yet/.test(document.getElementById('stGifts').textContent));
    await page.click('#btnAddGift');
    await page.fill('#gName', 'Example Store £100'); await page.fill('#gShop', 'Example Store'); await page.fill('#gFace', '100'); await page.fill('#gPaid', '95'); await page.fill('#gEnds', '4259');
    await page.click('#btnGiftSave');
    await page.waitForFunction(() => /£100\.00 left of £100\.00/.test(document.getElementById('stGifts').textContent));
    ok(/5% off/.test(await page.textContent('#stGifts')), 'shows the discount');
    await page.locator('#stGiftCard').scrollIntoViewIfNeeded(); await shot('1-gift-cards');
  });

  await t('Check my books: reads only, shows what it would do, then fills when asked', async () => {
    await page.click('#btnBooksCheck');
    await page.waitForFunction(() => /Sales linked to what you paid/.test(document.getElementById('stBooks').textContent));
    const txt = await page.textContent('#stBooks');
    ok(/Linked to a purchase: 1 of 1 sale\./.test(txt), 'counts the linked sale: ' + txt.slice(0, 200));
    ok(/1 link can be secured, and 3 purchase lines need an id/.test(txt), txt.slice(0, 400));
    ok(/Estimates with no receipt: 1 line \(£114\.00\)/.test(txt) && /Paid with your own money: 1 line \(£25\.00\)/.test(txt), 'finds the estimate and the personal payment');
    ok(P(2, '_item_id') === '', 'nothing written by the check');
    await page.locator('#stBooksCard').scrollIntoViewIfNeeded(); await shot('2-check-my-books');
    await page.click('[data-books="links"]');
    await page.waitForFunction(() => /Done: 3 purchase lines given an id, 1 link secured/.test(document.getElementById('stBooks').textContent));
    ok(/^p-/.test(P(2, '_item_id')), 'ids written');
    await page.click('[data-books="flags"]');
    await page.waitForFunction(() => /Done: 2 lines noted/.test(document.getElementById('stBooks').textContent));
    ok(P(3, 'flags') === 'Estimate' && P(4, 'flags') === 'Paid personally', 'flags written: ' + P(3, 'flags') + ' / ' + P(4, 'flags'));
    await shot('3-books-done');
  });

  await t('Saving a receipt: pay part with the gift card, tick an estimate; own card ticks "my own money"', async () => {
    await page.evaluate(() => {
      const today = new Date().toLocaleDateString('en-GB');
      showReview({ docType: 'receipt', rows: [{ 'purchase date': today, item: 'Example headphones', 'buy price': 30, quantity: 1, 'total price': 30, 'additional cost': 0, 'total cost': 30, store: 'Example Store', purpose: 'Resale stock' },
        { 'purchase date': today, item: 'Example cable', 'buy price': 10, quantity: 1, 'total price': 10, 'additional cost': 0, 'total cost': 10, store: 'Example Store', purpose: 'Resale stock' }], meta: {} }, 'manual');
    });
    await page.waitForSelector('#vReview:not(.hide)');
    ok(await page.isVisible('#fGift'), 'gift card picker shown');
    await page.fill('#fPay', 'Visa ••2222'); await page.dispatchEvent('#fPay', 'input');
    ok(await page.isChecked('#fgPers'), 'own card: ticked for you');
    await page.fill('#fPay', ''); await page.dispatchEvent('#fPay', 'input');
    ok(!(await page.isChecked('#fgPers')), 'unticked again');
    await page.selectOption('#fGift', { index: 1 });
    ok((await page.inputValue('#fGiftAmt')) === '40.00', 'amount filled in: ' + await page.inputValue('#fGiftAmt'));
    ok(/5% off, so £40\.00 on it really cost you £38\.00/.test(await page.textContent('#gcHint')), await page.textContent('#gcHint'));
    await page.click('#flagMore summary'); await page.check('#fgEst');
    await page.locator('#flagWrap').scrollIntoViewIfNeeded(); await shot('4-review-gift-card');
    await page.click('#btnSave');
    await page.waitForFunction(() => /£60\.00 left on Example Store £100/.test((document.querySelector('.toast,#toast') || {}).textContent || ''), null, { timeout: 15000 });
    ok(P(5, 'total cost') === 28.5 && P(6, 'total cost') === 9.5, 'real cost: ' + P(5, 'total cost') + ', ' + P(6, 'total cost'));
    ok(P(5, 'flags') === 'Estimate' && /^p-/.test(P(5, '_item_id')) && P(5, 'card amount') === 30, 'flag, id and card amount saved');
  });

  await t('Pay back screen shows the director\'s loan as a guide', async () => {
    await page.evaluate(() => openRepay());
    await page.waitForFunction(() => /Director's loan, as a guide/.test(document.getElementById('rOwed').textContent));
    ok(/You paid £25\.00 of business costs yourself this year/.test(await page.textContent('#rOwed')), await page.textContent('#rOwed'));
    await shot('5-directors-loan');
  });

  ok(!errors.length, 'page errors: ' + errors.join(' | '));
  if (errors.length) { fail++; console.log('✗ page errors: ' + errors.join(' | ')); }
  console.log(`e2e_books: ${pass} passed, ${fail} failed`);
  await browser.close(); server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
