(() => {
  const DATA_PATH = 'data/apartments.json';
  const LS_KEY = 'apartment-search-settings';

  // Places (friends, gyms, etc.) are loaded from data/places.json.
  // Schema per entry: { category, name, address, type, vibe, lat, lon }
  // Categories drive marker color via PLACE_STYLE below.
  const PLACE_STYLE = {
    friends: { color: '#7c3aed', label: 'Friends' },
    gym:     { color: '#16a34a', label: 'Climbing gym' },
    restaurant: { color: '#dc2626', label: 'Restaurant' },
    coffee:  { color: '#92400e', label: 'Coffee' },
    grocery: { color: '#0369a1', label: 'Grocery' },
    park:    { color: '#65a30d', label: 'Park' },
    transit: { color: '#525252', label: 'Transit' },
  };
  function styleForPlace(cat) {
    return PLACE_STYLE[cat] || { color: '#525252', label: cat || 'Place' };
  }

  const LS_VIEW_KEY = 'apartment-search-view';

  const state = {
    settings: { name: '', repo: '', branch: 'main', token: '' },
    apartments: [],
    sha: null,
    loading: false,
    readOnly: false,
    view: 'list',              // 'list' | 'grid' | 'map'
    map: null,
    markerLayer: null,
    neighborhoodLayer: null,
    neighborhoodsLoaded: false,
    neighborhoodFeatures: null,
    placeLayer: null,
    places: [],
    placesLoaded: false,
    sortKey: 'posted',          // 'address' | 'price' | 'beds' | 'sqft' | 'ppsf' | 'status' | 'posted'
    sortDir: 'desc',            // 'asc' | 'desc'
    filterBeds: '',             // '' | '0' | '1' | '2' | '3+'
    priceMin: null,
    priceMax: null,
  };

  function loadView() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_VIEW_KEY) || '{}');
      if (['grid','list','map'].includes(raw.view)) state.view = raw.view;
      if (raw.sortKey) state.sortKey = raw.sortKey;
      if (raw.sortDir === 'asc' || raw.sortDir === 'desc') state.sortDir = raw.sortDir;
    } catch {}
  }
  function saveView() {
    localStorage.setItem(LS_VIEW_KEY, JSON.stringify({
      view: state.view, sortKey: state.sortKey, sortDir: state.sortDir,
    }));
  }

  const $ = (id) => document.getElementById(id);

  // -------- Settings persistence --------

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) Object.assign(state.settings, JSON.parse(raw));
    } catch {}
  }

  function saveSettings() {
    localStorage.setItem(LS_KEY, JSON.stringify(state.settings));
  }

  function hasSettings() {
    const { name, repo, token } = state.settings;
    return Boolean(name && repo && token);
  }

  // -------- GitHub API --------

  function ghHeaders() {
    return {
      'Authorization': `Bearer ${state.settings.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  function ghUrl() {
    const { repo, branch } = state.settings;
    return `https://api.github.com/repos/${repo}/contents/${DATA_PATH}?ref=${encodeURIComponent(branch || 'main')}`;
  }

  function ghPutUrl() {
    const { repo } = state.settings;
    return `https://api.github.com/repos/${repo}/contents/${DATA_PATH}`;
  }

  // base64 helpers that handle unicode
  function b64encode(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  function b64decode(b64) {
    return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
  }

  async function fetchLocalData() {
    try {
      const res = await fetch('data/apartments.json', { cache: 'no-store' });
      if (!res.ok) return false;
      const parsed = await res.json();
      state.apartments = Array.isArray(parsed.apartments) ? parsed.apartments : [];
      state.readOnly = true;
      setSync(`Preview · ${state.apartments.length} apt${state.apartments.length === 1 ? '' : 's'} (local, read-only)`, 'ok');
      render();
      return true;
    } catch {
      return false;
    }
  }

  async function fetchData() {
    if (!hasSettings()) {
      // Local preview fallback when settings aren't configured yet
      await fetchLocalData();
      return;
    }
    state.readOnly = false;
    setSync('Loading...');
    state.loading = true;
    try {
      const res = await fetch(ghUrl(), { headers: ghHeaders() });
      if (res.status === 404) {
        // File doesn't exist in remote yet — try local fallback
        const loaded = await fetchLocalData();
        if (loaded) {
          setSync(`Preview · ${state.apartments.length} local (not on GitHub yet — push to share)`, 'ok');
          return;
        }
        state.apartments = [];
        state.sha = null;
        state.readOnly = false;
        setSync('Empty (file not created yet)', 'ok');
        render();
        return;
      }
      if (!res.ok) throw new Error(`GitHub returned ${res.status}: ${await res.text()}`);
      const body = await res.json();
      state.sha = body.sha;
      const content = b64decode(body.content);
      const parsed = JSON.parse(content);
      state.apartments = Array.isArray(parsed.apartments) ? parsed.apartments : [];
      setSync(`Synced (${state.apartments.length} apt${state.apartments.length === 1 ? '' : 's'})`, 'ok');
      render();
    } catch (err) {
      console.error(err);
      setSync('Sync error — see console', 'error');
    } finally {
      state.loading = false;
    }
  }

  async function persist(commitMessage) {
    if (!hasSettings()) throw new Error('Missing settings');
    const content = JSON.stringify({ apartments: state.apartments }, null, 2);
    const body = {
      message: commitMessage,
      content: b64encode(content),
      branch: state.settings.branch || 'main',
    };
    if (state.sha) body.sha = state.sha;

    const res = await fetch(ghPutUrl(), {
      method: 'PUT',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      throw new Error('Conflict: someone else updated this data. Hit Refresh and try again.');
    }
    if (!res.ok) throw new Error(`GitHub returned ${res.status}: ${await res.text()}`);
    const json = await res.json();
    state.sha = json.content.sha;
  }

  // -------- Rendering --------

  function setSync(text, kind = '') {
    const el = $('syncStatus');
    el.textContent = text;
    el.className = `sync-status ${kind}`;
  }

  function statusLabel(s) {
    return {
      to_see: 'To see',
      saw_it: 'Saw it',
      liked: 'Liked',
      applied: 'Applied',
      rejected: 'Rejected',
    }[s] || s;
  }

  function laundryLabel(l) {
    return ({ in_unit: 'In unit', shared: 'Shared', none: 'None' })[l] || '—';
  }
  function laundryClass(l) {
    if (l === 'in_unit') return 'laundry-good';
    if (l === 'shared') return 'laundry-ok';
    if (l === 'none') return 'laundry-bad';
    return 'laundry-unknown';
  }

  function detectLaundry(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    if (/\b(in[- ]?unit|w\/?d in[- ]?unit|in[- ]?unit w\/?d|laundry in unit|in apartment)\b/.test(t)) return 'in_unit';
    if (/\b(no laundry|no on[- ]?site laundry)\b/.test(t)) return 'none';
    if (/\b(on[- ]?site laundry|laundry on[- ]?site|shared laundry|building laundry|laundry room|coin[- ]?op|on site|laundry)\b/.test(t)) return 'shared';
    return null;
  }

  function fmtPrice(n) {
    if (n == null || n === '') return '';
    return '$' + Number(n).toLocaleString();
  }

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch { return iso; }
  }

  function getFiltered() {
    const q = $('search').value.trim().toLowerCase();
    const nb = $('filterNeighborhood').value;
    const st = $('filterStatus').value;
    const ld = $('filterLaundry').value;

    let list = state.apartments.slice();
    if (q) {
      list = list.filter(a => {
        const blob = [a.address, a.neighborhood, a.notes, a.url].filter(Boolean).join(' ').toLowerCase();
        return blob.includes(q);
      });
    }
    if (nb) list = list.filter(a => a.neighborhood === nb);
    if (st) list = list.filter(a => a.status === st);
    if (ld) {
      list = list.filter(a => ld === 'unknown' ? !a.laundry : a.laundry === ld);
    }

    if (state.filterBeds !== '') {
      list = list.filter(a => {
        if (a.bedrooms == null) return false;
        if (state.filterBeds === '3+') return Number(a.bedrooms) >= 3;
        return Number(a.bedrooms) === Number(state.filterBeds);
      });
    }
    if (state.priceMin != null) list = list.filter(a => a.price != null && a.price >= state.priceMin);
    if (state.priceMax != null) list = list.filter(a => a.price != null && a.price <= state.priceMax);

    list.sort((a, b) => {
      const dir = state.sortDir === 'asc' ? 1 : -1;
      const av = sortValue(a, state.sortKey);
      const bv = sortValue(b, state.sortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    return list;
  }

  function sortValue(a, key) {
    switch (key) {
      case 'price': return a.price ?? null;
      case 'beds': return a.bedrooms ?? null;
      case 'sqft': return a.sqft ?? null;
      case 'ppsf': return (a.price && a.sqft) ? Math.round(a.price / a.sqft) : null;
      case 'laundry': {
        // Rank: in_unit (3) > shared (2) > none (1) > unknown (0)
        return ({ in_unit: 3, shared: 2, none: 1 })[a.laundry] || 0;
      }
      case 'status': return a.status || '';
      case 'address': return (a.address || '').toLowerCase();
      case 'posted':
      default: return new Date(a.added_at || 0).getTime();
    }
  }

  function refreshNeighborhoodFilter() {
    const select = $('filterNeighborhood');
    const current = select.value;
    const set = new Set(state.apartments.map(a => a.neighborhood).filter(Boolean));
    const opts = Array.from(set).sort();
    select.innerHTML = '<option value="">All neighborhoods</option>' +
      opts.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    if (opts.includes(current)) select.value = current;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function render() {
    refreshNeighborhoodFilter();
    const grid = $('grid');
    const listWrap = $('listWrap');
    const empty = $('empty');
    const setup = $('needsSetup');

    if (!hasSettings() && state.apartments.length === 0) {
      grid.innerHTML = '';
      $('listBody').innerHTML = '';
      listWrap.classList.add('hidden');
      grid.classList.add('hidden');
      empty.classList.add('hidden');
      setup.classList.remove('hidden');
      $('count').textContent = '';
      return;
    }
    setup.classList.add('hidden');
    $('readonlyBanner').classList.toggle('hidden', !state.readOnly);

    // Sort indicators
    document.querySelectorAll('#listHeader th.sortable').forEach(th => {
      const k = th.dataset.sort;
      const active = k === state.sortKey;
      th.classList.toggle('sorted', active);
      th.querySelector('.sort-icon').textContent = active ? (state.sortDir === 'asc' ? '↑' : '↓') : '';
    });

    // View visibility
    const mapWrap = $('mapWrap');
    listWrap.classList.toggle('hidden', state.view !== 'list');
    grid.classList.toggle('hidden', state.view !== 'grid');
    mapWrap.classList.toggle('hidden', state.view !== 'map');
    document.querySelectorAll('.view-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === state.view);
    });

    const list = getFiltered();
    $('count').textContent = list.length === state.apartments.length
      ? `${list.length} apartment${list.length === 1 ? '' : 's'}`
      : `${list.length} of ${state.apartments.length}`;

    if (state.apartments.length === 0) {
      grid.innerHTML = '';
      $('listBody').innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    if (state.view === 'grid') {
      grid.innerHTML = list.map(renderCard).join('');
    } else if (state.view === 'map') {
      renderMap(list);
    } else {
      $('listBody').innerHTML = list.length
        ? list.map(renderRow).join('')
        : '<tr class="list-empty-row"><td colspan="9">No apartments match the current filters.</td></tr>';
    }
  }

  function initMap() {
    if (state.map) return;
    state.map = L.map('map', {
      center: [37.7749, -122.4194],
      zoom: 13,
      scrollWheelZoom: true,
      zoomControl: true,
    });
    // Carto Positron — clean light basemap (free, no API key)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(state.map);

    // Neighborhood overlay (loaded once, lazy)
    state.neighborhoodLayer = L.layerGroup().addTo(state.map);
    loadNeighborhoods();

    // Place markers (friends, gyms, etc.) — above polygons, below apartment pins
    state.placeLayer = L.layerGroup().addTo(state.map);
    loadPlaces();

    // Apartment price markers on top
    state.markerLayer = L.layerGroup().addTo(state.map);
  }

  async function loadPlaces() {
    if (state.placesLoaded) { renderPlaces(); return; }
    state.placesLoaded = true;
    try {
      const res = await fetch('data/places.json', { cache: 'no-store' });
      if (!res.ok) return;
      const parsed = await res.json();
      state.places = Array.isArray(parsed.places) ? parsed.places : [];
      // Auto-geocode any entries missing coords (rate-limited at ~1/sec)
      for (const p of state.places) {
        if ((p.lat == null || p.lon == null) && p.address) {
          const geo = await geocodeAddress(p.address);
          if (geo) { p.lat = geo.lat; p.lon = geo.lon; }
          await new Promise(r => setTimeout(r, 1100));
        }
      }
      renderPlaces();
    } catch (err) {
      console.warn('places.json failed to load', err);
    }
  }

  function renderPlaces() {
    if (!state.placeLayer) return;
    state.placeLayer.clearLayers();
    state.places.forEach((p, idx) => {
      if (p.lat == null || p.lon == null) return;
      const style = styleForPlace(p.category);
      const icon = L.divIcon({
        className: '',
        html: `<div class="place-marker" style="background:${style.color}">
                 <span class="place-cat-dot"></span>
                 <span>${escapeHtml(p.name)}</span>
               </div>`,
        iconSize: null,
        iconAnchor: [40, 14],
      });
      const marker = L.marker([p.lat, p.lon], { icon });
      const tipMeta = [p.type, p.vibe].filter(Boolean).join(' · ');
      marker.bindTooltip(
        `<div class="apt-tooltip-title">${escapeHtml(p.name)}</div>
         <div class="apt-tooltip-meta">
           <strong>${escapeHtml(style.label)}</strong>
           ${tipMeta ? `<span>${escapeHtml(tipMeta)}</span>` : ''}
           <span>${escapeHtml(p.address || '')}</span>
         </div>`,
        { className: 'apt-tooltip', direction: 'top', offset: [0, -10] }
      );
      marker.bindPopup(`
        <div class="popup-title">${escapeHtml(p.name)}</div>
        <div class="popup-nb">${escapeHtml(style.label)}</div>
        ${p.type ? `<div class="popup-meta"><strong>${escapeHtml(p.type)}</strong></div>` : ''}
        ${p.vibe ? `<div class="popup-meta">${escapeHtml(p.vibe)}</div>` : ''}
        <div class="popup-meta">${escapeHtml(p.address || '')}, San Francisco</div>
        ${state.readOnly ? '' : `<div class="popup-actions">
          <button class="btn btn-ghost" onclick="document.dispatchEvent(new CustomEvent('place-edit',{detail:${idx}}))">Edit</button>
        </div>`}
      `);
      marker.addTo(state.placeLayer);
    });
  }

  // -------- Place CRUD --------

  function openPlaceModal(idx) {
    const editing = idx != null && state.places[idx];
    $('placeTitle').textContent = editing ? 'Edit place' : 'Add place';
    $('pIndex').value = editing ? String(idx) : '';
    $('pCategory').value = editing?.category || 'friends';
    $('pName').value = editing?.name || '';
    $('pAddress').value = editing?.address || '';
    $('pType').value = editing?.type || '';
    $('pVibe').value = editing?.vibe || '';
    $('deletePlaceBtn').classList.toggle('hidden', !editing);
    msg('placeMsg', '', '');
    $('placeModal').classList.remove('hidden');
    setTimeout(() => $('pName').focus(), 50);
  }

  async function submitPlace(e) {
    e.preventDefault();
    const idxStr = $('pIndex').value;
    const idx = idxStr === '' ? -1 : Number(idxStr);
    const existing = idx >= 0 ? state.places[idx] : null;

    const place = {
      category: $('pCategory').value,
      name: $('pName').value.trim(),
      address: $('pAddress').value.trim(),
      type: $('pType').value.trim(),
      vibe: $('pVibe').value.trim(),
      lat: existing?.lat ?? null,
      lon: existing?.lon ?? null,
    };

    if (!place.name || !place.address) {
      msg('placeMsg', 'Name and address are required.', 'error');
      return;
    }
    if (!hasSettings()) {
      msg('placeMsg', 'Configure GitHub Settings to save places.', 'error');
      return;
    }

    // Geocode if missing or if address changed
    if (place.lat == null || (existing && existing.address !== place.address)) {
      msg('placeMsg', 'Locating address...', '');
      const geo = await geocodeAddress(place.address);
      if (geo) { place.lat = geo.lat; place.lon = geo.lon; }
    }

    const backup = state.places.slice();
    if (existing) state.places[idx] = place;
    else state.places.push(place);

    try {
      msg('placeMsg', 'Saving...', '');
      await persistPlaces(existing ? `Update place: ${place.name}` : `Add place: ${place.name}`);
      closeModal('placeModal');
      renderPlaces();
    } catch (err) {
      state.places = backup;
      msg('placeMsg', err.message || 'Save failed', 'error');
    }
  }

  async function deletePlace() {
    const idx = Number($('pIndex').value);
    if (!Number.isInteger(idx) || idx < 0) return;
    const p = state.places[idx];
    if (!p) return;
    if (!confirm(`Remove "${p.name}" from the map?`)) return;
    const backup = state.places.slice();
    state.places.splice(idx, 1);
    try {
      await persistPlaces(`Remove place: ${p.name}`);
      closeModal('placeModal');
      renderPlaces();
    } catch (err) {
      state.places = backup;
      msg('placeMsg', err.message || 'Delete failed', 'error');
    }
  }

  async function persistPlaces(commitMessage) {
    if (!hasSettings()) throw new Error('Missing settings');
    const { repo, branch } = state.settings;
    const path = 'data/places.json';
    // Get latest sha (may have been updated by collaborator)
    let currentSha = null;
    const getRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch || 'main')}`,
      { headers: ghHeaders() }
    );
    if (getRes.ok) {
      const j = await getRes.json();
      currentSha = j.sha;
    } else if (getRes.status !== 404) {
      throw new Error(`GitHub ${getRes.status}: ${await getRes.text()}`);
    }
    const content = JSON.stringify({ places: state.places }, null, 2) + '\n';
    const body = {
      message: commitMessage,
      content: b64encode(content),
      branch: branch || 'main',
    };
    if (currentSha) body.sha = currentSha;

    const putRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}`,
      {
        method: 'PUT',
        headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (!putRes.ok) {
      throw new Error(`GitHub ${putRes.status}: ${await putRes.text()}`);
    }
  }

  async function loadNeighborhoods() {
    if (state.neighborhoodsLoaded) return;
    state.neighborhoodsLoaded = true; // mark eagerly to avoid double-fetch
    try {
      const res = await fetch('data/sf-neighborhoods.geojson', { cache: 'force-cache' });
      if (!res.ok) return;
      const geo = await res.json();
      state.neighborhoodFeatures = geo.features;
      const occupied = occupiedHoodNames(geo.features);
      const layer = L.geoJSON(geo, {
        style: (feature) => styleForHood(feature.properties.name, occupied),
        onEachFeature: (feature, lyr) => {
          const name = feature.properties.name;
          lyr.bindTooltip(name, {
            sticky: true,
            direction: 'top',
            className: 'hood-tooltip',
          });
          lyr.on('mouseover', () => {
            lyr.setStyle({ fillOpacity: 0.28, weight: 2 });
            lyr.bringToFront();
          });
          lyr.on('mouseout', () => {
            const occ = occupiedHoodNames(state.neighborhoodFeatures || []);
            lyr.setStyle(styleForHood(name, occ));
          });
        },
      });
      layer.addTo(state.neighborhoodLayer);
      state.neighborhoodLayer.bringToBack();
    } catch (err) {
      console.warn('neighborhoods overlay failed', err);
    }
  }

  // Maps the neighborhood names we use in apartment records to the polygon
  // names in data/sf-neighborhoods.geojson. Both sides are lowercased.
  const HOOD_ALIASES = {
    'hayes valley': 'western addition',
    'soma': 'south of market',
    'soma / south beach': 'south of market',
    'south beach': 'south of market',
    'laurel heights': 'presidio heights',
    'tenderloin': 'downtown/civic center',
    'mid-market': 'downtown/civic center',
    'civic center': 'downtown/civic center',
    'castro': 'castro/upper market',
    'upper market': 'castro/upper market',
    'haight': 'haight ashbury',
    'lower haight': 'haight ashbury',
    'upper haight': 'haight ashbury',
    'cole valley': 'haight ashbury',
    'duboce triangle': 'castro/upper market',
    'polk gulch': 'russian hill',
    'telegraph hill': 'north beach',
    'nopa': 'western addition',
    'fillmore': 'western addition',
    'alamo square': 'western addition',
    'dogpatch': 'potrero hill',
    'mission bay': 'south of market',
    'fidi': 'financial district',
    'embarcadero': 'financial district',
  };

  // Point-in-polygon (ray-casting). Coords are [lon, lat].
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
    // polyCoords: [outerRing, ...holeRings]
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

  function occupiedHoodNames(features) {
    const occupied = new Set();
    const apts = state.apartments.filter(a => a.lat != null && a.lon != null);
    for (const feat of features) {
      const name = feat.properties?.name;
      if (!name) continue;
      for (const a of apts) {
        if (pointInGeometry([a.lon, a.lat], feat.geometry)) {
          occupied.add(name);
          break;
        }
      }
    }
    return occupied;
  }

  function styleForHood(name, occupied) {
    if (occupied.has(name)) {
      return { fillColor: '#c2410c', fillOpacity: 0.18, color: '#c2410c', weight: 1.8, opacity: 0.9 };
    }
    return { fillColor: '#1c1917', fillOpacity: 0.03, color: '#94918a', weight: 0.8, opacity: 0.55, dashArray: '2,3' };
  }

  function renderMap(list) {
    if (typeof L === 'undefined') return;
    initMap();
    setTimeout(() => state.map.invalidateSize(), 50);
    state.markerLayer.clearLayers();

    const pts = [];
    list.forEach(a => {
      if (!a.lat || !a.lon) return;
      const beds = a.bedrooms == null ? null : Number(a.bedrooms);
      const bedsClass = beds == null ? '' : `beds-${beds >= 4 ? 4 : beds}`;
      const statusClass = ['liked','applied','rejected'].includes(a.status) ? `status-${a.status}` : '';
      const labelPrice = a.price ? '$' + (a.price >= 1000 ? (a.price/1000).toFixed(a.price >= 10000 ? 0 : 1).replace(/\.0$/,'') + 'k' : a.price) : '?';
      const icon = L.divIcon({
        className: '',
        html: `<div class="price-marker ${bedsClass} ${statusClass}">${escapeHtml(labelPrice)}</div>`,
        iconSize: null,
        iconAnchor: [22, 12],
      });
      const marker = L.marker([a.lat, a.lon], { icon });
      const tipMeta = [
        beds == null ? null : (beds === 0 ? 'Studio' : `${beds} bd`),
        a.sqft ? `${a.sqft.toLocaleString()} sqft` : null,
        a.laundry ? `Laundry: ${laundryLabel(a.laundry)}` : null,
        a.neighborhood || null,
      ].filter(Boolean);
      marker.bindTooltip(
        `<div class="apt-tooltip-title">${escapeHtml(a.address || 'Untitled')}</div>
         <div class="apt-tooltip-meta">
           <strong>${a.price ? '$' + a.price.toLocaleString() : '—'}</strong>
           <span>${escapeHtml(tipMeta.join(' · '))}</span>
         </div>`,
        { className: 'apt-tooltip', direction: 'top', offset: [0, -8] }
      );
      marker.bindPopup(`
        <div class="popup-title">${escapeHtml(a.address || 'Untitled')}</div>
        ${a.neighborhood ? `<div class="popup-nb">${escapeHtml(a.neighborhood)}</div>` : ''}
        <div class="popup-meta">
          <strong>${a.price ? '$' + a.price.toLocaleString() : '—'}</strong>${tipMeta.length ? ' · ' + escapeHtml(tipMeta.join(' · ')) : ''}
        </div>
        <div><span class="pill pill-${escapeHtml(a.status)}">${escapeHtml(statusLabel(a.status))}</span></div>
        <div class="popup-actions">
          ${a.url ? `<a class="btn btn-ghost" href="${escapeHtml(a.url)}" target="_blank" rel="noreferrer">Open listing</a>` : ''}
          ${state.readOnly ? '' : `<button class="btn btn-primary" onclick="document.dispatchEvent(new CustomEvent('apt-edit',{detail:'${escapeHtml(a.id)}'}))">Edit</button>`}
        </div>
      `);
      marker.addTo(state.markerLayer);
      pts.push([a.lat, a.lon]);
    });

    if (pts.length > 1) {
      state.map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
    } else if (pts.length === 1) {
      state.map.setView(pts[0], 15);
    }

    // Refresh neighborhood styling using geometric containment
    if (state.neighborhoodLayer && state.neighborhoodFeatures) {
      const occupied = occupiedHoodNames(state.neighborhoodFeatures);
      state.neighborhoodLayer.eachLayer(group => {
        if (typeof group.eachLayer === 'function') {
          group.eachLayer(f => {
            const name = f.feature?.properties?.name;
            if (name) f.setStyle(styleForHood(name, occupied));
          });
        }
      });
    }
  }

  function renderRow(a) {
    const me = state.settings.name;
    const seen = Array.isArray(a.seen_by) ? a.seen_by : [];
    const haveSeen = seen.includes(me);
    const beds = a.bedrooms == null ? '—' : (Number(a.bedrooms) === 0 ? 'Studio' : a.bedrooms);
    const sqft = a.sqft ? a.sqft.toLocaleString() : '—';
    const ppsf = (a.price && a.sqft) ? '$' + Math.round(a.price / a.sqft) : '—';
    const price = a.price ? fmtPrice(a.price) : '—';
    const posted = a.added_at ? fmtRelative(a.added_at) : '—';
    const seenText = seen.length ? ` · seen by ${seen.map(escapeHtml).join(', ')}` : '';

    return `
      <tr data-id="${escapeHtml(a.id)}">
        <td>
          <div class="list-address">
            <div class="list-address-title" title="${escapeHtml(a.address || '')}">${escapeHtml(a.address || 'Untitled')}</div>
            <div class="list-address-meta">
              ${a.neighborhood ? `<span class="nb">${escapeHtml(a.neighborhood)}</span>` : ''}
              ${a.notes ? `<span title="${escapeHtml(a.notes)}">${escapeHtml(truncate(a.notes, 60))}</span>` : ''}
            </div>
          </div>
        </td>
        <td class="num list-price">${price}</td>
        <td class="num">${beds}</td>
        <td class="num">${sqft}</td>
        <td class="num">${ppsf}</td>
        <td><span class="pill ${laundryClass(a.laundry)}">${escapeHtml(laundryLabel(a.laundry))}</span></td>
        <td>
          <span class="pill pill-${escapeHtml(a.status)}">${escapeHtml(statusLabel(a.status))}</span>
          ${seenText ? `<div class="seen-by" style="margin-top:3px">${seenText}</div>` : ''}
        </td>
        <td class="num muted">${escapeHtml(posted)}</td>
        <td>
          <div class="list-actions">
            ${a.url ? `<a class="btn btn-ghost" href="${escapeHtml(a.url)}" target="_blank" rel="noreferrer">Open</a>` : ''}
            ${state.readOnly ? '' : `
              <button class="btn btn-ghost" data-action="toggle-seen" data-id="${escapeHtml(a.id)}">${haveSeen ? 'Unseen' : 'Seen'}</button>
              <button class="btn btn-ghost" data-action="edit" data-id="${escapeHtml(a.id)}">Edit</button>
            `}
          </div>
        </td>
      </tr>
    `;
  }

  function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function fmtRelative(iso) {
    const t = new Date(iso).getTime();
    if (!t) return '';
    const diff = (Date.now() - t) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 7 * 86400) return Math.floor(diff / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function renderCard(a) {
    const me = state.settings.name;
    const seen = Array.isArray(a.seen_by) ? a.seen_by : [];
    const haveSeen = seen.includes(me);
    const bedLabel = a.bedrooms == null || a.bedrooms === ''
      ? null
      : (Number(a.bedrooms) === 0 ? 'Studio' : `${a.bedrooms} bd`);
    const metaParts = [
      bedLabel,
      a.bathrooms != null && a.bathrooms !== '' ? `${a.bathrooms} ba` : null,
      a.sqft ? `${a.sqft} sqft` : null,
      a.laundry ? `Laundry: ${laundryLabel(a.laundry)}` : null,
      a.available ? `Avail ${fmtDate(a.available)}` : null,
    ].filter(Boolean);

    return `
      <article class="card" data-id="${escapeHtml(a.id)}">
        <div class="card-banner s-${escapeHtml(a.status)}"></div>
        <div class="card-body">
          <div class="card-head">
            <div>
              ${a.neighborhood ? `<div class="card-neighborhood">${escapeHtml(a.neighborhood)}</div>` : ''}
              <h3 class="card-address">${escapeHtml(a.address || 'Untitled')}</h3>
            </div>
            ${a.price ? `<div class="card-price">${escapeHtml(fmtPrice(a.price))}</div>` : ''}
          </div>
          ${metaParts.length ? `<div class="card-meta">${metaParts.map(m => `<span>${escapeHtml(m)}</span>`).join('')}</div>` : ''}
          ${a.notes ? `<div class="card-notes">${escapeHtml(a.notes)}</div>` : ''}
        </div>
        <div class="card-foot">
          <span class="pill pill-${escapeHtml(a.status)}">${escapeHtml(statusLabel(a.status))}</span>
          <span class="seen-by">
            ${seen.length
              ? `Seen by <strong>${seen.map(escapeHtml).join(', ')}</strong>`
              : 'Not seen yet'}
          </span>
          <div class="card-actions">
            ${a.url ? `<a class="btn btn-ghost" href="${escapeHtml(a.url)}" target="_blank" rel="noreferrer">Open</a>` : ''}
            ${state.readOnly ? '' : `
              <button class="btn btn-ghost" data-action="toggle-seen" data-id="${escapeHtml(a.id)}">
                ${haveSeen ? 'Unmark seen' : 'Mark seen'}
              </button>
              <button class="btn btn-ghost" data-action="edit" data-id="${escapeHtml(a.id)}">Edit</button>
            `}
          </div>
        </div>
        ${a.added_by ? `<div class="added-by">Added by ${escapeHtml(a.added_by)} · ${escapeHtml(fmtDate(a.added_at))}</div>` : ''}
      </article>
    `;
  }

  // -------- Actions --------

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function openEdit(apt) {
    $('editTitle').textContent = apt ? 'Edit apartment' : 'Add apartment';
    $('fId').value = apt?.id || '';
    $('fUrl').value = apt?.url || '';
    $('fAddress').value = apt?.address || '';
    $('fNeighborhood').value = apt?.neighborhood || '';
    $('fPrice').value = apt?.price ?? '';
    $('fBeds').value = apt?.bedrooms ?? '';
    $('fBaths').value = apt?.bathrooms ?? '';
    $('fSqft').value = apt?.sqft ?? '';
    $('fAvailable').value = apt?.available || '';
    $('fStatus').value = apt?.status || 'to_see';
    $('fLaundry').value = apt?.laundry || '';
    $('fNotes').value = apt?.notes || '';
    $('editMsg').textContent = '';
    $('editMsg').className = 'msg';
    $('deleteBtn').classList.toggle('hidden', !apt);
    $('editModal').classList.remove('hidden');
    setTimeout(() => $('fAddress').focus(), 50);
  }

  function closeModal(id) {
    $(id).classList.add('hidden');
  }

  async function submitEdit(e) {
    e.preventDefault();
    const id = $('fId').value;
    const existing = state.apartments.find(a => a.id === id);

    const data = {
      id: id || uid(),
      url: $('fUrl').value.trim(),
      address: $('fAddress').value.trim(),
      neighborhood: $('fNeighborhood').value.trim(),
      price: numOrNull($('fPrice').value),
      bedrooms: numOrNull($('fBeds').value),
      bathrooms: numOrNull($('fBaths').value),
      sqft: numOrNull($('fSqft').value),
      available: $('fAvailable').value || '',
      status: $('fStatus').value,
      laundry: $('fLaundry').value || null,
      lat: existing?.lat ?? null,
      lon: existing?.lon ?? null,
      notes: $('fNotes').value,
      seen_by: existing?.seen_by || [],
      added_by: existing?.added_by || state.settings.name,
      added_at: existing?.added_at || new Date().toISOString(),
    };

    if (!data.address) {
      msg('editMsg', 'Address/nickname is required.', 'error');
      return;
    }

    // If we don't have coords yet (new apartment, or address was previously ungeocodable), try to geocode now.
    if (data.lat == null && data.address) {
      msg('editMsg', 'Locating address on map...', '');
      const geo = await geocodeAddress(data.address, data.neighborhood);
      if (geo) {
        data.lat = geo.lat;
        data.lon = geo.lon;
      }
    }

    const wasNew = !existing;
    if (existing) {
      Object.assign(existing, data);
    } else {
      state.apartments.push(data);
    }

    try {
      msg('editMsg', 'Saving...', '');
      await persist(wasNew
        ? `Add apartment: ${data.address}`
        : `Update apartment: ${data.address}`);
      closeModal('editModal');
      render();
      setSync('Synced', 'ok');
    } catch (err) {
      console.error(err);
      msg('editMsg', err.message || 'Save failed', 'error');
      // Revert in-memory on conflict
      if (wasNew) {
        state.apartments = state.apartments.filter(a => a.id !== data.id);
      }
    }
  }

  async function deleteApt(id) {
    const apt = state.apartments.find(a => a.id === id);
    if (!apt) return;
    if (!confirm(`Delete "${apt.address}"?`)) return;
    const backup = state.apartments.slice();
    state.apartments = state.apartments.filter(a => a.id !== id);
    try {
      await persist(`Delete apartment: ${apt.address}`);
      closeModal('editModal');
      render();
    } catch (err) {
      state.apartments = backup;
      msg('editMsg', err.message || 'Delete failed', 'error');
    }
  }

  async function toggleSeen(id) {
    const apt = state.apartments.find(a => a.id === id);
    if (!apt) return;
    const me = state.settings.name;
    if (!me) return;
    apt.seen_by = Array.isArray(apt.seen_by) ? apt.seen_by : [];
    const idx = apt.seen_by.indexOf(me);
    if (idx >= 0) apt.seen_by.splice(idx, 1);
    else apt.seen_by.push(me);
    render();
    try {
      await persist(`${idx >= 0 ? 'Unmark' : 'Mark'} seen: ${apt.address} (${me})`);
      setSync('Synced', 'ok');
    } catch (err) {
      // Revert
      if (idx >= 0) apt.seen_by.push(me);
      else apt.seen_by.splice(apt.seen_by.indexOf(me), 1);
      render();
      setSync(err.message || 'Sync error', 'error');
    }
  }

  function numOrNull(v) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  async function geocodeAddress(address, neighborhood) {
    try {
      const parts = [address];
      if (neighborhood) parts.push(neighborhood);
      parts.push('San Francisco, CA');
      const q = parts.join(', ');
      // SF bounding box: roughly lon -122.55 to -122.35, lat 37.70 to 37.83
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=us&viewbox=-122.55,37.83,-122.35,37.70&bounded=1`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) return null;
      const arr = await res.json();
      if (!arr.length) return null;
      const lat = Number(arr[0].lat), lon = Number(arr[0].lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { lat, lon };
    } catch {
      return null;
    }
  }

  function msg(id, text, kind) {
    const el = $(id);
    el.textContent = text;
    el.className = `msg ${kind || ''}`;
  }

  // -------- Settings UI --------

  function openSettings() {
    $('settingName').value = state.settings.name || '';
    $('settingRepo').value = state.settings.repo || '';
    $('settingBranch').value = state.settings.branch || 'main';
    $('settingToken').value = state.settings.token || '';
    msg('settingsMsg', '', '');
    $('settingsModal').classList.remove('hidden');
  }

  async function testConnection() {
    const repo = $('settingRepo').value.trim();
    const token = $('settingToken').value.trim();
    const branch = $('settingBranch').value.trim() || 'main';
    if (!repo || !token) {
      msg('settingsMsg', 'Need repo and token to test.', 'error');
      return;
    }
    msg('settingsMsg', 'Testing...', '');
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
        },
      });
      if (res.ok) msg('settingsMsg', `Connected to ${repo}@${branch}`, 'success');
      else msg('settingsMsg', `Failed: ${res.status} ${await res.text()}`, 'error');
    } catch (err) {
      msg('settingsMsg', err.message || 'Connection failed', 'error');
    }
  }

  function saveSettingsFromForm() {
    state.settings.name = $('settingName').value.trim();
    state.settings.repo = $('settingRepo').value.trim();
    state.settings.branch = $('settingBranch').value.trim() || 'main';
    state.settings.token = $('settingToken').value.trim();
    if (!hasSettings()) {
      msg('settingsMsg', 'Name, repo, and token are all required.', 'error');
      return;
    }
    saveSettings();
    msg('settingsMsg', 'Saved. Loading data...', 'success');
    closeModal('settingsModal');
    fetchData();
  }

  // -------- Wiring --------

  function wire() {
    $('addBtn').addEventListener('click', () => {
      if (!hasSettings()) { openSettings(); return; }
      openEdit(null);
    });
    $('addPlaceBtn').addEventListener('click', () => {
      if (!hasSettings()) { openSettings(); return; }
      openPlaceModal(null);
    });
    $('placeForm').addEventListener('submit', submitPlace);
    $('deletePlaceBtn').addEventListener('click', deletePlace);
    document.addEventListener('place-edit', (e) => openPlaceModal(e.detail));
    $('settingsBtn').addEventListener('click', openSettings);
    $('refreshBtn').addEventListener('click', fetchData);
    $('saveSettings').addEventListener('click', saveSettingsFromForm);
    $('testConnection').addEventListener('click', testConnection);
    $('editForm').addEventListener('submit', submitEdit);
    $('deleteBtn').addEventListener('click', () => deleteApt($('fId').value));

    document.querySelectorAll('[data-close]').forEach(b => {
      b.addEventListener('click', () => closeModal(b.dataset.close));
    });

    document.querySelectorAll('.modal').forEach(m => {
      m.addEventListener('click', (e) => {
        if (e.target === m) m.classList.add('hidden');
      });
    });

    ['search', 'filterNeighborhood', 'filterStatus', 'filterLaundry'].forEach(id => {
      $(id).addEventListener('input', render);
      $(id).addEventListener('change', render);
    });

    $('priceMin').addEventListener('input', (e) => {
      state.priceMin = e.target.value === '' ? null : Number(e.target.value);
      render();
    });
    $('priceMax').addEventListener('input', (e) => {
      state.priceMax = e.target.value === '' ? null : Number(e.target.value);
      render();
    });

    document.querySelectorAll('.chip[data-beds]').forEach(chip => {
      chip.addEventListener('click', () => {
        state.filterBeds = chip.dataset.beds;
        document.querySelectorAll('.chip[data-beds]').forEach(c => c.classList.toggle('active', c === chip));
        render();
      });
    });

    document.querySelectorAll('.view-btn').forEach(b => {
      b.addEventListener('click', () => {
        state.view = b.dataset.view;
        saveView();
        render();
      });
    });

    document.querySelectorAll('#listHeader th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (state.sortKey === k) {
          state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortKey = k;
          // Sensible default direction by column type
          state.sortDir = (k === 'address' || k === 'status') ? 'asc' : 'desc';
        }
        saveView();
        render();
      });
    });

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'edit') {
        const apt = state.apartments.find(a => a.id === id);
        if (apt) openEdit(apt);
      } else if (action === 'toggle-seen') {
        toggleSeen(id);
      }
    });

    document.addEventListener('apt-edit', (e) => {
      const apt = state.apartments.find(a => a.id === e.detail);
      if (apt) openEdit(apt);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
      }
    });
  }

  // -------- Init --------

  loadSettings();
  loadView();
  wire();
  if (hasSettings()) {
    fetchData();
  } else {
    fetchLocalData().then(loaded => { if (!loaded) render(); });
  }
})();
