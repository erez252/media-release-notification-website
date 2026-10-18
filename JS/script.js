/* ─────────────────────────────────────────────────────────────
   Watchlist Manager
   Vanilla JS — no frameworks
───────────────────────────────────────────────────────────── */

const API          = 'https://media-release-notification.vercel.app/api';
const POSTER_BASE  = 'https://image.tmdb.org/t/p/w342';
const IGDB_BASE    = 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/';

// Global session state — password is kept only in memory
let currentPassword = '';
let watchlistData   = [];  // raw data from the last /get-data call

// ─────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const overlay         = $('password-overlay');
const app             = $('app');
const passwordInput   = $('access-password');
const submitBtn       = $('submit-password');
const authError       = $('auth-error');

const searchInput     = $('search-input');
const searchBtn       = $('search-btn');
const searchSection   = $('search-results-section');
const closeSearchBtn  = $('close-search-btn');
const searchError     = $('search-error');
const moviesWrap      = $('movies-results-wrap');
const tvWrap          = $('tv-results-wrap');
const gamesWrap       = $('games-results-wrap');
const moviesResults   = $('movies-results');
const tvResults       = $('tv-results');
const gamesResults    = $('games-results');
const noSearchResults = $('no-search-results');

const watchlistGrid   = $('watchlist-grid');
const watchlistCount  = $('watchlist-count');
const watchlistError  = $('watchlist-error');
const watchlistLoading= $('watchlist-loading');
const watchlistEmpty  = $('watchlist-empty');
const filterEmpty     = $('filter-empty');

const logoutBtn       = $('logout-btn');
const refreshBtn      = $('refresh-btn');
const genreFilter     = $('genre-filter');
const sortSelect      = $('sort-select');

// Detail overlay
const detailOverlay   = $('detail-overlay');
const detailPanel     = $('detail-panel');
const detailLoading   = $('detail-loading');
const detailError     = $('detail-error');
const detailContent   = $('detail-content');
const detailCloseBtn  = $('detail-close-btn');

// Global media-type filter (multi-select). Empty set = every type.
const activeTypes = new Set(); // subset of { 'movie', 'tv', 'game' }
let lastSearchResults = null; // { movies: [], tvShows: [], games: [] } — cached from last API call

/** Does a media_type pass the current type filter? */
function matchesActiveTypes(mediaType) {
  return activeTypes.size === 0 || activeTypes.has(mediaType);
}

/** Current free-text query from the single search/filter input. */
function currentQuery() {
  return searchInput.value.trim().toLowerCase();
}

/** Sync the type-pill UI with activeTypes ("All" is active when nothing is picked). */
function syncTypePills() {
  document.querySelectorAll('.search-type-pills .pill').forEach(btn => {
    const t  = btn.dataset.type;
    const on = t === 'all' ? activeTypes.size === 0 : activeTypes.has(t);
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

/** Re-render the list views (watchlist, calendar, recommendations) with the current filters. */
function refreshListViews() {
  applyFiltersAndSort();
  if (calendarLoaded) renderCalendar();
  if (recsLoaded) renderRecommendations();
  if (discoverReady) renderDiscover();
}

/** Apply the type filter to every rendered view. */
function applyTypeFilterEverywhere() {
  syncTypePills();
  if (lastSearchResults) {
    renderSearchResults(lastSearchResults.movies, lastSearchResults.tvShows, lastSearchResults.games);
  }
  refreshListViews();
  onDiscoverTypesChanged();
}

document.querySelectorAll('.search-type-pills .pill').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.type;
    if (t === 'all') {
      activeTypes.clear();
    } else if (activeTypes.has(t)) {
      activeTypes.delete(t);
    } else {
      activeTypes.add(t);
    }
    applyTypeFilterEverywhere();
  });
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Show/hide the built-in loading spinner inside a button */
function setBtnLoading(btn, loading) {
  const text    = btn.querySelector('.btn-text');
  const spinner = btn.querySelector('.btn-spinner');
  btn.disabled  = loading;
  if (text)    text.classList.toggle('hidden', loading);
  if (spinner) spinner.classList.toggle('hidden', !loading);
}

/** Toggle a section's visibility */
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

/** Safely set an error message and make it visible */
function showError(el, msg) {
  el.textContent = msg;
  show(el);
}

function clearError(el) {
  el.textContent = '';
  hide(el);
}

/** Create a poster <img> or placeholder. Pass mediaType='game' for IGDB URL. */
function makePoster(posterPath, title, classes, mediaType) {
  if (posterPath) {
    const img = document.createElement('img');
    img.src   = mediaType === 'game'
      ? `${IGDB_BASE}${posterPath}.webp`
      : `${POSTER_BASE}${posterPath}`;
    img.alt   = title;
    img.className = classes.img;
    img.loading = 'lazy';
    img.onerror = () => {
      // replace with placeholder on load error
      const ph = makePosterPlaceholder(classes.placeholder);
      img.replaceWith(ph);
    };
    return img;
  }
  return makePosterPlaceholder(classes.placeholder);
}

function makePosterPlaceholder(className) {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = 'No image';
  return div;
}

/** Map a status string to a CSS class suffix for the status dot */
function statusClass(status) {
  if (!status) return '';
  const s = status.toLowerCase();
  if (s.includes('return') || s.includes('ongoing') || s.includes('airing')) return 'status-active';
  if (s.includes('ended')  || s.includes('canceled') || s.includes('cancelled')) return 'status-ended';
  if (s.includes('released')) return 'status-released';
  return '';
}

/** Generic API call with JSON body */
async function apiPost(endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  // Attempt to parse JSON even for error responses (they carry messages)
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

// ─────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────

// Password is cached in localStorage so the site auto-logs-in on return visits.
// (Personal project — intentionally persisted, unlike the original Kiro spec.)
const SAVED_PASSWORD_KEY = 'watchlist.savedPassword';

async function handleLogin() {
  clearError(authError);
  const pwd = passwordInput.value.trim();
  if (!pwd) {
    showError(authError, 'Please enter a password.');
    return;
  }

  setBtnLoading(submitBtn, true);

  const { ok, status, data } = await apiPost('/get-data', { password: pwd });

  setBtnLoading(submitBtn, false);

  if (status === 401 || !ok) {
    try { localStorage.removeItem(SAVED_PASSWORD_KEY); } catch (_) { /* storage unavailable */ }
    showError(authError, 'Incorrect password. Please try again.');
    return;
  }

  // Success — store password and boot the app
  currentPassword = pwd;
  watchlistData   = Array.isArray(data) ? data : [];
  try { localStorage.setItem(SAVED_PASSWORD_KEY, pwd); } catch (_) { /* storage unavailable */ }

  hide(overlay);
  show(app);
  populateGenreFilter();
  applyFiltersAndSort();
}

function handleLogout() {
  currentPassword = '';
  watchlistData   = [];
  passwordInput.value = '';
  try { localStorage.removeItem(SAVED_PASSWORD_KEY); } catch (_) { /* storage unavailable */ }
  clearError(authError);
  hide(app);
  show(overlay);
  clearSearchUI();
  watchlistGrid.innerHTML = '';
  // Reset filter/sort controls
  searchInput.value  = '';
  genreFilter.innerHTML = '<option value="all">All Genres</option>';
  sortSelect.value   = 'newest';
  // Reset media-type pills (global filter)
  activeTypes.clear();
  lastSearchResults = null;
  syncTypePills();
  // Reset calendar view
  calendarData   = [];
  calendarLoaded = false;
  calendarView   = defaultCalendarView();
  calMonthCursor = startOfMonth(new Date());
  calGridView.innerHTML = '';
  calListView.innerHTML = '';
  calTbaRow.innerHTML   = '';
  hide(calTbaWrap);
  hide(calendarEmpty);
  hide(calendarLoading);
  clearError(calendarError);
  syncCalViewPills();
  // Reset recommendations view
  recsData   = [];
  recsLoaded = false;
  recSort    = 'score';
  recommendationsGrid.innerHTML = '';
  hide(recommendationsGrid);
  hide(recommendationsEmpty);
  hide(recommendationsLoading);
  clearError(recommendationsError);
  recSortSelect.value = 'score';
  // Reset discover view
  DISC_TYPES.forEach(t => { discPaging[t] = { page: 1, exhausted: false }; });
  discItems     = [];
  discRendered  = 0;
  discCategory  = 'popular';
  discGenre     = 'all';
  discSort      = '';
  discEx        = { reality: true, talk: true, news: true };
  discoverReady = false;
  discoverBusy  = false;
  discoverGrid.innerHTML = '';
  discoverCount.textContent = '0';
  discYearInput.value = '';
  discExReality.checked = true;
  discExTalk.checked    = true;
  discExNews.checked    = true;
  hide(discoverGrid);
  hide(discoverEmpty);
  hide(discoverFooter);
  hide(discoverEnd);
  hide(discoverLoading);
  clearError(discoverError);
  switchView('watchlist');
}

// Allow Enter key on password field
passwordInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') handleLogin();
});
submitBtn.addEventListener('click', handleLogin);
logoutBtn.addEventListener('click', handleLogout);

// ─────────────────────────────────────────────────────────────
// Watchlist rendering
// ─────────────────────────────────────────────────────────────

function renderWatchlist(data) {
  watchlistGrid.innerHTML = '';
  clearError(watchlistError);
  hide(watchlistEmpty);
  hide(filterEmpty);

  if (!data || data.length === 0) {
    show(watchlistEmpty);
    watchlistCount.textContent = '0';
    return;
  }

  watchlistCount.textContent = data.length;

  data.forEach((item, index) => {
    const card = buildWatchCard(item);
    // Stagger animation
    card.style.animationDelay = `${index * 30}ms`;
    watchlistGrid.appendChild(card);
  });
}

function buildWatchCard(item) {
  const isMovie = item.media_type === 'movie';
  const genres  = (item.genres || []).slice(0, 3).map(g => g.name);

  const card = document.createElement('div');
  card.className  = 'watch-card';
  card.dataset.id = item.id;
  card.dataset.type = item.media_type;
  card.setAttribute('role', 'listitem');

  // Poster
  const posterWrap = document.createElement('div');
  posterWrap.className = 'watch-card-poster-wrap';

  const poster = makePoster(item.poster_path, item.title, {
    img:         'watch-card-poster',
    placeholder: 'watch-card-poster-placeholder',
  }, item.media_type);
  posterWrap.appendChild(poster);

  // Type badge
  const badge = document.createElement('span');
  const badgeCls  = item.media_type === 'movie' ? 'type-badge-movie'
                  : item.media_type === 'game'  ? 'type-badge-game'
                  : 'type-badge-tv';
  const badgeText = item.media_type === 'movie' ? 'Movie'
                  : item.media_type === 'game'  ? 'Game'
                  : 'TV';
  badge.className  = `type-badge ${badgeCls}`;
  badge.textContent = badgeText;
  posterWrap.appendChild(badge);

  // Right-side badge: Digital (movies only) / Upcoming
  const rightBadge = (() => {
    if (item.media_type === 'movie') {
      if (item.digital === true) return { label: 'Digital', cls: 'digital-badge' };
      if (item.release_date && new Date(item.release_date) > new Date()) return { label: 'Upcoming', cls: 'upcoming-badge' };
    } else if (item.media_type === 'game') {
      if (item.release_date && new Date(item.release_date) > new Date()) return { label: 'Upcoming', cls: 'upcoming-badge' };
    } else {
      // TV show
      const upcomingStatuses = ['planned', 'in production', 'pilot'];
      if (item.status && upcomingStatuses.includes(item.status.toLowerCase())) return { label: 'Upcoming', cls: 'upcoming-badge' };
    }
    return null;
  })();

  if (rightBadge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = rightBadge.cls;
    badgeEl.textContent = rightBadge.label;
    posterWrap.appendChild(badgeEl);
  }

  card.appendChild(posterWrap);

  // Body
  const body = document.createElement('div');
  body.className = 'watch-card-body';

  const title = document.createElement('div');
  title.className   = 'watch-card-title';
  title.textContent = item.title;
  body.appendChild(title);

  // Year + runtime on one line: "2026 · 2h 25m"
  const dateStr = (item.media_type === 'movie' || item.media_type === 'game')
    ? item.release_date
    : item.first_air_date;
  const yearStr = dateStr ? dateStr.slice(0, 4) : null;
  const hasRuntime = typeof item.runtime === 'number' && item.runtime > 0;
  if (yearStr || hasRuntime) {
    const meta = document.createElement('div');
    meta.className = 'watch-card-meta';
    const parts = [];
    if (yearStr) parts.push(yearStr);
    if (hasRuntime) {
      const h = Math.floor(item.runtime / 60);
      const m = item.runtime % 60;
      parts.push(h > 0 ? `${h}h ${m}m` : `${m}m`);
    }
    meta.textContent = parts.join(' · ');
    body.appendChild(meta);
  }

  if (item.status) {
    const statusWrap = document.createElement('div');
    statusWrap.className = `watch-card-status ${statusClass(item.status)}`;

    const dot = document.createElement('span');
    dot.className = 'watch-card-status-dot';
    dot.setAttribute('aria-hidden', 'true');

    statusWrap.appendChild(dot);
    statusWrap.appendChild(document.createTextNode(item.status));
    body.appendChild(statusWrap);
  }

  if (genres.length) {
    const genreWrap = document.createElement('div');
    genreWrap.className = 'watch-card-genres';
    genres.forEach(g => {
      const tag = document.createElement('span');
      tag.className   = 'genre-tag';
      tag.textContent = g;
      genreWrap.appendChild(tag);
    });
    body.appendChild(genreWrap);
  }

  card.appendChild(body);

  // Footer with notification toggle + trash remove
  const footer = document.createElement('div');
  footer.className = 'watch-card-footer';

  const errorEl = document.createElement('div');
  errorEl.className = 'remove-error-msg hidden';
  footer.appendChild(errorEl);

  const btnRow = document.createElement('div');
  btnRow.className = 'watch-card-btn-row';

  // Info button — movies, TV shows and games
  if (item.media_type === 'movie' || item.media_type === 'tv' || item.media_type === 'game') {
    const infoBtn = document.createElement('button');
    infoBtn.className = 'btn btn-info-icon';
    infoBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    infoBtn.setAttribute('aria-label', `More info about ${item.title}`);
    infoBtn.addEventListener('click', () => {
      if (item.media_type === 'movie') {
        openDetailOverlay(item.id, 'movie');
      } else if (item.media_type === 'game') {
        openDetailOverlay(item.id, 'game');
      } else {
        openDetailOverlay(item.id, 'tv', item.tvmaze_id);
      }
    });
    btnRow.appendChild(infoBtn);
  }

  // Notification toggle button
  const notifBtn = document.createElement('button');
  notifBtn.className = `btn btn-notif ${item.notifications ? 'btn-notif-on' : 'btn-notif-off'}`;
  notifBtn.setAttribute('aria-label', `${item.notifications ? 'Disable' : 'Enable'} notifications for ${item.title}`);
  notifBtn.innerHTML = item.notifications
    ? `<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9z" fill="currentColor"/><path d="M13.73 21a2 2 0 01-3.46 0" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0M3 3l18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  notifBtn.addEventListener('click', () => handleToggleNotification(item.id, item.media_type, notifBtn, errorEl));
  btnRow.appendChild(notifBtn);

  // Trash remove button
  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn btn-trash';
  removeBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  removeBtn.setAttribute('aria-label', `Remove ${item.title} from watchlist`);
  let removeConfirmTimer = null;
  removeBtn.addEventListener('click', () => {
    if (removeBtn.dataset.confirming === 'true') {
      // Second click — confirm removal
      clearTimeout(removeConfirmTimer);
      delete removeBtn.dataset.confirming;
      removeBtn.classList.remove('btn-trash--confirming');
      removeBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      handleRemove(item.id, item.media_type, card, removeBtn, errorEl);
    } else {
      // First click — enter confirming state
      removeBtn.dataset.confirming = 'true';
      removeBtn.classList.add('btn-trash--confirming');
      removeBtn.textContent = '✕ Sure?';
      // Auto-revert after 3 seconds
      removeConfirmTimer = setTimeout(() => {
        delete removeBtn.dataset.confirming;
        removeBtn.classList.remove('btn-trash--confirming');
        removeBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      }, 3000);
    }
  });
  btnRow.appendChild(removeBtn);

  footer.appendChild(btnRow);

  card.appendChild(footer);
  return card;
}

// ─────────────────────────────────────────────────────────────
// Remove item
// ─────────────────────────────────────────────────────────────

async function handleRemove(movieId, movieType, cardEl, btn, errorEl) {
  clearError(errorEl);
  setBtnLoading(btn, true);

  const { ok, status, data } = await apiPost('/remove', {
    password:  currentPassword,
    movieId:   String(movieId),
    movieType: movieType,
  });

  if (!ok) {
    setBtnLoading(btn, false);
    const msg =
      status === 401 ? 'Session expired. Please re-login.' :
      status === 422 ? (data?.message || 'Item does not exist.') :
      status === 400 ? 'Bad request — missing parameters.' :
      'Something went wrong. Please try again.';
    showError(errorEl, msg);
    return;
  }

  // Animate card out then remove from DOM
  cardEl.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
  cardEl.style.opacity    = '0';
  cardEl.style.transform  = 'scale(0.93)';
  setTimeout(() => {
    watchlistData = watchlistData.filter(
      i => !(String(i.id) === String(movieId) && i.media_type === movieType)
    );
    populateGenreFilter();
    applyFiltersAndSort();
  }, 250);
}

// ─────────────────────────────────────────────────────────────
// Toggle notifications
// ─────────────────────────────────────────────────────────────

function updateNotifBtn(btn, enabled) {
  btn.className = `btn btn-notif ${enabled ? 'btn-notif-on' : 'btn-notif-off'}`;
  btn.setAttribute('aria-label', enabled ? btn.getAttribute('aria-label').replace('Enable', 'Disable') : btn.getAttribute('aria-label').replace('Disable', 'Enable'));
  btn.innerHTML = enabled
    ? `<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9z" fill="currentColor"/><path d="M13.73 21a2 2 0 01-3.46 0" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0M3 3l18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

async function handleToggleNotification(movieId, movieType, btn, errorEl) {
  clearError(errorEl);

  // Read current state from button class, flip it
  const currentlyOn = btn.classList.contains('btn-notif-on');
  const newState    = !currentlyOn;

  btn.disabled = true;

  const { ok, status, data } = await apiPost('/toggle/notification', {
    password:             currentPassword,
    movieId:              String(movieId),
    movieType:            movieType,
    notifications_enabled: newState,
  });

  btn.disabled = false;

  if (!ok || data?.success === 'false') {
    showError(errorEl, 'Could not update notifications. Please try again.');
    return;
  }

  // Use notification_status from response as source of truth
  const confirmed = data?.notification_status === true;
  updateNotifBtn(btn, confirmed);

  // Update in-memory data
  const item = watchlistData.find(i => String(i.id) === String(movieId) && i.media_type === movieType);
  if (item) item.notifications = confirmed;
}

// ─────────────────────────────────────────────────────────────
// Client-side filtering, sorting, genre population
// ─────────────────────────────────────────────────────────────

/** Populate the genre dropdown from watchlistData, filtered by the active type selection */
function populateGenreFilter() {
  const current = genreFilter.value;

  // Only collect genres from items that pass the global type filter
  const genres = new Set();
  watchlistData.forEach(item => {
    if (!matchesActiveTypes(item.media_type)) return;
    (item.genres || []).forEach(g => genres.add(g.name));
  });

  // Rebuild options, keep "All Genres" first
  genreFilter.innerHTML = '<option value="all">All Genres</option>';
  [...genres].sort().forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    genreFilter.appendChild(opt);
  });

  // Restore previous selection if still valid, otherwise reset to 'all'
  if ([...genreFilter.options].some(o => o.value === current)) {
    genreFilter.value = current;
  } else {
    genreFilter.value = 'all';
  }
}

