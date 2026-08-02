# CLAUDE.md — Cozumel Island Transfers (CIT)

The global rules from the Command_Center `CLAUDE.md` still apply — this file only adds scope.

## 🛑 Work in `~/code/cozumel-island-transfers` — NOT in Google Drive

**Canonical working copy: `~/code/cozumel-island-transfers` (local disk).**

A copy of this repo also exists at `Command_Center/Projects/Cozumel_Island_Transfers/` inside the
Google Drive vault. **Do not edit or commit there.** Drive's CloudStorage sync rewrites files while
git is using them and can corrupt the object store — it has already destroyed a memory file and
killed five LaunchAgents in this vault. Moved out 2026-07-29 per Mike's directive that GitHub is
canonical for all code.

If you find yourself in the Drive path, stop and `cd ~/code/cozumel-island-transfers`.

## Project
Marketing site for Cozumel Island Transfers. Static HTML deployed to Netlify (`cozu.netlify.app`),
auto-deploy from `main` on GitHub (`VisitCoz/cozumel-island-transfers`).

## Where the code actually lives

- Repo root: `~/code/cozumel-island-transfers` · remote `VisitCoz/cozumel-island-transfers`
- `netlify.toml` — `publish = "."`, `functions = "netlify/functions"`
- 13 static pages, `assets/`, `data/beach-clubs.json`, `scripts/build.js`, `llms.txt`, `sitemap.xml`

**The booking system (built 2026-08-01/02 — this takes real money):**

- `proto/flow-prototype.html` — the actual product. Hero → poster grid → 5-step wizard → Stripe.
  Despite the folder name it is no longer a throwaway; `index.html` is the OLD site.
- `netlify/functions/_cit.js` — catalogue, Stripe over `fetch`, webhook signature check, Resend email
- `netlify/functions/create-checkout.js` — server-side validation, then a Stripe Checkout Session
- `netlify/functions/stripe-webhook.js` — **this is where a booking becomes real**; emails the team
- `netlify/functions/daily-manifest.js` — scheduled 23:00 UTC (6 PM Cozumel) in `netlify.toml`
- `netlify/functions/ships-today.js` — scrapes APIQROO for ships in port (pre-existing)
- `data/cozumel-ships.json` — 144 ships, built by `scripts/build_ship_list.py`

**Three things about this that are easy to get wrong:**

1. **There is no database.** Every booking carries its date in Stripe **metadata**, so Stripe's own
   search is the query layer (`bookingsOn(date)` in `_cit.js`). Mike rejected the Google Sheet.
   `apps_script/cit_bookings/Code.gs` exists but is dormant and only wakes if `BOOKINGS_URL` +
   `BOOKINGS_TOKEN` are set. Don't reintroduce a spreadsheet.
2. **Stripe cannot live in Apps Script.** Apps Script can't read request headers, so it can never
   verify a webhook signature. That is the entire reason for Netlify functions.
3. **Guests are charged USD.** Never a hard-coded peso rate — the dead `booking-script-CIT.js` used
   18.5 when the real rate was 17.37, a ~$24 surprise overcharge. The statement must match the page.

⚠️ **`TEST_PRICE_USD` and `TEST_CURRENCY` are still set in Netlify**, which makes every destination
charge MX$100. They were for the first live-key run. Delete both and redeploy before real traffic.
Zero npm dependencies anywhere — Node 18+ built-ins only.

## Deploy target

**Netlify, auto-deploy on push to `main`.** Pushing IS deploying — that is the intended workflow and
it's why the pre-authorized list below is unusually permissive.

## Pre-authorized actions (do NOT ask)

Mike has explicitly authorized the following for this repo. Do not pause for confirmation on these — just execute:

- `git add`, `git commit`, `git push origin main` (and any branch)
- Editing any HTML/CSS/JS file in the project root, `assets/`, `data/`, `scripts/`, `template/`
- Editing `netlify.toml`, `.gitignore`, `README.md`
- Running local servers (`python3 -m http.server`, `npx serve`) for preview

The Netlify deploy is wired to GitHub. Pushing to main = deploying. That is the intended workflow.

## What still needs confirmation
- Renaming/deleting destination pages (chankanaab.html, mr-sanchos.html, etc.) — irreversible URL changes
- Touching `booking-script-CIT.js` if it's deployed live (check before)
- Changing Stripe keys, domain config, or anything in the Netlify dashboard
- Force-pushes, history rewrites, branch deletions

## Open items

- **🔴 Delete `TEST_PRICE_USD` and `TEST_CURRENCY`** in Netlify, then redeploy. Until then every
  booking on the site charges MX$100.
- **Still to add in Netlify:** `STRIPE_WEBHOOK_SECRET` (the `whsec_…` from the event destination),
  `TEAM_EMAILS`, `RESEND_API_KEY`. Until all three exist the team is not notified of bookings and
  no manifest goes out — the webhook returns 200 with `verified:false` by design, so the Stripe
  dashboard stays green and nothing looks broken. Check the env vars, not the dashboard.
- **⚠️ Two identity mismatches on a page that charges cards.** These pages say
  *Cozumel Island Transfers, S. de R.L. de C.V.* and `+52 987 114 6853`; **Stripe's registered legal
  name is Visit Cozumel Mexico** and its receipts carry `+52 987 113 6492`. Ask Mike/Iris before
  changing either — it's a fiscal question, not a copy question.
- **🔴 DNS cutover to `cozumelislandtransfers.com` is NOT done.** The real domain still points at the
  old Squarespace + FareHarbor setup. Customers are not seeing this site.
- `booking-script-CIT.js` is a dead Tierra Maya fork, wired to nothing and superseded. Safe to delete.
- `data/beach-clubs.json` still holds the stale 4-tier $269–$518 pricing, and `scripts/build.js`
  regenerates the destination pages from it — **a rebuild would silently cut prices ~27%.**
- The stack is **Apps Script + AI + Stripe**. FareHarbor is being replaced, not integrated.

## Doctrine refs

- **§2.2 SINGLE_CUSTOMER_RISK** — transfers are a revenue line independent of the cruise-line accounts.
