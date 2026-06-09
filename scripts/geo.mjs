// Shared geo helpers for lat/lon-based sources (Redfin, DAHLIA, RentCast) that
// give coordinates but no neighborhood name. We assign neighborhoods by
// point-in-polygon against data/sf-neighborhoods.geojson — the same 37-feature
// set the map uses — rather than by matching listing text. Ported from the
// in-browser pointInGeometry in app.js; keep the two in sync if either changes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEOJSON_PATH = path.resolve(__dirname, '..', 'data', 'sf-neighborhoods.geojson');

let _features = null;
function features() {
  if (_features) return _features;
  try {
    const g = JSON.parse(fs.readFileSync(GEOJSON_PATH, 'utf8'));
    _features = g.features || [];
  } catch {
    _features = [];
  }
  return _features;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}
function pointInPolyCoords(point, polyCoords) {
  if (!pointInRing(point, polyCoords[0])) return false;
  for (let i = 1; i < polyCoords.length; i++) {
    if (pointInRing(point, polyCoords[i])) return false; // inside a hole
  }
  return true;
}
function pointInGeometry(point, geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return pointInPolyCoords(point, geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(c => pointInPolyCoords(point, c));
  return false;
}

// The geojson name of the neighborhood containing (lat, lon), or null.
export function neighborhoodAt(lat, lon) {
  if (lat == null || lon == null) return null;
  const pt = [Number(lon), Number(lat)];
  for (const f of features()) {
    if (pointInGeometry(pt, f.geometry)) return f.properties?.name || null;
  }
  return null;
}

// A few targets in the user's search don't exist as distinct features in the
// 37-neighborhood set, so map them to the parent polygon they fall inside.
const ALIASES = {
  'hayes valley': 'Western Addition',
  'japantown': 'Western Addition',
  'japan town': 'Western Addition',
  'union square': 'Downtown/Civic Center',
  'cow hollow': 'Marina',
};

// Resolve the user's free-text neighborhood needles to the set of canonical
// geojson neighborhood names we'll accept. Returns null when no neighborhoods
// are configured (meaning: don't filter by neighborhood at all).
export function resolveTargetNeighborhoods(needles) {
  if (!needles || !needles.length) return null;
  const names = features().map(f => f.properties?.name).filter(Boolean);
  const set = new Set();
  for (const needle of needles) {
    const n = String(needle).toLowerCase().trim();
    if (!n) continue;
    if (ALIASES[n]) set.add(ALIASES[n]);
    for (const name of names) {
      const ln = name.toLowerCase();
      if (ln.includes(n) || n.includes(ln)) set.add(name);
    }
  }
  return set;
}