/** Apply all active filters + sort and re-render */
function applyFiltersAndSort() {
  const q     = currentQuery();
  const genre = genreFilter.value;      // 'all' | genre name string
  const sort  = sortSelect.value;       // 'newest' | 'oldest'

  // Helper: get a comparable release date string for an item ('' if missing)
  const getDate = item =>
    (item.media_type === 'movie' || item.media_type === 'game')
      ? (item.release_date ?? '')
      : (item.first_air_date ?? '');

  // Start from master data, apply sort
  let items = [...watchlistData];
  if (sort === 'newest') {
    items.sort((a, b) => {
      const da = a.added_date ?? '';
      const db = b.added_date ?? '';
      return db.localeCompare(da); // newest added_date first
    });
  } else if (sort === 'oldest') {
    items.sort((a, b) => {
      const da = a.added_date ?? '';
      const db = b.added_date ?? '';
      return da.localeCompare(db); // oldest added_date first
    });
  } else if (sort === 'release-desc') {
    items.sort((a, b) => {
      const da = getDate(a), db = getDate(b);
      if (!da && !db) return 0;
      if (!da) return 1;   // missing dates go to the bottom
      if (!db) return -1;
      return db.localeCompare(da);
    });
  } else if (sort === 'release-asc') {
    items.sort((a, b) => {
      const da = getDate(a), db = getDate(b);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da.localeCompare(db);
    });
  } else if (sort === 'popularity-desc') {
    items.sort((a, b) => {
      const popA = a.popularity ?? 0;
      const popB = b.popularity ?? 0;
      return popB - popA; // highest popularity first
    });
  } else if (sort === 'popularity-asc') {
    items.sort((a, b) => {
      const popA = a.popularity ?? 0;
      const popB = b.popularity ?? 0;
      return popA - popB; // lowest popularity first
    });
  } else if (sort === 'latest') {
    items.sort((a, b) => {
      const da = a.last_air_date ?? (a.digital ? (a.digital_release || a.release_date || '') : '');
      const db = b.last_air_date ?? (b.digital ? (b.digital_release || b.release_date || '') : '');
    
      if (!da) return 1;
      if (!db) return -1;
      return db.localeCompare(da);
    });
  } else if (sort === 'dynamic') {
    const todayStr = new Date().toISOString().split('T')[0];
    const todayTime = new Date(todayStr).getTime();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

    // Helper to find any release/air date falling within ±3 days of today
    const getActiveWindowDate = (item) => {
      const candidates = [
        item.next_air_date,
        item.last_air_date,
        item.digital ? (item.digital_release || item.release_date) : item.release_date
      ].filter(Boolean);

      for (const dStr of candidates) {
        const dTime = new Date(dStr).getTime();
        if (dTime >= todayTime - threeDaysMs && dTime <= todayTime + threeDaysMs) {
          return dStr;
        }
      }
      return null;
    };

    items.sort((a, b) => {
      const dateA = getActiveWindowDate(a);
      const dateB = getActiveWindowDate(b);

      const inWindowA = dateA !== null;
      const inWindowB = dateB !== null;

      // Priority 1: Items releasing/airing within ±3 days come first
      if (inWindowA && !inWindowB) return -1;
      if (!inWindowA && inWindowB) return 1;

      // Sub-sort: If both are in the ±3 day window, order them chronologically
      if (inWindowA && inWindowB) {
        return dateA.localeCompare(dateB);
      }

      // Priority 2: Standard fallback by newest added_date
      const addedA = a.added_date ?? '';
      const addedB = b.added_date ?? '';

      if (!addedA) return 1;
      if (!addedB) return -1;
      return addedB.localeCompare(addedA);
    });
  }

  // Apply filters
  items = items.filter(item => {
    if (!matchesActiveTypes(item.media_type)) return false;
    if (genre !== 'all' && !(item.genres || []).some(g => g.name === genre)) return false;
    if (q && !item.title.toLowerCase().includes(q)) return false;
    return true;
  });

  renderWatchlist(items);
}

// Wire up the remaining filter/sort controls (type is handled by the global pills)
genreFilter.addEventListener('change', applyFiltersAndSort);
sortSelect.addEventListener('change', applyFiltersAndSort);

// ─────────────────────────────────────────────────────────────
// TMDB Search
// ─────────────────────────────────────────────────────────────

async function handleSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  // Scroll to top so user sees results immediately
  window.scrollTo({ top: 0, behavior: 'smooth' });

  clearSearchUI();
  clearError(searchError);
  show(searchSection);
  setBtnLoading(searchBtn, true);

  const { ok, status, data } = await apiPost('/tmdb/search', {
    password:  currentPassword,
    movieName: query,
  });

  setBtnLoading(searchBtn, false);

  if (!ok) {
    const msg =
      status === 401 ? 'Session expired. Please re-login.' :
      status === 400 ? 'Please enter a valid search term.' :
      status === 502 ? 'Could not reach TMDB. Please try again.' :
      'Something went wrong. Please try again.';
    showError(searchError, msg);
    return;
  }

  const movies  = data?.movie_results ?? [];
  const tvShows = data?.tv_results    ?? [];
  const games   = data?.game_results  ?? [];

  if (!movies.length && !tvShows.length && !games.length) {
    lastSearchResults = null;
    show(noSearchResults);
    return;
  }

  lastSearchResults = { movies, tvShows, games };
  renderSearchResults(movies, tvShows, games);
}

/** Render search results respecting the active media-type pills. Called after fetch and on pill change. */
function renderSearchResults(movies, tvShows, games = []) {
  // Clear previous results but keep the panel visible
  hide(noSearchResults);
  hide(moviesWrap);
  hide(tvWrap);
  hide(gamesWrap);
  moviesResults.innerHTML = '';
  tvResults.innerHTML     = '';
  gamesResults.innerHTML  = '';

  const showMovies = matchesActiveTypes('movie');
  const showTV     = matchesActiveTypes('tv');
  const showGames  = matchesActiveTypes('game');

  if (movies.length && showMovies) {
    movies.forEach(m => moviesResults.appendChild(buildResultCard(m)));
    show(moviesWrap);
  }

  if (tvShows.length && showTV) {
    tvShows.forEach(t => tvResults.appendChild(buildResultCard(t)));
    show(tvWrap);
  }

  if (games.length && showGames) {
    games.forEach(g => gamesResults.appendChild(buildResultCard(g)));
    show(gamesWrap);
  }

  const nothingVisible =
    (!movies.length  || !showMovies) &&
    (!tvShows.length || !showTV)     &&
    (!games.length   || !showGames);
  if (nothingVisible) show(noSearchResults);
}

function clearSearchUI() {
  hide(searchSection);
  hide(noSearchResults);
  hide(moviesWrap);
  hide(tvWrap);
  hide(gamesWrap);
  moviesResults.innerHTML = '';
  tvResults.innerHTML     = '';
  gamesResults.innerHTML  = '';
  clearError(searchError);
}

function buildResultCard(item) {
  const isMovie = item.media_type === 'movie';
  const isGame  = item.media_type === 'game';
  // games and movies use `title`; TV shows use `name`
  const title   = (isMovie || isGame) ? item.title : item.name;
  // games and movies use `release_date`; TV shows use `first_air_date`
  const date    = (isMovie || isGame) ? item.release_date : item.first_air_date;
  const year    = date ? date.slice(0, 4) : '—';
  const rawVote = isGame ? item.vote_average / 10 : item.vote_average;
  const vote    = rawVote ? rawVote.toFixed(1) : null;

  const card = document.createElement('div');
  card.className = 'result-card';

  // Pass mediaType so IGDB URL is used for games
  const poster = makePoster(item.poster_path, title, {
    img:         'result-poster',
    placeholder: 'result-poster-placeholder',
  }, item.media_type);
  card.appendChild(poster);

  const info = document.createElement('div');
  info.className = 'result-info';

  const titleEl = document.createElement('div');
  titleEl.className   = 'result-title';
  titleEl.textContent = title;
  info.appendChild(titleEl);

  const meta = document.createElement('div');
  meta.className = 'result-meta';
  meta.textContent = year;
  if (vote) {
    const voteEl = document.createElement('span');
    voteEl.className   = 'result-vote';
    voteEl.textContent = `★ ${vote}`;
    meta.appendChild(voteEl);
  }
  info.appendChild(meta);

  const footer = document.createElement('div');
  footer.className = 'result-footer';

  // More info button for movies, TV and games
  if (item.media_type === 'movie' || item.media_type === 'tv' || item.media_type === 'game') {
    const infoBtn = document.createElement('button');
    infoBtn.className = 'btn btn-info-icon';
    infoBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    infoBtn.setAttribute('aria-label', `More info about ${title}`);
    infoBtn.addEventListener('click', () => openDetailOverlay(item.id, item.media_type));
    footer.appendChild(infoBtn);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-add';
  addBtn.innerHTML = `<span class="btn-text">+ Add</span><span class="btn-spinner spinner hidden" aria-hidden="true"></span>`;
  addBtn.setAttribute('aria-label', `Add ${title} to watchlist`);

  const feedbackEl = document.createElement('div');

  addBtn.addEventListener('click', () =>
    handleAdd(item.id, item.media_type, addBtn, feedbackEl)
  );

  footer.appendChild(addBtn);
  footer.appendChild(feedbackEl);
  info.appendChild(footer);
  card.appendChild(info);

  return card;
}

// ─────────────────────────────────────────────────────────────
// Add item
// ─────────────────────────────────────────────────────────────

async function handleAdd(mediaId, mediaType, btn, feedbackEl) {
  feedbackEl.textContent = '';
  feedbackEl.className   = '';
  setBtnLoading(btn, true);

  const { ok, status, data } = await apiPost('/add', {
    password:  currentPassword,
    mediaId:   String(mediaId),
    mediaType: mediaType,
  });

  setBtnLoading(btn, false);

  if (!ok) {
    const msg =
      status === 401 ? 'Session expired. Please re-login.' :
      status === 422 ? 'Already in your watchlist.' :
      status === 404 ? 'Title not found on TMDB.' :
      status === 400 ? 'Bad request — missing parameters.' :
      status === 500 ? 'Server error. Please try again.' :
      'Something went wrong. Please try again.';
    feedbackEl.className   = 'add-error-msg';
    feedbackEl.textContent = msg;
    return;
  }

  // Success: disable button and refresh watchlist
  btn.disabled = true;
  btn.querySelector('.btn-text').textContent = '✓ Added';
  feedbackEl.className   = 'add-success-msg';
  feedbackEl.textContent = 'Added to watchlist!';

  // Refresh watchlist in background
  refreshWatchlist();
}

// ─────────────────────────────────────────────────────────────
// Refresh watchlist (after add)
// ─────────────────────────────────────────────────────────────

async function refreshWatchlist() {
  show(watchlistLoading);

  const { ok, data } = await apiPost('/get-data', { password: currentPassword });

  hide(watchlistLoading);

  if (!ok) {
    // Don't block the user, just silently fail the refresh
    showError(watchlistError, 'Could not refresh watchlist. Please reload the page.');
    return;
  }

  watchlistData = Array.isArray(data) ? data : [];
  populateGenreFilter();
  applyFiltersAndSort();
}

// ─────────────────────────────────────────────────────────────
// Movie detail overlay
// ─────────────────────────────────────────────────────────────

const TMDB_LOGO_BASE    = 'https://image.tmdb.org/t/p/w92';
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280';
const TMDB_POSTER_DETAIL = 'https://image.tmdb.org/t/p/w342';

function openDetailOverlay(id, type = 'movie', tvmazeId = null) {
  // Reset state
  detailContent.innerHTML = '';
  hide(detailContent);
  hide(detailError);
  show(detailLoading);
  show(detailOverlay);
  document.body.style.overflow = 'hidden';
  detailPanel.scrollTop = 0;
  if (type === 'tv') {
    fetchTVDetail(id, tvmazeId);
  } else if (type === 'game') {
    fetchGameDetail(id);
  } else {
    fetchMovieDetail(id);
  }
}

function closeDetailOverlay() {
  hide(detailOverlay);
  document.body.style.overflow = '';
  // Remove any iframes to stop video playback
  detailContent.querySelectorAll('iframe').forEach(f => f.remove());
}

detailCloseBtn.addEventListener('click', closeDetailOverlay);
detailOverlay.addEventListener('click', e => {
  if (e.target === detailOverlay) closeDetailOverlay();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !detailOverlay.classList.contains('hidden')) closeDetailOverlay();
});

