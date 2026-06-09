// DAHLIA source — San Francisco's affordable-housing portal (housing.sfgov.org).
// Public JSON API, no key. These are BELOW-MARKET-RATE / affordable lottery
// units (income-restricted, with application deadlines), NOT market-rate
// rentals — so they complement Craigslist/Redfin rather than replace them.
//
// Listings carry an address but no coordinates, so we geocode new ones via
// Nominatim (rate-limited to ~1 req/sec, same as the app's place geocoder) and
// store lat/lon on the record so we never re-geocode an existing listing.

import { titleCase, sleep } from './craigslist.mjs';
import { neighborhoodAt, resolveTargetNeighborhoods } from './geo.mjs';

const UA =
  'apartment-search/1.0 (personal SF apartment tracker; geocoding via Nominatim)';

const LISTINGS_URL = 'https://housing.sfgov.org/api/v1/listings?type=rental';

async function fetchListings() {
  const res = await fetch(LISTINGS_URL, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`DAHLIA API failed: ${res.status}`);
  const json = await res.json();
  return json.listings || json || [];
}

// "Studio" -> 0, "1 BR" -> 1, ... ; null if unparseable.
function bedsOf(unitType) {
  if (!unitType) return null;
  if (/studio/i.test(unitType)) return 0;
  const m = unitType.match(/(\d+)\s*BR/i);
  return m ? Number(m[1]) : null;
}

async function geocode(address) {
  const params = new URLSearchParams({
    q: address,
    format: 'json',
    limit: '1',
    countrycodes: 'us',
    viewbox: '-122.52,37.84,-122.35,37.70',
    bounded: '1',
  });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) return { lat: null, lon: null };
    const arr = await res.json();
    if (!arr.length) return { lat: null, lon: null };
    return { lat: Number(arr[0].lat), lon: Number(arr[0].lon) };
  } catch {
    return { lat: null, lon: null };
  }
}

function listingUrl(l) {
  return `https://housing.sfgov.org/listings/${l.Id || l.listingID}`;
}

// Choose the unit type that best fits the target bedroom range (largest first),
// returning { beds, rent, sqft, unitType } or null if none match.
function pickUnit(l, capByBeds, minBeds, maxBeds, maxPrice) {
  const units = (l.unitSummaries && l.unitSummaries.general) || [];
  const candidates = units
    .map(u => ({
      beds: bedsOf(u.unitType),
      rent: u.minMonthlyRent ?? null,
      sqft: u.minSquareFt ?? null,
      unitType: u.unitType,
    }))
    .filter(u => u.beds != null)
    .sort((a, b) => b.beds - a.beds); // largest bedroom count first

  for (const u of candidates) {
    if (capByBeds) {
      const cap = capByBeds.get(u.beds);
      if (cap != null && (u.rent == null || u.rent <= cap)) return u;
    } else {
      const okBeds = (minBeds == null || u.beds >= minBeds) && (maxBeds == null || u.beds <= maxBeds);
      const okPrice = maxPrice == null || u.rent == null || u.rent <= maxPrice;
      if (okBeds && okPrice) return u;
    }
  }
  return null;
}

export const source = {
  id: 'dahlia',
  label: 'DAHLIA (affordable)',
  offMarket: 'setdiff',
  owns(apt) {
    return (
      apt.added_by === 'dahlia' ||
      (typeof apt.id === 'string' && apt.id.startsWith('sf_')) ||
      (typeof apt.url === 'string' && apt.url.includes('housing.sfgov.org'))
    );
  },
  async collect(criteria = {}, now = new Date().toISOString(), ctx = {}) {
    const existingByUrl = ctx.existingByUrl || new Map();
    const all = await fetchListings();
    const liveUrls = new Set(all.map(listingUrl));

    const capByBeds = criteria.priceByBeds
      ? new Map(Object.entries(criteria.priceByBeds).map(([k, v]) => [Number(k), Number(v)]))
      : null;
    const targetSet = resolveTargetNeighborhoods(criteria.neighborhoods);

    const add = [];
    for (const l of all) {
      const unit = pickUnit(
        l, capByBeds, criteria.minBeds ?? null, criteria.maxBeds ?? null, criteria.maxPrice ?? null
      );
      if (!unit) continue;

      const url = listingUrl(l);
      const existing = existingByUrl.get(url);

      // Reuse coordinates from a prior sync; only geocode genuinely new listings.
      let lat = existing?.lat ?? null;
      let lon = existing?.lon ?? null;
      if (lat == null || lon == null) {
        const addr = [l.Building_Street_Address, l.Building_City || 'San Francisco', l.Building_State || 'CA']
          .filter(Boolean)
          .join(', ');
        ({ lat, lon } = await geocode(addr));
        await sleep(1100); // Nominatim politeness: <1 req/sec
      }

      // Neighborhood gate (only when we have coordinates to test).
      const hood = neighborhoodAt(lat, lon);
      if (targetSet && (!hood || !targetSet.has(hood))) continue;

      const due = l.Application_Due_Date ? l.Application_Due_Date.slice(0, 10) : null;
      add.push({
        id: 'sf_' + (l.Id || l.listingID),
        url,
        address: l.Building_Street_Address || l.Name || null,
        neighborhood: hood ? titleCase(hood) : '',
        price: unit.rent,
        bedrooms: unit.beds,
        bathrooms: null,
        sqft: unit.sqft,
        available: due,
        status: 'to_see',
        laundry: null,
        lat,
        lon,
        notes:
          `Affordable/BMR · ${l.Name || ''}` +
          (unit.unitType ? ` · ${unit.unitType}` : '') +
          (due ? ` · apply by ${due}` : '') +
          (l.Listing_Type ? ` · ${l.Listing_Type}` : ''),
        seen_by: [],
        added_by: 'dahlia',
        added_at: now,
      });
    }
    return { add, liveUrls };
  },
};
