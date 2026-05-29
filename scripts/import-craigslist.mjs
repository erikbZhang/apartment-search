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
//
// For the automated hourly add + off-market sync, see scripts/sync-listings.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchListings, toApartment } from './craigslist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, '..', 'data', 'apartments.json');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const criteria = {
  maxPrice: args['max-price'] ? Number(args['max-price']) : null,
  minPrice: args['min-price'] ? Number(args['min-price']) : null,
  minBeds: args['min-beds'] ? Number(args['min-beds']) : null,
  maxBeds: args['max-beds'] ? Number(args['max-beds']) : null,
  query: args['query'] || null,
  neighborhoods: args['neighborhoods']
    ? String(args['neighborhoods']).toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
    : null,
  limit: args['limit'] ? Number(args['limit']) : 50,
};
const dryRun = !!args['dry-run'];

const { listings, totalAvailable } = await fetchListings(criteria);
console.log(`Total available: ${totalAvailable}, matched ${listings.length} SF listings after filters.`);

const existing = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const existingByUrl = new Map(existing.apartments.map(a => [a.url, a]));

const now = new Date().toISOString();
const newOnes = [];
for (const l of listings) {
  if (existingByUrl.has(l.url)) continue;
  newOnes.push(toApartment(l, now));
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