async function fetchMovieDetail(movieId) {
  const { ok, status, data } = await apiPost('/info/movie', {
    password: currentPassword,
    movieId:  String(movieId),
  });

  hide(detailLoading);

  if (!ok || data?.success === false) {
    showError(detailError, data?.message || 'Could not load movie details. Please try again.');
    return;
  }

  buildDetailContent(data);
  show(detailContent);
}

function fmt(n) {
  // Format large numbers with commas
  if (!n || n === 0) return null;
  return n.toLocaleString('en-US');
}

function buildDetailContent(d) {
  detailContent.innerHTML = '';

  // Intl helpers for language/country code → full name
  const langNames    = new Intl.DisplayNames(['en'], { type: 'language' });
  const regionNames  = new Intl.DisplayNames(['en'], { type: 'region' });
  const fullLang     = country => { try { return langNames.of(country); } catch { return country.toUpperCase(); } };
  const fullRegion   = code    => { try { return regionNames.of(code); } catch { return code; } };
  // Format a YYYY-MM-DD string into the user's local date format
  const fmtDate = str => {
    if (!str) return null;
    try {
      // Parse as local date (append T00:00:00 to avoid UTC shift)
      return new Date(`${str}T00:00:00`).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch { return str; }
  };

  // ── Hero media band (always rendered) ─────────────────────
  detailContent.appendChild(buildDetailHeroMedia(d));

  // ── Hero section (poster + headline info) ─────────────────
  const hero = document.createElement('div');
  hero.className = 'detail-hero';

  // Poster
  const posterWrap = document.createElement('div');
  posterWrap.className = 'detail-poster-wrap';
  if (d.poster_path) {
    const img = document.createElement('img');
    img.src = `${TMDB_POSTER_DETAIL}${d.poster_path}`;
    img.alt = d.title;
    img.className = 'detail-poster';
    img.loading = 'eager';
    posterWrap.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'detail-poster-placeholder';
    ph.textContent = 'No image';
    posterWrap.appendChild(ph);
  }
  hero.appendChild(posterWrap);

  // Headline info
  const headline = document.createElement('div');
  headline.className = 'detail-headline';

  const titleEl = document.createElement('h2');
  titleEl.className = 'detail-title';
  titleEl.textContent = d.title;
  headline.appendChild(titleEl);

  if (d.tagline) {
    const tagEl = document.createElement('p');
    tagEl.className = 'detail-tagline';
    tagEl.textContent = `"${d.tagline}"`;
    headline.appendChild(tagEl);
  }

  // Genres
  if (d.genres?.length) {
    const genreWrap = document.createElement('div');
    genreWrap.className = 'detail-genres';
    d.genres.forEach(g => {
      const tag = document.createElement('span');
      tag.className = 'genre-tag';
      tag.textContent = g.name;
      genreWrap.appendChild(tag);
    });
    headline.appendChild(genreWrap);
  }

  // Digital / expected on digital
  const digitalEl = document.createElement('div');
  digitalEl.className = 'detail-digital';
  if (d.digital) {
    digitalEl.innerHTML = `<span class="digital-indicator digital-yes">✓ Available digitally</span>`;
  } else if (d.expected_on_digital) {
    const raw   = d.expected_on_digital;
    let label;
    if (raw === 'Unknown(?)') {
      label = 'Unknown';
    } else {
      const parsedDate = new Date(`${raw}T00:00:00`);
      const dayEn = isNaN(parsedDate) ? '' : parsedDate.toLocaleDateString('en-US', { weekday: 'long' });
      const localDate = fmtDate(raw) ?? raw;
      label = dayEn ? `${localDate}, ${dayEn}` : localDate;
    }
    digitalEl.innerHTML = `<span class="digital-indicator digital-pending">⏳ Expected on digital: ${label}</span>`;
  }
  if (digitalEl.innerHTML) headline.appendChild(digitalEl);

  // External links — Official Site, IMDb, TMDB
  const linksRow = document.createElement('div');
  linksRow.className = 'detail-links';
  if (d.homepage) {
    const a = document.createElement('a');
    a.href = d.homepage; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.className = 'detail-ext-link'; a.textContent = 'Official Site';
    linksRow.appendChild(a);
  }
  if (d.imdb_id) {
    const a = document.createElement('a');
    a.href = `https://www.imdb.com/title/${d.imdb_id}`; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.className = 'detail-ext-link'; a.textContent = 'IMDb';
    linksRow.appendChild(a);
  }
  if (d.id) {
    const a = document.createElement('a');
    a.href = `https://www.themoviedb.org/movie/${d.id}`; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.className = 'detail-ext-link'; a.textContent = 'TMDB';
    linksRow.appendChild(a);
  }
  if (linksRow.children.length) headline.appendChild(linksRow);

  hero.appendChild(headline);
  detailContent.appendChild(hero);

  // ── Body ──────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'detail-body';

  // Facts strip — every headline fact grouped in one place
  const runtimeStr = d.runtime ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m` : null;
  const facts = buildQuickFacts([
    { label: 'Score',        value: d.vote_average ? `★ ${d.vote_average.toFixed(1)}` + (d.vote_count ? ` (${fmt(d.vote_count)} votes)` : '') : null, cls: 'detail-quickfact--score' },
    { label: 'Runtime',      value: runtimeStr },
    { label: 'Release Date', value: fmtDate(d.release_date) },
    { label: 'Status',       value: d.status },
    { label: 'Age Rating',   value: d.age_rating },
    { label: 'Studio',       value: d.production_companies?.[0]?.name },
    { label: 'Country',      value: d.origin_country?.length ? d.origin_country.map(fullRegion).join(', ') : null },
    { label: 'Language',     value: d.original_language ? fullLang(d.original_language) : null },
    { label: 'Budget',       value: d.budget  > 0 ? `$${fmt(d.budget)}`  : null },
    { label: 'Revenue',      value: d.revenue > 0 ? `$${fmt(d.revenue)}` : null },
  ]);
  if (facts) body.appendChild(facts);

  // Overview
  if (d.overview) {
    const sec = detailSection('Overview');
    const p = document.createElement('p');
    p.className = 'detail-overview';
    p.textContent = d.overview;
    sec.appendChild(p);
    body.appendChild(sec);
  }

  // Trailers / teasers — scrollable row
  const videosSec = buildVideosSection(d);
  if (videosSec) body.appendChild(videosSec);

  // Directors + Cast
  const castSec = buildCastDirectorsSection(d);
  if (castSec) body.appendChild(castSec);

  // Watch providers
  if (d.watch_providers && Object.keys(d.watch_providers).length) {
    const sec = detailSection('Where to Watch');
    const countries = Object.keys(d.watch_providers);
    const sorted = ['US', ...countries.filter(c => c !== 'US')];
    sorted.forEach(cc => {
      const pData = d.watch_providers[cc];
      if (!pData) return;
      const countryBlock = document.createElement('div');
      countryBlock.className = 'detail-provider-country';
      const countryLabel = document.createElement('div');
      countryLabel.className = 'detail-provider-label';
      countryLabel.textContent = fullRegion(cc);
      countryBlock.appendChild(countryLabel);

      ['flatrate', 'rent', 'buy'].forEach(type => {
        if (!pData[type]?.length) return;
        const typeLabel = document.createElement('span');
        typeLabel.className = 'detail-provider-type';
        typeLabel.textContent = type === 'flatrate' ? 'Stream' : type.charAt(0).toUpperCase() + type.slice(1);
        countryBlock.appendChild(typeLabel);

        const logoRow = document.createElement('div');
        logoRow.className = 'detail-provider-logos';
        const sortedProviders = [...pData[type]].sort((a,b) => (a.display_priority||0) - (b.display_priority||0));
        sortedProviders.forEach(p => {
          const a = document.createElement('a');
          a.href = pData.link || '#'; a.target = '_blank'; a.rel = 'noopener noreferrer';
          a.title = p.provider_name;
          if (p.logo_path) {
            const img = document.createElement('img');
            img.src = `${TMDB_LOGO_BASE}${p.logo_path}`;
            img.alt = p.provider_name;
            img.className = 'detail-provider-logo';
            img.loading = 'lazy';
            a.appendChild(img);
          } else {
            a.textContent = p.provider_name;
            a.className += ' detail-provider-text';
          }
          logoRow.appendChild(a);
        });
        countryBlock.appendChild(logoRow);
      });
      sec.appendChild(countryBlock);
    });
    body.appendChild(sec);
  }

  // Keywords
  if (d.keywords?.length) {
    const sec = detailSection('Keywords');
    const wrap = document.createElement('div');
    wrap.className = 'detail-keywords';
    d.keywords.forEach(k => {
      const tag = document.createElement('span');
      tag.className = 'detail-keyword-tag';
      tag.textContent = k.name;
      wrap.appendChild(tag);
    });
    sec.appendChild(wrap);
    body.appendChild(sec);
  }

  detailContent.appendChild(body);
}

/** Build a directors + cast section and return it. Used by both movie and TV detail. */
function buildCastDirectorsSection(d) {
  const hasDirectors = d.directors?.length > 0;
  const hasCast      = d.cast?.length > 0;
  if (!hasDirectors && !hasCast) return null;

  const sec = detailSection(hasDirectors ? 'Directors & Cast' : 'Cast');

  if (hasDirectors) {
    const dirLabel = document.createElement('div');
    dirLabel.className = 'detail-section-sub-label';
    dirLabel.textContent = 'Directed by';
    sec.appendChild(dirLabel);

    const dirRow = document.createElement('div');
    dirRow.className = 'detail-cast-row';
    d.directors.forEach(member => {
      const card = document.createElement('div');
      card.className = 'detail-cast-card';
      if (member.profile_path) {
        const img = document.createElement('img');
        img.src = `${TMDB_PROFILE_BASE}${member.profile_path}`;
        img.alt = member.name;
        img.className = 'detail-cast-photo';
        img.loading = 'lazy';
        img.onerror = () => {
          const ph = document.createElement('div');
          ph.className = 'detail-cast-photo-placeholder';
          ph.textContent = member.name.charAt(0);
          img.replaceWith(ph);
        };
        card.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'detail-cast-photo-placeholder';
        ph.textContent = member.name.charAt(0);
        card.appendChild(ph);
      }
      const name = document.createElement('div');
      name.className = 'detail-cast-name';
      name.textContent = member.name;
      card.appendChild(name);
      dirRow.appendChild(card);
    });
    sec.appendChild(dirRow);
  }

  if (hasCast) {
    if (hasDirectors) {
      const castLabel = document.createElement('div');
      castLabel.className = 'detail-section-sub-label';
      castLabel.textContent = 'Cast';
      sec.appendChild(castLabel);
    }
    const castRow = document.createElement('div');
    castRow.className = 'detail-cast-row';
    d.cast.forEach(member => {
      const card = document.createElement('div');
      card.className = 'detail-cast-card';
      if (member.profile_path) {
        const img = document.createElement('img');
        img.src = `${TMDB_PROFILE_BASE}${member.profile_path}`;
        img.alt = member.name;
        img.className = 'detail-cast-photo';
        img.loading = 'lazy';
        img.onerror = () => {
          const ph = document.createElement('div');
          ph.className = 'detail-cast-photo-placeholder';
          ph.textContent = member.name.charAt(0);
          img.replaceWith(ph);
        };
        card.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'detail-cast-photo-placeholder';
        ph.textContent = member.name.charAt(0);
        card.appendChild(ph);
      }
      const name = document.createElement('div');
      name.className = 'detail-cast-name';
      name.textContent = member.name;
      card.appendChild(name);
      if (member.character) {
        const char = document.createElement('div');
        char.className = 'detail-cast-char';
        char.textContent = member.character;
        card.appendChild(char);
      }
      castRow.appendChild(card);
    });
    sec.appendChild(castRow);
  }

  return sec;
}

/** Build a trailers/teasers scrollable row section */
function buildVideosSection(d) {
  const videos = d.trailers?.length ? d.trailers : (d.teasers?.length ? d.teasers : []);
  if (!videos.length) return null;

  const label = d.trailers?.length ? 'Trailers' : 'Teasers';
  const sec = detailSection(label);

  const row = document.createElement('div');
  row.className = 'detail-video-row';

  videos.forEach(v => {
    const card = document.createElement('div');
    card.className = 'detail-video-card';

    const iframeWrap = document.createElement('div');
    iframeWrap.className = 'detail-video-card-embed';
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube.com/embed/${v.key}?rel=0`;
    iframe.title = v.name;
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.loading = 'lazy';
    iframeWrap.appendChild(iframe);
    card.appendChild(iframeWrap);

    const meta = document.createElement('div');
    meta.className = 'detail-video-card-meta';

    const namEl = document.createElement('div');
    namEl.className = 'detail-video-card-name';
    namEl.textContent = v.name;
    meta.appendChild(namEl);

    const badges = document.createElement('div');
    badges.className = 'detail-video-card-badges';
    if (v.official) {
      const b = document.createElement('span');
      b.className = 'detail-video-badge detail-video-badge-official';
      b.textContent = 'Official';
      badges.appendChild(b);
    }
    if (v.iso_639_1 && v.iso_639_1 !== 'en') {
      const b = document.createElement('span');
      b.className = 'detail-video-badge';
      b.textContent = v.iso_639_1.toUpperCase();
      badges.appendChild(b);
    }
    if (badges.children.length) meta.appendChild(badges);

    card.appendChild(meta);
    row.appendChild(card);
  });

  sec.appendChild(row);
  return sec;
}

