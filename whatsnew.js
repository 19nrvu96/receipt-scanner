/* "What's new": a short walkthrough of the day's changes, shown once the next time the app opens,
   with Back / Next. Reopen it any time from Settings → What's new. Seen slides are remembered on
   this phone, so slides added later still show. */
(function () {
  const KEY = 'rs_whatsnew';
  const WAIT = 'Starts working once your Sheet\'s script has today\'s update (the one Terminal command).';
  const SLIDES = [
    { id: 'rs-hello-1115', icon: '👋', title: 'What\'s new in Receipts', text: 'A quick tour of what changed on 15 November. Tap <b>Next</b> and <b>Back</b>, or swipe. It won\'t pop up again, but you can open it from <b>Settings → What\'s new</b>.' },
    { id: 'rs-sales-1115', icon: '💷', title: 'Sales: clearer and quicker', text: 'A sale that needs a check now says what\'s missing, with <b>Take me there ›</b>. The price you sold for and how far it was <b>% off asking</b> are saved. The fees part stays folded away unless there\'s a promoted fee or a refund. Buyers can be found by name, phone number or email, and the cost search can be filtered by shop.', where: 'Sales, and Log a sale' },
    { id: 'rs-parcels-1115', icon: '📦', title: 'How many go in the parcel', text: 'To post cards and the QR screen now show how many items go in one parcel, for example "Pack 2 items in this parcel".', where: 'Sales → To post' },
    { id: 'rs-reading-1115', icon: '🤖', title: 'Saver reading, accurate models only', text: 'Receipts reads with the cheaper Flash-Lite model first and keeps the result only if the totals add up. If they don\'t, it reads again with 3.6 Flash. The less accurate models have been dropped. Switch it in Settings with <b>Saver: cheaper model first</b>.', where: 'Settings' },
    { id: 'rs-credit-1115', icon: '💳', title: 'Your Google credit', text: 'The home screen shows your prepaid Google credit, about how many receipts it covers, and when the next automatic top-up comes (£5 when it drops under £1, up to £10 a month). You get a warning when it\'s getting low.', where: 'Home screen' },
    { id: 'rs-toreturn-1115', icon: '↩️', title: 'New: To return', text: 'Things you\'re taking back get their own cards: last day, shop, amount, and where you decided (here, ListMe or FlipCheck). Tap <b>✓ Returned it</b> once it\'s handed back or dropped off. Then tap <b>📷 Refund receipt</b> on that card, or forward the refund email, and the refund is attached to the return as proof. Finished ones are under <b>Returned recently</b>.', where: 'Sales → To return', wait: true, go: 'slToRetWrap' },
    { id: 'rs-qr-1115', icon: '🔳', title: 'Return QR codes', text: 'Forward the shop\'s return email (QR code or drop-off label) and it\'s filed on the right return, matched by order number or shop. <b>Show return QR code</b> works with no signal at the counter. A "we\'ve received your return" email marks it as returned for you.', where: 'Sales → To return', wait: true },
    { id: 'rs-extended-1115', icon: '🎄', title: 'Extended return dates', text: 'When a receipt has its own later "return by" date (Christmas and other seasonal returns), that\'s the only deadline. Reminders here, in ListMe and in FlipCheck start 7 days before it, not at day 10 or 21. Its cards say <b>🎄 Extended return date</b>.', where: 'Last days to return, To return', wait: true },
    { id: 'rs-apps-1115', icon: '🔍', title: 'Worth it? Ask FlipCheck', text: 'Stock rows have <b>🔍 Worth it?</b>, and last-days-to-return cards have <b>Worth keeping? FlipCheck ›</b>. Each opens FlipCheck at that purchase. After you save a resale receipt there\'s a link too, and FlipCheck and ListMe are at the top of the home screen.', where: 'Stock page, Sales, home', wait: true }
  ];

  const seen = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } };
  const remember = () => { try { localStorage.setItem(KEY, JSON.stringify(Array.from(new Set(seen().concat(SLIDES.map(s => s.id)))))); } catch (e) {} };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // The Sheet's script has today's update when its startup data includes the sister-app links
  const ready = () => { try { return !!(typeof CFG !== 'undefined' && CFG.newReturns); } catch (e) { return false; } };

  function open(all) {
    const list = SLIDES.filter(s => all || seen().indexOf(s.id) < 0);
    if (!list.length || document.querySelector('.wn-veil')) return;
    let i = 0;
    const veil = document.createElement('div');
    veil.className = 'veil wn-veil';
    veil.style.alignItems = 'center';
    veil.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="wnTitle" style="border-radius:18px;margin:12px;max-width:460px"></div>';
    const box = veil.firstElementChild;
    const close = () => { remember(); veil.remove(); };
    const draw = () => {
      const s = list[i], last = i === list.length - 1;
      box.innerHTML = '<button class="close" data-wn="close" aria-label="Close">✕</button>' +
        '<p class="sub" style="margin:0 0 6px">What\'s new · ' + (i + 1) + ' of ' + list.length + '</p>' +
        '<div style="font-size:40px;line-height:1.1" aria-hidden="true">' + s.icon + '</div>' +
        '<h3 id="wnTitle" style="font-size:20px;margin:8px 0">' + esc(s.title) + '</h3>' +
        '<p style="margin:0 0 8px;line-height:1.5">' + s.text + '</p>' +
        (s.where ? '<p class="sub" style="margin:0 0 8px">Where: ' + esc(s.where) + '</p>' : '') +
        (s.wait && !ready() ? '<p class="hint" style="background:#fff4d6;color:#7a5300;border-radius:8px;padding:6px 10px">' + WAIT + '</p>' : '') +
        (s.go ? '<button class="btn sec" data-wn="go" style="margin:4px 0 8px">Show me</button>' : '') +
        '<div class="duo" style="margin-top:6px;align-items:center"><button class="btn sec" data-wn="back"' + (i === 0 ? ' disabled' : '') + '>‹ Back</button>' +
        '<button class="btn" data-wn="' + (last ? 'close' : 'next') + '">' + (last ? 'Done' : 'Next ›') + '</button></div>' +
        '<div style="display:flex;gap:5px;justify-content:center;margin-top:10px" aria-hidden="true">' + list.map((_, k) => '<i style="width:7px;height:7px;border-radius:50%;background:' + (k === i ? '#0a84ff' : '#d6d6db') + '"></i>').join('') + '</div>';
    };
    veil.addEventListener('click', e => {
      const b = e.target.closest('[data-wn]');
      if (!b) { if (e.target === veil) close(); return; }
      const a = b.dataset.wn;
      if (a === 'next') { i++; draw(); }
      else if (a === 'back') { i--; draw(); }
      else if (a === 'close') close();
      else if (a === 'go') { const to = list[i].go; close(); if (typeof openSales === 'function') openSales(to); }
    });
    let x0 = null;
    veil.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
    veil.addEventListener('touchend', e => {
      if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (dx < -50 && i < list.length - 1) { i++; draw(); } else if (dx > 50 && i > 0) { i--; draw(); }
    });
    document.addEventListener('keydown', function key(e) {
      if (!document.body.contains(veil)) { document.removeEventListener('keydown', key); return; }
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight' && i < list.length - 1) { i++; draw(); }
      else if (e.key === 'ArrowLeft' && i > 0) { i--; draw(); }
    });
    document.body.appendChild(veil);
    draw();
  }

  window.whatsNew = open;
  document.addEventListener('click', e => { if (e.target.closest('[data-whatsnew]')) { e.preventDefault(); open(true); } });
  // Once on this phone, after the app has its web-app address (set up) and has loaded its settings
  setTimeout(() => { if (localStorage.getItem('rs_url')) open(false); }, 2500);
})();
