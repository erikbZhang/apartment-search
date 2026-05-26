#!/usr/bin/env node
// Pull SF apartments from Craigslist's public JSON API and merge into data/apartments.json.
// Usage:
//   node scripts/import-craigslist.mjs                              # default: SF, sorted by newest
//   node scripts/import-craigslist.mjs --max-price=4000 --min-beds=1 --max-beds=2
//   node scripts/import-craigslist.mjs --query="hardwood"
//   node scripts/import-craigslist.mjs --limit=25 --dry-run
//
// After running: git add data/apartments.json && git commit && git push
// Then hit Refresh in the web app.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, '..', 'data', 'apartments.json');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const maxPrice = args['max-price'] ? Number(args['max-price']) : null;
const minPrice = args['min-price'] ? Number(args['min-price']) : null;
const minBeds = args['min-beds'] ? Number(args['min-beds']) : null;
const maxBeds = args['max-beds'] ? Number(args['max-beds']) : null;
const query = args['query'] || null;
const limit = args['limit'] ? Number(args['limit']) : 50;
const dryRun = !!args['dry-run'];
const neighborhoods = args['neighborhoods']
  ? String(args['neighborhoods']).toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
  : null;

const params = new URLSearchParams({
  searchPath: 'sfc/apa',
  sort: 'date',
  batch: '1-0-360-1-0',
  lang: 'en',
  cc: 'us',
});
if (maxPrice) params.set('max_price', String(maxPrice));
if (minPrice) params.set('min_price', String(minPrice));
if (minBeds) params.set('min_bedrooms', String(minBeds));
if (maxBeds) params.set('max_bedrooms', String(maxBeds));
if (query) params.set('query', query);

console.log(`Fetching Craigslist sfc/apa with: ${params.toString()}`);

