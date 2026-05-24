#!/usr/bin/env node
// ============================================================
// Cozumel Island Transfers — landing page build script
// ============================================================
// Reads data/beach-clubs.json, fills template/beach-club.html for
// each destination, writes <slug>.html to the project root.
//
// Pricing is UNIVERSAL (data.pricing): same 4 capacity tiers apply
// to every destination. Edit data.pricing once and re-run to update
// all generated pages.
//
// Usage:  node scripts/build.js
// ============================================================

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data/beach-clubs.json');
const TEMPLATE_PATH = path.join(PROJECT_ROOT, 'template/beach-club.html');

const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

// HTML-escape for text content.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Plain global string replace (Node-version-agnostic).
function replaceAll(str, find, replace) {
  return str.split(find).join(replace);
}

// Build the 4 pricing cards per destination (matches homepage design).
// "Book Now" opens the in-page booking modal with the destination
// pre-selected via the 5th openBookingModal argument.
function buildPricingCards(dest) {
  // Escape values for safe use inside an HTML attribute's JS handler.
  // We're wrapping arguments in single quotes, so escape any single quotes
  // and backslashes in the dynamic strings.
  const jsArg = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  return data.pricing.map(p => {
    const isPopular = !!p.popular;
    const ribbon = isPopular
      ? `<div class="price-ribbon">★ MOST POPULAR</div>`
      : '';
    const onclick = `openBookingModal('${jsArg(p.vehicleSlug)}','${jsArg(p.vehicle)}','${jsArg(p.pax)}',${p.priceUSD},'${jsArg(dest.shortName)}')`;
    return `
      <div class="price-card${isPopular ? ' popular' : ''}">
        ${ribbon}
        <div class="price-pill">PRIVATE</div>
        <h3 class="price-name">${esc(p.vehicle)}</h3>
        <div class="price-pax-sub">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
          ${esc(p.pax)}
        </div>
        <div class="price-big">${p.priceUSD}<span class="currency">USD</span></div>
        <div class="price-allin">All-inclusive · final price</div>
        <div class="price-divider"></div>
        <div class="price-type">Round-trip private transfer</div>
        <div class="price-cancel">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          <span>Free cancellation up to 24h before</span>
        </div>
        <button type="button" class="price-cta" onclick="${onclick}">Book Now</button>
      </div>`;
  }).join('');
}

function buildBundleCard(dest) {
  if (!dest.bundleAvailable) return '';
  return `
    <div class="bundle-card">
      <div class="bundle-badge">Bundle option</div>
      <h3>Transfer + ${esc(dest.shortName)} entry</h3>
      <p>${esc(dest.bundleNote || '')}</p>
    </div>`;
}

function buildTransferOnlyBadge(dest) {
  return dest.transferOnly
    ? `<span class="chip-transfer-only">Round-trip transfer only</span>`
    : '';
}

function buildFaqs(dest) {
  return dest.faqs.map((f, i) => `
      <details class="faq-item"${i === 0 ? ' open' : ''}>
        <summary>${esc(f.q)}</summary>
        <p>${esc(f.a)}</p>
      </details>`).join('');
}

function buildSchemaJsonLd(dest) {
  const cleanDesc = String(dest.description || '').replace(/\[PLACEHOLDER[^\]]*\]/g, '').trim()
    || `Private round-trip transfer to ${dest.name} from the Cozumel cruise port.`;

  const service = {
    "@context": "https://schema.org",
    "@type": "Service",
    "serviceType": "Private ground transfer",
    "name": `Round-trip transfer to ${dest.name}`,
    "description": cleanDesc,
    "provider": {
      "@type": "LocalBusiness",
      "name": "Cozumel Island Transfers",
      "url": "https://www.cozumelislandtransfers.com/",
      "telephone": "+529871146853",
      "address": {
        "@type": "PostalAddress",
        "addressLocality": "Cozumel",
        "addressRegion": "Quintana Roo",
        "addressCountry": "MX"
      }
    },
    "areaServed": "Cozumel, Quintana Roo, Mexico",
    "offers": data.pricing.map(p => ({
      "@type": "Offer",
      "name": `${dest.name} transfer — ${p.vehicle}`,
      "price": String(p.priceUSD),
      "priceCurrency": "USD",
      "eligibleQuantity": { "@type": "QuantitativeValue", "description": p.pax }
    }))
  };

  const faqPage = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": dest.faqs.map(f => ({
      "@type": "Question",
      "name": f.q,
      "acceptedAnswer": { "@type": "Answer", "text": f.a }
    }))
  };

  return `<script type="application/ld+json">${JSON.stringify(service)}</script>
<script type="application/ld+json">${JSON.stringify(faqPage)}</script>`;
}

function generatePage(dest) {
  let html = template;

  // Complex fragments first
  const fragments = {
    schema_jsonld: buildSchemaJsonLd(dest),
    transferOnlyBadge: buildTransferOnlyBadge(dest),
    pricing_cards_html: buildPricingCards(dest),
    bundle_card_html: buildBundleCard(dest),
    faqs_html: buildFaqs(dest)
  };
  Object.entries(fragments).forEach(([key, val]) => {
    html = replaceAll(html, `{{${key}}}`, val);
  });

  // Simple text fields (heroImage URL is treated as text — esc() leaves
  // it unmodified since URLs only contain safe characters from our data file).
  const simple = ['slug', 'name', 'shortName', 'type', 'typeLabel',
                  'tagline', 'metaDescription', 'description',
                  'distanceFromPort', 'driveTime',
                  'heroImage', 'heroAlt'];
  simple.forEach(k => {
    html = replaceAll(html, `{{${k}}}`, esc(dest[k]));
  });

  // Special: URL-encoded shortName for WhatsApp deep links
  html = replaceAll(html, '{{shortNameEnc}}', encodeURIComponent(dest.shortName));

  return html;
}

// ============================================================
// Run
// ============================================================
console.log(`\nCIT landing page build — ${data.destinations.length} destinations · ${data.pricing.length} pricing tiers\n`);
let totalBytes = 0;
data.destinations.forEach(dest => {
  const html = generatePage(dest);
  const outPath = path.join(PROJECT_ROOT, `${dest.slug}.html`);
  fs.writeFileSync(outPath, html);
  totalBytes += html.length;
  console.log(`  ✓ ${dest.slug}.html  (${(html.length / 1024).toFixed(1)} KB)`);
});
console.log(`\nGenerated ${data.destinations.length} pages, ${(totalBytes / 1024).toFixed(1)} KB total.\n`);
