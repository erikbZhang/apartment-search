# Listing sources — scoping & status

This project pulls SF rental listings from external sites on an hourly GitHub
Action, using **only Node stdlib + `fetch` (no dependencies), running from
GitHub Actions datacenter IPs**. That last constraint decides what's feasible:
modern anti-bot stacks (Cloudflare, PerimeterX/HUMAN, Akamai, DataDome) classify
datacenter IPs as hostile and block them on sight, and TLS fingerprinting defeats
bare Node `fetch` before IP reputation even matters. Craigslist works precisely
because it's the rare site that doesn't run that gauntlet on its JSON API.

## Source feasibility (researched 2026-06)

| Source | Status | Notes |
|---|---|---|
| **Craigslist** | ✅ Live (primary) | Undocumented `sapi.craigslist.org` JSON API. Best free market-rate feed; nothing else matches it. |
| **Redfin** | ✅ Live (supplement) | Internal "stingray" rentals API (`/stingray/api/v1/search/rentals`, SF region 17151). No heavy anti-bot vendor — plain `fetch` works. **Coverage caveat:** since Feb 2025 its apartment-building listings are Zillow passthrough; Redfin's own inventory is mostly sub-5-unit + SFR. **Datacenter-IP caveat:** the CDN 403s *some* endpoints from datacenter IPs; the rentals endpoint worked in local testing but may be blocked from CI — see "Operational notes". |
| **DAHLIA** (housing.sfgov.org) | ✅ Live (affordable) | SF gov public JSON API, no key. **Below-market-rate / affordable lottery units only** — income-restricted, with application deadlines. Complements market-rate sources. Listings lack coordinates, so we geocode via Nominatim. |
| **RentCast** | ⚙️ Scaffolded, off by default | Real listings via developer API, cleanest ToS (public-records sourced, not Zillow-scraped). Free tier is **50 calls/month** → daily, not hourly. Needs `RENTCAST_API_KEY`. See "Enabling RentCast". |
| **Zillow / Trulia / HotPads** | ❌ Not viable free | PerimeterX + Cloudflare block datacenter IPs immediately. Bridge API is MLS-partner-only and not a rentals feed. |
| **Apartments.com (CoStar)** | ❌ Avoid | Most aggressive anti-bot *and* most litigious in the space. Highest legal risk. |
| **Realtor.com** | ❌ Not viable free | Akamai Bot Manager + TLS fingerprinting; rentals are secondary coverage anyway. |
| **Facebook Marketplace, Zumper/PadMapper, ATTOM, HelloData, Apartment List** | ❌ | No public API, estimates-not-listings, or hostile anti-bot. |
| **Paid scraping services** (Apify, ScraperAPI, Bright Data) | 💸 Fallback only | They defeat the datacenter-IP problem but cost ~$5–49/mo and add an external dependency. Documented as an escape hatch if Craigslist ever dies; not integrated. |

## Architecture (multi-source)

Each source is a module in `scripts/` exposing a uniform interface, registered in
`scripts/sources.mjs`:

```
id        string — matches the record's `added_by`
label     string — for logs
offMarket 'recheck' (per-URL HTTP check) | 'setdiff' (absent from a fresh full fetch == gone)
owns(apt)                    -> bool
isGone(url)                  -> Promise<bool>   (offMarket==='recheck' only)
collect(criteria, now, ctx)  -> { add: [apt...], liveUrls: Set|null }
```

- **`scripts/craigslist.mjs`** — unchanged; wrapped as a source in `sources.mjs`.
  Uses `recheck` off-market because its search is date-sorted and capped, so a
  live listing can be absent from results (set-difference would wrongly retire it).
- **`scripts/redfin.mjs`, `scripts/dahlia.mjs`, `scripts/rentcast.mjs`** — the
  lat/lon API sources. They return the full live set, so `setdiff` off-market is
  safe and cheaper. `liveUrls` is built from the **unfiltered** SF fetch so a
  listing isn't retired merely because its price drifted out of criteria.
- **`scripts/geo.mjs`** — point-in-polygon against `data/sf-neighborhoods.geojson`
  (the same 37-feature set the map uses). The API sources give coordinates but no
  neighborhood name, so we assign neighborhoods geometrically instead of by text.
  A few targets aren't distinct features in that set, so they're aliased to their
  parent polygon: Hayes Valley & Japantown → Western Addition, Union Square →
  Downtown/Civic Center, Cow Hollow → Marina.
- **`scripts/sync-listings.mjs`** — orchestrates all enabled sources. A source
  that throws (e.g. Redfin 403 from CI) is logged and skipped; existing listings
  are left untouched, and the other sources still run.

Which sources run: `--sources=a,b` (CLI) > `"sources"` in
`data/search-criteria.json` > `["craigslist"]` (default).

## Operational notes

- **Watch the Redfin CI behavior.** Redfin's rentals endpoint worked from a
  residential IP in testing. If GitHub Actions runners get 403'd, the sync logs
  `[Redfin] FAILED: …` and continues with the other sources — so it degrades
  gracefully, but Redfin listings simply won't appear. Check the Action log after
  the first scheduled run.
- **DAHLIA geocoding** hits Nominatim at <1 req/sec and only for listings not
  already stored (lat/lon is cached on the record). Low volume (~tens of listings).
- **Neighborhood filtering for API sources is geometric**, so it's stricter and
  more accurate than Craigslist's title-text matching — but depends on the
  geojson's 37-neighborhood granularity (hence the aliases above).

## Enabling RentCast

1. Sign up at rentcast.io and get an API key (free tier = 50 req/month).
2. Add it as a repo secret `RENTCAST_API_KEY` and expose it to the sync step.
3. Because of the quota, run RentCast on a **daily** schedule, not hourly:
   `node scripts/sync-listings.mjs --sources=rentcast` (one call pulls a full SF
   page, filtered locally). Don't add `rentcast` to the hourly `sources` list.
