// Source registry. Each source exposes a uniform interface so sync-listings.mjs
// can treat them identically:
//
//   id        string — matches the record's `added_by`
//   label     string — human label for logs
//   offMarket 'recheck' (per-URL HTTP check) | 'setdiff' (absent from a fresh
//             full fetch == gone)
//   owns(apt)            -> bool: does this source own that record?
//   isGone(url)          -> Promise<bool>: only for offMarket==='recheck'
//   collect(criteria, now, ctx) -> { add: [apt...], liveUrls: Set|null }
//
// Craigslist uses 'recheck' because its search is date-sorted and capped, so a
// live listing can be absent from results — set-difference would wrongly retire
// it. The lat/lon API sources return the full live set, so set-difference is
// both safe and cheaper than per-URL probing.

import { fetchListings, toApartment as clToApartment, isListingGone, isCraigslist } from './craigslist.mjs';
import { source as redfin } from './redfin.mjs';
import { source as dahlia } from './dahlia.mjs';
import { source as rentcast, hasKey as rentcastHasKey } from './rentcast.mjs';

const craigslist = {
  id: 'craigslist',
  label: 'Craigslist',
  offMarket: 'recheck',
  owns: isCraigslist,
  isGone: isListingGone,
  async collect(criteria, now = new Date().toISOString()) {
    const { listings, totalAvailable } = await fetchListings(criteria);
    const add = listings.map(l => clToApartment(l, now));
    return { add, liveUrls: null, totalAvailable };
  },
};

const ALL = { craigslist, redfin, dahlia, rentcast };

// Map enabled source ids to source objects, dropping unknown ids and sources
// whose prerequisites (e.g. an API key) aren't met.
export function resolveSources(ids) {
  const out = [];
  for (const id of ids) {
    const s = ALL[id];
    if (!s) {
      console.warn(`  ! Unknown source "${id}" — skipping.`);
      continue;
    }
    if (id === 'rentcast' && !rentcastHasKey()) {
      console.warn('  ! RentCast enabled but RENTCAST_API_KEY is not set — skipping.');
      continue;
    }
    out.push(s);
  }
  return out;
}

export { craigslist, redfin, dahlia, rentcast, ALL };
