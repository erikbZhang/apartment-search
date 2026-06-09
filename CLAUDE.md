# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A two-person SF apartment-hunting tracker. **Static site, no backend, no build step, no dependencies.** The "database" is `data/apartments.json` committed in this repo; the web app reads and writes it directly via the GitHub Contents API using a Personal Access Token the user pastes into Settings (stored only in `localStorage`). Every edit is a commit on `main`, so git history is the audit log. The site is served from GitHub Pages off `main` at the repo root.

## Commands

```bash
# Serve locally (no build)
python3 -m http.server 8000      # then open http://localhost:8000

# Add new Craigslist listings (one-shot, merges into data/apartments.json)
node scripts/import-craigslist.mjs --max-price=4000 --min-beds=1 --max-beds=2 --limit=30
node scripts/import-craigslist.mjs --dry-run        # preview, write nothing

# Hourly sync logic (add new + off-market sweep) — also run by GitHub Action
node scripts/sync-listings.mjs --dry-run            # preview
node scripts/sync-listings.mjs                      # add new + re-check for removed
node scripts/sync-listings.mjs --no-offmarket       # only add new
node scripts/sync-listings.mjs --sources=craigslist,redfin,dahlia   # override enabled sources
```

There are no tests, linter, or package.json — the scripts are plain Node ESM (`.mjs`) using only the standard library and global `fetch` (Node 20+).

## Architecture

**Three data files in `data/`, all plain JSON arrays under a top-level key:**
- `apartments.json` → `{ apartments: [...] }` — the apartment records (see shape below). Written by both the web app and the sync scripts.
- `places.json` → `{ places: [...] }` — friends/gyms/etc. map markers. Written only by the web app.
- `search-criteria.json` — config for the hourly sync. `sf-neighborhoods.geojson` — polygon overlay for the map.

**Frontend (`index.html` + `app.js` + `styles.css`)** is a single IIFE in `app.js`. No framework. Key points:
- All UI state lives in one `state` object; `render()` is the single re-render entry point driven off `state.view` (`list`/`grid`/`map`).
- GitHub I/O: `fetchData()` reads `apartments.json` (storing `state.sha` for optimistic concurrency), `persist()` PUTs it back. A `409` means a collaborator wrote first → user must Refresh. `places.json` has its own `persistPlaces()` that re-fetches the SHA each write.
- **Read-only fallback:** if no settings are configured (or the file 404s on GitHub), the app `fetch`es the local `data/apartments.json` and renders it read-only (`state.readOnly`). This is what GitHub Pages visitors without a token see.
- **Map** (Leaflet, loaded via CDN; Carto basemap, no API key): apartment price pins + place markers + neighborhood polygons. Neighborhoods an apartment falls inside are highlighted via in-browser point-in-polygon (`pointInGeometry`), not by name matching.
- **Geocoding** is done client-side via Nominatim (`geocodeAddress`), bounded to an SF viewbox and rate-limited to ~1 req/sec for places missing `lat`/`lon`.

**Multi-source ingestion (`scripts/`)** — `sync-listings.mjs` orchestrates several listing sources behind a uniform interface registered in `sources.mjs`. Each source exposes `collect(criteria, now, ctx) -> { add, liveUrls }`, `owns(apt)`, an off-market strategy (`'recheck'` = per-URL HTTP check, or `'setdiff'` = absent-from-fresh-full-fetch means gone), and (for recheck) `isGone(url)`. Which sources run: `--sources=` CLI > `"sources"` in `search-criteria.json` > `["craigslist"]`. A source that throws is logged and skipped — existing listings are left untouched and the other sources still run. **See `SOURCES.md` for the full source-by-source feasibility analysis and caveats.**
- `craigslist.mjs` — the original Craigslist library (see below); wrapped as a source. Uses `recheck` because its search is capped/date-sorted.
- `redfin.mjs` — Redfin's internal "stingray" rentals API (SF region 17151). Supplement only; coverage is partial and the endpoint may be 403'd from CI datacenter IPs.
- `dahlia.mjs` — SF's DAHLIA affordable-housing API (BMR/lottery units only). Geocodes addresses via Nominatim since listings lack coordinates.
- `rentcast.mjs` — RentCast developer API; **off unless `RENTCAST_API_KEY` is set**. Free tier is 50 req/month, so it runs once daily via its own `sync-rentcast.yml` workflow and enforces a hard monthly cap (40) persisted in `data/rentcast-usage.json` — one request per run, never add pagination. Never put `rentcast` in the hourly `sources` list.
- `geo.mjs` — point-in-polygon neighborhood assignment for the lat/lon sources (shares `data/sf-neighborhoods.geojson` with the map); includes aliases for targets the 37-neighborhood set folds into a parent (Hayes Valley/Japantown → Western Addition, etc.).

