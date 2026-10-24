// Toonhouse — the app's logic. You normally don't need to edit this file;
// shows and playlists are set in config.js.
(function () {
  'use strict';

  // ---------- Settings coming from config.js ----------
  const NAME = (typeof APP_NAME !== 'undefined' && APP_NAME) ? String(APP_NAME) : 'Toonhouse';
  const MAIN_ID = cleanPlaylistId(typeof MAIN_PLAYLIST_ID !== 'undefined' ? MAIN_PLAYLIST_ID : '');
  const SHOW_LIST = (typeof SHOWS !== 'undefined' && Array.isArray(SHOWS)) ? SHOWS : [];

  const SHOW_COLORS = ['#FFD23F', '#6EC6FF', '#FF9E7A', '#7BE0AD', '#FF8FB1', '#B8A1FF', '#FFB84D', '#8BE3E8'];
  const OTHER_KEY = '__other';
  const OTHER_NAME = 'More cartoons';
  const OTHER_COLOR = '#D9D2E9';
  const KEY_STORE = 'toon_api_key';
  const PROGRESS_STORE = 'toon_progress';
  const DEFAULT_HERO = 'Your cartoon playlist, one tap away. Pick a show and watch whatever you feel like.';

  const showDefs = SHOW_LIST
    .filter(s => s && s.name)
    .map((s, i) => {
      const playlistId = cleanPlaylistId(s.playlistId || '');
      let matchers = (Array.isArray(s.match) ? s.match : []).map(m => String(m).toLowerCase().trim()).filter(Boolean);
      if (!matchers.length && !playlistId) matchers = [String(s.name).toLowerCase()];
      return {
        key: 's' + i,
        name: String(s.name),
        color: s.color || SHOW_COLORS[i % SHOW_COLORS.length],
        playlistId,
        matchers
      };
    });

  // ---------- Elements ----------
  const $ = (id) => document.getElementById(id);
  const brandName = $('brandName');
  const searchInput = $('searchInput');
  const settingsBtn = $('settingsBtn');
  const heroSub = $('heroSub');
  const loadingMsg = $('loadingMsg');
  const contentRoot = $('contentRoot');
  const settingsModal = $('settingsModal');
  const apiKeyInput = $('apiKeyInput');
  const settingsCancel = $('settingsCancel');
  const settingsSave = $('settingsSave');
  const settingsError = $('settingsError');
  const playerOverlay = $('playerOverlay');
  const playerTitle = $('playerTitle');
  const closePlayerBtn = $('closePlayerBtn');
  const playerFrameWrap = $('playerFrameWrap');

  brandName.textContent = NAME;
  document.title = NAME;

  // ---------- State ----------
  let apiKey = '';
  let status = 'idle';          // idle | loading | ready | error
  let loadIssues = [];          // problems from the last load
  let groups = [];              // shows (and "More cartoons") that have episodes
  let matchedShows = 0;
  let allVideos = [];
  let showOf = {};              // videoId -> group
  let currentShow = '';
  let loadToken = 0;
  let progressById = {};
  let ytApiPromise = null;
  let ytPlayer = null;
  let progressTimer = null;
  let currentVideo = null;
  let playerToken = 0;

  // ---------- Small helpers ----------
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function thumbImg(v) {
    const img = document.createElement('img');
    if (v.thumb) img.src = v.thumb;
    img.alt = '';
    img.loading = 'lazy';
    return img;
  }
  function pressable(node, label, fn) {
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', label);
    node.addEventListener('click', fn);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    });
  }

  function cleanApiKey(raw) {
    return String(raw || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  }
  // Forgiving about what gets pasted: quotes, spaces, or a whole playlist link.
  function cleanPlaylistId(raw) {
    const s = String(raw || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    if (!s) return '';
    const fromLink = s.match(/[?&]list=([^&#\s]+)/);
    const id = fromLink ? fromLink[1] : s;
    const clean = id.match(/^[A-Za-z0-9_-]+/);
    return clean ? clean[0] : id;
  }

  function loadProgress() {
    try { progressById = JSON.parse(safeGet(PROGRESS_STORE) || '{}') || {}; } catch (e) { progressById = {}; }
  }
  function saveProgress() { safeSet(PROGRESS_STORE, JSON.stringify(progressById)); }
  function inProgress(p) { return !!p && p.fraction > 0.03 && p.fraction < 0.95; }

  const configured = !!(MAIN_ID || showDefs.some(s => s.playlistId));

  // ---------- Plain-English API errors ----------
  function describeApiError(statusCode, reasons, detail, key, playlistId) {
    const raw = `YouTube API error (${statusCode}): ${detail || reasons[0] || 'request failed'}`;
    const has = (...names) => names.some(n => reasons.includes(n));
    const idNote = ` Playlist ID used: "${playlistId}".`;
    let fix = '';
    if (/^AIza/.test(playlistId)) {
      fix = 'The playlist ID looks like an API key (keys start with "AIza"). Playlist IDs usually start with "PL" — it is the part after list= in the playlist link.';
    } else if (/^PL/.test(key)) {
      fix = 'The API key you entered looks like a playlist ID. API keys start with "AIza" — copy it from Google Cloud Console → Credentials.';
    } else if (has('API_KEY_INVALID', 'keyInvalid') || /api key (not valid|expired)/i.test(detail)) {
      fix = 'YouTube does not accept this API key. Copy the whole key again from Google Cloud Console → Credentials (no spaces, nothing cut off), or create a new one.';
    } else if (has('accessNotConfigured', 'SERVICE_DISABLED')) {
      fix = 'The YouTube Data API v3 is not switched on for the Google Cloud project this key belongs to. Open that project, search for "YouTube Data API v3" and click Enable.';
    } else if (has('API_KEY_HTTP_REFERRER_BLOCKED', 'ipRefererBlocked')) {
      fix = 'This key is restricted to certain websites. In Google Cloud Console → Credentials, add the address you open this app from, or remove the website restriction.';
    } else if (has('quotaExceeded', 'rateLimitExceeded', 'dailyLimitExceeded')) {
      fix = 'The free daily limit for this key is used up. It resets once a day.';
    } else if (has('playlistNotFound') || statusCode === 404) {
      fix = 'YouTube cannot find that playlist. Check the ID, and make sure the playlist is set to Public or Unlisted (private playlists cannot be loaded).' + idNote;
    } else if (has('playlistItemsNotAccessible', 'playlistForbidden', 'forbidden')) {
      fix = 'That playlist is private. Set it to Public or Unlisted in YouTube.' + idNote;
    } else if (/invalid value/i.test(detail) || has('invalid', 'invalidValue')) {
      fix = 'YouTube accepted the API key but says one of the values sent is invalid — that is the playlist ID. Playlist IDs use only letters, numbers, - and _ (usually starting with "PL"), with no spaces, quotes or other text around them.' + idNote;
    } else if (statusCode === 400) {
      fix = 'YouTube rejected the request. This is almost always the API key or playlist ID pasted wrongly — check both for missing characters or extra text.' + idNote;
    }
    return fix ? `${raw.replace(/[.\s]+$/, '')}. ${fix}` : raw;
  }

  // ---------- Loading playlists ----------
  // Resolves to a list of watchable videos, or throws an Error whose message is safe to show.
  async function fetchPlaylist(key, playlistId) {
    key = cleanApiKey(key);
    playlistId = cleanPlaylistId(playlistId);
    let items = [];
    let pageToken = '';
    do {
      const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(key)}${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      let res;
      try {
        res = await fetch(url, { signal: controller.signal });
      } catch (err) {
        if (err.name === 'AbortError') {
          throw new Error('Request timed out after 15s — your network may be blocking access to googleapis.com (common on some mobile carriers, VPNs, or restrictive Wi-Fi).');
        }
        throw new Error(`Network error: ${err.message || 'the request failed before reaching YouTube.'}`);
      } finally {
        clearTimeout(timeoutId);
      }
      if (!res.ok) {
        let detail = '';
        const reasons = [];
        try {
          const j = await res.json();
          const e = j.error || {};
          detail = e.message || '';
          (e.errors || []).forEach(x => { if (x && x.reason) reasons.push(x.reason); });
          (e.details || []).forEach(x => { if (x && x.reason) reasons.push(x.reason); });
        } catch (parseErr) {}
        throw new Error(describeApiError(res.status, reasons, detail, key, playlistId));
      }
      const data = await res.json();
      items = items.concat(data.items || []);
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    return items
      .filter(it => it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId &&
        it.snippet.title !== 'Deleted video' && it.snippet.title !== 'Private video')
      .map(it => ({
        id: it.snippet.resourceId.videoId,
        title: it.snippet.title,
        thumb: ((it.snippet.thumbnails && (it.snippet.thumbnails.high || it.snippet.thumbnails.medium || it.snippet.thumbnails.default)) || {}).url || ''
      }));
  }

  // Loads the main playlist and every show's own playlist (each distinct ID once).
  async function loadAll(key) {
    const jobs = [];
    const seenIds = new Set();
    const add = (id, label, where) => {
      if (!id || seenIds.has(id)) return;
      seenIds.add(id);
      jobs.push({ id, label, where });
    };
    add(MAIN_ID, 'Main playlist', 'Check MAIN_PLAYLIST_ID in config.js.');
    showDefs.forEach(s => add(s.playlistId, `${s.name} playlist`, `Check the playlistId for "${s.name}" in config.js.`));

    const settled = await Promise.allSettled(jobs.map(j => fetchPlaylist(key, j.id)));
    const byId = {};
    const issues = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') byId[jobs[i].id] = r.value;
      else {
        const msg = (r.reason && r.reason.message) || 'Could not load this playlist.';
        issues.push({ label: jobs[i].label, message: msg, where: /Playlist ID used/.test(msg) ? jobs[i].where : '' });
      }
    });
    return { byId, issues, jobCount: jobs.length, okCount: Object.keys(byId).length };
  }

  function issueText(issue) {
    return `${issue.message}${issue.where ? ' ' + issue.where : ''}`;
  }

  // Puts every video into its show: a show's own playlist first, then main-playlist
  // videos matched by title, and whatever is left under "More cartoons".
  function computeGroups(byId) {
    const seen = new Set();
    const shows = showDefs.map(s => ({ key: s.key, name: s.name, color: s.color, videos: [] }));
    const other = { key: OTHER_KEY, name: OTHER_NAME, color: OTHER_COLOR, videos: [] };

    showDefs.forEach((s, i) => {
      (byId[s.playlistId] || []).forEach(v => {
        if (seen.has(v.id)) return;
        seen.add(v.id);
        shows[i].videos.push(v);
      });
    });
    (byId[MAIN_ID] || []).forEach(v => {
      if (seen.has(v.id)) return;
      seen.add(v.id);
      const t = v.title.toLowerCase();
      const idx = showDefs.findIndex(s => s.matchers.some(m => t.includes(m)));
      (idx >= 0 ? shows[idx] : other).videos.push(v);
    });

    const result = shows.filter(g => g.videos.length);
    const matched = result.length;
    if (other.videos.length) result.push(other);
    return { groups: result, matched };
  }

  function applyResult(res) {
    loadIssues = res.issues;
    const g = computeGroups(res.byId);
    groups = g.groups;
    matchedShows = g.matched;
    allVideos = [];
    showOf = {};
    groups.forEach(gr => gr.videos.forEach(v => { allVideos.push(v); showOf[v.id] = gr; }));
    status = 'ready';
    if (currentShow && !groups.some(x => x.key === currentShow)) currentShow = '';
  }

  async function load() {
    const token = ++loadToken;
    status = 'loading';
    loadIssues = [];
    loadingMsg.style.display = 'block';
    contentRoot.innerHTML = '';
    setHero();
    const res = await loadAll(apiKey);
    if (token !== loadToken) return;
    loadingMsg.style.display = 'none';
    if (res.okCount === 0) {
      status = 'error';
      loadIssues = res.issues;
    } else {
      applyResult(res);
    }
    setHero();
    render();
  }

  // ---------- Rendering ----------
  function searchQuery() { return searchInput.value.trim().toLowerCase(); }

  function setHero() {
    let text = DEFAULT_HERO;
    if (!apiKey) text = 'Add a free YouTube Data API key to load your cartoons.';
    else if (!configured) text = 'One more step: add your playlist to config.js.';
    else if (status === 'ready' && allVideos.length) {
      text = matchedShows
        ? `${plural(allVideos.length, 'episode')} across ${plural(matchedShows, 'show')} — pick one and press play.`
        : `${plural(allVideos.length, 'episode')} — press play on anything.`;
    }
    heroSub.textContent = text;
  }

  function render() {
    contentRoot.innerHTML = '';
    if (!apiKey) return renderNoKey();
    if (!configured) return renderNotConfigured();
    if (status === 'loading' || status === 'idle') return;
    if (status === 'error') return renderLoadFailure();
    if (!allVideos.length) {
      const d = el('div', 'empty-state');
      d.appendChild(el('strong', null, 'Nothing to watch yet.'));
      d.appendChild(document.createElement('br'));
      d.appendChild(document.createTextNode('Your playlist loaded, but it has no watchable videos. Add some on YouTube and reload.'));
      contentRoot.appendChild(d);
      return;
    }

    if (loadIssues.length) contentRoot.appendChild(buildIssueNotice());
    const q = searchQuery();

    if (currentShow) {
      const g = groups.find(x => x.key === currentShow);
      if (g) { contentRoot.appendChild(buildShowPage(g, q)); return; }
      currentShow = '';
    }

    if (q) {
      const results = allVideos.filter(v => v.title.toLowerCase().includes(q));
      contentRoot.appendChild(heading(results.length ? `Results for “${searchInput.value.trim()}”` : 'No matches'));
      if (results.length) contentRoot.appendChild(buildEpisodeList(results, matchedShows ? showOf : null));
      return;
    }

    const cont = getContinueList();
    if (cont.length) contentRoot.appendChild(buildShelf('Continue Watching', cont));

    if (!matchedShows) {
      contentRoot.appendChild(heading('All cartoons'));
      contentRoot.appendChild(buildEpisodeList(allVideos, null));
      return;
    }
    contentRoot.appendChild(heading('Pick a show'));
    const grid = el('div', 'show-grid');
    groups.forEach(g => grid.appendChild(buildShowTile(g)));
    contentRoot.appendChild(grid);
  }

  function heading(text) { return el('h2', 'cartoon-heading', text); }

  function renderNoKey() {
    const d = el('div', 'empty-state');
    d.appendChild(el('strong', null, 'Almost there.'));
    d.appendChild(document.createElement('br'));
    d.appendChild(document.createTextNode('Add your free YouTube Data API key to start watching.'));
    d.appendChild(document.createElement('br'));
    const b = el('button', 'btn', 'Add API key');
    b.addEventListener('click', openSettings);
    d.appendChild(b);
    contentRoot.appendChild(d);
  }

  function renderNotConfigured() {
    const d = el('div', 'empty-state');
    d.appendChild(el('strong', null, 'Pick your playlist.'));
    d.appendChild(document.createElement('br'));
    d.appendChild(document.createTextNode('Open '));
    d.appendChild(el('code', null, 'config.js'));
    d.appendChild(document.createTextNode(' and paste your YouTube playlist ID into '));
    d.appendChild(el('code', null, 'MAIN_PLAYLIST_ID'));
    d.appendChild(document.createTextNode(' (or give a show its own playlistId), then reload this page. Videos you add to the playlist later show up here on their own.'));
    contentRoot.appendChild(d);
  }

  function renderLoadFailure() {
    const d = el('div', 'empty-state');
    d.appendChild(el('strong', null, 'Couldn’t load your cartoons.'));
    loadIssues.forEach(i => {
      const s = el('span', 'err-detail', `${i.label}: ${issueText(i)}`);
      d.appendChild(s);
    });
    const retry = el('button', 'btn', 'Try again');
    retry.addEventListener('click', load);
    const set = el('button', 'btn btn-ghost', 'Open settings');
    set.addEventListener('click', openSettings);
    d.appendChild(document.createElement('br'));
    d.appendChild(retry);
    d.appendChild(set);
    contentRoot.appendChild(d);
  }

  function buildIssueNotice() {
    const n = el('div', 'notice');
    n.setAttribute('role', 'status');
    n.appendChild(document.createTextNode('Some playlists couldn’t load, so a few episodes may be missing:'));
    const ul = document.createElement('ul');
    loadIssues.forEach(i => ul.appendChild(el('li', null, `${i.label}: ${issueText(i)}`)));
    n.appendChild(ul);
    const retry = el('button', 'btn', 'Try again');
    retry.addEventListener('click', load);
    n.appendChild(retry);
    return n;
  }

  function progressBar(v) {
    const p = progressById[v.id];
    if (!inProgress(p)) return null;
    const track = el('div', 'progress-track');
    const fill = el('div', 'progress-fill');
    fill.style.width = Math.round(p.fraction * 100) + '%';
    track.appendChild(fill);
    return track;
  }

  function getContinueList() {
    return Object.keys(progressById)
      .map(id => ({ id, p: progressById[id] }))
      .filter(x => inProgress(x.p))
      .sort((a, b) => b.p.updatedAt - a.p.updatedAt)
      .map(x => allVideos.find(v => v.id === x.id))
      .filter(Boolean);
  }

  function buildShelf(title, videos) {
    const shelf = el('div', 'shelf');
    shelf.appendChild(el('div', 'shelf-title', title));
    const row = el('div', 'shelf-row');
    videos.forEach(v => {
      const card = el('div', 'watch-card');
      const thumb = el('div', 'watch-thumb');
      thumb.appendChild(thumbImg(v));
      const bar = progressBar(v);
      if (bar) thumb.appendChild(bar);
      card.appendChild(thumb);
      card.appendChild(el('p', 'watch-title', v.title));
      pressable(card, 'Continue ' + v.title, () => openPlayer(v));
      row.appendChild(card);
    });
    shelf.appendChild(row);
    return shelf;
  }

  function buildShowTile(g) {
    const tile = el('div', 'show-tile');
    tile.style.setProperty('--show-color', g.color);
    const cover = el('div', 'show-cover');
    cover.appendChild(thumbImg(g.videos[0]));
    tile.appendChild(cover);
    tile.appendChild(el('h3', 'show-name', g.name));
    tile.appendChild(el('p', 'show-count', plural(g.videos.length, 'episode')));
    pressable(tile, `${g.name}, ${plural(g.videos.length, 'episode')}`, () => openShow(g.key, true));
    return tile;
  }

  function buildShowPage(g, q) {
    const wrap = document.createElement('div');
    const banner = el('div', 'show-banner');
    banner.style.setProperty('--show-color', g.color);
    const back = el('button', 'back-btn', '← All shows');
    back.addEventListener('click', closeShow);
    const episodes = q ? g.videos.filter(v => v.title.toLowerCase().includes(q)) : g.videos;
    banner.appendChild(back);
    banner.appendChild(el('h2', 'show-banner-title', g.name));
    banner.appendChild(el('span', 'show-banner-count',
      q ? `${episodes.length} of ${plural(g.videos.length, 'episode')}` : plural(g.videos.length, 'episode')));
    wrap.appendChild(banner);
    if (episodes.length) wrap.appendChild(buildEpisodeList(episodes, null));
    else wrap.appendChild(el('div', 'empty-state', 'No matches found.'));
    return wrap;
  }

  function buildEpisodeList(videos, map) {
    const list = el('div', 'episode-list');
    videos.forEach(v => list.appendChild(buildEpisodeRow(v, map ? map[v.id] : null)));
    return list;
  }

  function buildEpisodeRow(v, group) {
    const row = el('div', 'episode-row');
    const thumb = el('div', 'ep-thumb');
    thumb.appendChild(thumbImg(v));
    const play = el('span', 'ep-play');
    play.setAttribute('aria-hidden', 'true');
    play.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 1L9 5L2 9V1Z" fill="#2B2140"/></svg>';
    thumb.appendChild(play);
    const bar = progressBar(v);
    if (bar) thumb.appendChild(bar);
    const info = el('div', 'ep-info');
    info.appendChild(el('p', 'ep-title', v.title));
    if (group) {
      const pill = el('span', 'ep-pill', group.name);
      pill.style.setProperty('--pill-color', group.color);
      info.appendChild(pill);
    }
    row.appendChild(thumb);
    row.appendChild(info);
    pressable(row, 'Play ' + v.title, () => openPlayer(v));
    return row;
  }

  // ---------- Show navigation (phone Back button returns to the show list) ----------
  function openShow(key, push) {
    currentShow = key;
    searchInput.value = '';
    if (push) { try { history.pushState({ toon: 'show', show: key }, ''); } catch (e) {} }
    render();
    window.scrollTo(0, 0);
  }
  function closeShow() {
    if (history.state && history.state.toon === 'show') history.back();
    else openShow('', false);
  }
  window.addEventListener('popstate', (e) => {
    currentShow = (e.state && e.state.toon === 'show') ? e.state.show : '';
    searchInput.value = '';
    render();
    window.scrollTo(0, 0);
  });

  searchInput.addEventListener('input', () => { if (status === 'ready') render(); });

  // ---------- Player ----------
  function loadYouTubeAPI() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      let done = false;
      const fail = () => {
        if (done) return;
        done = true;
        ytApiPromise = null;
        reject(new Error('player script did not load'));
      };
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prev === 'function') prev();
        if (done) return;
        done = true;
        resolve();
      };
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.onerror = fail;
      document.head.appendChild(tag);
      setTimeout(fail, 15000);
    });
    return ytApiPromise;
  }

  function recordProgress() {
    if (!ytPlayer || !currentVideo) return;
    try {
      const duration = ytPlayer.getDuration();
      const seconds = ytPlayer.getCurrentTime();
      if (!duration || isNaN(duration) || isNaN(seconds)) return;
      progressById[currentVideo.id] = { seconds, duration, fraction: seconds / duration, updatedAt: Date.now() };
      saveProgress();
    } catch (e) {}
  }
  function stopProgressTracking() {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  }
  function destroyPlayer() {
    stopProgressTracking();
    if (ytPlayer && typeof ytPlayer.destroy === 'function') { try { ytPlayer.destroy(); } catch (e) {} }
    ytPlayer = null;
  }

  function playerErrorText(code) {
    switch (String(code)) {
      case '101':
      case '150': return 'The owner of this video doesn’t allow it to play inside other apps.';
      case '153': return 'YouTube blocked this embed (error 153). This usually happens when the app is opened straight from a file. Run it from a local server or from your website instead — or watch it on YouTube.';
      case '100': return 'This video was removed or has been made private.';
      case '2': return 'YouTube couldn’t understand this video link.';
      case '5': return 'YouTube’s player ran into a problem with this video. Try again in a moment.';
      case 'load': return 'Couldn’t load YouTube’s player. Check your internet connection and try again.';
      default: return `YouTube couldn’t play this video (error ${code}).`;
    }
  }

  function showPlayerError(code, v) {
    recordProgress();
    destroyPlayer();
    playerFrameWrap.innerHTML = '';
    const box = el('div', 'player-error');
    box.setAttribute('role', 'alert');
    box.appendChild(el('p', null, playerErrorText(code)));
    const link = el('a', 'btn', 'Watch on YouTube');
    link.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(v.id);
    link.target = '_blank';
    link.rel = 'noopener';
    box.appendChild(link);
    playerFrameWrap.appendChild(box);
  }

  async function openPlayer(v) {
    const mine = ++playerToken;
    destroyPlayer();
    currentVideo = v;
    playerTitle.textContent = v.title;
    playerOverlay.classList.add('open');
    playerFrameWrap.innerHTML = '<div id="ytPlayerContainer"></div>';

    try { await loadYouTubeAPI(); }
    catch (e) { if (mine === playerToken) showPlayerError('load', v); return; }
    if (mine !== playerToken || !playerOverlay.classList.contains('open')) return;

    const saved = progressById[v.id];
    const start = inProgress(saved) ? Math.floor(saved.seconds) : 0;
    ytPlayer = new YT.Player('ytPlayerContainer', {
      videoId: v.id,
      playerVars: { autoplay: 1, rel: 0, playsinline: 1, start },
      events: {
        onReady: () => { stopProgressTracking(); progressTimer = setInterval(recordProgress, 5000); },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED) {
            delete progressById[v.id];
            saveProgress();
          } else if (e.data === YT.PlayerState.PAUSED) {
            recordProgress();
          }
        },
        onError: (e) => { if (mine === playerToken) showPlayerError(e && e.data, v); }
      }
    });
  }

  function closePlayer() {
    playerToken++;
    recordProgress();
    destroyPlayer();
    playerOverlay.classList.remove('open');
    currentVideo = null;
    playerFrameWrap.innerHTML = '<div id="ytPlayerContainer"></div>';
    if (status === 'ready') render();
  }
  closePlayerBtn.addEventListener('click', closePlayer);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') recordProgress(); });
  window.addEventListener('pagehide', recordProgress);

  // ---------- Settings ----------
  function openSettings() {
    apiKeyInput.value = apiKey;
    settingsError.style.display = 'none';
    settingsModal.classList.add('open');
    setTimeout(() => { try { apiKeyInput.focus(); } catch (e) {} }, 0);
  }
  function closeSettings() { settingsModal.classList.remove('open'); }
  function showSettingsError(msg) {
    settingsError.textContent = msg;
    settingsError.style.display = 'block';
  }

  settingsBtn.addEventListener('click', openSettings);
  settingsCancel.addEventListener('click', closeSettings);
  settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });
  apiKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') settingsSave.click(); });

  settingsSave.addEventListener('click', async () => {
    const key = cleanApiKey(apiKeyInput.value);
    if (!key) { showSettingsError('Paste your API key first.'); return; }
    settingsError.style.display = 'none';

    // No playlist set in config.js yet: nothing to test the key against, so just keep it.
    if (!configured) {
      apiKey = key;
      safeSet(KEY_STORE, key);
      closeSettings();
      setHero();
      render();
      return;
    }

    settingsSave.textContent = 'Loading…';
    settingsSave.disabled = true;
    try {
      const res = await loadAll(key);
      if (res.okCount === 0) {
        const i = res.issues[0];
        showSettingsError(i ? issueText(i) : 'Could not load your playlist.');
        return; // the key is only kept once it works
      }
      loadToken++; // drop any load still in flight
      apiKey = key;
      safeSet(KEY_STORE, key);
      applyResult(res);
      closeSettings();
      loadingMsg.style.display = 'none';
      setHero();
      render();
    } finally {
      settingsSave.textContent = 'Save & load';
      settingsSave.disabled = false;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (playerOverlay.classList.contains('open')) closePlayer();
    else if (settingsModal.classList.contains('open')) closeSettings();
  });

  // ---------- Boot ----------
  (function init() {
    loadProgress();
    apiKey = cleanApiKey(safeGet(KEY_STORE) || '');
    setHero();
    if (!apiKey || !configured) { render(); return; }
    load();
  })();
})();
