(() => {
  const DATA_PATH = 'data/apartments.json';
  const LS_KEY = 'apartment-search-settings';

  const state = {
    settings: { name: '', repo: '', branch: 'main', token: '' },
    apartments: [],
    sha: null,
    loading: false,
    readOnly: false,
  };

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
    const sort = $('sortBy').value;

    let list = state.apartments.slice();
    if (q) {
      list = list.filter(a => {
        const blob = [a.address, a.neighborhood, a.notes, a.url].filter(Boolean).join(' ').toLowerCase();
        return blob.includes(q);
      });
    }
    if (nb) list = list.filter(a => a.neighborhood === nb);
    if (st) list = list.filter(a => a.status === st);

    list.sort((a, b) => {
      if (sort === 'price_asc') return (a.price || 0) - (b.price || 0);
      if (sort === 'price_desc') return (b.price || 0) - (a.price || 0);
      if (sort === 'added_asc') return new Date(a.added_at) - new Date(b.added_at);
      return new Date(b.added_at) - new Date(a.added_at);
    });

    return list;
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
    const empty = $('empty');
    const setup = $('needsSetup');

    // Show setup prompt only when no settings AND no local preview loaded
    if (!hasSettings() && state.apartments.length === 0) {
      grid.innerHTML = '';
      empty.classList.add('hidden');
      setup.classList.remove('hidden');
      $('count').textContent = '';
      return;
    }
    setup.classList.add('hidden');
    $('readonlyBanner').classList.toggle('hidden', !state.readOnly);

    const list = getFiltered();
    $('count').textContent = list.length === state.apartments.length
      ? `${list.length} apartment${list.length === 1 ? '' : 's'}`
      : `${list.length} of ${state.apartments.length}`;

    if (state.apartments.length === 0) {
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    grid.innerHTML = list.map(renderCard).join('');
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
      notes: $('fNotes').value,
      seen_by: existing?.seen_by || [],
      added_by: existing?.added_by || state.settings.name,
      added_at: existing?.added_at || new Date().toISOString(),
    };

    if (!data.address) {
      msg('editMsg', 'Address/nickname is required.', 'error');
      return;
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

    ['search', 'filterNeighborhood', 'filterStatus', 'sortBy'].forEach(id => {
      $(id).addEventListener('input', render);
      $(id).addEventListener('change', render);
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

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
      }
    });
  }

  // -------- Init --------

  loadSettings();
  wire();
  if (hasSettings()) {
    fetchData();
  } else {
    fetchLocalData().then(loaded => { if (!loaded) render(); });
  }
})();