/** Helper: create a section with a heading */
function detailSection(title) {
  const sec = document.createElement('div');
  sec.className = 'detail-section';
  const h = document.createElement('h3');
  h.className = 'detail-section-title';
  h.textContent = title;
  sec.appendChild(h);
  return sec;
}

/**
 * Top media band of the detail panel. Always rendered so the poster/headline
 * keeps its overlap — falls back to the blurred poster, then to a gradient.
 */
function buildDetailHeroMedia(d) {
  const band = document.createElement('div');
  if (d.backdrop_path) {
    band.className = 'detail-hero-backdrop';
    band.style.backgroundImage = `url(${TMDB_BACKDROP_BASE}${d.backdrop_path})`;
  } else if (d.poster_path) {
    band.className = 'detail-hero-backdrop detail-hero-backdrop--poster';
    band.style.backgroundImage = `url(${TMDB_POSTER_DETAIL}${d.poster_path})`;
  } else {
    band.className = 'detail-hero-backdrop detail-hero-backdrop--none';
  }
  return band;
}

/**
 * Compact labeled grid of headline facts (score, runtime, dates, status…).
 * Used by both the movie and TV detail views. `facts` items: { label, value, cls }.
 */
function buildQuickFacts(facts) {
  const list = (facts || []).filter(f => f && f.value);
  if (!list.length) return null;

  const wrap = document.createElement('div');
  wrap.className = 'detail-quickfacts';

  list.forEach(f => {
    const item = document.createElement('div');
    item.className = 'detail-quickfact' + (f.cls ? ` ${f.cls}` : '');

    const label = document.createElement('span');
    label.className = 'detail-quickfact-label';
    label.textContent = f.label;

    const value = document.createElement('span');
    value.className = 'detail-quickfact-value';
    value.textContent = f.value;

    item.appendChild(label);
    item.appendChild(value);
    wrap.appendChild(item);
  });

  return wrap;
}

// ─────────────────────────────────────────────────────────────
// TV detail overlay
// ─────────────────────────────────────────────────────────────

const TMDB_PROFILE_BASE = 'https://image.tmdb.org/t/p/w185';

async function fetchTVDetail(showId, tvmazeId) {
  const { ok, data } = await apiPost('/info/tv', {
    password:  currentPassword,
    showId:    String(showId),
    tvmazeid:  tvmazeId ? String(tvmazeId) : undefined,
  });

  hide(detailLoading);

  if (!ok || data?.success === false) {
    showError(detailError, data?.message || 'Could not load TV details. Please try again.');
    return;
  }

  buildTVDetailContent(data);
  show(detailContent);
}

/** Strip HTML tags from TVMaze summary strings */
function stripHtml(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, '');
}

/** Determine the default season to show: currently airing or most recent */
function defaultSeason(episodes, status) {
  if (!episodes?.length) return 1;
  const seasons = [...new Set(episodes.map(e => e.season))].sort((a, b) => a - b);
  // If returning/airing, find the season with the most recent future or today episode
  const isActive = status && (status.toLowerCase().includes('return') || status.toLowerCase().includes('airing'));
  if (isActive) {
    const now = Date.now();
    // Find season whose latest episode is closest to now (could be past or upcoming)
    let bestSeason = seasons[seasons.length - 1];
    let bestDiff = Infinity;
    seasons.forEach(s => {
      const eps = episodes.filter(e => e.season === s);
      const latest = eps.reduce((best, e) => {
        const t = e.airstamp ? new Date(e.airstamp).getTime() : 0;
        return t > best ? t : best;
      }, 0);
      const diff = Math.abs(now - latest);
      if (diff < bestDiff) { bestDiff = diff; bestSeason = s; }
    });
    return bestSeason;
  }
  return seasons[seasons.length - 1];
}

function buildTVDetailContent(d) {
  detailContent.innerHTML = '';

  // Intl helpers
  const langNames   = new Intl.DisplayNames(['en'], { type: 'language' });
  const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
  const fullLang    = c => { try { return langNames.of(c); } catch { return c.toUpperCase(); } };
  const fullRegion  = c => { try { return regionNames.of(c); } catch { return c; } };
  const fmtDate     = str => {
    if (!str) return null;
    try { return new Date(`${str}T00:00:00`).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }); }
    catch { return str; }
  };
  const fmtStamp = str => {
    if (!str) return null;
    try { return new Date(str).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }); }
    catch { return str; }
  };

  // ── Hero media band (always rendered) ─────────────────────
  detailContent.appendChild(buildDetailHeroMedia(d));

  // ── Hero ──────────────────────────────────────────────────
  const hero = document.createElement('div');
  hero.className = 'detail-hero';

  const posterWrap = document.createElement('div');
  posterWrap.className = 'detail-poster-wrap';
  if (d.poster_path) {
    const img = document.createElement('img');
    img.src = `${TMDB_POSTER_DETAIL}${d.poster_path}`;
    img.alt = d.title;
    img.className = 'detail-poster';
    img.loading = 'eager';
    posterWrap.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'detail-poster-placeholder';
    ph.textContent = 'No image';
    posterWrap.appendChild(ph);
  }
  hero.appendChild(posterWrap);

  const headline = document.createElement('div');
  headline.className = 'detail-headline';

  const titleEl = document.createElement('h2');
  titleEl.className = 'detail-title';
  titleEl.textContent = d.title;
  headline.appendChild(titleEl);

  if (d.tagline) {
    const tagEl = document.createElement('p');
    tagEl.className = 'detail-tagline';
    tagEl.textContent = `"${d.tagline}"`;
    headline.appendChild(tagEl);
  }

  if (d.genres?.length) {
    const genreWrap = document.createElement('div');
    genreWrap.className = 'detail-genres';
    d.genres.forEach(g => {
      const tag = document.createElement('span');
      tag.className = 'genre-tag';
      tag.textContent = g.name;
      genreWrap.appendChild(tag);
    });
    headline.appendChild(genreWrap);
  }

  // External links
  const linksRow = document.createElement('div');
  linksRow.className = 'detail-links';
  if (d.homepage) {
    const a = document.createElement('a');
    a.href = d.homepage; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.className = 'detail-ext-link'; a.textContent = 'Official Site';
    linksRow.appendChild(a);
  }
  if (d.imdb_id) {
    const a = document.createElement('a');
    a.href = `https://www.imdb.com/title/${d.imdb_id}`; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.className = 'detail-ext-link'; a.textContent = 'IMDb';
    linksRow.appendChild(a);
  }
  if (d.id) {
    const a = document.createElement('a');
    a.href = `https://www.themoviedb.org/tv/${d.id}`; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.className = 'detail-ext-link'; a.textContent = 'TMDB';
    linksRow.appendChild(a);
  }
  if (d.tvdb_id) {
    const a = document.createElement('a');
    a.href = `https://www.thetvdb.com/?tab=series&id=${d.tvdb_id}`; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.className = 'detail-ext-link'; a.textContent = 'TVDB';
    linksRow.appendChild(a);
  }
  if (d.tvmaze_id) {
    const a = document.createElement('a');
    a.href = `https://www.tvmaze.com/shows/${d.tvmaze_id}`; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.className = 'detail-ext-link'; a.textContent = 'TVmaze';
    linksRow.appendChild(a);
  }
  if (linksRow.children.length) headline.appendChild(linksRow);

  hero.appendChild(headline);
  detailContent.appendChild(hero);

  // ── Body ──────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'detail-body';

  // Facts strip — every headline fact grouped in one place
  let rtVal = Array.isArray(d.runtime) ? null : (typeof d.runtime === 'number' && d.runtime > 0 ? d.runtime : null);
  if (!rtVal && d.episodes?.length) {
    const rts = d.episodes.map(e => e.runtime).filter(r => typeof r === 'number' && r > 0);
    if (rts.length) rtVal = Math.round(rts.reduce((a, b) => a + b, 0) / rts.length);
  }

  const nextEp = d.episodes?.find(e => e.airstamp && new Date(e.airstamp) > new Date());
  let nextText = null;
  if (nextEp) {
    const epCode = `S${String(nextEp.season).padStart(2,'0')}E${String(nextEp.number ?? '?').padStart(2,'0')}`;
    const epDate = new Date(nextEp.airstamp);
    const epDateStr = epDate.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const epTimeStr = epDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const epDay = epDate.toLocaleDateString('en-US', { weekday: 'long' }); // always English
    nextText = `▶ ${epCode} — ${nextEp.name}  ·  ${epDateStr}, ${epDay} at ${epTimeStr}`;
  } else if (d.next_air_date) {
    nextText = `▶ Next episode ${fmtDate(d.next_air_date)}`;
  }

  const facts = buildQuickFacts([
    { label: 'Score',        value: d.vote_average ? `★ ${d.vote_average.toFixed(1)}` + (d.vote_count ? ` (${(d.vote_count).toLocaleString('en-US')} votes)` : '') : null, cls: 'detail-quickfact--score' },
    { label: 'Status',       value: d.status },
    { label: 'Ep. Runtime',  value: rtVal ? `${rtVal}m / ep` : null },
    { label: 'Seasons',      value: d.number_of_seasons  > 0 ? String(d.number_of_seasons)  : null },
    { label: 'Episodes',     value: d.number_of_episodes > 0 ? String(d.number_of_episodes) : null },
    { label: 'First Aired',  value: fmtDate(d.release_date) },
    { label: 'Last Aired',   value: fmtDate(d.last_air_date) },
    { label: 'Next Episode', value: nextText, cls: 'detail-quickfact--next detail-quickfact--wide' },
    { label: 'Age Rating',   value: d.age_rating },
    { label: 'Studio',       value: d.production_companies?.[0]?.name },
    { label: 'Country',      value: d.origin_country?.length ? d.origin_country.map(fullRegion).join(', ') : null },
    { label: 'Language',     value: d.original_language ? fullLang(d.original_language) : null },
    { label: 'Budget',       value: d.budget  > 0 ? `$${(d.budget).toLocaleString('en-US')}`  : null },
    { label: 'Revenue',      value: d.revenue > 0 ? `$${(d.revenue).toLocaleString('en-US')}` : null },
  ]);
  if (facts) body.appendChild(facts);

  // Overview
  if (d.overview) {
    const sec = detailSection('Overview');
    const p = document.createElement('p');
    p.className = 'detail-overview';
    p.textContent = d.overview;
    sec.appendChild(p);
    body.appendChild(sec);
  }

  // Trailers / teasers — scrollable row
  const tvVideosSec = buildVideosSection(d);
  if (tvVideosSec) body.appendChild(tvVideosSec);

  // Directors + Cast
  const tvCastSec = buildCastDirectorsSection(d);
  if (tvCastSec) body.appendChild(tvCastSec);

  // Watch providers
  if (d.watch_providers && Object.keys(d.watch_providers).length) {
    const sec = detailSection('Where to Watch');
    const countries = Object.keys(d.watch_providers);
    const sorted = ['US', ...countries.filter(c => c !== 'US')];
    sorted.forEach(cc => {
      const pData = d.watch_providers[cc];
      if (!pData) return;
      const countryBlock = document.createElement('div');
      countryBlock.className = 'detail-provider-country';
      const countryLabel = document.createElement('div');
      countryLabel.className = 'detail-provider-label';
      countryLabel.textContent = fullRegion(cc);
      countryBlock.appendChild(countryLabel);
      ['flatrate', 'rent', 'buy'].forEach(type => {
        if (!pData[type]?.length) return;
        const typeLabel = document.createElement('span');
        typeLabel.className = 'detail-provider-type';
        typeLabel.textContent = type === 'flatrate' ? 'Stream' : type.charAt(0).toUpperCase() + type.slice(1);
        countryBlock.appendChild(typeLabel);
        const logoRow = document.createElement('div');
        logoRow.className = 'detail-provider-logos';
        [...pData[type]].sort((a,b) => (a.display_priority||0)-(b.display_priority||0)).forEach(p => {
          const a = document.createElement('a');
          a.href = pData.link || '#'; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = p.provider_name;
          if (p.logo_path) {
            const img = document.createElement('img');
            img.src = `${TMDB_LOGO_BASE}${p.logo_path}`; img.alt = p.provider_name;
            img.className = 'detail-provider-logo'; img.loading = 'lazy';
            a.appendChild(img);
          } else { a.textContent = p.provider_name; a.className += ' detail-provider-text'; }
          logoRow.appendChild(a);
        });
        countryBlock.appendChild(logoRow);
      });
      sec.appendChild(countryBlock);
    });
    body.appendChild(sec);
  }

  // Episodes — grouped by season, cached, season selector pills
  if (d.episodes?.length) {
    const sec = detailSection('Episodes');

    const seasons = [...new Set(d.episodes.map(e => e.season))].sort((a, b) => a - b);
    const activeSeason = defaultSeason(d.episodes, d.status);
    // Used as the thumbnail for episodes without their own image
    const epFallback = d.backdrop_path
      ? `${TMDB_BACKDROP_BASE}${d.backdrop_path}`
      : (d.poster_path ? `${TMDB_POSTER_DETAIL}${d.poster_path}` : null);

    // Season selector
    const seasonNav = document.createElement('div');
    seasonNav.className = 'detail-season-nav';
    const seasonLabel = document.createElement('span');
    seasonLabel.className = 'detail-season-label';
    seasonLabel.textContent = 'Season:';
    seasonNav.appendChild(seasonLabel);
    const pillGroup = document.createElement('div');
    pillGroup.className = 'detail-season-pills';
    seasons.forEach(s => {
      const btn = document.createElement('button');
      btn.className = `pill${s === activeSeason ? ' active' : ''}`;
      btn.textContent = s;
      btn.dataset.season = s;
      btn.addEventListener('click', () => {
        pillGroup.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
      });
      pillGroup.appendChild(btn);
    });
    seasonNav.appendChild(pillGroup);
    sec.appendChild(seasonNav);

    // Toggle button to expand/collapse episodes
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn-ghost detail-ep-toggle';
    toggleBtn.textContent = 'Show episodes ▾';
    let epRendered = false;
    let epExpanded = false;

    // Episode grid container — collapsed by default
    const episodeGrid = document.createElement('div');
    episodeGrid.className = 'detail-episode-grid detail-episode-grid--collapsed';

    toggleBtn.addEventListener('click', () => {
      epExpanded = !epExpanded;
      episodeGrid.classList.toggle('detail-episode-grid--collapsed', !epExpanded);
      toggleBtn.textContent = epExpanded ? 'Hide episodes ▴' : 'Show episodes ▾';
      // Render episodes lazily on first expand
      if (epExpanded && !epRendered) {
        renderEpisodes(episodeGrid, d.episodes, activeSeason, fmtStamp, epFallback);
        epRendered = true;
      }
      // Update season pill clicks to re-render into the now-visible grid
    });

    // Wire season pills to also use the grid (re-render when pill changes)
    pillGroup.querySelectorAll('.pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = Number(btn.dataset.season);
        renderEpisodes(episodeGrid, d.episodes, s, fmtStamp, epFallback);
        epRendered = true;
      });
    });

    sec.appendChild(toggleBtn);
    sec.appendChild(episodeGrid);

    body.appendChild(sec);
  }

  // Keywords
  if (d.keywords?.length) {
    const sec = detailSection('Keywords');
    const wrap = document.createElement('div');
    wrap.className = 'detail-keywords';
    d.keywords.forEach(k => {
      const tag = document.createElement('span');
      tag.className = 'detail-keyword-tag';
      tag.textContent = k.name;
      wrap.appendChild(tag);
    });
    sec.appendChild(wrap);
    body.appendChild(sec);
  }

  detailContent.appendChild(body);
}

