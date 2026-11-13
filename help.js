/* Help topics: searchable from Settings → Help. Plain words, short steps.
   Keep each topic self-contained; the search matches title, keywords and body. */
const HELP = [
  { id: 'fwd-gmail', title: 'My orders come to this Gmail: nothing to forward', keys: 'gmail forward automatic same account',
    body: `<p>If your eBay, Vinted or Amazon emails already land in the Gmail account the app runs in, you don't need to forward anything.</p>
    <div class="step"><span class="k">1</span><span>Open <span class="ui">Settings</span> → <span class="ui">Your emails</span>.</span></div>
    <div class="step"><span class="k">2</span><span>Choose <span class="ui">This Gmail account</span>.</span></div>
    <div class="step"><span class="k">3</span><span>Turn on the shops and sites you want picked up (coming soon). Until then, forward them: it takes two taps.</span></div>` },
  { id: 'fwd-manual', title: 'Forward an email by hand (any email app)', keys: 'forward manual address receipts contact',
    body: `<div class="step"><span class="k">1</span><span>Open the order or sale email.</span></div>
    <div class="step"><span class="k">2</span><span>Tap <span class="ui">Forward</span> (often under the ⋯ or ↩ menu).</span></div>
    <div class="step"><span class="k">3</span><span>Send it to your forwarding address. Find it in <span class="ui">Settings</span> → <span class="ui">Your emails</span> → <span class="ui">Copy the forwarding address</span>.</span></div>
    <p>Tip: save that address as a contact called <b>Receipts</b>. Then you just type "Rec…".</p>
    <p>It shows in <span class="ui">Emailed receipts</span> within a few minutes. In a hurry? Tap <span class="ui">Check inbox now</span>.</p>` },
  { id: 'fwd-outlook', title: 'Auto-forward from Outlook or Hotmail', keys: 'outlook hotmail microsoft live rule automatic forwarding verify not working loop security info authenticator',
    body: `<p><b>Do this once, on a computer</b> (outlook.com). The phone app can't make rules.</p>
    <div class="step"><span class="k">1</span><span><b>Verify your account first.</b> Outlook won't forward until you do. Go to ⚙️ <span class="ui">Settings</span> → <span class="ui">Mail</span> → <span class="ui">Forwarding</span>. If you see <i>"Sign in and verify your account"</i>, click <span class="ui">Sign in</span> and enter the code Microsoft sends you. Keeps asking again? Add the Microsoft Authenticator app or a second email at <b>account.microsoft.com</b> → <span class="ui">Security</span>, then try once more.</span></div>
    <p><b>Leave "Enable forwarding" off.</b> That switch (Settings → Mail → Forwarding) sends <i>every</i> email, personal ones too. A rule sends only the ones you choose.</p>
    <div class="step"><span class="k">2</span><span>⚙️ <span class="ui">Settings</span> → <span class="ui">Mail</span> → <span class="ui">Rules</span> → <span class="ui">Add new rule</span>. Name it <b>Receipts</b>.</span></div>
    <div class="step"><span class="k">3</span><span>Add <b>one</b> condition: <span class="ui">From</span> → <i>ebay@ebay.co.uk</i>, <i>ebay@ebay.com</i>, <i>no-reply@vinted.co.uk</i>, and any shops you buy from. One rule can hold all of them: it forwards an email from <i>any</i> address in the list. <b>Don't add a "Message body" condition</b>: Outlook only forwards emails that match <i>every</i> condition, and order emails rarely share the same body words. Shops' ads will come through too; the app spots those and skips them for free (see <span class="ui">Skipped as ads</span>)</span></div>
    <div class="step"><span class="k">4</span><span>Action: <span class="ui">Forward to</span> → paste your forwarding address from the app. <span class="ui">Save</span>.</span></div>
    <div class="step"><span class="k">5</span><span>Rules only work on <b>new</b> emails. Old ones won't be forwarded: forward those by hand.</span></div>
    <p>Want fewer ads forwarded at all? Add a <span class="ui">Subject includes</span> condition with words like <i>order</i>, <i>sold</i>, <i>sale</i>, <i>label</i>, <i>refund</i>, <i>return</i>, <i>delivered</i>. It's optional, and any order email without one of those words would then be missed.</p>
    <p><b>Work or school Microsoft 365 account?</b> Your admin may block forwarding outside the company. Forward by hand instead.</p>` },
  { id: 'fwd-icloud', title: 'Auto-forward from iCloud Mail (Apple)', keys: 'icloud apple mail me.com rule forwarding',
    body: `<div class="step"><span class="k">1</span><span>On a computer go to <b>icloud.com/mail</b> and sign in.</span></div>
    <div class="step"><span class="k">2</span><span>Click ⚙️ (top) → <span class="ui">Settings</span> → <span class="ui">Rules</span> → <span class="ui">Add a Rule</span>.</span></div>
    <div class="step"><span class="k">3</span><span>"If a message is from" → the shop's address (e.g. <i>ebay@ebay.co.uk</i>). One rule per shop.</span></div>
    <div class="step"><span class="k">4</span><span>"Then" → <span class="ui">Forward to</span> → your forwarding address. <span class="ui">Done</span>.</span></div>
    <p>Hide My Email addresses forward to your real inbox first, then this rule picks them up, so they work too.</p>` },
  { id: 'fwd-yahoo', title: 'Auto-forward from Yahoo Mail', keys: 'yahoo filter forwarding',
    body: `<p>Yahoo can forward your <b>whole</b> inbox (Settings → More settings → Mailboxes → Forwarding) but not just some emails on free accounts. Forwarding everything would send personal mail to the app, so we don't recommend it.</p>
    <p>Instead: forward by hand (two taps), or move your shop accounts to a Gmail address.</p>` },
  { id: 'fwd-gmail-other', title: 'Auto-forward from a different Gmail', keys: 'gmail filter forward another account confirmation code',
    body: `<div class="step"><span class="k">1</span><span>On a computer, open that Gmail → ⚙️ → <span class="ui">See all settings</span> → <span class="ui">Forwarding and POP/IMAP</span> → <span class="ui">Add a forwarding address</span> → paste your forwarding address.</span></div>
    <div class="step"><span class="k">2</span><span>Google sends a confirmation code to the app's Gmail. Open <span class="ui">Emailed receipts</span> → <span class="ui">Check inbox now</span>; the code shows at the top. Enter it in the other Gmail.</span></div>
    <div class="step"><span class="k">3</span><span>Still in that Gmail: search <i>from:ebay.co.uk OR from:vinted.co.uk OR from:amazon.co.uk</i> → click the search options ▾ → <span class="ui">Create filter</span> → tick <span class="ui">Forward it to</span> → choose the address → <span class="ui">Create filter</span>.</span></div>
    <p>Only emails matching the filter are forwarded. Add more shops to the search any time.</p>` },
  { id: 'check-now', title: 'My forwarded email hasn\'t appeared', keys: 'email missing not showing slow check inbox now 15 minutes',
    body: `<p>Gmail can take 1–2 minutes to pass a forwarded email on, and the app looks every 5 minutes.</p>
    <p>Open <span class="ui">Emailed receipts</span> and tap <span class="ui">Check inbox now</span>. If nothing's there yet it looks again by itself for 2 minutes.</p>
    <p>Still missing after 10 minutes? Check the email went to the exact forwarding address in Settings, and that it isn't in the Gmail spam folder.</p>` },
  { id: 'scan', title: 'Scanning a receipt', keys: 'scan photo receipt blurry long add photo',
    body: `<p>Tap <span class="ui">Add receipt</span> → <span class="ui">Take a photo</span>. Lay the receipt flat with good light. Long receipt? Add a photo for each part; they're read together.</p>
    <p>Tap a photo to check it's sharp. If the app says it looks blurry, retake it: each read costs a little, so a clear photo saves money.</p>` },
  { id: 'review', title: 'Checking a receipt before saving', keys: 'review purpose set purpose select all share ticked save',
    body: `<p>Check each line, then pick what it's for (<b>purpose</b>). <span class="ui">Select all</span> then <span class="ui">Set purpose</span> does the lot in one go. <span class="ui">Share ticked</span> is for things split with someone else: only your share is saved.</p>
    <p>Bought something to resell with a longer returns date (e.g. at Christmas)? Tick <span class="ui">Longer returns</span> and put in the shop's date.</p>` },
  { id: 'labels', title: 'Postage labels and QR codes', keys: 'qr code label post evri inpost vinted ebay posted',
    body: `<p>Forward the label email. It appears under <span class="ui">Sales &amp; postage</span> → <span class="ui">To post</span> with its deadline. Tap it to show the code at the shop (turn brightness up), then tap <span class="ui">Posted</span>. The label is kept on your phone, so it works with no signal.</p>` },
  { id: 'returns', title: 'Return reminders', keys: 'return keep refund 14 days 28 days window',
    body: `<p>Things you bought to resell and haven't sold get a reminder before the shop's return window ends: 14 days for online orders, often 28–30 days for shop receipts (check the shop's own rules). Tap <span class="ui">Keep it</span> or tick what you'll return. When the refund comes, scan the refund receipt or forward the email and it's ticked off.</p>` },
  { id: 'buyers', title: 'Buyers: notes, contacts and who might want it', keys: 'crm buyer customer notes contact interested haggle no-show whatsapp repeat',
    body: `<p>Turn on in <span class="ui">Settings</span> → <span class="ui">Selling</span> → <span class="ui">Buyers</span>. Then every sale has an <span class="ui">About the buyer</span> section: how it went, sell to them again, how they buy, did they turn up, what they're after, and contact details if they gave them. It all goes on a <b>Buyers</b> tab in your Sheet.</p>
    <p>Put in your <b>listed at</b> price and the app works out how much they haggle. When you save a purchase that matches what someone's after, the home screen shows who might want it. Stock items show <b>👥 interested</b> too.</p>
    <p><b>The rules:</b> only message people about new items if they said they're happy to hear from you. eBay and Amazon don't allow messaging their buyers about other items or offering to sell outside the site; you can, at your own risk. Only write notes you'd be happy for the buyer to read.</p>` },
  { id: 'message-buyers', title: 'Messaging buyers (WhatsApp, text, email)', keys: 'whatsapp message contact buyers bulk outreach email cash collect drop-off distance',
    body: `<p>From <span class="ui">Sales</span> → <span class="ui">Buyers</span> tap <span class="ui">Select</span>, or from "who might want it" after a purchase, tick people and tap <span class="ui">Message</span>. Fill in the item, price and key features: each person gets their own message with their name.</p>
    <p><b>WhatsApp and texts</b> open one at a time with the message ready: tap send, come back, tap the next. That's free and nobody is put in a group. <b>Emails</b> go one each from your Gmail (free, about 100 a day).</p>
    <p>Filter by how people usually buy: <b>Collects</b> (often cash, the quickest flip), <b>Drop-off</b> (add their postcode to see how far) or <b>Online</b>. Pick people who said they're happy to hear about similar items. eBay and Amazon buyers can be ticked too, but their policies forbid contacting buyers about sales outside the site: that's at your own risk (they can restrict or suspend accounts). Gmail sends about 100 emails a day.</p>` },
  { id: 'ebay-postage', title: 'eBay postage cost on a sale', keys: 'ebay postage label cost free postage order find',
    body: `<p>eBay's emails never show what the label cost. On an eBay sale where you paid postage, tap <span class="ui">Open order on eBay</span>: the price is under "What you earned" → <b>Postage label</b>. No order number yet? The button searches your eBay orders by the item's name. The app also offers your last eBay label price as a one-tap fill.</p>` },
  { id: 'card-fees', title: 'Card reader fees on in-person sales', keys: 'card reader sumup zettle square fee percent',
    body: `<p>Put your reader's fees in <span class="ui">Settings</span> → <span class="ui">Selling</span> (e.g. 1.69%, or 20p + 1%). On each card sale the fee is worked out and recorded as a cost. HMRC still counts the full price as your sales; the fee is an expense.</p>` },
  { id: 'business-type', title: 'Sole trader, limited company and VAT', keys: 'sole trader limited company ltd vat registered change business type',
    body: `<p>Set this in <span class="ui">Settings</span> → <span class="ui">Business and tax</span>. It changes the tax quarters, what counts when (sole traders: the date you're paid; companies: the date sold) and what the summary shows.</p>
    <p>Changed from sole trader to a company? Switch it in Settings. Your old records stay as they are; a copy of the old summary is saved and a new one starts from that day.</p>` },
  { id: 'reporting', title: 'Why does the app track 30 sales / £1,700?', keys: 'hmrc report 30 sales 1700 platform reporting',
    body: `<p>Online marketplaces must tell HMRC about sellers who make 30 or more sales, or about £1,700, in a calendar year. That's normal and doesn't mean you owe tax; it just means your records should be tidy, which this app does for you.</p>` },
  { id: 'sheet', title: 'Where is my data? Can I change the Sheet?', keys: 'google sheet data drive change connection privacy',
    body: `<p>Everything lives in a Google Sheet and Drive folder in <b>your</b> Google account. We don't hold a copy. Open it from <span class="ui">Settings</span> → <span class="ui">Account</span>.</p>
    <p><span class="ui">Change sheet connection</span> points the app at a different Sheet's script. Nothing is deleted or moved: your old Sheet stays in your Drive, and the app starts reading the new one.</p>` },
  { id: 'cost', title: 'What does a scan cost?', keys: 'cost price gemini free tier billing reads',
    body: `<p>Reading a receipt or email uses Google's AI. It's about half a penny per receipt; around 200 receipts a month is roughly £1. Labels, matching, trips, manual sales and the monthly email cost nothing.</p>` },
  { id: 'bug', title: 'Something isn\'t working', keys: 'bug error broken report problem',
    body: `<p>First: close the app fully and open it again (it updates itself). Then <span class="ui">Settings</span> → <span class="ui">Report a bug</span>. Say what you tapped and what you expected; we read every report.</p>` }
];
