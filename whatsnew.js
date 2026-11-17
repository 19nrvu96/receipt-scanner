/* Guided tour of the 15–17 November changes in Receipts (17 Nov: Sell in person. 16 Nov: To collect, return pick-ups, Purchases and drop-off trips added). Each feature opens the real screen, points at the
   real thing, says what to do, then shows what it does in the Google Sheet and in FlipCheck and ListMe.
   Opens once on this phone; reopen from Settings → What's new. Engine: tour-engine.js.
   Previews use example data only (this app is public, so no real data goes in it). */
(function () {
  if (!window.FlipTour) return;
  const M = window.FlipTour.mock;
  const go = fn => async () => { try { await fn(); } catch (e) {} };
  const sales = t => go(() => openSales(t));
  const ready = async () => { try { return !!(typeof CFG !== 'undefined' && CFG.newReturns); } catch (e) { return false; } };

  const RET_CARD = M.receipts('<div class="c"><div class="st">Pokémon TCG 30th Battle <span class="sm">×2</span></div><div class="sm">Smyths Toys · bought 30/10/2026 · £39.98 · from ListMe</div>' +
    '<span class="tag soon">Last day Fri 27 Nov</span><span class="tag">🏬 Shop: often 28–30 days</span><span class="tag">QR code saved</span>' +
    '<div><span class="b">Show return QR code</span></div><div><span class="b s">✓ Returned it</span><span class="b s">📷 Refund receipt</span></div></div>', 'Sales → To return');

  const D17 = 'New today · 17 Nov', D16 = '16 Nov', D15 = '15 Nov';
  // Tonight's: Purchases page, drop-off trips. Made-up example data.
  const PU_CARD = M.receipts('<div class="c"><div class="st">Facebook Marketplace <span style="float:right">£50.00</span></div><div class="sm">16/11/2026 · logged 20:09</div>' +
    '<span class="tag" style="background:#eef3fb;color:#1d4f91">📊 FlipCheck</span><span class="tag">Cash</span>' +
    '<div class="sm">Games console, handheld · £31.20<br>Racing game · £10.40<br>Platform game · £8.40</div>' +
    '<div><span class="b s">FlipCheck analysis ↗</span><span class="b s">Listing ↗</span><span class="b s">🚗 Log the trip (8.5 mi each way)</span></div></div>', 'Purchases');
  const DROP_SHEET = M.receipts('<div class="c"><div class="st">Log the trip to drop it off?</div><div class="sm">Driving to post a sale counts as business miles. InPost: where did it go?</div>' +
    '<span class="tag" style="background:#0a84ff;color:#fff">🔐 Locker</span><span class="tag">🏪 ParcelShop</span><span class="tag">📮 Post Office</span><span class="tag">🏠 Collected from home</span>' +
    '<div class="sm">Where (optional): <i>Locker, Example Superstore</i></div><div><span class="b">🚗 Log the trip now</span><span class="b s">Save it for later</span></div></div>', 'Sales → ✓ Posted');
  const TRIPS_CARD = M.receipts('<div class="c"><div class="st">Trips to log <span class="tag">2</span></div><div class="sm"><b>Mon 16 Nov</b> <span class="b s">Log these 2 as one trip</span></div>' +
    '<div class="sm">📦 <b>Drop-off: Pipe fittings</b><br>Locker: 24/7 Locker - Example Superstore, Townsville · 18:05</div>' +
    '<div class="sm">🛍️ <b>Collected: Games console + 2 games</b><br>Facebook Marketplace · Townsville · about 8.5 miles each way · from FlipCheck</div>' +
    '<div><span class="b">Log it</span><span class="b s">Not needed</span></div></div>', 'Log a trip');

  const MSGS = M.receipts('<div class="c"><div class="st">Saved messages</div><div class="sm">Shared with ListMe (the Messages tab in your Sheet): change one here or in ListMe and it changes in both.</div>' +
    '<div style="margin-top:6px"><b>Still available</b><div class="sm">Hi [Name], yes the [Item] is still available at £[Price]. I can do [Times]…</div></div><div><span class="b s">Edit</span><span class="b s">✕</span></div></div>', 'Settings → Collection');
  // Today's: click & collect, and courier pick-up returns. Example data only (Argos / Amazon style, made-up orders).
  const COLL_CARD = M.receipts('<div class="c"><div class="st"><span class="tag">3 ×</span> Ninja Air Fryer AF100</div><div class="sm">📍 Example Retail Park Argos · #1234567890</div><div class="sm">£179.97 · £59.99 each · for Resale Stock</div>' +
    '<span class="tag late">Collect by tomorrow</span><div><span class="b">Details &amp; code</span><span class="b s">✓ Collected</span></div></div>', 'Sales → To collect');
  const COLL_SHEET = M.receipts('<div class="c"><div class="st">3 × Ninja Air Fryer AF100</div><div class="sm" style="background:#fff4e5;color:#7a4a00;border-radius:8px;padding:6px 8px;margin:6px 0">📦 Collect 3 items. Check you get them all.</div>' +
    '<div class="sm"><b>Example Retail Park Argos</b><br>1 Example Road, Townsville AB1 2CD</div><div><span class="b s">🧭 Directions</span><span class="b s">📅 Remind me</span></div>' +
    '<div class="sm" style="margin-top:6px"><b style="color:#1a73e8">Today 9:00am–9:00pm</b> · Sun 10:00am–4:00pm</div>' +
    '<div style="margin:8px 0;height:44px;background:repeating-linear-gradient(90deg,#000 0 2px,#fff 2px 4px,#000 4px 5px,#fff 5px 8px)"></div><div style="text-align:center;font-weight:700;letter-spacing:2px">1234567890</div></div>', 'Details & code');
  const PICK_CARD = M.receipts('<div class="c"><div class="st">Desk lamp, black</div><div class="sm">Amazon · bought 10/11/2026 · £24.99 · #205-1111111-2222222</div>' +
    '<span class="tag soon">🚚 UPS pick-up tomorrow · Mon-Fri: 9AM-5PM</span><span class="tag" style="background:#e8f6ee;color:#1b6b3a">About £24.99 back</span>' +
    '<div class="sm">📍 Collected from TOWNSVILLE</div><div class="sm" style="margin-top:6px">1. <b>Print the label</b> <span class="b s">🖨 Print label</span><span class="b s">✓ Printed</span><br>2. <b>Pack it</b> · How to pack it (3)<br>3. <b>Hand it to the driver</b>, then tap ✓ Picked up</div>' +
    '<div class="sm" style="margin-top:6px;color:#0a58ca">📅 Reschedule · 🔁 Change return method · ⏰ Remind me</div><div class="sm">📋 Order details to copy ▸</div>' +
    '<div><span class="b">✓ Picked up</span><span class="b s">📷 Refund receipt</span></div><div class="sm" style="color:#0a58ca">✕ Cancel this return</div></div>', 'Sales → To return');
  // 17 Nov: Sell in person. Made-up example data only.
  const SELL_ROW = M.receipts('<div class="c" style="display:flex;gap:10px;align-items:center"><div style="width:44px;height:44px;border-radius:10px;background:#eef0f4"></div><div style="flex:1"><div class="st">Example games console</div><div class="sm">Paid £60 · listed £85 · 2 left</div><div class="sm" style="color:#b25e00;font-weight:700">52 days old</div></div><span class="b" style="background:#14804a">Sell this</span></div>', 'Stock');
  const SELL_SCREEN = M.receipts('<div class="c"><div class="st">Example games console</div><div class="sm">Paid £60 · listed £85 · 2 left</div>' +
    '<div style="font-size:28px;font-weight:700;border:2px solid #d0d0d5;border-radius:12px;padding:4px 10px;margin:8px 0">£75</div><div class="sm"><b>12% off asking</b> · Profit <b>£15</b> after costs</div>' +
    '<div style="margin-top:8px"><span class="b" style="background:#14804a;display:block;margin-bottom:6px">Cash · logs it now</span><span class="b" style="background:#3d3f8f;display:block">Card · take it in Monzo · fee about £1.25</span></div></div>', 'Sell in person');
  const SELL_CARD = M.receipts('<div class="c"><div class="st">Take £75 in Monzo, then tap Done</div><div class="sm">Card fee £1.25 (1.4% + 20p). Change it in Settings → Selling.</div><div><span class="b">Done, they paid</span><span class="b s">The card didn\'t go through</span></div></div>', 'Card');
  const PAY_SCREEN = M.receipts('<div class="c"><div class="st">Pay £75 by bank</div><div style="width:120px;height:120px;margin:6px auto;background:repeating-linear-gradient(45deg,#000 0 6px,#fff 6px 12px);border:8px solid #fff;outline:1px solid #ddd"></div>' +
    '<div class="sm">Name <b>D Example</b> · Sort code <b>12-34-56</b> · Account <b>12345678</b> · Reference <b>EXAMPL-1117</b> <span class="b s">Copy</span></div>' +
    '<div class="sm" style="background:#fff1d6;border-radius:8px;padding:6px 8px;margin:6px 0"><b>Only tap Paid when you see it in your bank app, not on their screen.</b></div>' +
    '<div><span class="b">It\'s in my bank</span><span class="b s">Leave as awaiting payment</span></div><div class="sm" style="color:#0a58ca">They didn\'t pay</div></div>', 'Bank transfer');
  const SELLCH = [
    { id: 'rs-paybank', day: D17, icon: '🏦', title: 'Get paid by bank in person', summary: 'A QR code and your details on screen; Paid when it\'s in your bank',
      steps: [
        { title: 'Your bank details, once', go: go(() => openSettings()), target: '#stBankCard',
          text: 'Settings → Selling → <b>Get paid by bank</b>: account name, sort code and account number (buyers see these), and a payment link if you have one. They stay in your own Google account and on your phone, so the pay screen works with no signal.',
          todo: ['Fill them in and tap <b>Save</b>.'] },
        { title: 'Bank transfer', mock: PAY_SCREEN,
          text: 'On the Sell screen, tap <b>Bank transfer</b>. The sale is logged as <b>Awaiting payment</b> (not in your totals yet) and the buyer scans the QR code: it opens a page with your details, the amount and a short reference, each with a Copy button. Or they type the details from your screen. With Monzo you can still show your own Monzo QR code instead.',
          todo: ['Tap <b>It\'s in my bank</b> only once you see it in your bank app.', 'Paid by card through your Monzo QR? Tick <b>They paid by card</b> and put in the fee.', '<b>They didn\'t pay</b> cancels it and puts the item back in stock (and back on sale in ListMe).'] },
        { title: 'Waiting for the money', go: go(() => show('vHome')), target: '#todo',
          missing: 'Nothing awaiting payment now. When something is, home says <b>💷 1 sale awaiting payment</b>.',
          text: 'Left as awaiting payment? Home shows it, and turns into a warning after a day. <b>Sales → Awaiting payment</b> has It\'s in my bank, Show pay screen and They didn\'t pay.' },
      ],
      effect: [
        { app: 'Sheet', text: 'The sale row has <b>payment status</b> Awaiting payment, then Paid (with <b>paid at</b>), and the <b>payment ref</b>. It only counts in profit and the tax summary once it\'s Paid. Your numbers shows money awaiting payment on its own line.' },
        { app: 'ListMe', text: 'The item comes off sale straight away. If they didn\'t pay, it goes back on sale and the sites flagged to end it go back to live.' },
      ] },
    { id: 'rs-sellthis', day: D17, icon: '💷', title: 'Sell in person in three taps', summary: 'Find it, check the price, tap how they paid',
      steps: [
        { title: 'Sell this', go: go(() => openStock()), target: '.sellthis',
          missing: 'Nothing in stock right now. With stock, each row looks like this:', mock: SELL_ROW,
          text: 'Every Stock row has a <b>Sell this</b> button. Rows show what you paid, what it\'s listed at in ListMe, how many are left and how old it is (orange once it\'s past 45 days). The photo comes from ListMe.',
          todo: ['Open <b>Sales → Stock</b>.', 'Tap <b>Sell this</b> on the item in your hand.'] },
        { title: 'Check the price', mock: SELL_SCREEN,
          text: 'The price is filled in with the listed price. Tap it to change it. Under it you see <b>% off asking</b> and your <b>profit after costs</b>, live. With more than one left, a − / ＋ sets how many.',
          todo: ['Change the price if you agreed less.', 'Tap <b>Cash</b>: it\'s logged, with 5 seconds to Undo, and you\'re back where you were.'] },
        { title: 'Card', mock: SELL_CARD,
          text: 'Card apps don\'t let other apps start a payment for them, so Receipts tells you where to take it and waits. Tap <b>Done, they paid</b> once your card app says it went through. The fee comes off your profit.',
          todo: ['Tap <b>Card</b>, take the payment in your card app, then come back and tap <b>Done, they paid</b>.'] },
        { title: 'From the home screen', go: go(() => show('vHome')), target: '#btnSellSome',
          text: '<b>Sell something</b> opens a search of your stock. It works with no signal: your stock and the small photos are kept on your phone, and the sale is sent when you\'re back online.',
          todo: ['Tap <b>Sell something</b> and type a word or two.'] },
        { title: 'Your card app and fee', go: go(() => openSettings()), target: '#stCardApp',
          text: 'Settings → Selling → <b>Card payments in person</b>. Pick your app and its usual fee fills in (checked 17 Nov 2026). Check it against your app: fees change.',
          todo: ['Pick your card app.', 'Tap <b>Save</b> at the bottom.'] },
      ],
      effect: [
        { app: 'Sheet', text: 'One row on the Sales tab: In person, price, listed at, % off asking, Cash or Card (and which app), the card fee, <b>payment status</b> Paid, linked to its purchase, so profit and days to sell work.',
          mock: M.sheet('Sales', ['item', 'sale price', 'platform fees', 'payment method', 'payment status', 'profit'], [['Example games console', '75', '1.25', 'Card reader', 'Paid', '13.75']], [[0, 4]], ['Purchases', 'Sales', 'Listed']) },
        { app: 'ListMe', text: 'Next time ListMe opens it marks the item sold, and the 🔔 lists the other sites to end it on. ListMe\'s <b>Sold → In person</b> opens this same screen.' },
        { app: 'FlipCheck', text: 'If you bought it through FlipCheck, its deal moves to <b>Sold</b> with the real price and profit next to the estimate.' },
      ] },
  ];

  const NEWCH = [
    { id: 'rs-collect', day: D16, icon: '🛍️', title: 'To collect: click & collect', summary: 'What, how many, where, opening times, the code',
      steps: [
        { title: 'Forward the "ready to collect" email',
          mock: M.email('info@argos.example', 'Your order is ready to collect - 1234567890', '3 items ready for collection from Example Retail Park Argos<br>You have until Mon 23 November to collect<br>Monday 9:00am – 9:00pm …<br>Ninja Air Fryer AF100 · Qty:3 · £179.97'),
          text: 'When a shop emails that your order is ready, forward it to your receipts address like any receipt. It\'s read by rules (no AI request, so it\'s free): the items, how many, the price each, the store and address, its opening times and the last day to collect.',
          todo: ['Forward the email.', 'Within a few minutes it\'s under <b>Sales → To collect</b>, and the home screen says <b>🛍️ 1 order ready to collect</b>.'] },
        { title: 'Your To collect list', go: sales('slCollWrap'), target: '#slCollWrap',
          missing: 'Nothing to collect right now. With an order waiting, it looks like this:', mock: COLL_CARD,
          text: 'Each order shows how many, the price each, what it\'s for (from your Sheet), the store and the last day. The tag turns red on the last two days, and the home screen shows <b>🔴 last day</b> too.',
          todo: ['Open <b>Sales</b> and scroll to <b>To collect</b>.'] },
        { title: 'Before you go in', go: sales('slCollWrap'), target: '[data-cview]',
          missing: 'No order to open yet. Its details look like this:', mock: COLL_SHEET,
          text: '<b>Details &amp; code</b> shows everything before you go in: what you\'re collecting and how many, the address with <b>🧭 Directions</b>, the opening times (today highlighted, or <b>Find opening times ↗</b> if the email had none), and a barcode made from the order number for the counter or kiosk.',
          todo: ['Tap <b>Details &amp; code</b>.', '<b>📅 Remind me</b> adds a calendar alert the day before the last day.', 'At the counter, show the barcode, or read out the number under it.'] },
        { title: 'Collected (or cancelled)', go: sales('slCollWrap'), target: '[data-cdone]',
          missing: 'The buttons are on each To collect card.',
          text: '<b>✓ Collected</b> logs it with the date, then offers <b>🚗 Log the trip there and back</b> (from home, or 📍 from where you are) and <b>🧾 Add the collection receipt</b> (a photo, saved as evidence). <b>Cancel collection</b> asks "are you sure?" first, then logs it as Cancelled.',
          todo: ['Tap <b>✓ Collected</b>.', 'Tap <b>🚗 Log the trip</b>, check the miles, save.', 'Tap <b>🧾 Add the collection receipt</b> and take the photo.'] },
      ],
      effect: [
        { app: 'Sheet', text: 'A new <b>To collect</b> tab: one row per order, then <b>Collected</b> or <b>Cancelled</b> with the date, the trip and the receipt link.',
          mock: M.sheet('To collect', ['retailer', 'store', 'items', 'collect by', 'status', 'collected on', 'mileage', 'receipt'], [['Argos', 'Example Retail Park Argos', '3 × Ninja Air Fryer AF100 @ £59.99', '23 November', 'Collected', '18/11/2026', 'Mileage row 42 · 6.4 miles', 'drive…/collection.jpg']], [[0, 4], [0, 5], [0, 6], [0, 7]], ['Purchases', 'Sales', 'To collect', 'Mileage']) },
        { app: 'Sheet', text: 'The trip goes on your <b>Mileage</b> tab as a return trip, linked to the order. The receipt photo is also linked on the order\'s Purchases lines if they had none.' },
        { app: 'Drive', text: 'The collection receipt photo goes in <b>Receipt Images</b>, private to you.' },
      ] },
    { id: 'rs-pickup', day: D16, icon: '🚚', title: 'Return pick-ups', summary: 'Countdown, print, pack, reschedule, cancel, copy',
      steps: [
        { title: 'Forward the return email',
          mock: M.email('return@amazon.example', 'Your return of Desk lamp, black…', 'Your return request is confirmed.<br>Pick-up scheduled for the next business day. From TOWNSVILLE.<br>Total estimated refund £24.99<br><u>Print label</u> · <u>Reschedule</u> · <u>Change return method</u> · <u>Cancel</u>'),
          text: 'When you book a return that a courier collects, forward the shop\'s confirmation. It\'s read by rules (free): the courier, the pick-up day and times, where from, how to pack it, the estimated refund, the reason, and the email\'s own buttons. "Your refund will be issued after pick-up" is no longer mistaken for the refund itself.',
          todo: ['Forward the email to your receipts address.', 'It joins the order\'s return (by order number). If the order isn\'t in your Sheet, the return is started from the email.'] },
        { title: 'The countdown', go: sales('slToRetWrap'), target: '.pkbox', wait: true,
          missing: 'No pick-up booked right now. With one, the card looks like this:', mock: PICK_CARD,
          text: 'The card says when the courier comes (<b>today</b> and <b>tomorrow</b> in red and amber), and the home screen says <b>🚚 Return pick-up today or tomorrow: print the label and pack it</b>. <b>⏰ Remind me</b> adds a calendar alert for 8:30 that morning.',
          todo: ['Open <b>Sales → To return</b>.'] },
        { title: 'Print, then tick', go: sales('slToRetWrap'), target: '[data-rprinted]', wait: true,
          missing: 'The steps are on a pick-up card.',
          text: '<b>🖨 Print label</b> opens the shop\'s own label page. Once it\'s printed, tap <b>✓ Printed</b> so you know it\'s done. <b>How to pack it</b> lists the shop\'s instructions.',
          todo: ['Tap <b>🖨 Print label</b> and print it.', 'Tap <b>✓ Printed</b>.'] },
        { title: 'Reschedule or cancel', go: sales('slToRetWrap'), target: '[data-rresched]', wait: true,
          missing: 'These are on a pick-up card.',
          text: '<b>📅 Reschedule</b> asks "are you sure?", opens the shop\'s reschedule page, then asks for the new day so the countdown is right. <b>✕ Cancel this return</b> asks first, opens the shop\'s cancel page, then asks you to confirm once it\'s cancelled. If the shop\'s "return cancelled" email comes first, the return is cancelled in your Sheet for you.',
          todo: ['Tap <b>📅 Reschedule</b> → <b>Yes</b> → pick a day on their page → put it in here.', 'Or <b>✕ Cancel this return</b> → <b>Yes</b> → cancel on their page → <b>✓ It\'s cancelled</b>.'] },
        { title: 'Order details to copy', go: sales('slToRetWrap'), target: '.cpbox', wait: true,
          missing: 'On each return card.',
          text: 'Shop return pages ask for things from the order. <b>📋 Order details to copy</b> lists them (order number, item, quantity, price, date, reason, the email used for the order, refund), each with a copy button to paste straight into their page.',
          todo: ['Open <b>📋 Order details to copy</b>.', 'Tap 📋 next to one, then paste it into the shop\'s page.'] },
        { title: 'Picked up, then the refund', go: sales('slToRetWrap'), target: '[data-rsent]', wait: true,
          missing: 'On each return card.',
          text: 'Tap <b>✓ Picked up</b> when the driver has it (a "picked up" email from the shop does it for you). When the refund comes, forward the refund email or scan the receipt: it\'s joined to this return by its order number, even if the order was never in your Sheet.' },
      ],
      effect: [
        { app: 'Sheet', text: 'The return\'s row on <b>Returns</b> gets the method, courier, pick-up day, printed date and estimated refund; then <b>Sent back</b>, and <b>Refunded</b> with the proof. Cancelled ones say <b>Cancelled</b> with the date.',
          mock: M.sheet('Returns', ['status', 'item', 'method', 'courier', 'pickup date', 'printed on', 'refund estimate'], [['To return', 'Desk lamp, black', 'Pick-up', 'UPS', '17/11/2026', '16/11/2026', '24.99']], [[0, 2], [0, 3], [0, 4], [0, 5], [0, 6]], ['Purchases', 'Sales', 'Returns', 'To collect']) },
        { app: 'Sheet', text: 'The order\'s line on <b>Purchases</b> gets a note on its item: "Return started", then "Picked up", "Refunded £24.99" (or "Return cancelled"), so the story is on the purchase too.' },
      ] },

    { id: 'rs-purchases', day: D16, icon: '🛍️', title: 'Purchases: everything you logged', summary: 'Newest first, where each came from, FlipCheck buys too',
      steps: [
        { title: 'One page for every purchase', go: go(() => openPurchases()), target: '#puList', wait: true,
          missing: 'Nothing logged yet. With purchases, it looks like this:', mock: PU_CARD,
          text: 'Home → <b>Purchases</b>. One card per receipt, email or purchase, newest first. Each says where it was logged from: 📷 receipt photo, ✉️ email, ✍️ typed in, or 📊 <b>FlipCheck</b>.',
          todo: ['Tap <b>Purchases</b> on the home screen.', 'Tap a chip (e.g. <b>📊 FlipCheck</b>) to see just those, or search an item, shop or order number.'] },
        { title: 'Bought in FlipCheck', go: go(() => openPurchases()), target: '#puFrom', wait: true,
          missing: 'The chips appear once you have purchases from more than one place.',
          text: 'In FlipCheck, an analysis now has a <b>Bought it?</b> box: what you paid, the day, how you paid. <b>Save: I bought it</b> marks the ledger as Bought, adds it here (one line per item, the price split by what each sells for) and sends it to ListMe. A private seller has no return window, so no "last days to return" for these.',
          todo: ['In FlipCheck, open the analysis and scroll to <b>Next</b>.', 'Fill in <b>Paid</b> and <b>Paid by</b>, tick <b>Add to Receipts</b>, tap <b>Save: I bought it</b>.'] },
        { title: 'The trip to collect it', go: go(() => openPurchases()), target: '[data-putrip]', wait: true,
          missing: 'On a FlipCheck card where you drove to collect it.',
          text: 'FlipCheck knows how far the seller was, so the card offers <b>🚗 Log the trip</b>: the form opens filled in (home → the seller → home). Once saved it says <b>🚗 Trip logged</b>.' },
      ],
      effect: [
        { app: 'Sheet', text: 'Each line on <b>Purchases</b> has a new last column, <b>logged from</b>. FlipCheck buys have the analysis as the document link and the trip in the notes.',
          mock: M.sheet('Purchases', ['item', 'total cost', 'store', 'payment method', 'notes', 'logged from'], [['Games console, handheld', '31.20', 'Facebook Marketplace', 'Cash', 'Bought through FlipCheck · Trip: 8.5 miles each way to Townsville', 'FlipCheck'], ['Racing game', '10.40', 'Facebook Marketplace', 'Cash', 'Bought through FlipCheck · …', 'FlipCheck']], [[0, 5], [1, 5]], ['Purchases', 'Sales', 'Mileage']) },
      ] },

    { id: 'rs-droptrips', day: D16, icon: '🚗', title: 'Drop-off trips', summary: 'Posted? Log the trip now, later, or let the receipt fill it in',
      steps: [
        { title: 'Posted asks about the trip', go: sales('slPostWrap'), target: '[data-posted]', wait: true,
          missing: 'Nothing to post right now. When you tap ✓ Posted, this comes up:', mock: DROP_SHEET,
          text: 'After <b>✓ Posted</b>: was it a <b>locker</b>, <b>ParcelShop</b>, <b>Post Office</b>, a <b>pickup point</b>, or <b>collected from home</b>? Then <b>Log the trip now</b>, <b>Save it for later</b>, or <b>No trip</b>. Posting several? Only the first asks: the rest join the same trip for 3 hours.',
          todo: ['Tap <b>✓ Posted</b> on a parcel.', 'Pick where it went, then <b>Save it for later</b> if you\'ve more to drop off.'] },
        { title: 'The drop-off receipt fills it in', mock: M.email('inpost@inpost.example', 'Your digital receipt', 'Thanks for dropping off your parcel.<br>Parcel number <b>JJD0000000000000001</b><br>Drop-off time <b>16/11/2026 18:05</b><br>Drop-off point <b>24/7 Locker - Example Superstore, 1 High Street, Townsville AB1 2CD</b>'),
          text: 'Forward the drop-off receipt (InPost, Evri, Royal Mail, DPD, Yodel) to your receipts address. It\'s read by rules (free), matched to the parcel by its number, and fills in where and when it went. If you forgot to tap Posted, it marks it posted too.',
          todo: ['Forward the courier\'s "dropped off" email to your receipts address.'] },
        { title: 'Trips to log', go: go(() => openTrip()), target: '#tTodo', wait: true,
          missing: 'Nothing waiting right now. With some, the top of the trip page looks like this:', mock: TRIPS_CARD,
          text: 'Home → <b>🚗 Trips to log</b>, or open <b>Log a trip</b>. Drop-offs saved for later or filled in from a receipt, and FlipCheck collections, grouped by day. <b>Log these as one trip</b> puts them all on one route (home → each place → home). <b>Not needed</b> takes one off.',
          todo: ['Open <b>Log a trip</b>.', 'Tap <b>Log it</b> or <b>Log these as one trip</b>, check the miles, <b>Save trip</b>.'] },
      ],
      effect: [
        { app: 'Sheet', text: '<b>To post</b> gets four new columns: <b>drop-off type</b>, <b>drop-off</b>, <b>drop-off time</b> and <b>trip</b> (Later, None, or the Mileage row once logged). The <b>Mileage</b> row says what it covered.',
          mock: M.sheet('To post', ['item', 'status', 'tracking', 'drop-off type', 'drop-off', 'drop-off time', 'trip'], [['Pipe fittings', 'Posted', 'JJD0000000000000001', 'Locker', '24/7 Locker - Example Superstore, Townsville AB1 2CD', '16/11/2026 18:05', 'Mileage row 43 · 17 miles']], [[0, 3], [0, 4], [0, 5], [0, 6]], ['Purchases', 'Sales', 'To post', 'Mileage']) },
      ] },

    { id: 'rs-msgs', day: D16, icon: '✉️', title: 'Saved messages, shared with ListMe', summary: 'One list, edit it in either app',
      steps: [
        { title: 'Your saved messages', go: go(() => openSettings()), target: '#stTpls', mock: MSGS, mockAlways: true,
          text: 'Your saved messages now live in your Sheet (a new <b>Messages</b> tab) instead of only on this phone, so ListMe uses the same ones. Any you saved on this phone before are moved there the first time. Change one here and it changes in ListMe, and the other way round. ListMe also fills <b>[Features]</b>, <b>[Condition]</b> and <b>[Link]</b> from the listing.',
          todo: ['Open <b>Settings</b> and scroll to <b>Saved messages</b>.', 'Edit one, or add one under <b>＋ Add a saved message</b>.', 'Needs today\'s script update: run <b>sh deploy.sh</b> on your Mac.'] },
      ],
      effect: [
        { app: 'Sheet', text: 'The <b>Messages</b> tab: name, message, when it was changed.', mock: M.sheet('Messages', ['name', 'message', 'updated'], [['Where to meet', 'Hi [Name], for security I don\'t meet people at my door…', '16/11/2026 07:00'], ['Still available', 'Hi [Name], yes the [Item] is still available at £[Price]…', '16/11/2026 07:00']], [[0, 0], [1, 0]], ['Purchases', 'Sales', 'Buyers', 'Messages']) },
        { app: 'ListMe', text: 'On each item with possible buyers (🔔), and on the new Leads page, these messages are filled in from the listing, ready to send by WhatsApp, text or email.' },
      ] },
    { id: 'rs-leads', day: D16, icon: '👥', title: 'Leads: spoken to, not bought yet', summary: 'They become buyers when they buy',
      steps: [
        { title: 'Not bought yet', go: go(() => openBuyers()), target: '[data-f=lead]',
          text: 'People you\'ve spoken to who haven\'t bought yet are on the Buyers tab too: add them with <b>＋ Add</b> here, or <b>+ Add a lead</b> in ListMe after a chat. The new <b>Not bought yet</b> filter shows just them.',
          todo: ['Open <b>Sales → Buyers</b>.', 'Tap <b>Not bought yet</b>.'] },
        { title: 'When they buy', go: sales(), target: '#btnNewSale',
          text: 'Log the sale and pick them under <b>Choose from your buyers</b> (or type their name). They become a buyer in both apps, with the sale counted on their row, even if you saved them by their username and the sale has their name (or the other way round).' },
      ],
      effect: [
        { app: 'Sheet', text: 'Their row on the <b>Buyers</b> tab: times bought, total spent and last bought fill in.', mock: M.sheet('Buyers', ['name', 'username', 'times bought', 'total spent', 'last bought'], [['Priya Shah', 'priya_s', '1', '85', '20/11/2026']], [[0, 2], [0, 3], [0, 4]], ['Purchases', 'Sales', 'Buyers', 'Messages']) },
        { app: 'ListMe', text: 'They move from <b>Interested</b> to <b>Buyers</b> on ListMe\'s Leads page, with "bought N times".' },
      ] },
    { id: 'rs-across', day: D16, icon: '🔀', title: 'Your Receipts data in the other apps', summary: 'Leads in ListMe, Shops in FlipCheck',
      steps: [
        { title: 'Your other apps', go: go(() => show('vHome')), target: '#appSw', missing: 'Your other apps show at the top of the home screen once their addresses are in Settings.',
          text: 'Two new pages use what Receipts already keeps. <b>ListMe → Leads</b>: everyone on your Buyers tab, with a 🔔 on items they might want and your saved messages filled in from the listing. <b>FlipCheck → Shops</b>: every shop from your Purchases tab, most visits first, with the cashback, gift card and discount sites checked for each. Neither changes your Sheet, except leads you add (Buyers tab) and messages you edit (Messages tab).',
          todo: ['Tap <b>ListMe</b> or <b>FlipCheck</b> at the top of the home screen.', 'Each one has its own tour of today\'s changes.'] },
      ] },
    { id: 'rs-dark', day: D15, icon: '🌙', title: 'Dark mode', summary: 'Automatic, light or dark',
      steps: [
        { title: 'Look', go: go(() => openSettings()), target: '#stTheme',
          text: '<b>Automatic</b> follows your phone (dark at night if your phone is). <b>Light</b> or <b>Dark</b> keeps it that way. QR codes stay black on white so they still scan.',
          todo: ['Open <b>Settings → Look</b>.', 'Pick one: it changes straight away.'] },
      ] },
  ];
  const chapters = [
    { id: 'rs-toreturn', icon: '↩️', title: 'To return', summary: 'Last day, returned, refund proof',
      steps: [
        { title: 'Your To return list', go: sales('slToRetWrap'), target: '#slToRetWrap', wait: true,
          missing: 'Nothing is being returned yet. Once something is, its card looks like this:', mock: RET_CARD,
          text: 'Everything you\'re taking back has a card: the last day, the shop, the amount, and where you decided (here, ListMe or FlipCheck). The last day is 14 days for online orders, 28 for shop receipts, or the receipt\'s own later "return by" date.',
          todo: ['Open <b>Sales</b> (home → Sales).', 'Scroll to <b>To return</b>.'] },
        { title: 'Handed it back?', go: sales('slToRetWrap'), target: '[data-rsent]', wait: true,
          missing: 'No returns yet: the button is on each To return card.',
          text: 'Once it\'s back at the shop, or dropped off for post, mark it so you know you\'re only waiting for the money.',
          todo: ['Tap <b>✓ Returned it</b>, then OK.', 'The card changes to "Returned: waiting for the refund".'] },
        { title: 'Attach the refund', go: sales('slToRetWrap'), target: '[data-rscan]', wait: true,
          missing: 'No returns yet: the button is on each To return card.',
          text: 'At the shop: photograph the refund receipt from this card, and it\'s attached to <b>this</b> return. Refunded online: forward the refund email to your receipts address, check it on the review screen, and save.',
          todo: ['Tap <b>📷 Refund receipt</b> and take the photo.', 'Check the review screen (the amount is negative) and tap <b>Save</b>.', 'The card moves to <b>Returned recently</b> with a <b>refund proof</b> link.'] },
      ],
      effect: [
        { app: 'Sheet', text: 'Deciding to return adds a row to the <b>Returns</b> tab.', mock: M.sheet('Returns', ['status', 'purchase row', 'item', 'amount', 'return by', 'from'], [['To return', '41', 'Pokemon TCG 30th Battle', '39.98', '27/11/2026', 'ListMe']], [[0, 0]], ['Purchases', 'Sales', 'Returns', 'To post']) },
        { app: 'Sheet', text: '<b>✓ Returned it</b> sets <b>Sent back</b> and the date. Saving the refund sets <b>Refunded</b>, the amount, the date, and the photo or email link as <b>refund proof</b>.',
          mock: M.sheet('Returns', ['status', 'item', 'sent back on', 'refund amount', 'refunded on', 'refund proof'], [['Refunded', 'Pokemon TCG 30th Battle', '24/11/2026', '39.98', '25/11/2026', 'drive…/refund.jpg']], [[0, 0], [0, 2], [0, 3], [0, 4], [0, 5]], ['Purchases', 'Sales', 'Returns', 'To post']) },
        { app: 'Sheet', text: 'On <b>Purchases</b>, the original line is marked <b>Returned</b> and <b>refunded</b>, and the refund is saved as its own line (a negative amount), so your tax figures stay right.',
          mock: M.sheet('Purchases', ['item', 'total cost', 'keep or return', 'refunded?', 'refund amount', 'document link'], [['Pokemon TCG 30th Battle', '39.98', 'Returned', 'Yes', '39.98', 'drive…/receipt.jpg'], ['Pokemon TCG 30th Battle', '-39.98', '', '', '', 'drive…/refund.jpg']], [[0, 2], [0, 3], [0, 4], [1, 1], [1, 5]]) },
        { app: 'ListMe', text: 'The item is archived (it\'s gone), and it was already off your to-do lists while it was going back.' },
        { app: 'FlipCheck', text: 'Its analysis\' Bought box says "Returned and refunded". The purchase leaves the Purchases list, because it\'s no longer in stock.' },
      ] },

    { id: 'rs-qr', icon: '🔳', title: 'Return QR codes', summary: 'Forward the shop\'s email; show it at the counter',
      steps: [
        { title: 'Forward the return email', wait: true,
          mock: M.email('returns@shop.example', 'Your return QR code for order 204-1234567', 'Take this code to any Evri ParcelShop. Please drop it off by 28 November.<div class="qr"></div>'),
          text: 'When you start a return on a shop\'s website, it usually emails you a QR code or a label. Forward that email to the same address you send receipts to.',
          todo: ['Forward it like any receipt email.', 'Receipts matches it to the return by order number, or by shop if only one return is open there.', 'If you hadn\'t marked it for return yet, it starts the return for you.'] },
        { title: 'Show it at the counter', go: sales('slToRetWrap'), target: '[data-rqr]', wait: true,
          missing: 'No return has a code yet. On a card with one, it looks like this:', mock: RET_CARD,
          text: 'The card says <b>QR code saved</b>. The code is kept on your phone, so it opens with no signal.',
          todo: ['Tap <b>Show return QR code</b>.', 'Turn the brightness up and let them scan it.', 'Then tap <b>✓ Returned it</b>. If the shop emails "we\'ve received your return", forwarding that does it for you.'] },
      ],
      effect: [
        { app: 'Drive', text: 'The code (image or PDF) goes in a <b>Return labels</b> folder, private to you.' },
        { app: 'Sheet', text: 'The return\'s row gets the files, the email link, and the shop\'s own drop-off date if the email gives one.',
          mock: M.sheet('Returns', ['status', 'item', 'return by', 'label files', 'return email'], [['To return', 'Pokemon TCG 30th Battle', '28/11/2026', '1a2B…', 'mail.google…/#all/18c…']], [[0, 2], [0, 3], [0, 4]], ['Purchases', 'Sales', 'Returns', 'To post']) },
      ] },

    { id: 'rs-closing', icon: '⏳', title: 'Last days to return', summary: 'Keep it or take it back, in time',
      steps: [
        { title: 'Reminders by receipt', go: sales('slRetWrap'), target: '#slRetWrap',
          missing: 'Nothing is near its last day. Your 30 October buys appear here from Friday 20 November. It looks like this:',
          mock: M.receipts('<div class="c"><div class="st">Smyths Toys · 2 things</div><div class="sm">bought 30/10/2026 · £49.96</div><span class="tag soon">Last day Fri 27 Nov</span><span class="tag">🏬 Shop: often 28–30 days</span><span class="tag" style="background:#fff6d6">Worth keeping? FlipCheck ›</span><div><span class="b s">Keep them all</span><span class="b">Return ticked</span></div></div>'),
          text: 'Unsold things bought to resell show up as their last day gets close: from day 10 of 14 for online orders, and from day 21 of 28 for shop receipts. A receipt you marked with a later <b>Return by</b> date (seasonal or Christmas) shows <b>🎄 Extended return date</b>, and only appears in its last 7 days.',
          todo: ['Not sure? Tap <b>Worth keeping? FlipCheck ›</b> to see if it\'s worth selling.', 'Tap <b>Keep it</b> (reminders stop), or <b>I\'ll return it</b>. For a receipt with several items, tick the ones going back first.'] },
      ],
      effect: [
        { app: 'ListMe', text: 'The same reminder shows on ListMe\'s Today on the same days, with Keep and We\'ll return it.' },
        { app: 'Sheet', text: '<b>I\'ll return it</b> adds the Returns row, the same as from ListMe or FlipCheck. <b>Keep</b> changes nothing in the Sheet: it just stops the reminders.' },
      ] },

    { id: 'rs-worth', icon: '🔍', title: 'Worth it? Ask FlipCheck', summary: 'From Stock, straight to that purchase',
      steps: [
        { title: 'On the Stock page', go: go(() => openStock()), target: '[data-skfc]', wait: true,
          missing: 'The links appear once the FlipCheck address is saved in this app (it is now: give the page a moment, or reopen Stock).',
          text: 'Every unsold line has a <b>🔍 Worth it?</b> tag. It opens FlipCheck on that exact purchase, with <b>Analyse</b> ready.',
          todo: ['Open <b>Stock</b>.', 'Tap <b>🔍 Worth it?</b> on a line.', 'In FlipCheck, tap <b>Analyse</b>, or <b>That\'s it</b> if you checked it before buying.'] },
        { title: 'Your other apps', go: go(() => show('vHome')), target: '#appSw', wait: true,
          text: 'FlipCheck and ListMe sit at the top of the home screen. After you save a resale receipt, the status line also says <b>Worth it? Check in FlipCheck</b>.' },
      ],
      effect: [
        { app: 'FlipCheck', text: 'The analysis is tied to this purchase: it uses what you paid, knows the last day to return, and can send it to ListMe in one tap. The Sheet is only read.' },
      ] },

    { id: 'rs-sales', icon: '💷', title: 'Clearer sales', summary: 'Take me there, % off asking, buyer search',
      steps: [
        { title: 'Needs a check: Take me there', go: sales('slNeedsWrap'), target: '#slNeedsWrap',
          missing: 'No sales need a check right now. When one does, it looks like this:',
          mock: M.receipts('<div class="c"><b>This sale needs a check</b><div class="sm">⚠️ No item cost yet <u>Take me there ›</u></div></div>'),
          text: 'A sale that needs a check now says exactly what\'s missing, and <b>Take me there ›</b> jumps to that field.',
          todo: ['Tap a sale under <b>Needs your input</b>.', 'Tap <b>Take me there ›</b> and fill it in.'] },
        { title: 'Logging a sale', go: sales(), target: '#btnNewSale',
          text: 'Put in what you listed it at, and Receipts saves how far <b>% off asking</b> the buyer got you. The fees section stays folded away unless there\'s a promoted fee or a refund. Buyers can be searched by name, phone number or email, and the cost search can be filtered by shop.',
          todo: ['Tap <b>＋ Log a sale</b>.', 'Fill in <b>Sold for</b> and <b>Listed at</b>: it shows, for example, "20% off asking (£10 less)".'] },
      ],
      effect: [
        { app: 'Sheet', text: 'The Sales tab saves <b>listed at</b> and <b>off asking %</b>, and Buyers shows each buyer\'s average.',
          mock: M.sheet('Sales', ['sale date', 'item', 'sale price', 'listed at', 'off asking %'], [['14/11/2026', 'Pokémon Blue', '80', '100', '20']], [[0, 3], [0, 4]], ['Purchases', 'Sales', 'Returns', 'To post']) },
      ] },

    { id: 'rs-parcels', icon: '📦', title: 'How many in the parcel', summary: 'On To post and the QR screen',
      steps: [
        { title: 'To post', go: sales('slPostWrap'), target: '#slPostWrap',
          missing: 'No parcels to post right now. With one, it looks like this:',
          mock: M.receipts('<div class="c"><div class="st"><span class="tag">2 ×</span> Pokémon booster</div><div class="sm">📦 2 items go in this parcel</div><div class="sm">eBay · Evri</div><div><span class="b">Show QR code</span><span class="b s">✓ Posted</span></div></div>'),
          text: 'Cards and the QR screen now say how many items go in one parcel, for example <b>Pack 2 items in this parcel. One code covers them all.</b>',
          todo: ['Tap <b>Show QR code</b> at the drop-off.', 'Then tap <b>✓ Posted</b>.'] },
      ],
      effect: [
        { app: 'Sheet', text: 'The To post tab has a <b>quantity</b> column, taken from the label email or the sale.' },
        { app: 'ListMe', text: 'ListMe\'s Today shows the same label with the drop-off near you.' },
      ] },

    { id: 'rs-reading', icon: '🤖', title: 'Saver reading and credit', summary: 'Cheaper first, kept only if it adds up',
      steps: [
        { title: 'The switch', go: go(() => openSettings()), target: () => { const c = document.getElementById('stSaver'); return c && c.closest('label'); },
          text: 'Receipts reads with the cheaper Flash-Lite model first and keeps the result only if the lines add up to the total. If they don\'t, it reads the receipt again with 3.6 Flash. The less accurate models have been dropped.',
          todo: ['Leave <b>Saver: cheaper model first</b> on to spend less.', 'Turn it off if you\'d rather always use the best model.'] },
        { title: 'Your Google credit', go: go(() => show('vHome')), target: '#usage',
          mock: M.receipts('<div class="c"><div class="st">Google credit (prepaid) £3.72</div><div class="sm">About 3,400 receipts now · next top-up of £5 after about 2,500</div></div>', 'home'),
          text: 'The home screen shows your prepaid Google credit, about how many receipts it covers, and when the next automatic top-up comes (£5 when it drops under £1, at most £10 a month). You get a warning when it\'s getting low.' },
        { title: 'Open this tour again', go: go(() => openSettings()), target: '[data-whatsnew]', text: 'Settings → <b>✨ What\'s new</b> brings this tour back. Use ☰ to jump to any feature.' },
      ] },
  ];

  chapters.forEach(c => { c.day = c.day || D15; });
  const all = SELLCH.concat(NEWCH.filter(c => c.day === D16), chapters, NEWCH.filter(c => c.day === D15));
  const cfg = { app: 'receipts', name: 'Receipts', key: 'tour:receipts:1117b', chapters: all, ready,
    get theme() { const d = document.documentElement.classList.contains('dark');
      return d ? { accent: '#0a84ff', accentInk: '#fff', bg: '#1d2027', fg: '#e8e8ea', line: '#3a3d45', strong: '#fff' } : { accent: '#0a84ff', accentInk: '#fff', bg: '#fff', fg: '#111', line: '#d6d6db', strong: '#111' }; },
    when: () => !!localStorage.getItem('rs_url') };
  window.whatsNew = () => window.FlipTour.start(cfg);
  document.addEventListener('click', e => { if (e.target.closest('[data-whatsnew]')) { e.preventDefault(); window.FlipTour.start(cfg); } });
  window.FlipTour.auto(cfg, 2500);
})();
