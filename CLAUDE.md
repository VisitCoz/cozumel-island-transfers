# CLAUDE.md — Cozumel Island Transfers (CIT)

This folder is a Warp tab. The global rules from `../../CLAUDE.md` still apply — this file only adds scope.

## Project
Marketing site for Cozumel Island Transfers. Static HTML deployed to Netlify (`cozu.netlify.app`), auto-deploy from `main` on GitHub (`VisitCoz/cozumel-island-transfers`).

## Where the code actually lives

**This folder IS the repo** — unlike the Tierra Maya and Visit Cozumel sites, whose code sits in an
external iCloud repo. CIT is the only website whose code lives inside the vault, and the only one with
**push-to-deploy**.

- Repo root: this folder · remote `VisitCoz/cozumel-island-transfers` · last commit 2026-06-09
- `netlify.toml` — `publish = "."`, `functions = "netlify/functions"`
- `netlify/functions/ships-today.js` — scrapes APIQROO for ships in port
- 13 static pages, `assets/`, `data/beach-clubs.json`, `scripts/build.js`, `llms.txt`, `sitemap.xml`

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

- **🔴 DNS cutover to `cozumelislandtransfers.com` is NOT done.** The real domain still points at the
  old Squarespace + FareHarbor setup. The Netlify build at `cozu.netlify.app` is finished and parked —
  customers are not seeing it. This is the single blocker between built and launched.
- Site has been idle ~7 weeks (HTML last touched 2026-05-26, last commit 2026-06-09). Working tree is
  clean and in sync with origin.
- The stack is **Apps Script + AI + Stripe**. FareHarbor is being replaced, not integrated.

## Doctrine refs

- **§2.2 SINGLE_CUSTOMER_RISK** — transfers are a revenue line independent of the cruise-line accounts.