/** Render episode cards for a given season into the container. Pure client-side — no API call. */
function renderEpisodes(container, allEpisodes, season, fmtStamp, fallbackImg) {
  container.innerHTML = '';
  const eps = allEpisodes.filter(e => e.season === season);
  eps.forEach(ep => {
    const card = document.createElement('div');
    card.className = 'detail-episode-card';

    // Thumbnail
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'detail-ep-thumb-wrap';
    if (ep.image?.medium) {
      const img = document.createElement('img');
      img.src = ep.image.medium;
      img.alt = ep.name;
      img.className = 'detail-ep-thumb';
      img.loading = 'lazy';
      img.onerror = () => { img.replaceWith(makeThumbnailPlaceholder(fallbackImg)); };
      thumbWrap.appendChild(img);
    } else {
      thumbWrap.appendChild(makeThumbnailPlaceholder(fallbackImg));
    }
    card.appendChild(thumbWrap);

    // Info
    const info = document.createElement('div');
    info.className = 'detail-ep-info';

    const epLabel = document.createElement('div');
    epLabel.className = 'detail-ep-label';
    epLabel.textContent = `S${String(ep.season).padStart(2,'0')}E${String(ep.number ?? '?').padStart(2,'0')}`;
    info.appendChild(epLabel);

    const epName = document.createElement('div');
    epName.className = 'detail-ep-name';
    epName.textContent = ep.name;
    info.appendChild(epName);

    const epMeta = document.createElement('div');
    epMeta.className = 'detail-ep-meta';
    const metaParts = [];
    if (ep.airstamp) metaParts.push(fmtStamp(ep.airstamp));
    if (ep.runtime)  metaParts.push(`${ep.runtime}m`);
    if (ep.rating?.average) metaParts.push(`★ ${ep.rating.average}`);
    epMeta.textContent = metaParts.join('  ·  ');
    info.appendChild(epMeta);

    if (ep.summary) {
      const epSummary = document.createElement('div');
      epSummary.className = 'detail-ep-summary';
      epSummary.textContent = stripHtml(ep.summary);
      info.appendChild(epSummary);
    }

    card.appendChild(info);
    container.appendChild(card);
  });
}

function makeThumbnailPlaceholder(fallbackImg) {
  const div = document.createElement('div');
  div.className = 'detail-ep-thumb-placeholder';
  if (fallbackImg) {
    div.classList.add('detail-ep-thumb-placeholder--fallback');
    div.style.backgroundImage = `url(${fallbackImg})`;
  }
  return div;
}

// ─────────────────────────────────────────────────────────────
// Game detail overlay (IGDB-backed)
// ─────────────────────────────────────────────────────────────

const IGDB_BACKDROP_BASE = 'https://images.igdb.com/igdb/image/upload/t_1080p/';
const IGDB_LOGO_BASE     = 'https://images.igdb.com/igdb/image/upload/t_logo_med/';

/** A relation-group cover entry (bundles, dlcs, expansions, ports, remakes, remasters). */
function gameCoverCard(entry, fmtDate) {
  const card = document.createElement('div');
  card.className = 'detail-rel-card';

  const coverWrap = document.createElement('div');
  coverWrap.className = 'detail-rel-cover-wrap';
  if (entry.cover) {
    const img = document.createElement('img');
    img.src = `${IGDB_BASE}${entry.cover}.webp`;
    img.alt = entry.name || '';
    img.className = 'detail-rel-cover';
    img.loading = 'lazy';
    img.onerror = () => img.replaceWith(makeGamePlaceholder('detail-rel-cover-placeholder'));
    coverWrap.appendChild(img);
  } else {
    coverWrap.appendChild(makeGamePlaceholder('detail-rel-cover-placeholder'));
  }
  card.appendChild(coverWrap);

  const name = document.createElement('div');
  name.className = 'detail-rel-name';
  name.textContent = entry.name || 'Untitled';
  card.appendChild(name);

  const date = fmtDate(entry.first_release_date);
  if (date) {
    const dateEl = document.createElement('div');
    dateEl.className = 'detail-rel-date';
    dateEl.textContent = date;
    card.appendChild(dateEl);
  }

  return card;
}

/** Generic empty-image placeholder for the game page. */
function makeGamePlaceholder(cls) {
  const div = document.createElement('div');
  div.className = cls;
  return div;
}

/** Horizontal scrollable row of game relation covers. */
function buildGameRelationSection(title, items, fmtDate) {
  if (!items?.length) return null;
  const sec = detailSection(title);
  const row = document.createElement('div');
  row.className = 'detail-rel-grid';
  items.forEach(it => row.appendChild(gameCoverCard(it, fmtDate)));
  sec.appendChild(row);
  return sec;
}

/** Chips built from an array of {name} objects or plain strings. */
function buildGameChips(items, chipClass = 'detail-keyword-tag') {
  const wrap = document.createElement('div');
  wrap.className = 'detail-keywords';
  items.forEach(raw => {
    const label = typeof raw === 'string' ? raw : raw?.name;
    if (!label) return;
    const tag = document.createElement('span');
    tag.className = chipClass;
    tag.textContent = label;
    wrap.appendChild(tag);
  });
  return wrap;
}

async function fetchGameDetail(gameId) {
  const { ok, data } = await apiPost('/info/game', {
    password: currentPassword,
    gameid:   String(gameId),
  });

  hide(detailLoading);

  if (!ok || data?.success === false) {
    showError(detailError, data?.message || 'Could not load game details. Please try again.');
    return;
  }

  buildGameDetailContent(data);
  show(detailContent);
}

function buildGameDetailContent(d) {
  detailContent.innerHTML = '';

  const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
  const fullRegion  = c => { try { return regionNames.of(c); } catch { return c; } };
  const fmtDate     = str => {
    if (!str) return null;
    try { return new Date(`${str}T00:00:00`).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }); }
    catch { return str; }
  };
  const fmtDuration = sec => {
    if (!sec || sec <= 0) return null;
    const totalMin = Math.round(sec / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h && m) return `${h}h ${m}m`;
    return h ? `${h}h` : `${m}m`;
  };

  // ── Hero media band (IGDB backdrop → blurred cover → gradient) ──
  const band = document.createElement('div');
  if (d.backdrop_path) {
    band.className = 'detail-hero-backdrop';
    band.style.backgroundImage = `url(${IGDB_BACKDROP_BASE}${d.backdrop_path}.webp)`;
  } else if (d.poster_path) {
    band.className = 'detail-hero-backdrop detail-hero-backdrop--poster';
    band.style.backgroundImage = `url(${IGDB_BASE}${d.poster_path}.webp)`;
  } else {
    band.className = 'detail-hero-backdrop detail-hero-backdrop--none';
  }
  detailContent.appendChild(band);

  // ── Hero: cover + headline ──
  const hero = document.createElement('div');
  hero.className = 'detail-hero';

  const posterWrap = document.createElement('div');
  posterWrap.className = 'detail-poster-wrap';
  if (d.poster_path) {
    const img = document.createElement('img');
    img.src = `${IGDB_BASE}${d.poster_path}.webp`;
    img.alt = d.title;
    img.className = 'detail-poster';
    img.loading = 'eager';
    posterWrap.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'detail-poster-placeholder';
    ph.textContent = 'No image';
    posterWrap.appendChild(ph);
  }
  hero.appendChild(posterWrap);

  const headline = document.createElement('div');
  headline.className = 'detail-headline';

  const titleEl = document.createElement('h2');
  titleEl.className = 'detail-title';
  titleEl.textContent = d.title;
  headline.appendChild(titleEl);

  if (d.tagline) {
    const tagEl = document.createElement('p');
    tagEl.className = 'detail-tagline';
    tagEl.textContent = `"${d.tagline}"`;
    headline.appendChild(tagEl);
  }

  if (d.genres?.length) {
    const genreWrap = document.createElement('div');
    genreWrap.className = 'detail-genres';
    d.genres.forEach(g => {
      const tag = document.createElement('span');
      tag.className = 'genre-tag';
      tag.textContent = g.name;
      genreWrap.appendChild(tag);
    });
    headline.appendChild(genreWrap);
  }

  // External links — Official Site, IGDB
  const linksRow = document.createElement('div');
  linksRow.className = 'detail-links';
  const addExtLink = (href, label) => {
    const a = document.createElement('a');
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.className = 'detail-ext-link'; a.textContent = label;
    linksRow.appendChild(a);
  };
  if (d.homepage)  addExtLink(d.homepage, 'Official Site');
  if (d.igdb_url)  addExtLink(d.igdb_url, 'IGDB');
  if (linksRow.children.length) headline.appendChild(linksRow);

  hero.appendChild(headline);
  detailContent.appendChild(hero);

  // ── Body ──
  const body = document.createElement('div');
  body.className = 'detail-body';

  // Facts strip
  const languages = Array.isArray(d.original_language) ? d.original_language : [];
  const facts = buildQuickFacts([
    { label: 'Score',        value: d.vote_average ? `★ ${d.vote_average.toFixed(1)}` + (d.vote_count ? ` (${fmt(d.vote_count)} votes)` : '') : null, cls: 'detail-quickfact--score' },
    { label: 'Release Date', value: fmtDate(d.release_date) },
    { label: 'Status',       value: d.status },
    { label: 'Game Type',    value: d.game_type },
    { label: 'Country',      value: d.origin_country?.length ? d.origin_country.map(fullRegion).join(', ') : null },
    { label: 'Languages',    value: languages.length ? languages.join(', ') : null, cls: 'detail-quickfact--wide' },
  ]);
  if (facts) body.appendChild(facts);

  // Time to Beat — durations (seconds) for each play style
  if (d.time_to_beat) {
    const ttb = buildQuickFacts([
      { label: 'Normally',   value: fmtDuration(d.time_to_beat.normally) },
      { label: 'Hastily',    value: fmtDuration(d.time_to_beat.hastily) },
      { label: 'Completely', value: fmtDuration(d.time_to_beat.completely) },
    ]);
    if (ttb) {
      const sec = detailSection('Time to Beat');
      sec.appendChild(ttb);
      body.appendChild(sec);
    }
  }

  // Franchise — linked entries
  if (d.franchise?.length) {
    const sec = detailSection('Franchise');
    const wrap = document.createElement('div');
    wrap.className = 'detail-linkrow';
    d.franchise.forEach(f => {
      if (!f.name) return;
      const a = document.createElement('a');
      a.className = 'detail-franchise-chip';
      a.href = f.url || '#'; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = f.name;
      wrap.appendChild(a);
    });
    sec.appendChild(wrap);
    body.appendChild(sec);
  }

  // Overview
  if (d.overview) {
    const sec = detailSection('Overview');
    const p = document.createElement('p');
    p.className = 'detail-overview';
    p.textContent = d.overview;
    sec.appendChild(p);
    body.appendChild(sec);
  }

  // Storyline
  if (d.storyline) {
    const sec = detailSection('Storyline');
    const p = document.createElement('p');
    p.className = 'detail-overview';
    p.textContent = d.storyline;
    sec.appendChild(p);
    body.appendChild(sec);
  }

  // Videos — scrollable row of all videos
  if (d.videos?.length) {
    const sec = detailSection('Videos');
    const row = document.createElement('div');
    row.className = 'detail-video-row';
    d.videos.forEach(v => {
      if (!v.video_id) return;
      const card = document.createElement('div');
      card.className = 'detail-video-card';

      const iframeWrap = document.createElement('div');
      iframeWrap.className = 'detail-video-card-embed';
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube.com/embed/${v.video_id}?rel=0`;
      iframe.title = v.name || 'Video';
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.loading = 'lazy';
      iframeWrap.appendChild(iframe);
      card.appendChild(iframeWrap);

      const meta = document.createElement('div');
      meta.className = 'detail-video-card-meta';
      const nameEl = document.createElement('div');
      nameEl.className = 'detail-video-card-name';
      nameEl.textContent = v.name || 'Video';
      meta.appendChild(nameEl);
      card.appendChild(meta);

      row.appendChild(card);
    });
    sec.appendChild(row);
    body.appendChild(sec);
  }

  // Involved companies — grouped by role
  if (d.involved_companies?.length) {
    const roles = [
      { key: 'developer',  label: 'Developer' },
      { key: 'publisher',  label: 'Publisher' },
      { key: 'porting',    label: 'Porting' },
      { key: 'supporting', label: 'Supporting' },
    ];
    const sec = detailSection('Companies');
    let any = false;

    roles.forEach(role => {
      const companies = d.involved_companies.filter(c => c[role.key]);
      if (!companies.length) return;
      any = true;

      const label = document.createElement('div');
      label.className = 'detail-section-sub-label';
      label.textContent = role.label;
      sec.appendChild(label);

      const row = document.createElement('div');
      row.className = 'detail-company-row';
      companies.forEach(c => {
        const co = c.company || {};
        const card = document.createElement('a');
        card.className = 'detail-company-card';
        if (co.url) { card.href = co.url; card.target = '_blank'; card.rel = 'noopener noreferrer'; }

        const logoWrap = document.createElement('div');
        logoWrap.className = 'detail-company-logo-wrap';
        if (co.logo_path) {
          const img = document.createElement('img');
          img.src = `${IGDB_LOGO_BASE}${co.logo_path}.webp`;
          img.alt = co.name || '';
          img.className = 'detail-company-logo';
          img.loading = 'lazy';
          img.onerror = () => img.remove();
          logoWrap.appendChild(img);
        }
        card.appendChild(logoWrap);

        const name = document.createElement('div');
        name.className = 'detail-company-name';
        name.textContent = co.name || 'Unknown';
        card.appendChild(name);

        if (co.country) {
          const country = document.createElement('div');
          country.className = 'detail-company-country';
          country.textContent = fullRegion(co.country);
          card.appendChild(country);
        }

        row.appendChild(card);
      });
      sec.appendChild(row);
    });

    if (any) body.appendChild(sec);
  }

  // Age ratings
  if (d.age_ratings?.length) {
    const sec = detailSection('Age Ratings');
    const wrap = document.createElement('div');
    wrap.className = 'detail-ageratings';
    d.age_ratings.forEach(ar => {
      if (!ar?.organization && !ar?.rating) return;
      const pill = document.createElement('span');
      pill.className = 'detail-agerating';
      const org = document.createElement('span');
      org.className = 'detail-agerating-org';
      org.textContent = ar.organization || '';
      const val = document.createElement('span');
      val.className = 'detail-agerating-val';
      val.textContent = ar.rating || '';
      pill.appendChild(org);
      pill.appendChild(val);
      wrap.appendChild(pill);
    });
    sec.appendChild(wrap);
    body.appendChild(sec);
  }

  // Game modes
  if (d.game_modes?.length) {
    const sec = detailSection('Game Modes');
    sec.appendChild(buildGameChips(d.game_modes));
    body.appendChild(sec);
  }

  // Player perspectives
  if (d.player_perspectives?.length) {
    const sec = detailSection('Player Perspectives');
    sec.appendChild(buildGameChips(d.player_perspectives));
    body.appendChild(sec);
  }

  // Platforms
  if (d.platforms?.length) {
    const sec = detailSection('Platforms');
    const wrap = document.createElement('div');
    wrap.className = 'detail-platform-row';
    d.platforms.forEach(p => {
      const chip = document.createElement('span');
      chip.className = 'detail-platform-chip';
      if (p.platform_logo) {
        const img = document.createElement('img');
        img.src = `${IGDB_LOGO_BASE}${p.platform_logo}.webp`;
        img.alt = p.abbreviation || '';
        img.className = 'detail-platform-logo';
        img.loading = 'lazy';
        img.onerror = () => img.remove();
        chip.appendChild(img);
      }
      const label = document.createElement('span');
      label.textContent = p.abbreviation || '';
      chip.appendChild(label);
      wrap.appendChild(chip);
    });
    sec.appendChild(wrap);
    body.appendChild(sec);
  }

  // Game engines
  if (d.game_engines?.length) {
    const sec = detailSection('Game Engines');
    const row = document.createElement('div');
    row.className = 'detail-engine-row';
    d.game_engines.forEach(e => {
      const card = document.createElement('div');
      card.className = 'detail-engine-card';
      if (e.image_path) {
        const img = document.createElement('img');
        img.src = `${IGDB_LOGO_BASE}${e.image_path}.webp`;
        img.alt = e.name || '';
        img.className = 'detail-engine-logo';
        img.loading = 'lazy';
        img.onerror = () => img.remove();
        card.appendChild(img);
      }
      const name = document.createElement('div');
      name.className = 'detail-engine-name';
      name.textContent = e.name || '';
      card.appendChild(name);
      row.appendChild(card);
    });
    sec.appendChild(row);
    body.appendChild(sec);
  }

  // Parent game
  if (d.parent_game?.name) {
    const sec = detailSection('Parent Game');
    const wrap = document.createElement('div');
    wrap.className = 'detail-parent-wrap';

    const row = document.createElement('div');
    row.className = 'detail-rel-grid';
    row.appendChild(gameCoverCard({
      cover: d.parent_game.cover?.image_id,
      name:  d.parent_game.name,
    }, fmtDate));
    wrap.appendChild(row);

    const actions = document.createElement('div');
    actions.className = 'detail-parent-actions';

    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-add';
    addBtn.innerHTML = `<span class="btn-text">+ Add</span><span class="btn-spinner spinner hidden" aria-hidden="true"></span>`;
    addBtn.setAttribute('aria-label', `Add ${d.parent_game.name} to watchlist`);

    const feedbackEl = document.createElement('div');
    addBtn.addEventListener('click', () => handleAdd(d.parent_game.id, 'game', addBtn, feedbackEl));

    actions.appendChild(addBtn);
    actions.appendChild(feedbackEl);
    wrap.appendChild(actions);

    sec.appendChild(wrap);
    body.appendChild(sec);
  }

  // Stores
  if (d.stores?.length) {
    const sec = detailSection('Stores');
    const wrap = document.createElement('div');
    wrap.className = 'detail-linkrow';
    d.stores.forEach(s => {
      if (!s.name) return;
      const a = document.createElement('a');
      a.className = 'detail-store-chip';
      a.href = s.url || '#'; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = s.name;
      wrap.appendChild(a);
    });
    sec.appendChild(wrap);
    body.appendChild(sec);
  }

  // Links (social / web)
  if (d.links?.length) {
    const sec = detailSection('Links');
    const wrap = document.createElement('div');
    wrap.className = 'detail-linkrow';
    d.links.forEach(l => {
      if (!l.name) return;
      const a = document.createElement('a');
      a.className = 'detail-link-chip';
      a.href = l.url || '#'; a.target = '_blank'; a.rel = 'noopener noreferrer';
      // IGDB labels Twitter as "Twitter" — display it as "X"
      a.textContent = l.name === 'Twitter' ? 'X' : l.name;
      wrap.appendChild(a);
    });
    sec.appendChild(wrap);
    body.appendChild(sec);
  }

  // Keywords
  if (d.keywords?.length) {
    const sec = detailSection('Keywords');
    sec.appendChild(buildGameChips(d.keywords));
    body.appendChild(sec);
  }

  // Related content — one horizontal cover row per non-empty group
  const relationGroups = [
    { key: 'bundles',    label: 'Bundles' },
    { key: 'dlcs',       label: 'DLCs' },
    { key: 'expansions', label: 'Expansions' },
    { key: 'ports',      label: 'Ports' },
    { key: 'remakes',    label: 'Remakes' },
    { key: 'remasters',  label: 'Remasters' },
  ];
  relationGroups.forEach(g => {
    const sec = buildGameRelationSection(g.label, d[g.key], fmtDate);
    if (sec) body.appendChild(sec);
  });

  detailContent.appendChild(body);
}

// ─────────────────────────────────────────────────────────────
// Search event wiring
// ─────────────────────────────────────────────────────────────

searchBtn.addEventListener('click', handleSearch);

// Typing filters the current list live; Enter (or the Search button) runs the add-search.
searchInput.addEventListener('input', refreshListViews);

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') handleSearch();
});

closeSearchBtn.addEventListener('click', () => {
  clearSearchUI();
  lastSearchResults = null;
  searchInput.value = '';
  refreshListViews();
});

// ─────────────────────────────────────────────────────────────
// Stremio sync
// ─────────────────────────────────────────────────────────────

const stremioBtn = $('stremio-sync-btn');

stremioBtn.addEventListener('click', async () => {
  setBtnLoading(stremioBtn, true);

  let res, data;
  try {
    res = await fetch(`${API}/sync/stremio`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${currentPassword}`,
        'Content-Type':  'application/json',
      },
    });
    data = await res.json();
  } catch (e) {
    setBtnLoading(stremioBtn, false);
    showError(watchlistError, 'Stremio sync failed. Please try again.');
    return;
  }

  setBtnLoading(stremioBtn, false);

  if (!res.ok || data?.success === false) {
    showError(watchlistError, data?.message || 'Stremio sync failed.');
    return;
  }

  // Refresh watchlist after sync
  refreshWatchlist();
});

