# CLAUDE.md — Cozumel Island Transfers (CIT)

## Project
Marketing site for Cozumel Island Transfers. Static HTML deployed to Netlify (`cozu.netlify.app`), auto-deploy from `main` on GitHub (`VisitCoz/cozumel-island-transfers`).

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
