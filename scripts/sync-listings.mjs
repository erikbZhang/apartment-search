#!/usr/bin/env node
// Hourly sync (run by .github/workflows/sync-listings.yml):
//   1. Fetch Craigslist listings matching data/search-criteria.json and ADD any new ones.
//   2. Re-check every existing Craigslist listing's URL; if the posting has been
//      deleted/expired/removed, mark it status: "off_market" (preserving the
//      previous status in prev_status). Nothing is ever deleted from the file.
//
// Usage:
//   node scripts/sync-listings.mjs                 # add new + off-market sweep
//   node scripts/sync-listings.mjs --dry-run       # show what would change, write nothing
//   node scripts/sync-listings.mjs --no-offmarket  # only add new listings
//   node scripts/sync-listings.mjs --max-price=4000 --min-beds=1   # override criteria
//
// Criteria precedence: CLI args > data/search-criteria.json > built-in defaults.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchListings, toApartment, isCraigslist, isListingGone, sleep } from './craigslist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, '..', 'data', 'apartments.json');
const CRITERIA_PATH = path.resolve(__dirname, '..', 'data', 'search-criteria.json');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const dryRun = !!args['dry-run'];
const skipOffMarket = !!args['no-offmarket'];
// Politeness delay between Craigslist page checks (ms).
const checkDelay = args['delay'] ? Number(args['delay']) : 1000;

// Load criteria from config, then let CLI args override.
let fileCriteria = {};
try {
  fileCriteria = JSON.parse(fs.readFileSync(CRITERIA_PATH, 'utf8'));
} catch {
  console.log(`No ${path.basename(CRITERIA_PATH)} found, using defaults.`);
}
const num = (v, fallback) => (v != null ? Number(v) : fallback);
const criteria = {
  maxPrice: num(args['max-price'], fileCriteria.max_price ?? null),
  minPrice: num(args['min-price'], fileCriteria.min_price ?? null),
  minBeds: num(args['min-beds'], fileCriteria.min_beds ?? null),
  maxBeds: num(args['max-beds'], fileCriteria.max_beds ?? null),
  query: args['query'] || fileCriteria.query || null,
  neighborhoods: args['neighborhoods']
    ? String(args['neighborhoods']).toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
    : (fileCriteria.neighborhoods || null),
  limit: num(args['limit'], fileCriteria.limit ?? 50),
};

console.log('Search criteria:', JSON.stringify(criteria));

const db = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const byUrl = new Map(db.apartments.map(a => [a.url, a]));
const now = new Date().toISOString();

// ---- 1. Add new matching listings -------------------------------------------
const { listings, totalAvailable } = await fetchListings(criteria);
console.log(`Craigslist: ${totalAvailable} available, ${listings.length} match after filters.`);

const added = [];
for (const l of listings) {
  if (byUrl.has(l.url)) continue;
  const apt = toApartment(l, now);
  db.apartments.push(apt);
  byUrl.set(apt.url, apt);
  added.push(apt);
}
console.log(`Added ${added.length} new listing(s).`);
added.slice(0, 10).forEach(a => console.log(`  + ${a.price ? '$' + a.price : 'n/a'} · ${a.bedrooms ?? '?'}bd · ${a.address}`));

// ---- 2. Off-market sweep ----------------------------------------------------
const wentOffMarket = [];
if (!skipOffMarket) {
  const addedUrls = new Set(added.map(a => a.url));
  // Skip ones we just added this run — they came straight from the live search.
  const toCheck = db.apartments.filter(
    a => isCraigslist(a) && a.status !== 'off_market' && !addedUrls.has(a.url)
  );
  console.log(`Re-checking ${toCheck.length} active Craigslist listing(s) for removal...`);
  for (const apt of toCheck) {
    const gone = await isListingGone(apt.url);
    if (gone) {
      apt.prev_status = apt.status;
      apt.status = 'off_market';
      apt.off_market_at = now;
      wentOffMarket.push(apt);
      console.log(`  - off-market: ${apt.address} (was ${apt.prev_status})`);
    }
    if (checkDelay) await sleep(checkDelay);
  }
}
console.log(`Marked ${wentOffMarket.length} listing(s) off-market.`);

// ---- 3. Write --------------------------------------------------------------
const changed = added.length > 0 || wentOffMarket.length > 0;
if (dryRun) {
  console.log('\n--- DRY RUN, not writing ---');
} else if (changed) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2) + '\n');
  console.log(`\nWrote changes to ${DATA_PATH}.`);
} else {
  console.log('\nNo changes.');
}
