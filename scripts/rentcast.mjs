// RentCast source — developer rental-listings API (rentcast.io). Real live
// for-rent listings sourced from public records/MLS/directories (NOT scraped
// from Zillow), so it's the most ToS-clean third-party option.
//
// Requires an API key in the RENTCAST_API_KEY env var. The free tier is only
// 50 requests/month, so this is meant to run on a LOW-FREQUENCY (e.g. daily)
// schedule, not the hourly Craigslist sweep. One call pulls a full page of SF
// listings, which we then filter locally to conserve quota.

import { detectLaundry, titleCase } from './craigslist.mjs';
import { neighborhoodAt, resolveTargetNeighborhoods } from './geo.mjs';

const API = 'https://api.rentcast.io/v1/listings/rental/long-term';

export function hasKey() {
  return Boolean(process.env.RENTCAST_API_KEY);
}

async function fetchSFRentals(limit = 500) {
  const params = new URLSearchParams({
    city: 'San Francisco',
    state: 'CA',
    status: 'Active',
    limit: String(Math.min(Math.max(limit, 1), 500)),
  });
  const res = await fetch(`${API}?${params}`, {
    headers: { 'X-Api-Key': process.env.RENTCAST_API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`RentCast API failed: ${res.status} ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  return Array.isArray(json) ? json : json.listings || [];
}

// RentCast responses don't include a public listing URL, so synthesize a stable,
// human-useful one (a maps search for the address) that doubles as the dedup key.
function listingUrl(l) {
  const addr = l.formattedAddress || l.addressLine1 || '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr + ', San Francisco, CA')}`;
}

export const source = {
  id: 'rentcast',
  label: 'RentCast',
  offMarket: 'setdiff',
  owns(apt) {
    return apt.added_by === 'rentcast' || (typeof apt.id === 'string' && apt.id.startsWith('rc_'));
  },
  async collect(criteria = {}, now = new Date().toISOString()) {
    const all = await fetchSFRentals(criteria.limit ?? 500);
    const liveUrls = new Set(all.map(listingUrl));

    const { bbox = null } = criteria;
    const capByBeds = criteria.priceByBeds
      ? new Map(Object.entries(criteria.priceByBeds).map(([k, v]) => [Number(k), Number(v)]))
      : null;
    const targetSet = resolveTargetNeighborhoods(criteria.neighborhoods);

    const add = [];
    for (const l of all) {
      const beds = l.bedrooms ?? null;
      const price = typeof l.price === 'number' ? l.price : null;
      const lat = l.latitude ?? null;
      const lon = l.longitude ?? null;

      if (bbox && lat != null && lon != null) {
        if (lat < bbox.minLat || lat > bbox.maxLat || lon < bbox.minLon || lon > bbox.maxLon) continue;
      }

      // Price / bedroom gate.
      if (capByBeds) {
        if (beds == null || price == null) continue;
        const cap = capByBeds.get(beds);
        if (cap == null || price > cap) continue;
      } else {
        if (criteria.minBeds != null && beds != null && beds < criteria.minBeds) continue;
        if (criteria.maxBeds != null && beds != null && beds > criteria.maxBeds) continue;
        if (criteria.maxPrice != null && price != null && price > criteria.maxPrice) continue;
      }

      const hood = neighborhoodAt(lat, lon);
      if (targetSet && (!hood || !targetSet.has(hood))) continue;

      const key = l.id || listingUrl(l);
      add.push({
        id: 'rc_' + key,
        url: listingUrl(l),
        address: l.formattedAddress || l.addressLine1 || null,
        neighborhood: hood ? titleCase(hood) : '',
        price,
        bedrooms: beds,
        bathrooms: l.bathrooms ?? null,
        sqft: l.squareFootage ?? null,
        available: l.listedDate ? l.listedDate.slice(0, 10) : null,
        status: 'to_see',
        laundry: detectLaundry(l.description || ''),
        lat,
        lon,
        notes:
          `From RentCast${price ? ` · $${price}` : ''}` +
          (l.daysOnMarket != null ? ` · ${Math.round(l.daysOnMarket)}d on market` : ''),
        seen_by: [],
        added_by: 'rentcast',
        added_at: now,
      });
    }
    return { add, liveUrls };
  },
};
