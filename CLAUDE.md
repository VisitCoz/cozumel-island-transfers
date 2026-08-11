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
- **One page.** `index.html` (the booking flow) + `terms.html`, `privacy.html`, `404.html`, `meet/`.
  `assets/`, `llms.txt`, `sitemap.xml`. `proto/` is design scratch, disallowed in robots.txt.
- The eight destination pages, `cruise-transfers.html` and `airport-transfers.html` were retired
  2026-08-06; `netlify.toml` 301s their paths to `/`. They are in git history if ever wanted back.
- `data/beach-clubs.json` and `scripts/build.js` went with them. The JSON held the old four-tier
  $269–$518 list and the build wrote it into the visible prices — a rebuild would have cut every
  advertised price ~27% silently. That gun is now unloaded; don't reintroduce it.

**The booking system (built 2026-08-01/02 — this takes real money):**

- `index.html` — the product and the whole site. Hero → poster grid → 5-step wizard → Stripe.
  It was `proto/flow-prototype.html` until 2026-08-06.
- `netlify/functions/_cit.js` — catalogue, **`ADMISSION` gate prices**, Stripe over `fetch`,
  webhook signature check, Resend email
- 🔒 **Prices and the return URL are server-side, and must stay there.** The admission amount and
  `returnUrl` both used to come from the request body: anyone could prepay a $65 day pass for $1,
  or mint a real Checkout session on this account that redirected the buyer to their own site.
  Prepay is refused wherever `ADMISSION[dest].verified` is false — and `index.html` hides the
  option in exactly those cases, so the two sides must be changed together or a guest ticks a box
  she is never charged for.
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

✅ **`TEST_PRICE_USD` and `TEST_CURRENCY` were DELETED 2026-08-06** (`486617f`) and verified absent
from the Netlify environment again on 2026-08-11. The override code still exists in
`create-checkout.js`, so setting either variable re-arms the same footgun — don't. Cheap live
testing is the `CITFLOW90R4K` promotion code.
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

- ✅ **Netlify environment is COMPLETE as of 2026-08-11** — verified with `netlify env:list`, not
  assumed: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `TEAM_EMAILS`,
  `MAIL_FROM`, `SITE_URL`, `PREVIEW_TOKEN`, `FLEET_RUNS_PER_DAY`, `REFUSALS_URL`/`REFUSALS_TOKEN`,
  `CALENDAR_URL`/`CALENDAR_TOKEN`. A real booking on 2026-08-11 charged the $369 list price and
  delivered both emails and the calendar events.
  ⚠️ Two of them are marked "Contains secret values" (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`)
  so `netlify env:get` returns nothing for them — that is correct, not a missing variable.
- **⚠️ Two identity mismatches on a page that charges cards.** These pages say
  *Cozumel Island Transfers, S. de R.L. de C.V.* and `+52 987 114 6853`; **Stripe's registered legal
  name is Visit Cozumel Mexico** and its receipts carry `+52 987 113 6492`. Ask Mike/Iris before
  changing either — it's a fiscal question, not a copy question.
- ✅ **DNS cutover DONE 2026-08-06.** Live at `https://cozumelislandtransfers.com` via **Cloudflare
  in front of Netlify** — that proxy is load-bearing, do not set those records to "DNS only".
  The Squarespace path redirects are in `netlify.toml` and verified working (`/czm`,
  `/onewayservice`, `/privatecar`, `/about`, `/contact-us` → apex; `/ssa`, `/maya`, `/langosta` →
  the meet pages).
  ⚠️ **Google has not fully reprocessed them.** A brand search still returns the old Squarespace
  title — "Airport & Cruise Port Transportation", advertising airport transfers and
  "English-speaking drivers", both of which are prohibited. This is reindex lag, not a broken
  redirect. Request indexing in Search Console; don't go hunting for a redirect bug.
- `booking-script-CIT.js` is a dead Tierra Maya fork, wired to nothing and superseded. Safe to delete.
- The stack is **Apps Script + AI + Stripe**. FareHarbor is being replaced, not integrated.

## Doctrine refs

- **§2.2 SINGLE_CUSTOMER_RISK** — transfers are a revenue line independent of the cruise-line accounts.
