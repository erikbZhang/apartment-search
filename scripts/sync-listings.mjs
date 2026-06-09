#!/usr/bin/env node
// Multi-source hourly sync (run by .github/workflows/sync-listings.yml):
//   1. For each enabled source, fetch matching listings and ADD any new ones.
//   2. Re-check existing listings and mark removed ones status: "off_market"
//      (preserving the previous status in prev_status). Nothing is ever deleted.
//
// Sources live in scripts/sources.mjs. Which ones run is decided by, in order:
//   --sources=craigslist,redfin   (CLI)  >  data/search-criteria.json "sources"
//   >  ["craigslist"] (default). RentCast is skipped unless RENTCAST_API_KEY is set.
//
// Usage:
//   node scripts/sync-listings.mjs                      # add new + off-market sweep
//   node scripts/sync-listings.mjs --dry-run            # show changes, write nothing
//   node scripts/sync-listings.mjs --no-offmarket       # only add new listings
//   node scripts/sync-listings.mjs --sources=craigslist,redfin,dahlia
//   node scripts/sync-listings.mjs --max-price=4000 --min-beds=1   # override criteria
//
// Criteria precedence: CLI args > data/search-criteria.json > built-in defaults.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './craigslist.mjs';
import { resolveSources } from './sources.mjs';

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
// Politeness delay between per-URL off-market checks (ms) — Craigslist only.
const checkDelay = args['delay'] ? Number(args['delay']) : 1000;

// Load criteria from config, then let CLI args override.
let fileCriteria = {};
try {
  fileCriteria = JSON.parse(fs.readFileSync(CRITERIA_PATH, 'utf8'));
} catch {
  console.log(`No ${path.basename(CRITERIA_PATH)} found, using defaults.`);
}
const num = (v, fallback) => (v != null ? Number(v) : fallback);

// SF bounding box (config uses snake_case; the lib wants camelCase).
const b = fileCriteria.bbox || null;
const bbox = b
  ? { minLat: b.min_lat, maxLat: b.max_lat, minLon: b.min_lon, maxLon: b.max_lon }
  : null;

const criteria = {
  priceByBeds: fileCriteria.price_by_beds || null,
  bbox,
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

const sourceIds = args['sources']
  ? String(args['sources']).split(',').map(s => s.trim()).filter(Boolean)
  : (fileCriteria.sources || ['craigslist']);
const sources = resolveSources(sourceIds);

console.log('Search criteria:', JSON.stringify(criteria));
console.log('Sources:', sources.map(s => s.id).join(', ') || '(none)');

const db = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const byUrl = new Map(db.apartments.map(a => [a.url, a]));
const now = new Date().toISOString();

// ---- 1. Collect + add new listings from every source ------------------------
const added = [];
const collected = []; // { source, liveUrls, ok }
for (const source of sources) {
  try {
    const { add, liveUrls, totalAvailable } = await source.collect(criteria, now, { existingByUrl: byUrl });
    const before = added.length;
    for (const apt of add) {
      if (!apt.url || byUrl.has(apt.url)) continue;
      db.apartments.push(apt);
      byUrl.set(apt.url, apt);
      added.push(apt);
    }
    const avail = totalAvailable != null ? `${totalAvailable} available, ` : '';
    console.log(`[${source.label}] ${avail}${add.length} match, ${added.length - before} new.`);
    add.slice(0, 8).forEach(a =>
      console.log(`  + ${a.price ? '$' + a.price : 'n/a'} · ${a.bedrooms ?? '?'}bd · ${a.neighborhood || '—'} · ${a.address}`)
    );
    collected.push({ source, liveUrls, ok: true });
  } catch (err) {
    console.warn(`[${source.label}] FAILED: ${err.message} — skipping (existing listings untouched).`);
    collected.push({ source, liveUrls: null, ok: false });
  }
}
console.log(`Added ${added.length} new listing(s) total.`);

// ---- 2. Off-market sweep, per source ----------------------------------------
const addedUrls = new Set(added.map(a => a.url));
const wentOffMarket = [];
if (!skipOffMarket) {
  for (const { source, liveUrls, ok } of collected) {
    if (!ok) continue; // collection failed — don't risk retiring live listings
    if (source.offMarket === 'setdiff' && !liveUrls) continue;

    const toCheck = db.apartments.filter(
      a => source.owns(a) && a.status !== 'off_market' && !addedUrls.has(a.url)
    );
    if (!toCheck.length) continue;
    console.log(`[${source.label}] re-checking ${toCheck.length} active listing(s) (${source.offMarket})...`);

    for (const apt of toCheck) {
      let gone = false;
      if (source.offMarket === 'recheck') {
        gone = await source.isGone(apt.url);
        if (checkDelay) await sleep(checkDelay);
      } else {
        // setdiff: absent from the fresh full live set == gone.
        gone = !liveUrls.has(apt.url);
      }
      if (gone) {
        apt.prev_status = apt.status;
        apt.status = 'off_market';
        apt.off_market_at = now;
        wentOffMarket.push(apt);
        console.log(`  - off-market: ${apt.address} (was ${apt.prev_status})`);
      }
    }
  }
}
console.log(`Marked ${wentOffMarket.length} listing(s) off-market.`);

// ---- 3. Write ---------------------------------------------------------------
const changed = added.length > 0 || wentOffMarket.length > 0;
if (dryRun) {
  console.log('\n--- DRY RUN, not writing ---');
} else if (changed) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2) + '\n');
  console.log(`\nWrote changes to ${DATA_PATH}.`);
} else {
  console.log('\nNo changes.');
}