const res = await fetch(`https://sapi.craigslist.org/web/v8/postings/search/full?${params}`, {
  headers: { 'Referer': 'https://sfbay.craigslist.org/' },
});
if (!res.ok) {
  console.error(`API failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const json = await res.json();
const data = json.data;
console.log(`Total available: ${data.totalResultCount}, returned this batch: ${data.items.length}`);

const decode = data.decode;

function parseItem(item) {
  const postingIdOffset = item[0];
  const postedDateOffset = item[1];
  const price = typeof item[3] === 'number' && item[3] > 0 ? item[3] : null;
  const locField = item[4];

  let slug = null, beds = null, sqft = null;
  for (const el of item) {
    if (Array.isArray(el)) {
      const code = el[0];
      if (code === 6) slug = el[1];
      else if (code === 5) { beds = el[1]; sqft = el[2]; }
    }
  }

  // Title = last plain string that isn't the loc field (contains ~) or a short id-like token.
  let title = null;
  for (let i = item.length - 1; i >= 0; i--) {
    const el = item[i];
    if (typeof el !== 'string') continue;
    if (el.includes('~')) continue;
    if (el.length < 12 && /^[a-z0-9]+$/i.test(el)) continue;
    title = el;
    break;
  }

  // Location: "locIdx:hoodDescIdx:hoodIdx~lat~lon"
  const parts = locField.split('~');
  const [locIdx, hoodDescIdx] = parts[0].split(':').map(Number);
  const lat = Number(parts[1]);
  const lon = Number(parts[2]);

  const locEntry = decode.locations?.[locIdx] || [];
  const subareaAbbr = locEntry[2] || 'sfc';
  const cityName = locEntry[1] || '';
  const neighborhood = decode.locationDescriptions?.[hoodDescIdx] || cityName || '';

  const postingId = decode.minPostingId + postingIdOffset;
  const postedEpoch = decode.minPostedDate + postedDateOffset;
  const url = `https://sfbay.craigslist.org/${subareaAbbr}/apa/d/${slug}/${postingId}.html`;

  return {
    posting_id: postingId,
    title,
    price,
    beds,
    sqft,
    neighborhood: typeof neighborhood === 'string' ? neighborhood : '',
    subareaAbbr,
    lat,
    lon,
    posted_at: new Date(postedEpoch * 1000).toISOString(),
    url,
  };
}

let listings = data.items
  .map(parseItem)
  .filter(l => l.title && l.subareaAbbr === 'sfc');

if (maxPrice) listings = listings.filter(l => l.price != null && l.price <= maxPrice);
if (minPrice) listings = listings.filter(l => l.price != null && l.price >= minPrice);
if (minBeds) listings = listings.filter(l => l.beds == null || l.beds >= minBeds);
if (maxBeds) listings = listings.filter(l => l.beds == null || l.beds <= maxBeds);

if (neighborhoods) {
  listings = listings.filter(l => {
    const blob = `${l.neighborhood || ''} ${l.title || ''}`.toLowerCase();
    const match = neighborhoods.find(needle => blob.includes(needle));
    if (match) l.matchedNeighborhood = match;
    return Boolean(match);
  });
}

// Rank: prefer 1-2 bedrooms (good for couples), then bigger sqft, then newer postings, then lower price
listings.sort((a, b) => score(b) - score(a));

function score(l) {
  let s = 0;
  if (l.beds === 1 || l.beds === 2) s += 5;
  else if (l.beds === 0) s -= 2;
  else if (l.beds == null) s -= 1;
  if (l.sqft) s += Math.min(l.sqft / 200, 5);
  if (l.price) s += Math.max(0, (4500 - l.price) / 1000);
  const ageDays = (Date.now() - new Date(l.posted_at).getTime()) / 86400000;
  if (ageDays < 1) s += 2;
  else if (ageDays < 3) s += 1;
  return s;
}

listings = listings.slice(0, limit);
console.log(`Matched ${listings.length} SF listings after filters.`);

const existing = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const existingByUrl = new Map(existing.apartments.map(a => [a.url, a]));

const now = new Date().toISOString();
const newOnes = [];
for (const l of listings) {
  if (existingByUrl.has(l.url)) continue;
  newOnes.push({
    id: 'cl_' + l.posting_id,
    url: l.url,
    address: l.title,
    neighborhood: titleCase(l.matchedNeighborhood || l.neighborhood),
    price: l.price,
    bedrooms: l.beds,
    bathrooms: null,
    sqft: l.sqft,
    available: null,
    status: 'to_see',
    laundry: detectLaundry(l.title),
    notes: `From Craigslist · posted ${formatPosted(l.posted_at)}${l.lat ? ` · ${l.lat},${l.lon}` : ''}`,
    seen_by: [],
    added_by: 'craigslist',
    added_at: now,
  });
}

console.log(`New (not already in file): ${newOnes.length}`);
if (newOnes.length) {
  console.log('Sample:');
  newOnes.slice(0, 5).forEach(a => {
    console.log(`  · ${a.address}`);
    console.log(`    ${a.price ? '$' + a.price : 'no price'} · ${a.bedrooms ?? '?'}bd${a.sqft ? ` · ${a.sqft} sqft` : ''} · ${a.neighborhood || '—'}`);
    console.log(`    ${a.url}`);
  });
}

if (dryRun) {
  console.log('\n--- DRY RUN, not writing ---');
} else if (newOnes.length) {
  existing.apartments.push(...newOnes);
  fs.writeFileSync(DATA_PATH, JSON.stringify(existing, null, 2) + '\n');
  console.log(`\nWrote ${newOnes.length} apartments to ${DATA_PATH}`);
  console.log('Next: git add data/apartments.json && git commit && git push');
} else {
  console.log('\nNothing new to write.');
}

function titleCase(s) {
  if (!s) return '';
  return s.replace(/\b([a-z])/g, c => c.toUpperCase());
}

function detectLaundry(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(in[- ]?unit|w\/?d in[- ]?unit|in[- ]?unit w\/?d|laundry in unit|in apartment)\b/.test(t)) return 'in_unit';
  if (/\b(no laundry|no on[- ]?site laundry)\b/.test(t)) return 'none';
  if (/\b(on[- ]?site laundry|laundry on[- ]?site|shared laundry|building laundry|laundry room|coin[- ]?op|on site|laundry)\b/.test(t)) return 'shared';
  return null;
}

function formatPosted(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
