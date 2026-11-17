// End-to-end: the real app in Chrome at iPhone 13 size, talking to the real backend code
// (receipt-scanner-backend, run in Node with a fake Sheet). Fake data only.
//   node tests/e2e_sell.js            (BACKEND=../receipt-scanner-backend by default)
//   SHOTS=dir node tests/e2e_sell.js  also saves screenshots: phone and desktop, light and dark
const path = require('path'), http = require('http'), fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright');
const BACKEND = path.resolve(__dirname, '..', process.env.BACKEND || '../receipt-scanner-backend');
const { makeEnv } = require(path.join(BACKEND, 'tests/fake_gas.cjs'));
const ROOT = path.resolve(__dirname, '..'), SHOTS = process.env.SHOTS || '';
const RX = 'https://script.google.com/macros/s/FAKE_TEST_ID/exec';
// a 24×24 grey PNG, as the item photo
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGOYtmA9VRDDqEGjBo0aNGrQqEGjBg28QQDIYkN9+DXWvAAAAABJRU5ErkJggg==';

let pass = 0, fail = 0;
const ok = (v, m) => { if (!v) throw new Error(m || 'not ok'); };
async function t(name, fn) { try { await fn(); pass++; console.log('✓ ' + name); } catch (e) { fail++; console.log('✗ ' + name + '\n   ' + String(e.stack || e).split('\n').slice(0, 4).join('\n   ')); } }

function seed() {
  const g = makeEnv(), ss = g.SpreadsheetApp.getActiveSpreadsheet();
  ss.insertSheet('_Config').getRange(1, 1, 3, 2).setValues([['purpose', 'category'], ['Resale stock', ''], ['Personal', '']]);
  const pu = ss.insertSheet('Purchases'), C = g.__g('COLUMNS');
  pu.getRange(1, 2, 1, C.length).setValues([C]);
  const row = o => C.map(c => o[c] !== undefined ? o[c] : '');
  const ago = n => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
  pu.getRange(2, 2, 3, C.length).setValues([
    row({ 'purchase date': ago(52), item: 'Example games console', quantity: 1, 'total cost': 60, store: 'Facebook', purpose: 'Resale stock' }),
    row({ 'purchase date': ago(20), item: 'Example streaming stick', quantity: 3, 'total cost': 104.97, store: 'Example Shop', purpose: 'Resale stock' }),
    row({ 'purchase date': ago(5), item: 'Example kettle', quantity: 1, 'total cost': 12, store: 'Example Shop', purpose: 'Resale stock' })
  ]);
  g.props.BUSINESS_PROFILE = JSON.stringify({ type: 'sole', cardApp: 'SumUp', cardFee: { perTap: 0, pct: 1.69 } });
  g.call('listStock', { items: [
    { key: 'g1', name: 'Example games console', row: 2, price: 85, sites: ['eBay', 'Facebook'], left: 1, unitIds: ['u1'], photoKey: 'p1' },
    { key: 'g2', name: 'Example streaming stick', row: 3, price: 50, sites: ['eBay'], left: 3, unitIds: ['u2', 'u3', 'u4'], photoKey: '' },
    { key: 'u9', name: 'Example handheld (old)', row: null, price: 70, sites: ['Vinted'], left: 1, unitIds: ['u9'], photoKey: '' }] });
  g.call('listPhoto', { key: 'g1', photoKey: 'p1', base64: PNG, mime: 'image/png' });
  return g;
}

function serve() {
  return new Promise(res => {
    const srv = http.createServer((q, r) => {
      const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : f.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
      fs.createReadStream(f).pipe(r);
    }).listen(0, () => res(srv));
  });
}

