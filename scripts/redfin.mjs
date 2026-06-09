// Redfin rental source. Hits Redfin's undocumented internal "stingray" rentals
// search API for San Francisco (region 17151) and maps results to our apartment
// shape. Like the Craigslist parser, this depends on an internal JSON shape and
// will break if Redfin changes it — parseHome() is where that happens.
//
// IMPORTANT: Redfin sits behind a CDN that blocks some endpoints from
// datacenter IPs. The rentals search endpoint responded fine in testing, but
// from GitHub Actions runners it may return 403. collect() therefore lets the
// caller treat a failure as non-fatal (the hourly Craigslist sync must not die
// because Redfin blocked us).
//
// Coverage caveat: since Feb 2025 Redfin's apartment-building (multifamily)
// listings are sourced from Zillow; Redfin's own rental inventory is mostly
// sub-5-unit buildings + single-family. So this is a *supplement* to Craigslist,
// not a comprehensive market-rate feed. See SOURCES.md.

import { detectLaundry, titleCase } from './craigslist.mjs';
import { neighborhoodAt, resolveTargetNeighborhoods } from './geo.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// San Francisco city region in Redfin's region system.
const SF_REGION_ID = 17151;
const SF_REGION_TYPE = 6;

async function fetchAllSFRentals(limit = 350) {
  const params = new URLSearchParams({
    al: '1',
    market: 'sanfrancisco',
    num_homes: String(Math.min(Math.max(limit, 1), 350)),
    ord: 'days-on-redfin-asc',
    page_number: '1',
    region_id: String(SF_REGION_ID),
    region_type: String(SF_REGION_TYPE),
    status: '9',
    v: '8',
  });
  const url = `https://www.redfin.com/stingray/api/v1/search/rentals?${params}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.redfin.com/city/17151/CA/San-Francisco/apartments-for-rent',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Redfin API failed: ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
  let text = await res.text();
  // Redfin prefixes some stingray responses with an anti-JSON-hijacking token
  // (")]}'" or "{}&&"). Strip it defensively before parsing.
  text = text.replace(/^\)\]\}'?/, '').replace(/^\{\}&&/, '');
  const json = JSON.parse(text);
  return (json.homes || []).map(parseHome).filter(Boolean);
}

function parseHome(h) {
  const d = h.homeData || {};
  const r = h.rentalExtension || {};
  const ai = d.addressInfo || {};
  const c = (ai.centroid && ai.centroid.centroid) || {};
  const path = d.url;
  if (!path) return null;

  const key = r.rentalId || d.propertyId;
  if (!key) return null;

  const beds = r.bedRange || {};
  const baths = r.bathRange || {};
  const sqft = r.sqftRange || {};
  const rent = r.rentPriceRange || {};

  return {
    key,
    url: 'https://www.redfin.com' + path,
    address: ai.formattedStreetLine || null,
    bedMin: beds.min ?? null,
    bedMax: beds.max ?? null,
    bath: baths.min ?? null,
    sqft: sqft.min ?? null,
    priceMin: typeof rent.min === 'number' ? rent.min : null,
    priceMax: typeof rent.max === 'number' ? rent.max : null,
    lat: c.latitude ?? null,
    lon: c.longitude ?? null,
    available: r.dateAvailable || null,
    desc: r.description || '',
  };
}

// Does this listing offer a unit in the target bedroom range, within the cap
// for that bedroom count? Returns the matched bedroom count, or null.
function matchedBeds(l, capByBeds, minBeds, maxBeds, maxPrice) {
  const lo = l.bedMin ?? l.bedMax;
  const hi = l.bedMax ?? l.bedMin;
  if (lo == null || hi == null) return null;
  if (capByBeds) {
    // Prefer the largest offered bedroom count that has a cap and fits the price.
    for (let b = hi; b >= lo; b--) {
      const cap = capByBeds.get(b);
      if (cap != null && l.priceMin != null && l.priceMin <= cap) return b;
    }
    return null;
  }
  // Flat mode: overlap [minBeds,maxBeds] and price under maxPrice.
  const okBeds = (minBeds == null || hi >= minBeds) && (maxBeds == null || lo <= maxBeds);
  const okPrice = maxPrice == null || (l.priceMin != null && l.priceMin <= maxPrice);
  if (!okBeds || !okPrice) return null;
  return Math.min(hi, maxBeds ?? hi);
}

function toApartment(l, beds, now) {
  const hood = neighborhoodAt(l.lat, l.lon);
  const range =
    l.priceMax && l.priceMin && l.priceMax !== l.priceMin
      ? `$${l.priceMin}–$${l.priceMax}`
      : l.priceMin
      ? `$${l.priceMin}`
      : 'price n/a';
  const blurb = l.desc ? ' · ' + l.desc.slice(0, 140) : '';
  return {
    id: 'rf_' + l.key,
    url: l.url,
    address: l.address,
    neighborhood: hood ? titleCase(hood) : '',
    price: l.priceMin,
    bedrooms: beds,
    bathrooms: l.bath ?? null,
    sqft: l.sqft ?? null,
    available: l.available,
    status: 'to_see',
    laundry: detectLaundry(`${l.address || ''} ${l.desc || ''}`),
    lat: l.lat ?? null,
    lon: l.lon ?? null,
    notes: `From Redfin · ${range}${blurb}`,
    seen_by: [],
    added_by: 'redfin',
    added_at: now,
  };
}

export const source = {
  id: 'redfin',
  label: 'Redfin',
  offMarket: 'setdiff',
  owns(apt) {
    return (
      apt.added_by === 'redfin' ||
      (typeof apt.id === 'string' && apt.id.startsWith('rf_')) ||
      (typeof apt.url === 'string' && apt.url.includes('redfin.com'))
    );
  },
  async collect(criteria = {}, now = new Date().toISOString()) {
    const all = await fetchAllSFRentals(criteria.limit ?? 350);
    // liveUrls = every currently-live SF rental, BEFORE price/bed/hood filtering,
    // so the off-market sweep doesn't retire a listing merely because its price
    // drifted out of our criteria.
    const liveUrls = new Set(all.map(l => l.url));

    const { bbox = null } = criteria;
    const capByBeds = criteria.priceByBeds
      ? new Map(Object.entries(criteria.priceByBeds).map(([k, v]) => [Number(k), Number(v)]))
      : null;
    const targetSet = resolveTargetNeighborhoods(criteria.neighborhoods);

    let kept = all;
    if (bbox) {
      const { minLat, maxLat, minLon, maxLon } = bbox;
      kept = kept.filter(
        l =>
          l.lat != null && l.lon != null &&
          l.lat >= minLat && l.lat <= maxLat &&
          l.lon >= minLon && l.lon <= maxLon
      );
    }
    if (targetSet) {
      kept = kept.filter(l => {
        const hood = neighborhoodAt(l.lat, l.lon);
        return hood && targetSet.has(hood);
      });
    }

    const add = [];
    for (const l of kept) {
      const beds = matchedBeds(
        l, capByBeds, criteria.minBeds ?? null, criteria.maxBeds ?? null, criteria.maxPrice ?? null
      );
      if (beds == null) continue;
      add.push(toApartment(l, beds, now));
    }
    return { add, liveUrls };
  },
};