// ─────────────────────────────────────────────────────────────
// Manual refresh button
// ─────────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', async () => {
  setBtnLoading(refreshBtn, true);
  // Show the spinning icon during fetch
  refreshBtn.querySelector('.refresh-icon')?.classList.add('spinning');

  const { ok, data } = await apiPost('/get-data', { password: currentPassword });

  setBtnLoading(refreshBtn, false);
  refreshBtn.querySelector('.refresh-icon')?.classList.remove('spinning');

  if (!ok) {
    showError(watchlistError, 'Could not refresh watchlist. Please try again.');
    return;
  }

  watchlistData = Array.isArray(data) ? data : [];
  populateGenreFilter();
  applyFiltersAndSort();
});

// ─────────────────────────────────────────────────────────────
// View switching (Watchlist ↔ Calendar)
// ─────────────────────────────────────────────────────────────

const viewToggleBtns   = document.querySelectorAll('.view-toggle [data-view]');
const watchlistSection = document.querySelector('.watchlist-section');

function switchView(view) {
  viewToggleBtns.forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const isCalendar = view === 'calendar';
  const isRecs     = view === 'recommendations';
  const isDisc     = view === 'discover';

  watchlistSection.classList.toggle('hidden', isCalendar || isRecs || isDisc);

  hide(searchSection);
  hide(calendarSection);
  hide(recommendationsSection);
  hide(discoverSection);

  if (isCalendar) {
    show(calendarSection);
    if (calendarLoaded) renderCalendar();
    else loadCalendar();
  } else if (isRecs) {
    show(recommendationsSection);
    if (recsLoaded) renderRecommendations();
    else loadRecommendations();
  } else if (isDisc) {
    show(discoverSection);
    syncDiscoverControls();
    if (!discoverReady) loadDiscover();
  }
}

viewToggleBtns.forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));

// ─────────────────────────────────────────────────────────────
// Calendar
// ─────────────────────────────────────────────────────────────

const calendarSection = $('calendar-section');
const calendarError   = $('calendar-error');
const calendarLoading = $('calendar-loading');
const calendarEmpty   = $('calendar-empty');
const calendarCount   = $('calendar-count');
const calRefreshBtn   = $('calendar-refresh-btn');
const calMonthNav     = $('cal-month-nav');
const calMonthLabel   = $('cal-month-label');
const calMonthView    = $('cal-month-view');
const calGridView     = $('cal-grid');
const calListView     = $('cal-list-view');
const calTbaWrap      = $('cal-tba-wrap');
const calTbaRow       = $('cal-tba-row');

let calendarData   = [];          // raw items from /calendar/get
let calendarLoaded = false;       // has the endpoint been fetched this session?

// Default calendar layout: List on small screens, Month on desktop
const CAL_LIST_MQ = window.matchMedia('(max-width: 768px)');
function defaultCalendarView() { return CAL_LIST_MQ.matches ? 'list' : 'month'; }

/** Reflect the current calendarView on the Month/List toggle buttons. */
function syncCalViewPills() {
  document.querySelectorAll('.cal-view-toggle [data-cal-view]').forEach(b => {
    b.classList.toggle('active', b.dataset.calView === calendarView);
  });
}

let calendarView   = defaultCalendarView();  // 'month' | 'list'
let calMonthCursor = startOfMonth(new Date());

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** 'YYYY-MM-DD' from an ISO airstamp — timezone-safe (uses the stamped calendar date). */
function stampKey(stamp) {
  return String(stamp || '').slice(0, 10);
}

/** Parse a 'YYYY-MM-DD' key into a local Date at midnight. */
function parseKeyDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function keyFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PRECISE_DATE_FORMATS = new Set(['YYYYMMDD', 'YYYYMMMMDD']);

/** Only games carry a `date_format`; a vague one (quarter / year / TBD) belongs in the TBA strip. */
function isPreciseItem(item) {
  if (item.media_type !== 'game') return true;
  if (!item.date_format) return true;
  return PRECISE_DATE_FORMATS.has(item.date_format);
}

/** Human label for a vague release date, e.g. "Q2 2027", "2028" or "TBA". */
function vagueDateLabel(item) {
  const key = stampKey(item.airstamp);
  const [y, m] = key.split('-').map(Number);
  const monthName = new Date(y || 2000, (m || 1) - 1, 1).toLocaleDateString('en-US', { month: 'long' });
  switch (item.date_format) {
    case 'YYYYMMMM': return `${monthName} ${y}`;
    case 'YYYY':     return `${y}`;
    case 'YYYYQ1':   return `Q1 ${y}`;
    case 'YYYYQ2':   return `Q2 ${y}`;
    case 'YYYYQ3':   return `Q3 ${y}`;
    case 'YYYYQ4':   return `Q4 ${y}`;
    default:         return 'TBA';
  }
}

/** Poster image (TMDB for movie/tv, IGDB for games) with a graceful placeholder. */
function calPoster(item, imgClass) {
  if (item.poster_path) {
    const img = document.createElement('img');
    img.src = item.media_type === 'game'
      ? `${IGDB_BASE}${item.poster_path}.webp`
      : `${POSTER_BASE}${item.poster_path}`;
    img.alt = item.title || '';
    img.className = imgClass;
    img.loading = 'lazy';
    img.onerror = () => img.replaceWith(calPosterPlaceholder(imgClass));
    return img;
  }
  return calPosterPlaceholder(imgClass);
}

function calPosterPlaceholder(imgClass) {
  const div = document.createElement('div');
  div.className = `${imgClass}-ph`;
  return div;
}

function episodeCode(item) {
  return `S${String(item.season ?? '?').padStart(2, '0')}E${String(item.number ?? '?').padStart(2, '0')}`;
}

/** Secondary line shown under a title in the list view. */
function calSubtitle(item) {
  if (item.media_type === 'tv')   return `${episodeCode(item)} · ${item.name || 'Episode'}`;
  if (item.media_type === 'game') return item.name && item.name !== item.title ? item.name : '';
  return '';
}

/** Rich hover tooltip for the compact month-grid chips. */
function calTooltip(item) {
  const parts = [item.title];
  if (item.media_type === 'tv') parts.push(`${episodeCode(item)} ${item.name || ''}`.trim());
  if (item.type) parts.push(item.type);
  if (item.runtime) parts.push(`${item.runtime}m`);
  if (item.media_type === 'game' && item.platforms?.length) parts.push(item.platforms.join(', '));
  return parts.filter(Boolean).join(' — ');
}

/** Reuse the existing detail overlay for movies / shows / games. */
function openCalendarItem(item) {
  if (item.media_type === 'movie')      openDetailOverlay(item.id, 'movie');
  else if (item.media_type === 'tv')    openDetailOverlay(item.id, 'tv', item.tvmaze_id);
  else if (item.media_type === 'game')  openDetailOverlay(item.id, 'game');
}

function relativeDayLabel(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((date - today) / 86400000);
  if (diff === 0)  return 'Today';
  if (diff === 1)  return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return diff > 1 ? `In ${diff} days` : `${-diff} days ago`;
}