(async () => {
  const srv = await serve(), base = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined });
  let g;
  const sales = () => g.__g('readSales_')();
  async function open(opts = {}) {
    const ctx = await browser.newContext({ viewport: opts.desktop ? { width: 1280, height: 900 } : { width: 390, height: 844 }, deviceScaleFactor: opts.desktop ? 1 : 2,
      colorScheme: opts.dark ? 'dark' : 'light', serviceWorkers: 'block' });
    await ctx.addInitScript(([rx]) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('rs_url', rx); localStorage.setItem('rs_intro', '1');
      localStorage.setItem('tour:receipts:1117b', '{"opened":true}');
    }, [RX]);
    await ctx.route('https://script.google.com/**', async route => {
      const req = JSON.parse(route.request().postData() || '{}');
      const out = g.call(req.action, req);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => console.log('   page error:', e.message));
    page.on('dialog', d => (page.__dialogs = (page.__dialogs || []).concat(d.message()), d.accept()));
    await page.goto(base + (opts.hash || ''));
    await page.waitForSelector('#vHome:not(.hide), #vSell:not(.hide)');
    await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 5000 }).catch(() => {});
    return { ctx, page };
  }
  const noSideScroll = async page => ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll');
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
  const toStock = async page => { await page.evaluate(() => openStock()); await page.waitForSelector('.sellthis'); };

  await t('Stock rows: photo, paid and listed, age, Sell this', async () => {
    g = seed(); const { ctx, page } = await open();
    await toStock(page);
    const txt = await page.textContent('#skList');
    ok(/Paid £60 · listed £85/.test(txt), 'paid · listed: ' + txt.slice(0, 200));
    ok(/52 days old/.test(txt), 'age');
    ok(/3 left/.test(txt), 'copies');
    ok(/In ListMe, with no purchase linked/.test(txt) && /Example handheld/.test(txt), 'ListMe-only item');
    await page.waitForSelector('#skList [data-thumb] img', { timeout: 5000 });
    ok(await page.$eval('.skage.old', el => /52 days/.test(el.textContent)), 'past 45 days in warning colour');
    await noSideScroll(page);
    await ctx.close();
  });

  await t('Cash: three taps, 5-second undo, then one Paid row', async () => {
    g = seed(); const { ctx, page } = await open();
    await toStock(page);
    await page.click('.sellthis[data-sell="3"]');
    await page.waitForSelector('#vSell:not(.hide)');
    ok((await page.inputValue('#sePrice')) === '50', 'price is the listed price');
    await page.click('#sePlus');
    ok((await page.inputValue('#sePrice')) === '100', 'price follows the quantity');
    await page.fill('#sePrice', '90');
    ok(/10% off asking/.test(await page.textContent('#seOff')), 'off asking');
    ok(/Profit £20.02/.test(await page.textContent('#seProfit')), 'profit: ' + await page.textContent('#seProfit'));
    await page.click('#btnSeCash');
    await page.waitForSelector('.undobar');
    ok(/Sold for £90 · cash/.test(await page.textContent('.undobar')), 'undo bar');
    ok(sales().length === 0, 'not sent during the undo window');
    await page.waitForFunction(() => !document.querySelector('.undobar'), null, { timeout: 8000 });
    await page.waitForTimeout(800);
    const s = sales();
    ok(s.length === 1, 'one row');
    const r = s[0];
    ok(r.platform === 'In person' && r.quantity === 2 && r['sale price'] === 90 && r['payment method'] === 'Cash' && r['payment status'] === 'Paid', JSON.stringify(r).slice(0, 300));
    ok(r['listed at'] === 100 && r['off asking %'] === 10, 'listed at / off asking');
    ok(r['listme units'] === 'u2,u3', 'ListMe units: ' + r['listme units']);
    ok(/Purchases row 3/.test(r['linked purchase']) && r['item cost'] === 69.98, 'linked + cost');
    ok(!(await page.isHidden('#vStock')), 'back on Stock');
    await ctx.close();
  });

  await t('Undo puts it back and saves nothing', async () => {
    g = seed(); const { ctx, page } = await open();
    await toStock(page);
    await page.click('.sellthis[data-sell="2"]');
    await page.click('#btnSeCash');
    await page.click('.undobar button');
    await page.waitForSelector('#vSell:not(.hide)');
    await page.waitForTimeout(6000);
    ok(sales().length === 0, 'nothing saved');
    ok(await page.evaluate(() => JSON.parse(localStorage.getItem('rs_sale_outbox') || '[]').length) === 0, 'outbox empty');
    await ctx.close();
  });

  await t('Card: says where to take it, logs the fee on Done', async () => {
    g = seed(); const { ctx, page } = await open();
    await page.evaluate(() => refreshConfig());
    await toStock(page);
    await page.click('.sellthis[data-sell="2"]');
    ok(/Take it in SumUp · fee about £1.44/.test(await page.textContent('#btnSeCard')), await page.textContent('#btnSeCard'));
    await page.click('#btnSeCard');
    ok(/Take £85 in SumUp, then tap Done/.test(await page.textContent('#seCardStep')), 'card step');
    ok(/Profit £23.56/.test(await page.textContent('#seProfit')), 'profit after card fee: ' + await page.textContent('#seProfit'));
    await shot(page, 'sell-card-phone-light');
    // closed and reopened while taking the payment: it carries on
    await page.reload(); await page.waitForSelector('#seCardBox:not(.hide)');
    await page.click('#btnSeCardDone');
    await page.waitForFunction(() => !document.querySelector('.undobar'), null, { timeout: 8000 });
    await page.waitForTimeout(800);
    const r = sales()[0];
    ok(r && r['payment method'] === 'Card reader' && r['card app'] === 'SumUp' && r['platform fees'] === 1.44, JSON.stringify(r || {}).slice(0, 300));
    await ctx.close();
  });

  await t('Card didn\'t go through: nothing logged', async () => {
    g = seed(); const { ctx, page } = await open();
    await toStock(page);
    await page.click('.sellthis[data-sell="2"]');
    await page.click('#btnSeCard'); await page.click('#btnSeCardCancel');
    ok(await page.isVisible('#btnSeCash'), 'pay buttons back');
    await page.waitForTimeout(500);
    ok(sales().length === 0 && !(await page.evaluate(() => localStorage.getItem('rs_card_wait'))), 'nothing kept');
    await ctx.close();
  });

  await t('No signal: saved on the phone, sent when back online', async () => {
    g = seed(); const { ctx, page } = await open();
    await toStock(page);
    await ctx.setOffline(true);
    await page.click('.sellthis[data-sell="4"]');
    await page.fill('#sePrice', '15');
    await page.click('#btnSeCash');
    await page.waitForFunction(() => !document.querySelector('.undobar'), null, { timeout: 8000 });
    await page.waitForTimeout(500);
    ok(sales().length === 0, 'nothing sent offline');
    ok(await page.evaluate(() => JSON.parse(localStorage.getItem('rs_sale_outbox') || '[]').length) === 1, 'waiting in the outbox');
    await ctx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(1500);
    ok(sales().length === 1 && sales()[0]['sale price'] === 15, 'sent once back online');
    await ctx.close();
  });

  await t('£0 asks first; the last one sold twice warns', async () => {
    g = seed(); const { ctx, page } = await open();
    await toStock(page);
    await page.click('.sellthis[data-sell="2"]');
    await page.fill('#sePrice', '0');
    await page.click('#btnSeCash');
    ok((page.__dialogs || []).some(m => /Give it away for £0/.test(m)), '£0 confirm');
    await page.waitForFunction(() => !document.querySelector('.undobar'), null, { timeout: 8000 });
    await page.waitForTimeout(800);
    // Sold again (the phone still thinks there's one, but the Sheet says none)
    await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('rs_stock')); d.items.find(i => i.row === 2).left = 1; localStorage.setItem('rs_stock', JSON.stringify(d)); STOCK = d; openSell(sellItem(d.items.find(i => i.row === 2)), 'vHome'); });
    await page.waitForFunction(() => !document.getElementById('seWarn').classList.contains('hide'), null, { timeout: 5000 });
    await page.click('#btnSeCash');
    ok((page.__dialogs || []).some(m => /This was the last one. Sell anyway\?/.test(m)), 'last-one warning');
    await page.waitForFunction(() => !document.querySelector('.undobar'), null, { timeout: 8000 });
    await page.waitForTimeout(800);
    ok(sales()[1].needs === 'sold more than you had: check', 'flagged in the Sheet');
    await ctx.close();
  });

  await t('Home → Sell something: search, sell an item with no purchase linked', async () => {
    g = seed(); const { ctx, page } = await open();
    await page.evaluate(() => loadStock());
    await page.click('#btnSellSome');
    await page.fill('#sfSearch', 'handheld');
    await page.click('#sfList .sellthis');
    ok(/Profit: link a purchase/.test(await page.textContent('#seProfit')), 'no purchase linked');
    await page.click('#btnSeCash');
    await page.waitForFunction(() => !document.querySelector('.undobar'), null, { timeout: 8000 });
    await page.waitForTimeout(800);
    const r = sales()[0];
    ok(r && r['listme units'] === 'u9' && r['linked purchase'] === '' && r['sale price'] === 70, JSON.stringify(r || {}).slice(0, 200));
    ok(!(await page.isHidden('#vHome')), 'back home');
    await ctx.close();
  });

  await t('ListMe link opens the same screen (and connects a fresh copy of the app)', async () => {
    g = seed();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => localStorage.setItem('tour:receipts:1117b', '{"opened":true}'));
    await ctx.route('https://script.google.com/**', async route => { const req = JSON.parse(route.request().postData() || '{}'); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(g.call(req.action, req)) }); });
    const page = await ctx.newPage(); page.on('pageerror', e => console.log('   page error:', e.message));
    const q = new URLSearchParams({ u: 'u2,u3,u4', k: 'g2', t: 'Example streaming stick', p: '50', r: '3', n: '3', c: '34.99', rx: RX });
    await page.goto(base + '#sell?' + q.toString());
    await page.waitForSelector('#vSell:not(.hide)');
    ok((await page.textContent('#seTitle')) === 'Example streaming stick', 'title');
    ok((await page.inputValue('#sePrice')) === '50', 'price');
    ok(await page.isVisible('#seQtyWrap'), 'stepper for 3 left');
    ok(await page.evaluate(() => location.hash === ''), 'link cleared');
    await page.click('#btnSeCash');
    await page.waitForFunction(() => !document.querySelector('.undobar'), null, { timeout: 8000 });
    await page.waitForTimeout(800);
    ok(sales()[0] && sales()[0]['listme units'] === 'u2', 'saved with its ListMe item');
    await ctx.close();
  });

  await t('About the buyer: the same section as the sale form, never required', async () => {
    g = seed(); g.props.BUSINESS_PROFILE = JSON.stringify({ type: 'sole', crm: true, cardApp: 'SumUp', cardFee: { perTap: 0, pct: 1.69 } });
    const { ctx, page } = await open();
    await page.evaluate(() => refreshConfig());
    await toStock(page);
    await page.click('.sellthis[data-sell="2"]');
    ok(await page.isVisible('#seBuyer'), 'collapsed row shown');
    ok(await page.evaluate(() => document.getElementById('saCrm').parentNode.id === 'seCrmSlot'), 'section moved here');
    await page.click('#seBuyer summary');
    await page.fill('#saBuyer', 'Example Buyer');
    await page.click('#saExp button[data-v="Good"]');
    await page.click('#btnSeCash');
    await page.waitForFunction(() => !document.querySelector('.undobar'), null, { timeout: 8000 });
    await page.waitForTimeout(800);
    const r = sales()[0];
    ok(r && r.buyer === 'Example Buyer' && r['buyer experience'] === 'Good' && r['listed at'] === 85, JSON.stringify(r || {}).slice(0, 300));
    ok(await page.evaluate(() => document.getElementById('saCrm').parentNode.id !== 'seCrmSlot'), 'back in the sale form');
    await ctx.close();
  });

  const BANK = { type: 'sole', cardApp: 'Monzo', cardFee: { perTap: 0, pct: 0 }, bank: { name: 'D Example', sort: '123456', acct: '12345678', link: '' } };
  await t('Bank transfer: QR and details, logged as awaiting, then Paid', async () => {
    g = seed(); g.props.BUSINESS_PROFILE = JSON.stringify(BANK);
    const { ctx, page } = await open();
    await page.evaluate(() => refreshConfig()); await toStock(page);
    await page.click('.sellthis[data-sell="2"]');
    await page.click('#btnSeBank');
    await page.waitForSelector('#vPay:not(.hide)');
    ok((await page.textContent('#pyTitle')) === 'Pay £85 by bank', 'heading');
    ok(await page.$('#pyQr svg'), 'QR drawn');
    const det = await page.textContent('#pyDet');
    ok(/D Example/.test(det) && /12-34-56/.test(det) && /12345678/.test(det) && /EXAMPL-\d{4}/.test(det) && /£85\.00/.test(det), det);
    ok(/Bank transfer: no fees/.test(await page.textContent('#pyHow')) && /Get paid by QR code/.test(await page.textContent('#pyHow')), 'how to pay');
    await shot(page, 'pay-phone-light');
    await page.waitForTimeout(1500);
    let r = sales()[0];
    ok(r && r['payment status'] === 'Awaiting payment' && r['counts in totals'] === 'No' && r['payment method'] === 'Bank transfer' && /^EXAMPL-/.test(r['payment ref']), JSON.stringify(r || {}).slice(0, 300));
    await page.click('#btnPayPaid');
    await page.waitForTimeout(1500);
    r = sales()[0];
    ok(sales().length === 1 && r['payment status'] === 'Paid' && r['counts in totals'] === 'Yes' && r['payment method'] === 'Bank transfer', JSON.stringify(r).slice(0, 300));
    await ctx.close();
  });

  await t('Bank with no signal: Paid before it was sent makes one Paid row; card through the QR keeps its fee', async () => {
    g = seed(); g.props.BUSINESS_PROFILE = JSON.stringify(BANK);
    const { ctx, page } = await open();
    await page.evaluate(() => refreshConfig()); await toStock(page);
    await ctx.setOffline(true);
    await page.click('.sellthis[data-sell="2"]'); await page.click('#btnSeBank');
    await page.waitForSelector('#vPay:not(.hide)');
    ok(await page.$('#pyQr svg'), 'QR works offline');
    await page.check('#pyCard'); await page.fill('#pyFee', '1.5');
    await page.click('#btnPayPaid');
    await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(1500);
    const r = sales();
    ok(r.length === 1 && r[0]['payment status'] === 'Paid' && r[0]['payment method'] === 'Card reader' && r[0]['platform fees'] === 1.5 && r[0]['card app'] === 'Monzo', JSON.stringify(r[0] || {}).slice(0, 300));
    await ctx.close();
  });

  await t('Left awaiting: on Sales and home; They didn\'t pay cancels and puts it back', async () => {
    g = seed(); g.props.BUSINESS_PROFILE = JSON.stringify(BANK);
    const { ctx, page } = await open();
    await page.evaluate(() => refreshConfig()); await toStock(page);
    await page.click('.sellthis[data-sell="2"]'); await page.click('#btnSeBank');
    await page.click('#btnPayLater');
    await page.waitForTimeout(1500);
    await page.evaluate(() => openSales());
    await page.waitForSelector('#slAwaitWrap:not(.hide)');
    ok(/Example games console/.test(await page.textContent('#slAwait')), 'listed on Sales');
    await page.evaluate(() => show('vHome'));
    ok(/1 sale awaiting payment/.test(await page.textContent('#todo')), 'home row: ' + await page.textContent('#todo'));
    await page.evaluate(() => openSales()); await page.waitForSelector('[data-awno]');
    await page.click('[data-awno]');
    await page.waitForTimeout(1500);
    ok(sales()[0].status === 'Cancelled' && sales()[0]['payment status'] === 'Cancelled', 'cancelled');
    ok(g.call('stock', {}).data.items.some(x => x.row === 2), 'back in stock');
    await ctx.close();
  });

  await t('The buyer\'s pay page shows the details from the link, with Copy buttons', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
    await page.goto(base + 'pay.html#n=D%20Example&s=123456&a=12345678&v=85.00&r=SWLITE-1117&t=Switch%20Lite');
    const txt = await page.textContent('main');
    ok(/Pay D Example by bank transfer/.test(txt) && /£85\.00/.test(txt) && /12-34-56/.test(txt) && /SWLITE-1117/.test(txt), txt);
    ok((await page.$$('button[data-c]')).length === 5, 'copy buttons');
    await shot(page, 'paypage-phone-light');
    await page.goto(base + 'pay.html#n=%3Cimg%20src=x%20onerror=alert(1)%3E&s=123456&a=12345678');
    ok(!(await page.$('main img')), 'names are shown as text');
    await ctx.close();
  });

  await t('About the buyer: full-size boxes, a new buyer, several interests at once, listed price from ListMe', async () => {
    g = seed(); g.props.BUSINESS_PROFILE = JSON.stringify({ type: 'sole', crm: true });
    const { ctx, page } = await open();
    await page.evaluate(() => refreshConfig()); await toStock(page);
    await page.click('.sellthis[data-sell="3"]');
    await page.click('#seBuyer summary');
    const w = await page.$eval('#saBuyer', el => el.getBoundingClientRect().width);
    const lw = await page.$eval('#saListed', el => el.getBoundingClientRect().width);
    ok(w > 300 && lw > 130, 'boxes full size: ' + w + ' / ' + lw);
    ok((await page.inputValue('#saListed')) === '50', 'listed at from ListMe: ' + await page.inputValue('#saListed'));
    await page.fill('#saBuyer', 'Example Newbuyer');
    await page.waitForSelector('[data-newb]');
    await page.click('[data-newb]');
    ok(/new buyer/.test(await page.textContent('#saBuyerHint')), 'new buyer note');
    await page.click('#intsQ');
    await page.waitForSelector('#intsDrop [data-opt="golf"]');
    await page.click('#intsDrop [data-opt="golf"]');
    await page.fill('#intsQ', 'train'); await page.waitForSelector('#intsDrop [data-opt="trainers"]');
    await page.click('#intsDrop [data-opt="trainers"]');
    await page.fill('#intsQ', 'lego, retro consoles');
    await page.keyboard.press('Enter');
    ok((await page.$$('.tagchip')).length === 4, 'four chips');
    await page.click('.tagchip [data-ix="1"]');
    await shot(page, 'buyer-phone-light');
    await page.click('#btnSeCash');
    await page.waitForFunction(() => !document.querySelector('.undobar'), null, { timeout: 8000 });
    await page.waitForTimeout(800);
    const r = sales()[0];
    ok(r && r.buyer === 'Example Newbuyer' && r['buyer interests'] === 'golf, lego, retro consoles', JSON.stringify(r || {}).slice(0, 400));
    ok(JSON.stringify(g.__g('readBuyers_')()).includes('Example Newbuyer'), 'added to Buyers');
    await ctx.close();
  });

  await t('Reopening with a card payment waiting and Buyers on starts normally (the v72 splash bug)', async () => {
    g = seed(); g.props.BUSINESS_PROFILE = JSON.stringify({ type: 'sole', crm: true, cardApp: 'Monzo' });
    const { ctx, page } = await open();
    await page.evaluate(() => refreshConfig()); await toStock(page);
    await page.click('.sellthis[data-sell="2"]'); await page.click('#btnSeCard');
    await page.reload();
    await page.waitForSelector('#seCardBox:not(.hide)', { timeout: 8000 });
    ok(!(await page.$('#splash')) || !(await page.isVisible('#bootRetry').catch(() => false)), 'no stuck splash');
    await ctx.close();
  });

  await t('Settings: bank details typed in are saved and reach the pay screen', async () => {
    g = seed(); const { ctx, page } = await open();
    await page.click('#btnSettings'); await page.waitForTimeout(800);
    await page.fill('#stBankName', 'D Example'); await page.fill('#stBankSort', '04-00-03'); await page.fill('#stBankAcct', '12345678');
    await page.click('#btnStSave'); await page.waitForTimeout(1500);
    const b = g.call('settings', {}).data.bank;
    ok(b.sort === '040003' && b.acct === '12345678' && b.name === 'D Example', JSON.stringify(b));
    ok(await page.evaluate(() => CFG.bank && CFG.bank.acct === '12345678'), 'on the phone');
    await ctx.close();
  });

  await t('Your numbers shows money awaiting payment', async () => {
    g = seed();
    g.call('saleSave', { clientId: 'a-wait-0000001', sale: { 'sale date': '17/11/2026', platform: 'In person', item: 'Example', 'sale price': 85, 'payment status': 'Awaiting payment' } });
    const { ctx, page } = await open();
    await page.click('#btnNumbers');
    await page.waitForSelector('#numBody .ncard');
    ok(/Awaiting payment \(1 sale\)\. Counted once it's paid£85\.00/.test(await page.textContent('#numBody')), 'awaiting line');
    await ctx.close();
  });

  await t('Settings: picking a card app fills in its fee', async () => {
    g = seed(); const { ctx, page } = await open();
    await page.click('#btnSettings');
    await page.waitForFunction(() => document.getElementById('stCardApp').value === 'SumUp');
    await page.selectOption('#stCardApp', 'Monzo');
    ok((await page.inputValue('#stTap')) === '20' && (await page.inputValue('#stPct')) === '1.4', 'Monzo fee');
    await ctx.close();
  });

  if (SHOTS) await t('Screenshots: phone and desktop, light and dark', async () => {
    for (const dark of [false, true]) for (const desktop of [false, true]) {
      g = seed(); const { ctx, page } = await open({ dark, desktop });
      const tag = (desktop ? 'desktop' : 'phone') + '-' + (dark ? 'dark' : 'light');
      await shot(page, 'home-' + tag);
      await toStock(page); await page.waitForSelector('#skList [data-thumb] img'); await shot(page, 'stock-' + tag); await noSideScroll(page);
      await page.click('.sellthis[data-sell="3"]'); await page.waitForTimeout(300); await page.fill('#sePrice', '45'); await page.click('#sePlus');
      await shot(page, 'sell-' + tag); await noSideScroll(page);
      await page.click('#btnSeCard'); await shot(page, 'sell-card-' + tag); await page.click('#btnSeCardCancel');
      await page.evaluate(b => { CFG.bank = b; }, { name: 'D Example', sort: '123456', acct: '12345678', link: '' });
      await page.click('#btnSeBank'); await page.waitForSelector('#vPay:not(.hide)'); await shot(page, 'pay-' + tag); await noSideScroll(page);
      await page.click('#btnPayNo'); await page.evaluate(() => openStock()); await page.waitForSelector('.sellthis'); await page.click('.sellthis[data-sell="3"]');
      await page.click('#btnSellBack'); await page.evaluate(() => show('vHome'));
      await page.click('#btnSellSome'); await page.fill('#sfSearch', 'example'); await page.waitForTimeout(300); await shot(page, 'sellfind-' + tag); await noSideScroll(page);
      await page.evaluate(() => openSettings()); await page.waitForFunction(() => document.getElementById('stCardApp').value === 'SumUp');
      await page.$eval('#stCardApp', el => el.scrollIntoView({ block: 'center' })); await page.screenshot({ path: path.join(SHOTS, 'settings-card-' + tag + '.png') });
      await ctx.close();
    }
  });

  await browser.close(); srv.close();
  console.log(`e2e_sell: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
