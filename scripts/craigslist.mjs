// Shared Craigslist helpers used by import-craigslist.mjs and sync-listings.mjs.
// Pulls SF apartments from Craigslist's public JSON API, parses the compact
// array format into objects, converts them to our apartment shape, and can
// check whether an individual posting has been taken down.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Fetch + filter + rank listings matching the given criteria.
// criteria: { maxPrice, minPrice, minBeds, maxBeds, query, neighborhoods, limit }
export async function fetchListings(criteria = {}) {
  let {
    maxPrice = null,
    minPrice = null,
    minBeds = null,
    maxBeds = null,
    query = null,
    neighborhoods = null,
    limit = 50,
    priceByBeds = null,
    bbox = null,
  } = criteria;

  // Tiered mode: a per-bedroom price cap, e.g. { "2": 4500, "3": 7000, "4": 8500 }.
  // We derive the bedroom range and overall price ceiling from it for the API
  // query, then enforce the exact per-bedroom caps in the local filter below.
  let capByBeds = null;
  if (priceByBeds && typeof priceByBeds === 'object') {
    capByBeds = new Map(
      Object.entries(priceByBeds).map(([k, v]) => [Number(k), Number(v)])
    );
    const beds = [...capByBeds.keys()];
    if (minBeds == null) minBeds = Math.min(...beds);
    if (maxBeds == null) maxBeds = Math.max(...beds);
    if (maxPrice == null) maxPrice = Math.max(...capByBeds.values());
  }

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

  const url = `https://sapi.craigslist.org/web/v8/postings/search/full?${params}`;
  const res = await fetch(url, {
    headers: { Referer: 'https://sfbay.craigslist.org/', 'User-Agent': UA },
  });
  if (!res.ok) {
    throw new Error(`Craigslist API failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const data = json.data;
  const decode = data.decode;

  let listings = data.items
    .map(item => parseItem(item, decode))
    .filter(l => l.title && l.subareaAbbr === 'sfc');

  // Geographic gate: Craigslist tags many out-of-city posts (Fremont, Oakland,
  // etc.) as "sfc", but their real coordinates give them away. Keep only
  // listings whose coordinates fall inside the SF bounding box.
  if (bbox) {
    const { minLat, maxLat, minLon, maxLon } = bbox;
    listings = listings.filter(
      l =>
        l.lat != null && l.lon != null &&
        l.lat >= minLat && l.lat <= maxLat &&
        l.lon >= minLon && l.lon <= maxLon
    );
  }

  if (minPrice) listings = listings.filter(l => l.price != null && l.price >= minPrice);

  if (capByBeds) {
    // Keep only listings whose bedroom count has a cap and whose price is within it.
    // Listings with no price or no parsed bedroom count are dropped — we can't
    // apply a per-bedroom cap to them.
    listings = listings.filter(l => {
      if (l.price == null || l.beds == null) return false;
      const cap = capByBeds.get(l.beds);
      return cap != null && l.price <= cap;
    });
  } else {
    if (maxPrice) listings = listings.filter(l => l.price != null && l.price <= maxPrice);
    if (minBeds) listings = listings.filter(l => l.beds == null || l.beds >= minBeds);
    if (maxBeds) listings = listings.filter(l => l.beds == null || l.beds <= maxBeds);
  }

  if (neighborhoods && neighborhoods.length) {
    listings = listings.filter(l => {
      const blob = `${l.neighborhood || ''} ${l.title || ''}`.toLowerCase();
      const match = neighborhoods.find(needle => blob.includes(needle));
      if (match) l.matchedNeighborhood = match;
      return Boolean(match);
    });
  }

  // Rank: bigger sqft, newer postings, and better price. In tiered mode we reward
  // listings furthest under their bedroom's cap rather than a fixed bedroom count.
  listings.sort((a, b) => score(b, capByBeds) - score(a, capByBeds));
  listings = listings.slice(0, limit);

  return { listings, totalAvailable: data.totalResultCount };
}

function parseItem(item, decode) {
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

function score(l, capByBeds = null) {
  let s = 0;
  if (capByBeds) {
    // Reward listings comfortably under their bedroom's cap; don't bias bed count.
    const cap = capByBeds.get(l.beds);
    if (cap && l.price) s += Math.max(0, (cap - l.price) / cap) * 5;
  } else {
    if (l.beds === 1 || l.beds === 2) s += 5;
    else if (l.beds === 0) s -= 2;
    else if (l.beds == null) s -= 1;
    if (l.price) s += Math.max(0, (4500 - l.price) / 1000);
  }
  if (l.sqft) s += Math.min(l.sqft / 200, 5);
  const ageDays = (Date.now() - new Date(l.posted_at).getTime()) / 86400000;
  if (ageDays < 1) s += 2;
  else if (ageDays < 3) s += 1;
  return s;
}

// Convert a parsed listing into the apartment object stored in apartments.json.
export function toApartment(l, now = new Date().toISOString()) {
  return {
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
    lat: l.lat || null,
    lon: l.lon || null,
    notes: `From Craigslist · posted ${formatPosted(l.posted_at)}`,
    seen_by: [],
    added_by: 'craigslist',
    added_at: now,
  };
}

// True if the apartment came from Craigslist (so we know to re-check / off-market it).
export function isCraigslist(apt) {
  return (
    apt.added_by === 'craigslist' ||
    (typeof apt.url === 'string' && apt.url.includes('craigslist.org'))
  );
}

// Check whether a single Craigslist posting has been taken down.
// Returns true only when we're confident it's gone; transient/network errors
// return false so we never wrongly mark a live listing as off-market.
export async function isListingGone(url) {
  const GONE_MARKERS = [
    'this posting has been deleted',
    'this posting has expired',
    'this posting has been flagged for removal',
    'this posting has been removed',
  ];
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://sfbay.craigslist.org/' },
      redirect: 'follow',
    });
    if (res.status === 404 || res.status === 410) return true;
    if (!res.ok) return false; // 403/5xx/etc. — be conservative, don't mark gone
    const body = (await res.text()).toLowerCase();
    return GONE_MARKERS.some(m => body.includes(m));
  } catch {
    return false; // network error — be conservative
  }
}

export function titleCase(s) {
  if (!s) return '';
  return s.replace(/\b([a-z])/g, c => c.toUpperCase());
}

export function detectLaundry(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(in[- ]?unit|w\/?d in[- ]?unit|in[- ]?unit w\/?d|laundry in unit|in apartment)\b/.test(t)) return 'in_unit';
  if (/\b(no laundry|no on[- ]?site laundry)\b/.test(t)) return 'none';
  if (/\b(on[- ]?site laundry|laundry on[- ]?site|shared laundry|building laundry|laundry room|coin[- ]?op|on site|laundry)\b/.test(t)) return 'shared';
  return null;
}

export function formatPosted(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