function applyCalendarFilter(items) {
  const q = currentQuery();
  return items.filter(i => {
    if (!matchesActiveTypes(i.media_type)) return false;
    if (q && !String(i.title || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

async function loadCalendar() {
  clearError(calendarError);
  hide(calendarEmpty);
  hide(calMonthView);
  hide(calListView);
  hide(calTbaWrap);
  show(calendarLoading);
  setBtnLoading(calRefreshBtn, true);
  calRefreshBtn.querySelector('.refresh-icon')?.classList.add('spinning');

  let ok = false, status = 0, data = null;
  try {
    const res = await fetch(`${API}/calendar/get`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${currentPassword}`,
        'Content-Type':  'application/json',
      },
    });
    ok     = res.ok;
    status = res.status;
    try { data = await res.json(); } catch (_) { /* empty body */ }
  } catch (_) { ok = false; }

  hide(calendarLoading);
  setBtnLoading(calRefreshBtn, false);
  calRefreshBtn.querySelector('.refresh-icon')?.classList.remove('spinning');

  if (!ok) {
    showError(calendarError, status === 401
      ? 'Session expired. Please re-login.'
      : 'Could not load the calendar. Please try again.');
    return;
  }

  calendarData   = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
  calendarLoaded = true;
  calMonthCursor = startOfMonth(new Date());
  renderCalendar();
}

function renderCalendar() {
  const items   = applyCalendarFilter(calendarData);
  const precise = items.filter(isPreciseItem);
  const vague   = items.filter(i => !isPreciseItem(i));

  calendarCount.textContent = items.length;
  calMonthNav.classList.toggle('hidden', calendarView !== 'month');
  syncCalViewPills();

  if (calendarView === 'month') {
    hide(calListView);
    show(calMonthView);
    renderMonthView(precise);
  } else {
    hide(calMonthView);
    show(calListView);
    renderListView(precise);
  }

  renderTbaStrip(vague);
}

function renderMonthView(items) {
  const y = calMonthCursor.getFullYear();
  const m = calMonthCursor.getMonth();
  calMonthLabel.textContent = calMonthCursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const byDate = new Map();
  items.forEach(it => {
    const k = stampKey(it.airstamp);
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(it);
  });

  const typeOrder = { movie: 0, tv: 1, game: 2 };
  const todayKey  = keyFromDate(new Date());
  const gridStart = new Date(y, m, 1 - new Date(y, m, 1).getDay());

  calGridView.innerHTML = '';
  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const key      = keyFromDate(cellDate);
    const cell     = document.createElement('div');
    cell.className = 'cal-day'
      + (cellDate.getMonth() === m ? '' : ' cal-day--other')
      + (key === todayKey ? ' cal-day--today' : '');

    const num = document.createElement('div');
    num.className = 'cal-day-num';
    num.textContent = cellDate.getDate();
    cell.appendChild(num);

    const dayItems = byDate.get(key);
    if (dayItems && dayItems.length) {
      const wrap = document.createElement('div');
      wrap.className = 'cal-day-items';
      [...dayItems]
        .sort((a, b) => (typeOrder[a.media_type] ?? 3) - (typeOrder[b.media_type] ?? 3))
        .forEach(it => wrap.appendChild(buildCalendarChip(it)));
      cell.appendChild(wrap);
    }
    calGridView.appendChild(cell);
  }

  const monthPrefix = `${y}-${String(m + 1).padStart(2, '0')}`;
  if (items.some(it => stampKey(it.airstamp).startsWith(monthPrefix))) {
    hide(calendarEmpty);
  } else {
    calendarEmpty.textContent = 'No releases this month.';
    show(calendarEmpty);
  }
}

function buildCalendarChip(item) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `cal-chip cal-chip--${item.media_type}`;
  chip.title = calTooltip(item);

  chip.appendChild(calPoster(item, 'cal-chip-poster'));

  const title = document.createElement('span');
  title.className = 'cal-chip-title';
  title.textContent = item.media_type === 'tv' ? `${item.title} ${episodeCode(item)}` : item.title;
  chip.appendChild(title);

  chip.addEventListener('click', () => openCalendarItem(item));
  return chip;
}

function renderListView(items) {
  calListView.innerHTML = '';

  // The endpoint also returns historical releases — the list is an upcoming agenda, so skip past days.
  const todayKey = keyFromDate(new Date());

  const groups = new Map();
  [...items]
    .filter(it => stampKey(it.airstamp) >= todayKey)
    .sort((a, b) => stampKey(a.airstamp).localeCompare(stampKey(b.airstamp)))
    .forEach(it => {
      const k = stampKey(it.airstamp);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    });

  if (!groups.size) {
    calendarEmpty.textContent = 'No upcoming releases.';
    show(calendarEmpty);
    return;
  }
  hide(calendarEmpty);

  [...groups.keys()].sort().forEach(key => {
    const dateObj = parseKeyDate(key);

    const group = document.createElement('div');
    group.className = 'cal-list-group';

    const header = document.createElement('div');
    header.className = 'cal-list-date';
    header.appendChild(document.createTextNode(
      dateObj.toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
    ));
    const rel = document.createElement('span');
    rel.className = 'cal-rel';
    rel.textContent = relativeDayLabel(dateObj);
    header.appendChild(rel);
    group.appendChild(header);

    const list = document.createElement('div');
    list.className = 'cal-list-items';
    groups.get(key).forEach(it => list.appendChild(buildCalendarRow(it)));
    group.appendChild(list);
    calListView.appendChild(group);
  });
}

function buildCalendarRow(item) {
  const row = document.createElement('div');
  row.className = 'cal-list-item cal-list-item--clickable';

  row.appendChild(calPoster(item, 'cal-list-poster'));

  const info = document.createElement('div');
  info.className = 'cal-list-info';

  const title = document.createElement('div');
  title.className = 'cal-list-title';
  title.textContent = item.title;
  info.appendChild(title);

  const sub = calSubtitle(item);
  if (sub) {
    const subEl = document.createElement('div');
    subEl.className = 'cal-list-sub';
    subEl.textContent = sub;
    info.appendChild(subEl);
  }

  const meta = document.createElement('div');
  meta.className = 'cal-list-meta';

  const badge = document.createElement('span');
  badge.className = `cal-type-badge cal-type-badge--${item.media_type}`;
  badge.textContent = item.type || item.media_type;
  meta.appendChild(badge);

  if (item.runtime) meta.appendChild(document.createTextNode(`${item.runtime}m`));
  if (item.media_type === 'game' && item.platforms?.length) {
    meta.appendChild(document.createTextNode(item.platforms.join(' · ')));
  }
  info.appendChild(meta);
  row.appendChild(info);

  row.addEventListener('click', () => openCalendarItem(item));
  return row;
}

function renderTbaStrip(vagueItems) {
  if (!vagueItems.length) {
    calTbaRow.innerHTML = '';
    hide(calTbaWrap);
    return;
  }
  calTbaRow.innerHTML = '';
  [...vagueItems]
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''))
    .forEach(it => calTbaRow.appendChild(buildTbaCard(it)));
  show(calTbaWrap);
}

function buildTbaCard(item) {
  const card = document.createElement('div');
  card.className = `cal-tba-card cal-tba-card--${item.media_type} cal-tba-card--clickable`;

  card.appendChild(calPoster(item, 'cal-tba-poster'));

  const info = document.createElement('div');
  info.className = 'cal-tba-info';

  const name = document.createElement('div');
  name.className = 'cal-tba-name';
  name.textContent = item.name && item.name !== item.title ? `${item.title} — ${item.name}` : item.title;
  info.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'cal-list-meta';
  const badge = document.createElement('span');
  badge.className = `cal-type-badge cal-type-badge--${item.media_type}`;
  badge.textContent = item.type || 'Game';
  meta.appendChild(badge);
  if (item.platforms?.length) meta.appendChild(document.createTextNode(item.platforms.join(' · ')));
  info.appendChild(meta);
  card.appendChild(info);

  const dateBadge = document.createElement('span');
  dateBadge.className = 'cal-tba-date';
  dateBadge.textContent = vagueDateLabel(item);
  card.appendChild(dateBadge);

  card.addEventListener('click', () => openCalendarItem(item));
  return card;
}

// Calendar toolbar wiring
document.querySelectorAll('.cal-view-toggle [data-cal-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    calendarView = btn.dataset.calView;
    syncCalViewPills();
    renderCalendar();
  });
});

$('cal-prev').addEventListener('click', () => {
  calMonthCursor = new Date(calMonthCursor.getFullYear(), calMonthCursor.getMonth() - 1, 1);
  renderCalendar();
});

$('cal-next').addEventListener('click', () => {
  calMonthCursor = new Date(calMonthCursor.getFullYear(), calMonthCursor.getMonth() + 1, 1);
  renderCalendar();
});

$('cal-today').addEventListener('click', () => {
  calMonthCursor = startOfMonth(new Date());
  renderCalendar();
});

calRefreshBtn.addEventListener('click', loadCalendar);

// ─────────────────────────────────────────────────────────────
// Recommendations
// ─────────────────────────────────────────────────────────────

const recommendationsSection = $('recommendations-section');
const recommendationsError   = $('recommendations-error');
const recommendationsLoading = $('recommendations-loading');
const recommendationsEmpty   = $('recommendations-empty');
const recommendationsCount   = $('recommendations-count');
const recommendationsGrid    = $('recommendations-grid');
const recSortSelect          = $('rec-sort-select');

let recsData   = [];          // raw items from /recommendations/get
let recsLoaded = false;       // has the endpoint been fetched this session?
let recSort    = 'score';     // 'score' | 'rating' | 'popularity' | 'release-desc' | 'release-asc'

/** Game vote_average comes on a 0-100 scale (IGDB); movies/TV are 0-10 (TMDB). */
function recVote(item) {
  const raw = Number(item.vote_average);
  if (!raw) return null;
  return item.media_type === 'game' ? raw / 10 : raw;
}

function applyRecommendationsFilter(items) {
  const q = currentQuery();
  return items.filter(i => {
    if (!matchesActiveTypes(i.media_type)) return false;
    if (q && !String(i.title || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Default sort is the recommendation score; other options break ties on it. */
function sortRecommendations(items) {
  const score = i => Number(i.recommendation_score) || 0;
  const byScore = (a, b) => score(b) - score(a);

  switch (recSort) {
    case 'rating':
      return [...items].sort((a, b) => (recVote(b) || 0) - (recVote(a) || 0) || byScore(a, b));
    case 'popularity':
      return [...items].sort((a, b) => (Number(b.popularity) || 0) - (Number(a.popularity) || 0) || byScore(a, b));
    case 'release-desc':
      return [...items].sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')) || byScore(a, b));
    case 'release-asc':
      return [...items].sort((a, b) => String(a.release_date || '').localeCompare(String(b.release_date || '')) || byScore(a, b));
    default:
      return [...items].sort(byScore);
  }
}

async function loadRecommendations() {
  clearError(recommendationsError);
  hide(recommendationsEmpty);
  hide(recommendationsGrid);
  show(recommendationsLoading);

  let ok = false, status = 0, data = null;
  try {
    const res = await fetch(`${API}/recommendations/get`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${currentPassword}`,
        'Content-Type':  'application/json',
      },
    });
    ok     = res.ok;
    status = res.status;
    try { data = await res.json(); } catch (_) { /* empty body */ }
  } catch (_) { ok = false; }

  hide(recommendationsLoading);

  if (!ok) {
    showError(recommendationsError, status === 401
      ? 'Session expired. Please re-login.'
      : 'Could not load recommendations. Please try again.');
    return;
  }

  recsData   = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
  recsLoaded = true;
  renderRecommendations();
}

function renderRecommendations() {
  const items = sortRecommendations(applyRecommendationsFilter(recsData));
  recommendationsCount.textContent = items.length;
  recommendationsGrid.innerHTML = '';

  if (!items.length) {
    recommendationsEmpty.textContent = 'No recommendations match your filter.';
    show(recommendationsEmpty);
    return;
  }

  hide(recommendationsEmpty);
  items.forEach(it => recommendationsGrid.appendChild(buildRecommendationCard(it)));
  show(recommendationsGrid);
}

function buildRecommendationCard(item) {
  const isGame = item.media_type === 'game';
  const genres = (item.genres || []).slice(0, 3).map(g => (typeof g === 'string' ? g : g.name));
  const year   = item.release_date ? String(item.release_date).slice(0, 4) : null;
  const vote   = recVote(item);

  const card = document.createElement('div');
  card.className = 'rec-card';
  card.setAttribute('role', 'listitem');

  // Poster + type badge + recommendation score
  const posterWrap = document.createElement('div');
  posterWrap.className = 'rec-card-poster-wrap';

  posterWrap.appendChild(makePoster(item.poster_path, item.title, {
    img:         'rec-card-poster',
    placeholder: 'rec-card-poster-placeholder',
  }, item.media_type));

  const badge = document.createElement('span');
  const badgeCls = item.media_type === 'movie' ? 'type-badge-movie'
                 : isGame ? 'type-badge-game'
                 : 'type-badge-tv';
  badge.className  = `type-badge ${badgeCls}`;
  badge.textContent = item.media_type === 'movie' ? 'Movie' : isGame ? 'Game' : 'TV';
  posterWrap.appendChild(badge);

  if (item.recommendation_score != null) {
    const scoreBadge = document.createElement('span');
    scoreBadge.className   = 'rec-score-badge';
    scoreBadge.textContent = `\u2605 ${item.recommendation_score}`;
    scoreBadge.title       = `Recommendation score: ${item.recommendation_score}`;
    posterWrap.appendChild(scoreBadge);
  }

  card.appendChild(posterWrap);

  // Body
  const body = document.createElement('div');
  body.className = 'rec-card-body';

  const title = document.createElement('div');
  title.className   = 'rec-card-title';
  title.textContent = item.title;
  body.appendChild(title);

  const metaParts = [];
  if (year)        metaParts.push(year);
  if (vote != null) metaParts.push(`\u2605 ${vote.toFixed(1)}`);
  if (metaParts.length) {
    const meta = document.createElement('div');
    meta.className   = 'rec-card-meta';
    meta.textContent = metaParts.join(' \u00b7 ');
    body.appendChild(meta);
  }

  if (genres.length) {
    const genreWrap = document.createElement('div');
    genreWrap.className = 'rec-card-genres';
    genres.forEach(g => {
      const tag = document.createElement('span');
      tag.className   = 'genre-tag';
      tag.textContent = g;
      genreWrap.appendChild(tag);
    });
    body.appendChild(genreWrap);
  }

  // Footer actions — details (movie/tv/game) + add to watchlist
  const footer = document.createElement('div');
  footer.className = 'rec-card-footer';

  const btnRow = document.createElement('div');
  btnRow.className = 'rec-card-btn-row';

  const infoBtn = document.createElement('button');
  infoBtn.className = 'btn btn-info-icon';
  infoBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  infoBtn.setAttribute('aria-label', `More info about ${item.title}`);
  infoBtn.addEventListener('click', () => {
    if (item.media_type === 'movie')      openDetailOverlay(item.id, 'movie');
    else if (item.media_type === 'game')  openDetailOverlay(item.id, 'game');
    else                                  openDetailOverlay(item.id, 'tv');
  });
  btnRow.appendChild(infoBtn);

  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-add';
  addBtn.innerHTML = `<span class="btn-text">+ Add</span><span class="btn-spinner spinner hidden" aria-hidden="true"></span>`;
  addBtn.setAttribute('aria-label', `Add ${item.title} to watchlist`);

  const feedbackEl = document.createElement('div');
  addBtn.addEventListener('click', () => handleAdd(item.id, item.media_type, addBtn, feedbackEl));
  btnRow.appendChild(addBtn);

  footer.appendChild(btnRow);
  footer.appendChild(feedbackEl);
  body.appendChild(footer);
  card.appendChild(body);

  return card;
}

// Recommendations toolbar wiring
recSortSelect.addEventListener('change', () => {
  recSort = recSortSelect.value;
  renderRecommendations();
});

// ─────────────────────────────────────────────────────────────
// Discover — merged feed from /discaver/get/<media_type>
// ─────────────────────────────────────────────────────────────

const discoverSection  = $('discover-section');
const discoverError    = $('discover-error');
const discoverLoading  = $('discover-loading');
const discoverGrid     = $('discover-grid');
const discoverCount    = $('discover-count');
const discoverEmpty    = $('discover-empty');
const discoverFooter   = $('discover-footer');
const discoverEnd      = $('discover-end');
const discoverSentinel = $('discover-sentinel');
const discoverMoreBtn  = $('discover-more-btn');
const discCategories   = $('disc-categories');
const discGenreSel     = $('disc-genre');
const discYearInput    = $('disc-year');
const discSortSel      = $('disc-sort');
const discTvFilters    = $('disc-tv-filters');
const discExReality    = $('disc-ex-reality');
const discExTalk       = $('disc-ex-talk');
const discExNews       = $('disc-ex-news');

const DISC_TYPES = ['movie', 'tv', 'game'];

/** search_type values each media type accepts */
const DISC_CATEGORIES = {
  movie: ['popular', 'upcoming', 'anticipated', 'new'],
  tv:    ['popular', 'upcoming', 'anticipated', 'new', 'airing'],
  game:  ['popular', 'upcoming', 'anticipated', 'new'],
};

/** Genre IDs accepted by the endpoint, per media type (from the API doc) */
const DISC_GENRES = {
  movie: [
    [28, 'Action'], [12, 'Adventure'], [16, 'Animation'], [35, 'Comedy'], [80, 'Crime'],
    [99, 'Documentary'], [18, 'Drama'], [10751, 'Family'], [14, 'Fantasy'], [36, 'History'],
    [27, 'Horror'], [10402, 'Music'], [9648, 'Mystery'], [10749, 'Romance'],
    [878, 'Science Fiction'], [10770, 'TV Movie'], [53, 'Thriller'], [10752, 'War'], [37, 'Western'],
  ],
  tv: [
    [10759, 'Action & Adventure'], [16, 'Animation'], [35, 'Comedy'], [80, 'Crime'],
    [99, 'Documentary'], [18, 'Drama'], [10751, 'Family'], [10762, 'Kids'], [9648, 'Mystery'],
    [10763, 'News'], [10764, 'Reality'], [10765, 'Sci-Fi & Fantasy'], [10766, 'Soap'],
    [10767, 'Talk'], [10768, 'War & Politics'], [37, 'Western'],
  ],
  game: [
    [2, 'Point-and-click'], [4, 'Fighting'], [5, 'Shooter'], [7, 'Music'], [8, 'Platform'],
    [9, 'Puzzle'], [10, 'Racing'], [11, 'Real Time Strategy (RTS)'], [12, 'Role-playing (RPG)'],
    [13, 'Simulator'], [14, 'Sport'], [15, 'Strategy'], [16, 'Turn-based strategy (TBS)'],
    [24, 'Tactical'], [25, "Hack and slash/Beat 'em up"], [26, 'Quiz/Trivia'], [30, 'Pinball'],
    [31, 'Adventure'], [32, 'Indie'], [33, 'Arcade'], [34, 'Visual Novel'], [35, 'Card & Board Game'],
  ],
};

/** Sort values the endpoint accepts for movies / TV shows */
const DISC_SORTS = {
  movie: [
    ['popularity.desc', 'Popularity \u2193'], ['popularity.asc', 'Popularity \u2191'],
    ['vote_average.desc', 'Rating \u2193'],   ['vote_average.asc', 'Rating \u2191'],
    ['vote_count.desc', 'Votes \u2193'],      ['vote_count.asc', 'Votes \u2191'],
    ['primary_release_date.desc', 'Release Date \u2193'], ['primary_release_date.asc', 'Release Date \u2191'],
    ['title.asc', 'Title A\u2013Z'],          ['title.desc', 'Title Z\u2013A'],
    ['original_title.asc', 'Original Title A\u2013Z'], ['revenue.desc', 'Revenue \u2193'],
  ],
  tv: [
    ['popularity.desc', 'Popularity \u2193'], ['popularity.asc', 'Popularity \u2191'],
    ['vote_average.desc', 'Rating \u2193'],   ['vote_average.asc', 'Rating \u2191'],
    ['vote_count.desc', 'Votes \u2193'],      ['vote_count.asc', 'Votes \u2191'],
    ['first_air_date.desc', 'First Air Date \u2193'], ['first_air_date.asc', 'First Air Date \u2191'],
    ['name.asc', 'Name A\u2013Z'],            ['name.desc', 'Name Z\u2013A'],
    ['original_name.asc', 'Original Name A\u2013Z'],
  ],
};

// Discover state. Paging is tracked per media type because the endpoint is
// one-request-per-type and reports "has more" differently for games.
const discPaging = {
  movie: { page: 1, exhausted: false },
  tv:    { page: 1, exhausted: false },
  game:  { page: 1, exhausted: false },
};
let discItems     = [];      // accumulated items, each tagged with media_type
let discRendered  = 0;       // how many of the filtered items are already in the DOM
let discCategory  = 'popular';
let discGenre     = 'all';
let discSort      = '';
let discEx        = { reality: true, talk: true, news: true };
let discoverReady = false;   // has a page been loaded successfully?
let discoverBusy  = false;   // a page request is in flight

/** Media types currently picked in the global pills, in a stable order. */
function discActiveTypes() {
  return DISC_TYPES.filter(t => matchesActiveTypes(t));
}

/** search_type values supported by every currently active media type. */
function discAvailableCategories(types) {
  const base = DISC_CATEGORIES[types[0]] || [];
  return base.filter(c => types.every(t => DISC_CATEGORIES[t].includes(c)));
}

/** Rebuild the genre dropdown for one media type, keeping the current pick when valid. */
function buildDiscGenreOptions(mediaType) {
  const prev = discGenre;
  discGenreSel.innerHTML = '<option value="all">All Genres</option>';
  DISC_GENRES[mediaType].forEach(([id, name]) => {
    const opt = document.createElement('option');
    opt.value       = String(id);
    opt.textContent = name;
    discGenreSel.appendChild(opt);
  });
  discGenreSel.value = [...discGenreSel.options].some(o => o.value === prev) ? prev : 'all';
  return discGenreSel.value;
}

/** Rebuild the sort dropdown with the values shared by the active movie/TV types. */
function buildDiscSortOptions(types) {
  const prev  = discSort;
  const video = types.filter(t => t === 'movie' || t === 'tv');
  discSortSel.innerHTML = '<option value="">Default</option>';

  if (video.length) {
    const shared = DISC_SORTS[video[0]]
      .filter(([val]) => video.every(t => DISC_SORTS[t].some(([v]) => v === val)));
    shared.forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value       = val;
      opt.textContent = label;
      discSortSel.appendChild(opt);
    });
  }

  discSortSel.value = [...discSortSel.options].some(o => o.value === prev) ? prev : '';
  return discSortSel.value;
}

/**
 * Show/hide the discover controls for the current media-type selection and rebuild
 * the option lists. Returns true when a query filter had to be reset (caller refetches).
 */
function syncDiscoverControls() {
  const types    = discActiveTypes();
  const hasTV    = types.includes('tv');
  let changed = false;

  // Category chips — only the search_type values every active type supports
  const available = discAvailableCategories(types);
  if (!available.includes(discCategory)) {
    discCategory = available[0] || 'popular';
    changed = true;
  }
  discCategories.querySelectorAll('[data-disc-cat]').forEach(btn => {
    const cat = btn.dataset.discCat;
    btn.classList.toggle('hidden', !available.includes(cat));
    btn.classList.toggle('active', cat === discCategory);
  });

  // Genre — IDs are not comparable across media types, so only offer it for a single type
  const singleType = types.length === 1 ? types[0] : null;
  discGenreSel.classList.toggle('hidden', !singleType);
  if (singleType) {
    const resolved = buildDiscGenreOptions(singleType);
    if (resolved !== discGenre) { discGenre = resolved; changed = true; }
  } else if (discGenre !== 'all') {
    discGenre = 'all';
    discGenreSel.value = 'all';
    changed = true;
  }

  // Year + sort exist for movies and TV only, so they are offered only when the
  // selection is movies/TV alone — with games in the mix they would apply to part
  // of the feed and be silently ignored by the rest.
  const videoOnly = types.length > 0 && types.every(t => t === 'movie' || t === 'tv');
  discYearInput.classList.toggle('hidden', !videoOnly);
  discSortSel.classList.toggle('hidden', !videoOnly);
  if (videoOnly) {
    const resolved = buildDiscSortOptions(types);
    if (resolved !== discSort) { discSort = resolved; changed = true; }
  } else {
    if (discSort) { discSort = ''; discSortSel.value = ''; changed = true; }
    if (discYearInput.value) { discYearInput.value = ''; changed = true; }
  }

  // TV-only content filters
  discTvFilters.classList.toggle('hidden', !hasTV);

  return changed;
}

/** Fetch a single discover page for one media type. */
async function fetchDiscoverPage(mediaType, page) {
  const params = new URLSearchParams();
  params.set('search_type', discCategory);
  params.set('page', String(page));
  if (discGenre !== 'all' && discActiveTypes().length === 1) params.set('genre', discGenre);
  if (mediaType === 'movie' || mediaType === 'tv') {
    const year = discYearInput.value.trim();
    if (year) params.set('year', year);
    if (discSort) params.set('sort', discSort);
  }
  if (mediaType === 'tv') {
    params.set('exclude_reality', String(discEx.reality));
    params.set('exclude_talk',    String(discEx.talk));
    params.set('exclude_news',    String(discEx.news));
  }

  let ok = false, status = 0, data = null;
  try {
    const res = await fetch(`${API}/discaver/get/${mediaType}?${params.toString()}`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${currentPassword}`,
        'Content-Type':  'application/json',
      },
    });
    ok     = res.ok;
    status = res.status;
    try { data = await res.json(); } catch (_) { /* empty body */ }
  } catch (_) { ok = false; }

  return { ok, status, data };
}

/** Discover items that pass the global type pills + the live search box. */
function filteredDiscItems() {
  const q = currentQuery();
  return discItems.filter(i => {
    if (!matchesActiveTypes(i.media_type)) return false;
    if (q && !String(i.title || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Draw the end-of-feed state once nothing else can be fetched. */
function finishDiscover() {
  if (!discItems.length) {
    hide(discoverFooter);
    return;
  }
  const more = discActiveTypes().some(t => !discPaging[t].exhausted);
  show(discoverFooter);
  discoverMoreBtn.classList.toggle('hidden', !more);
  discoverEnd.classList.toggle('hidden', more);
}

/** Load one more page for every active media type and append the merged results. */
async function loadDiscoverMore() {
  if (discoverBusy) return;

  const types = discActiveTypes().filter(t => !discPaging[t].exhausted);
  if (!types.length) { finishDiscover(); return; }

  discoverBusy = true;
  hide(discoverEnd);
  show(discoverFooter);
  setBtnLoading(discoverMoreBtn, true);

  const batches = await Promise.all(types.map(async mediaType => {
    const page = discPaging[mediaType].page;
    const { ok, status, data } = await fetchDiscoverPage(mediaType, page);
    if (!ok) return { mediaType, status, items: [], failed: true };

    const results = Array.isArray(data?.results) ? data.results : [];
    // Tag every item — the endpoint does not tell us which type it came from
    const items = results.map(i => ({ ...i, media_type: mediaType }));

    // Games report has_more; movies and TV report total_pages
    discPaging[mediaType].exhausted = mediaType === 'game'
      ? (!data?.has_more || !results.length)
      : (results.length === 0 || page >= (Number(data?.total_pages) || 1));
    discPaging[mediaType].page = page + 1;

    return { mediaType, items };
  }));

  discoverBusy = false;
  setBtnLoading(discoverMoreBtn, false);
  hide(discoverLoading);

  const failed = batches.filter(b => b.failed);
  if (failed.length === batches.length) {
    showError(discoverError, failed[0].status === 401
      ? 'Session expired. Please re-login.'
      : 'Could not load discover. Please try again.');
    hide(discoverFooter);
    return;
  }

  discoverReady = true;

  // Order the new batch by popularity so multiple media types interleave
  const batch = batches.flatMap(b => b.items)
                       .sort((a, b) => (Number(b.popularity) || 0) - (Number(a.popularity) || 0));
  discItems.push(...batch);

  renderDiscover({ append: true });
  finishDiscover();
}

/** Reset the feed and load the first page. */
async function loadDiscover() {
  clearError(discoverError);
  DISC_TYPES.forEach(t => { discPaging[t] = { page: 1, exhausted: false }; });
  discItems     = [];
  discRendered  = 0;
  discoverReady = false;
  discoverGrid.innerHTML = '';
  hide(discoverGrid);
  hide(discoverEmpty);
  hide(discoverFooter);
  hide(discoverEnd);
  show(discoverLoading);
  await loadDiscoverMore();
}

/** Render (or extend) the discover grid from the accumulated items. */
function renderDiscover({ append = false } = {}) {
  const items = filteredDiscItems();
  discoverCount.textContent = items.length;

  if (!items.length) {
    discoverGrid.innerHTML = '';
    discRendered = 0;
    hide(discoverGrid);
    discoverEmpty.textContent = discItems.length
      ? 'No titles match your filter.'
      : 'Nothing to discover here.';
    show(discoverEmpty);
    return;
  }

  hide(discoverEmpty);

  // Only the tail needs drawing when appending to an unchanged filter
  if (!append || discRendered > items.length) {
    discoverGrid.innerHTML = '';
    discRendered = 0;
  }
  for (let i = discRendered; i < items.length; i++) {
    discoverGrid.appendChild(buildRecommendationCard(items[i]));
  }
  discRendered = items.length;
  show(discoverGrid);
}

/** Fetch a page for any newly picked media type that has no data yet. */
function ensureDiscoverTypes() {
  const needsFetch = discActiveTypes()
    .some(t => !discPaging[t].exhausted && !discItems.some(i => i.media_type === t));
  if (needsFetch) loadDiscoverMore();
}

/** React to a global media-type pill change while Discover is open. */
function onDiscoverTypesChanged() {
  if (!discoverReady) return;
  if (syncDiscoverControls()) { loadDiscover(); return; }
  ensureDiscoverTypes();
  renderDiscover();
}

// Discover controls — every change refetches from the first page
discCategories.querySelectorAll('[data-disc-cat]').forEach(btn => {
  btn.addEventListener('click', () => {
    discCategory = btn.dataset.discCat;
    syncDiscoverControls();
    loadDiscover();
  });
});

discGenreSel.addEventListener('change', () => {
  discGenre = discGenreSel.value;
  loadDiscover();
});

discSortSel.addEventListener('change', () => {
  discSort = discSortSel.value;
  loadDiscover();
});

let discYearTimer = null;
discYearInput.addEventListener('input', () => {
  clearTimeout(discYearTimer);
  discYearTimer = setTimeout(loadDiscover, 450);
});

[[discExReality, 'reality'], [discExTalk, 'talk'], [discExNews, 'news']].forEach(([el, key]) => {
  el.addEventListener('change', () => {
    discEx[key] = el.checked;
    loadDiscover();
  });
});

discoverMoreBtn.addEventListener('click', loadDiscoverMore);

// Endless scrolling — pull the next page while the sentinel is near the viewport
const discObserver = new IntersectionObserver(entries => {
  if (!entries.some(e => e.isIntersecting)) return;
  if (!discoverReady || discoverBusy) return;
  if (discoverSection.classList.contains('hidden')) return;
  loadDiscoverMore();
}, { rootMargin: '400px 0px' });
discObserver.observe(discoverSentinel);

// ─────────────────────────────────────────────────────────────
// Auto-login with the saved password (skip the overlay on return visits)
// ─────────────────────────────────────────────────────────────

(function autoLogin() {
  let saved = null;
  try { saved = localStorage.getItem(SAVED_PASSWORD_KEY); } catch (_) { /* storage unavailable */ }
  if (!saved) return;
  passwordInput.value = saved;
  handleLogin();
})();
