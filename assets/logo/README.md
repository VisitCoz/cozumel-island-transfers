# Cozumel Island Transfers — brand mark

Chosen 19 Aug 2026 ("CIT Monogram"): the C drawn as a road, opening east toward the
beaches, with the pickup dot at its centre.

## Colours — do not substitute
| Role | Hex | Where |
|---|---|---|
| Navy | `#0F2C44` | the arc, on light backgrounds |
| Accent | `#1D7AFC` | the dot, on light backgrounds |
| Reverse arc | `#FFFFFF` | on navy / photos |
| Reverse dot | `#6BA8FF` | on navy / photos |

`#1D7AFC` is 3.75:1 on the site's `#F4F8FA` surface and **fails WCAG AA for body text** —
it is fine for the dot (a graphic, not text). If the mark ever needs a coloured *word*
beside it on a light surface, that word uses `#0F62D6`.

## Files
| File | Use |
|---|---|
| `cit-mark.svg` | master mark, light backgrounds |
| `cit-mark-reverse.svg` | navy / photo backgrounds |
| `cit-mark-mono.svg` | one colour, inherits `currentColor` — stamps, embroidery, CSS masks |
| `cit-logo-horizontal.svg` · `-reverse.svg` | mark + wordmark, one line |
| `cit-logo-stacked.svg` | mark over wordmark, centred |
| `*@2x.png`, `cit-mark-512.png` | rasters for partners who cannot take SVG |
| `/favicon.svg`, `/favicon.ico`, `/apple-touch-icon.png` | repo root, not here |

## Rules
- **Clear space** = the diameter of the centre dot on every side.
- **Minimum size** 16px. Below 24px use the favicon build (heavier stroke), not the master.
- The favicon and apple-touch icon sit on a **navy plate** on purpose: a transparent mark
  disappears in dark browser chrome, and iOS composites the home-screen icon over whatever
  wallpaper the guest has.
- Never recolour the dot to anything but the two accents above, never outline the mark,
  never set the wordmark in anything but **Inter 800, letter-spacing −0.025em**.

## Known limitation
The lockup SVGs use live `<text>`, not outlined paths — there is no font tool on this
machine. They render correctly anywhere Inter is available (the site, any Mac with Inter
installed). **Send a printer the `@2x.png` files, not the lockup SVGs**, unless you first
outline the text in a vector editor.
