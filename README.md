# Cozumel Island Transfers — Netlify Site

Replacement for the current Squarespace + FareHarbor site at https://www.cozumelislandtransfers.com/

**Stack:** single-file HTML on Netlify · Stripe Checkout · Google Apps Script booking webhook (forked from Tierra Maya pattern)

---

## Files in this folder

| File | What it is |
|---|---|
| `index.html` | The entire site. Drag to Netlify, done. ~1,200 lines (HTML + inline CSS + inline JS). |
| `booking-script-CIT.js` | Source-of-truth copy of the Apps Script. Mirror of what's pasted into the "CIT Bookings" Sheet's Apps Script editor. **Update this file when you update the deployed script — git is the truth.** |
| `netlify.toml` | Netlify config: security headers, 404 redirect. |
| `assets/` | Static images (og-image.jpg for social previews, favicon.ico). |
| `README.md` | This file. |

---

## Deploy procedure

### First deploy (preview URL)
1. Open https://app.netlify.com/drop in a browser.
2. Drag this entire folder (`Cozumel_Island_Transfers/`) onto the drop zone.
3. Netlify gives you a URL like `cit-preview-abc123.netlify.app` in ~10 seconds.
4. Click **Claim site** → sign in with Google → site is yours.
5. Site Settings → Site details → Change site name → `cit-preview` (or whatever).

### Updates (after edits)
1. Make changes to `index.html` (or any file).
2. Open `app.netlify.com/sites/<your-site-name>/deploys`.
3. Drag the **whole folder** onto the deploy zone at the bottom.
4. New deploy goes live in ~10 seconds. Netlify keeps every prior deploy (rollback in one click).

### Production swap (DNS — do AFTER all verification passes)
1. Netlify → Domain settings → Add custom domain → `cozumelislandtransfers.com` + `www.cozumelislandtransfers.com`.
2. Netlify gives you DNS records (CNAME or A record).
3. Go to current registrar (Squarespace) → update DNS → wait 30 min – 24 hrs propagation.
4. Squarespace site stays paid 30 days as rollback.
5. Cancel FareHarbor only after 14 days of clean bookings through the new flow.

---

## Updating the Stripe key

The publishable key lives in `index.html` (search for `STRIPE_PK`). The secret key lives in the Apps Script **Script Properties** (never in any file).

To rotate the secret:
1. Stripe Dashboard → Developers → API Keys → Roll secret key.
2. Apps Script editor (CIT Bookings) → File → Project Properties → Script Properties → update `CIT_STRIPE_SK`.
3. No file changes needed. The script reads from Script Properties on every PaymentIntent.

To change the publishable key (e.g. test ↔ live):
1. Edit `index.html` line with `const STRIPE_PK = 'pk_...'`.
2. Redeploy (drag folder to Netlify).

---

## Updating the Apps Script Web App URL

When you redeploy the Apps Script (Deploy → Manage deployments → Edit → New version), the URL **stays the same** if you use "Edit" instead of "New deployment". Keep using Edit to avoid breaking the site.

If you ever need a new URL (full redeploy):
1. Copy the new `https://script.google.com/macros/s/.../exec` URL.
2. Edit `index.html` — search for `STRIPE_SCRIPT_URL` and `BOOKING_SCRIPT_URL`. Both should be the same URL.
3. Redeploy site.

---

## Adding new transfer routes

In `index.html`, find `const CIT_PRODUCTS = [` near the bottom. Each row is one route × vehicle combination:

```js
{ route: 'airport-hotel', vehicle: 'van_1_4', maxPax: 4, priceUSD: 45, label: 'Airport → Hotel (Van 1–4)' }
```

Copy a row, change route, vehicle, maxPax, priceUSD, label. Save. Redeploy. The form's dropdowns rebuild automatically from this array.

The Apps Script (`booking-script-CIT.js`) **does not need updating** when you add routes — it just logs whatever string the form sends in the `tier` field.

---

## Verification before going live

Run all 9 on the preview URL (Stripe TEST mode):

- [ ] **Smoke** — page loads <2s, no console errors, mobile renders without horizontal scroll.
- [ ] **Happy booking** — `4242 4242 4242 4242`, $1 amount, all 4 systems fire (Stripe charge, Sheet row, 5 staff emails, calendar event at correct time).
- [ ] **Decline** — `4000 0042 0000 0119` shows error, no Sheet row, no email.
- [ ] **Discount code** — apply `WELCOME10`, -10% reflects on Stripe + Sheet.
- [ ] **Amount tamper** — DevTools modify hidden price to $1, Apps Script rejects via `MIN_AMOUNT_CENTS`.
- [ ] **Guest confirmation** — book for tomorrow, manually run `sendGuestConfirmations` in Apps Script, verify operational-voice email.
- [ ] **WhatsApp link** — tap on iPhone Safari, opens WhatsApp with `+52 987 114 6853` prefilled.
- [ ] **404 handling** — visit `/nonexistent`, doesn't break.
- [ ] **Live key dry run** — flip `CIT_STRIPE_SK` Script Property to live, real $1 booking with your own card, refund immediately.

Only after all 9 pass → DNS swap.

---

## Reference

Plan: `/Users/mb/.claude/plans/first-i-want-functional-meadow.md`
Memory: `feedback_web_platform_netlify_claude.md`, `reference_codebase_structure.md`
Fork source: `cozumel-projects/tierra-maya/apps-script-TM-COMPLETE.js`
