#!/usr/bin/env bash
# Re-stamp the meet.css cache-buster after ANY change to meet/meet.css.
#
# Netlify serves the stylesheet with `cache-control: max-age=14400` — four hours. Without a
# version in the URL, a returning visitor gets NEW html with OLD css for up to four hours, and
# the page renders unstyled. That is exactly what happened on 2026-08-20: the terminal signage
# shipped correctly and appeared as plain blue links on Mike's phone.
#
# The version is a hash of the file's own contents, so it changes when — and only when — the
# CSS changes. Run this, then commit.
set -euo pipefail
cd "$(dirname "$0")/.."
v=$(md5 -q meet/meet.css | cut -c1-8)
for f in meet/*.html; do
  perl -pi -e "s{(href=\"/?(?:meet/)?meet\.css)(\?v=[0-9a-f]+)?\"}{\$1?v=$v\"}g" "$f"
done
echo "meet.css stamped ?v=$v across $(ls meet/*.html | wc -l | tr -d ' ') pages"