**Craigslist library (`craigslist.mjs`)** — `import-craigslist.mjs` (manual) and the Craigslist source both call into it.
- `fetchListings()` hits Craigslist's undocumented public JSON API (`sapi.craigslist.org/.../search/full`) and parses its compact positional-array format in `parseItem()`. **This parser is fragile** — it depends on element positions and the `decode` lookup tables; if Craigslist changes the response shape, `parseItem` is where it breaks.
- Two filtering modes: a flat `maxPrice`/`minBeds`/`maxBeds`, or **tiered `priceByBeds`** (a per-bedroom price ceiling like `{ "2": 4500, "3": 7000 }`). In tiered mode the bedroom range and overall ceiling are derived from the keys, and only listings whose bed count appears in the map (and price ≤ that tier) survive.
- `bbox` is a **geographic gate** (lat/lon box) that drops out-of-city posts Craigslist mis-tags as `sfc` — more reliable than title-text filtering.
- Dedup is by `url`. `toApartment()` maps a listing to the stored shape with `id: 'cl_' + posting_id`, `added_by: 'craigslist'`.

**Off-market sweep:** `sync-listings.mjs` re-fetches every existing Craigslist listing's URL via `isListingGone()` (checks for 404/410 or known "deleted/expired/removed" body text). When gone, it sets `status: 'off_market'`, saves the old status in `prev_status`, and stamps `off_market_at`. **Nothing is ever deleted** from the file. `isListingGone` is deliberately conservative: transient/network/403/5xx errors return `false` so a live listing is never wrongly retired.

**Automation:** `.github/workflows/sync-listings.yml` runs `sync-listings.mjs` hourly (cron, UTC) and on manual dispatch, then commits `data/apartments.json` back to `main`. Scheduled workflows only run from the default branch, so this must stay on `main`. Requires repo Actions write permissions.

## Apartment record shape

```json
{
  "id": "cl_7935703587 | <uid for manual>",
  "url": "...", "address": "...", "neighborhood": "...",
  "price": 4150, "bedrooms": 2, "bathrooms": null, "sqft": 750,
  "available": null, "status": "to_see",
  "laundry": "in_unit | shared | none | null",
  "lat": 37.788, "lon": -122.4183,
  "notes": "...", "seen_by": ["name", ...],
  "added_by": "craigslist | <person>", "added_at": "ISO",
  "prev_status": "...", "off_market_at": "ISO"   // only once off-market
}
```

`status` ∈ `to_see` / `saw_it` / `liked` / `applied` / `rejected` / `off_market`. `laundry` is inferred from listing text by `detectLaundry()` (kept duplicated in both `app.js` and `craigslist.mjs` — keep them in sync if you change the patterns).

## Conventions

- Keep it dependency-free and build-free. Leaflet/CDN scripts are loaded in `index.html`; don't introduce npm tooling without a reason.
- The web app and scripts both write `data/apartments.json` — preserve the `{ apartments: [...] }` envelope and 2-space-indent + trailing newline formatting (scripts write `JSON.stringify(db, null, 2) + '\n'`).
- All user-supplied strings rendered into the DOM go through `escapeHtml()`.
