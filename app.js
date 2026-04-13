const state = {
  songs: [],
  songCache: new Map(),
  favorites: [],
  playlists: [],
  officialPlaylists: [],
  totalSongs: 0,
  favoriteSort: "manual",
  currentView: "all",
  currentPlaylistId: null,
  selectedSongId: null,
  query: "",
  decade: "all",
  localSongs: false,
  offset: 0,
  limit: 80,
  hasMore: false,
  loading: false,
  playbackMode: "normal",
  playbackSpeed: 1,
  playbackCandidates: [],
  summary: {
    albumCount: 0,
    trackCount: 0,
  },
};

const nodes = {
  searchInput: document.querySelector("#search-input"),
  decadeFilter: document.querySelector("#decade-filter"),
  localSongs: document.querySelector("#local-songs"),
  mobileMenuToggle: document.querySelector("#mobile-menu-toggle"),
  mobileMenuBackdrop: document.querySelector("#mobile-menu-backdrop"),
  sideRail: document.querySelector("#side-rail"),
  songList: document.querySelector("#song-list"),
  resultCount: document.querySelector("#result-count"),
  collectionTitle: document.querySelector("#collection-title"),
  collectionSortWrap: document.querySelector("#collection-sort-wrap"),
  albumCount: document.querySelector("#album-count"),
  trackCount: document.querySelector("#track-count"),
  favoriteCount: document.querySelector("#favorite-count"),
  favoritesCard: document.querySelector("#favorites-card"),
  favoriteSort: document.querySelector("#favorite-sort-body"),
  playlistCount: document.querySelector("#playlist-count"),
  playlistList: document.querySelector("#playlist-list"),
  playlistForm: document.querySelector("#playlist-form"),
  playlistInput: document.querySelector("#playlist-input"),
  refreshButton: document.querySelector("#refresh-library"),
  showAllRail: document.querySelector("#show-all-rail"),
  loadMore: document.querySelector("#load-more"),
  nowTitle: document.querySelector("#now-title"),
  nowArtist: document.querySelector("#now-artist"),
  nowMovie: document.querySelector("#now-movie"),
  nowYear: document.querySelector("#now-year"),
  nowComposer: document.querySelector("#now-composer"),
  playToggle: document.querySelector("#play-toggle"),
  previousTrack: document.querySelector("#previous-track"),
  nextTrack: document.querySelector("#next-track"),
  playbackMode: document.querySelector("#playback-mode"),
  favoriteToggle: document.querySelector("#favorite-toggle"),
  speedSelect: document.querySelector("#speed-select"),
  volumeControl: document.querySelector("#volume-control"),
  audioPlayer: document.querySelector("#audio-player"),
  seekBar: document.querySelector("#seek-bar"),
  currentTime: document.querySelector("#current-time"),
  durationTime: document.querySelector("#duration-time"),
  playbackStatus: document.querySelector("#playback-status"),
  songTemplate: document.querySelector("#song-item-template"),
  favoriteTemplate: document.querySelector("#favorite-item-template"),
  playlistTemplate: document.querySelector("#playlist-item-template"),
};

const FAVORITES_KEY = "sruthi-favorites";
const FAVORITES_SORT_KEY = "sruthi-favorite-sort";
const PLAYLISTS_KEY = "sruthi-playlists";
let searchDebounce = null;
let isSeeking = false;
let mobileMenuOpen = false;
const mobileMediaQuery = window.matchMedia("(max-width: 720px)");

function sanitizeText(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function slugify(value) {
  return sanitizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "playlist";
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function setPlaybackStatus(text = "") {
  nodes.playbackStatus.textContent = text;
  nodes.playbackStatus.hidden = !text;
}

function playbackCandidatesForSong(song) {
  if (!song) return [];
  return [...new Set([song.audioUrl, song.localAudio320Url, song.localAudio128Url, song.audio128Url, song.audio320Url].filter(Boolean))];
}

function playbackUrlForSong(song) {
  return playbackCandidatesForSong(song)[0] || "";
}

function cacheSongs(songs) {
  songs.forEach((song) => {
    if (!song?.id) return;
    state.songCache.set(song.id, {
      ...song,
      title: sanitizeText(song.title),
      artist: sanitizeText(song.artist),
      composer: sanitizeText(song.composer),
      movie: sanitizeText(song.movie),
    });
  });
}

function selectedSong() {
  return state.songCache.get(state.selectedSongId) || null;
}

function selectedSongIndex() {
  return state.songs.findIndex((item) => item.id === state.selectedSongId);
}

function isFavorite(songId) {
  return state.favorites.some((item) => item.id === songId);
}

function currentPlaylist() {
  return [...state.officialPlaylists, ...state.playlists].find((playlist) => playlist.id === state.currentPlaylistId) || null;
}

function currentCollectionTitle() {
  if (state.currentView === "favorites") return "Favourites";
  if (state.currentView === "playlist") {
    const playlist = currentPlaylist();
    return playlist?.official ? officialPlaylistDisplayName(playlist.name) : playlist?.name || "Playlist";
  }
  return "Song Collection";
}

function officialPlaylistDisplayName(name) {
  const text = sanitizeText(name);
  const normalized = text.toLowerCase();
  const replacements = [
    [/^anirudh.*$/i, "Anirudh Ravichander Hits"],
    [/^(arr|a\.?\s*r\.?\s*rahman).*$/i, "A. R. Rahman Hits"],
    [/^sean roldan.*$/i, "Sean Roldan Hits"],
    [/^vijay antony.*$/i, "Vijay Antony Hits"],
    [/^hiphop tamizha.*$/i, "Hiphop Tamizha Hits"],
    [/^deva.*$/i, "Deva Hits"],
    [/^ilaiyaraaja.*$/i, "Ilaiyaraaja Hits"],
    [/^imman.*$/i, "D. Imman Hits"],
    [/^yuvan.*$/i, "Yuvan Shankar Raja Hits"],
    [/^harris.*$/i, "Harris Jayaraj Hits"],
    [/^santhosh narayanan.*$/i, "Santhosh Narayanan Hits"],
    [/^g\.?\s*v\.?\s*prakash.*$/i, "G. V. Prakash Hits"],
    [/^sai.*$/i, "Sai Abhyankkar Hits"],
  ];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(normalized)) return replacement;
  }
  return text.replace(/\b(top\s*\d+|maxxx|hits?)\b/gi, "").replace(/\s{2,}/g, " ").trim() || text;
}

function saveFavorites() {
  window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites));
}

function saveFavoriteSort() {
  window.localStorage.setItem(FAVORITES_SORT_KEY, state.favoriteSort);
}

function savePlaylists() {
  window.localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(state.playlists));
}

function loadFavorites() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(FAVORITES_KEY) || "[]");
    state.favorites = Array.isArray(stored) ? stored.filter((item) => item?.id) : [];
  } catch (_) {
    state.favorites = [];
  }

  const storedSort = window.localStorage.getItem(FAVORITES_SORT_KEY);
  state.favoriteSort = ["manual", "recent", "title", "composer"].includes(storedSort) ? storedSort : "manual";
}

function loadPlaylists() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PLAYLISTS_KEY) || "[]");
    state.playlists = Array.isArray(stored)
      ? stored
          .filter((item) => item?.id && item?.name)
          .map((item) => ({
            id: item.id,
            name: sanitizeText(item.name),
            songIds: Array.isArray(item.songIds) ? item.songIds.filter(Boolean) : [],
          }))
      : [];
  } catch (_) {
    state.playlists = [];
  }
}

async function loadOfficialPlaylists() {
  const sources = [
    "/api/playlists",
    "https://sruthi.vklokesh70.workers.dev/api/playlists",
  ];
  for (const source of sources) {
    try {
      const payload = await fetchJson(source);
      state.officialPlaylists = Array.isArray(payload?.playlists)
        ? payload.playlists.map((playlist) => ({
            id: sanitizeText(playlist.id),
            name: sanitizeText(playlist.name),
            songIds: Array.isArray(playlist.songIds) ? playlist.songIds.filter(Boolean) : [],
            songCount: Number(playlist.songCount || (Array.isArray(playlist.songIds) ? playlist.songIds.length : 0)),
            sourceUrl: sanitizeText(playlist.sourceUrl),
            official: true,
          }))
        : [];
      return;
    } catch (_) {
      // try next source
    }
  }
  state.officialPlaylists = [];
}

function syncFavoriteSnapshot(song) {
  if (!song?.id) return;
  const index = state.favorites.findIndex((item) => item.id === song.id);
  if (index < 0) return;
  state.favorites[index] = {
    id: song.id,
    title: sanitizeText(song.title),
    composer: sanitizeText(song.composer),
  };
  saveFavorites();
}

function orderedFavorites() {
  const items = [...state.favorites];
  switch (state.favoriteSort) {
    case "title":
      return items.sort((a, b) => sanitizeText(a.title).localeCompare(sanitizeText(b.title)));
    case "composer":
      return items.sort((a, b) => {
        const composerRank = sanitizeText(a.composer).localeCompare(sanitizeText(b.composer));
        return composerRank || sanitizeText(a.title).localeCompare(sanitizeText(b.title));
      });
    default:
      return items;
  }
}

function updateTransportState() {
  const duration = nodes.audioPlayer.duration;
  const currentTime = nodes.audioPlayer.currentTime;
  nodes.currentTime.textContent = formatTime(currentTime);
  nodes.durationTime.textContent = formatTime(duration);
  nodes.seekBar.disabled = !Number.isFinite(duration) || duration <= 0;
  if (!isSeeking) {
    nodes.seekBar.value = Number.isFinite(duration) && duration > 0 ? String((currentTime / duration) * 100) : "0";
  }

  const index = selectedSongIndex();
  const hasSongs = state.songs.length > 0;
  nodes.previousTrack.disabled = !hasSongs;
  nodes.nextTrack.disabled = !hasSongs;
  nodes.favoriteToggle.classList.toggle("is-active", isFavorite(state.selectedSongId));
  nodes.favoriteToggle.textContent = isFavorite(state.selectedSongId) ? "♥" : "♡";
  nodes.speedSelect.value = String(state.playbackSpeed);
  nodes.playbackMode.value = state.playbackMode;
  nodes.volumeControl.value = String(Math.round((nodes.audioPlayer.volume ?? 0.85) * 100));

  if (!hasSongs || index < 0) {
    nodes.previousTrack.disabled = true;
    nodes.nextTrack.disabled = true;
  }
  renderTransportLabels();
}

function renderTransportLabels() {
  const isMobile = mobileMediaQuery.matches;
  const playing = !nodes.audioPlayer.paused;
  nodes.previousTrack.textContent = isMobile ? "⏮" : "Prev";
  nodes.nextTrack.textContent = isMobile ? "⏭" : "Next";
  nodes.playToggle.textContent = isMobile ? (playing ? "⏸" : "▶") : (playing ? "Pause" : "Play");
  nodes.previousTrack.setAttribute("aria-label", "Previous track");
  nodes.nextTrack.setAttribute("aria-label", "Next track");
  nodes.playToggle.setAttribute("aria-label", playing ? "Pause" : "Play");
}

function replaceOptions(selectNode, defaultLabel, values) {
  const fragment = document.createDocumentFragment();
  fragment.append(new Option(defaultLabel, "all"));
  values.forEach((value) => fragment.append(new Option(value, value)));
  selectNode.innerHTML = "";
  selectNode.append(fragment);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json().catch(() => ({}));
}

async function fetchSongById(songId) {
  const payload = await fetchJson(`/api/song?id=${encodeURIComponent(songId)}`);
  cacheSongs([payload]);
  syncFavoriteSnapshot(payload);
  return payload;
}

async function ensureSongsCached(songIds) {
  const missing = [...new Set(songIds.filter((id) => id && !state.songCache.has(id)))];
  if (!missing.length) return;
  try {
    const payload = await postJson("/api/songs-batch", { ids: missing });
    cacheSongs(payload.songs || []);
    (payload.songs || []).forEach(syncFavoriteSnapshot);
  } catch (_) {
    for (const songId of missing) {
      try {
        await fetchSongById(songId);
      } catch (_) {
        // ignore individual misses
      }
    }
  }
}

function songMatches(song, query) {
  const normalized = sanitizeText(query).toLowerCase();
  if (!normalized) return 10;
  const title = sanitizeText(song.title).toLowerCase();
  const movie = sanitizeText(song.movie).toLowerCase();
  const artist = sanitizeText(song.artist).toLowerCase();
  const composer = sanitizeText(song.composer).toLowerCase();
  if (title === normalized) return 0;
  if (title.startsWith(normalized)) return 1;
  if (movie === normalized) return 2;
  if (movie.startsWith(normalized)) return 3;
  if (artist === normalized || artist.startsWith(normalized)) return 4;
  if (composer === normalized || composer.startsWith(normalized)) return 5;
  if (title.includes(normalized)) return 6;
  if (movie.includes(normalized)) return 7;
  if (artist.includes(normalized)) return 8;
  if (composer.includes(normalized)) return 9;
  return 99;
}

function filterClientSongs(songs) {
  return songs
    .filter((song) => {
      if (state.decade !== "all") {
        const decade = song.year ? `${Math.floor(song.year / 10) * 10}s` : "Unknown";
        if (decade !== state.decade) return false;
      }
      if (state.localSongs && !(song.localAudio320Url || song.localAudio128Url)) return false;
      if (!state.query) return true;
      return songMatches(song, state.query) < 99;
    })
    .sort((a, b) => {
      const matchRank = songMatches(a, state.query) - songMatches(b, state.query);
      if (matchRank) return matchRank;
      return sanitizeText(a.title).localeCompare(sanitizeText(b.title));
    });
}

function collectionSongIds() {
  if (state.currentView === "favorites") return orderedFavorites().map((item) => item.id);
  if (state.currentView === "playlist") return currentPlaylist()?.songIds || [];
  return [];
}

async function loadCollectionView() {
  if (state.currentView === "playlist" && currentPlaylist()?.official) {
    const playlist = currentPlaylist();
    const sources = [
      `/api/playlist?id=${encodeURIComponent(playlist.id)}`,
      `https://sruthi.vklokesh70.workers.dev/api/playlist?id=${encodeURIComponent(playlist.id)}`,
    ];
    for (const source of sources) {
      try {
        const payload = await fetchJson(source);
        const songs = Array.isArray(payload?.songs) ? payload.songs : [];
        const songIds = songs.map((song) => song.id).filter(Boolean);
        cacheSongs(songs);
        songs.forEach(syncFavoriteSnapshot);
        playlist.songIds = songIds;
        playlist.songCount = Number(payload?.songCount || songIds.length);
        const filtered = filterClientSongs(songs);
        state.songs = filtered;
        state.totalSongs = filtered.length;
        state.hasMore = false;
        state.offset = filtered.length;
        if (!state.selectedSongId && filtered.length) state.selectedSongId = filtered[0].id;
        renderSongs();
        return;
      } catch (_) {
        // try next source
      }
    }
  }
  const ids = collectionSongIds();
  await ensureSongsCached(ids);
  const songs = ids.map((id) => state.songCache.get(id)).filter(Boolean);
  const filtered = filterClientSongs(songs);
  state.songs = filtered;
  state.totalSongs = filtered.length;
  state.hasMore = false;
  state.offset = filtered.length;
  if (!state.selectedSongId && filtered.length) state.selectedSongId = filtered[0].id;
  renderSongs();
}

function renderFavorites() {
  nodes.favoriteSort.value = state.favoriteSort;
  nodes.favoriteCount.textContent = String(state.favorites.length);
  nodes.favoritesCard.classList.toggle("is-active", state.currentView === "favorites");
}

function renderPlaylists() {
  nodes.playlistList.innerHTML = "";
  const allPlaylists = [...state.officialPlaylists, ...state.playlists];
  nodes.playlistCount.textContent = String(allPlaylists.length);

  if (!allPlaylists.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Create playlists for your own queue.";
    nodes.playlistList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  allPlaylists.forEach((playlist) => {
    const row = nodes.playlistTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.playlistId = playlist.id;
    row.dataset.official = playlist.official ? "true" : "false";
    row.classList.toggle("is-active", state.currentView === "playlist" && state.currentPlaylistId === playlist.id);
    row.querySelector(".playlist-title").textContent = playlist.official ? officialPlaylistDisplayName(playlist.name) : playlist.name;
    row.querySelector(".playlist-detail").textContent = playlist.official
      ? `Official • ${playlist.songCount ?? playlist.songIds.length} songs`
      : `${playlist.songIds.length} songs`;
    row.querySelector(".playlist-remove").classList.toggle("hidden", Boolean(playlist.official));
    fragment.append(row);
  });
  nodes.playlistList.append(fragment);
}

function renderSongRowActions(row, song) {
  const picker = row.querySelector(".playlist-pick");
  picker.innerHTML = "";
  picker.append(new Option("Add to playlist", ""));
  state.playlists.forEach((playlist) => picker.append(new Option(playlist.name, playlist.id)));
  picker.disabled = !state.playlists.length;

  const removeButton = row.querySelector(".song-remove");
  removeButton.classList.toggle("hidden", state.currentView !== "playlist");
}

function renderSongs() {
  nodes.songList.innerHTML = "";
  nodes.resultCount.textContent = `${state.totalSongs} songs`;
  nodes.collectionTitle.textContent = currentCollectionTitle();
  nodes.collectionSortWrap.classList.toggle("hidden", state.currentView !== "favorites");
  nodes.showAllRail.classList.toggle("hidden", state.currentView === "all");
  nodes.favoriteSort.value = state.favoriteSort;

  if (!state.songs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.currentView === "all" ? "No songs match this search." : "No songs in this collection yet.";
    nodes.songList.append(empty);
    nodes.loadMore.hidden = true;
    renderFavorites();
    renderPlaylists();
    renderSelectedSong();
    return;
  }

  const fragment = document.createDocumentFragment();
  state.songs.forEach((song) => {
    const row = nodes.songTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.songId = song.id;
    row.classList.toggle("is-selected", song.id === state.selectedSongId);
    row.querySelector(".song-title").textContent = song.title;
    row.querySelector(".song-detail").textContent = `${song.artist} • ${song.movie}`;
    row.querySelector(".song-subdetail").textContent = song.composer;
    row.querySelector(".song-year").textContent = song.year || "-";
    renderSongRowActions(row, song);
    fragment.append(row);
  });
  nodes.songList.append(fragment);
  nodes.loadMore.hidden = state.currentView !== "all" || !state.hasMore;
  renderFavorites();
  renderPlaylists();
  renderSelectedSong();
}

function renderSelectedSong() {
  const song = selectedSong();
  if (!song) {
    nodes.nowTitle.textContent = "Choose a song";
    nodes.nowArtist.textContent = "Select a track from the library.";
    nodes.nowMovie.textContent = "-";
    nodes.nowYear.textContent = "-";
    nodes.nowComposer.textContent = "-";
    nodes.audioPlayer.pause();
    nodes.audioPlayer.removeAttribute("src");
    nodes.audioPlayer.load();
    nodes.playToggle.textContent = "Play";
    nodes.favoriteToggle.textContent = "♡";
    nodes.seekBar.disabled = true;
    nodes.seekBar.value = "0";
    nodes.currentTime.textContent = "0:00";
    nodes.durationTime.textContent = "0:00";
    setPlaybackStatus("");
    state.playbackCandidates = [];
    updateTransportState();
    return;
  }

  nodes.nowTitle.textContent = song.title;
  nodes.nowArtist.textContent = song.artist;
  nodes.nowMovie.textContent = song.movie || "-";
  nodes.nowYear.textContent = song.year || "-";
  nodes.nowComposer.textContent = song.composer || "-";
  state.playbackCandidates = playbackCandidatesForSong(song);
  const playbackUrl = state.playbackCandidates[0] || "";
  if (playbackUrl) {
    const absolute = new URL(playbackUrl, window.location.origin).toString();
    if (nodes.audioPlayer.src !== absolute) {
      nodes.audioPlayer.src = playbackUrl;
      nodes.audioPlayer.load();
    }
  }
  nodes.audioPlayer.loop = state.playbackMode === "loop";
  nodes.audioPlayer.playbackRate = state.playbackSpeed;
  setPlaybackStatus("");
  updateTransportState();
}

function setMobileMenuOpen(open) {
  mobileMenuOpen = Boolean(open && mobileMediaQuery.matches);
  document.body.classList.toggle("menu-open", mobileMenuOpen);
  nodes.sideRail?.classList.toggle("is-open", mobileMenuOpen);
  if (nodes.mobileMenuBackdrop) {
    nodes.mobileMenuBackdrop.hidden = !mobileMenuOpen;
  }
  if (nodes.mobileMenuToggle) {
    nodes.mobileMenuToggle.setAttribute("aria-expanded", mobileMenuOpen ? "true" : "false");
  }
}

function prefetchSongIds(songIds) {
  const ids = [...new Set(songIds.filter(Boolean))];
  if (!ids.length) return;
  postJson("/api/prefetch", { ids }).catch(() => {});
}

function waitForPlayableAudio() {
  if (nodes.audioPlayer.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      nodes.audioPlayer.removeEventListener("canplay", onReady);
      nodes.audioPlayer.removeEventListener("loadeddata", onReady);
      nodes.audioPlayer.removeEventListener("error", onDone);
      window.clearTimeout(timeoutId);
      resolve();
    };
    const onReady = () => finish();
    const onDone = () => finish();
    const timeoutId = window.setTimeout(finish, 2200);
    nodes.audioPlayer.addEventListener("canplay", onReady, { once: true });
    nodes.audioPlayer.addEventListener("loadeddata", onReady, { once: true });
    nodes.audioPlayer.addEventListener("error", onDone, { once: true });
  });
}

async function playCurrentSong() {
  const song = selectedSong();
  if (!song || !playbackUrlForSong(song)) return;
  try {
    await waitForPlayableAudio();
    await nodes.audioPlayer.play();
    nodes.playToggle.textContent = "Pause";
  } catch (_) {
    nodes.playToggle.textContent = "Play";
  }
  setPlaybackStatus("");
}

async function selectSong(songId, { autoplay = false } = {}) {
  if (!songId) return;
  if (!state.songCache.has(songId)) {
    try {
      await fetchSongById(songId);
    } catch (_) {
      return;
    }
  }
  state.selectedSongId = songId;
  renderSongs();
  await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  const index = selectedSongIndex();
  prefetchSongIds([songId, state.songs[index - 1]?.id, state.songs[index + 1]?.id]);
  if (autoplay) await playCurrentSong();
}

function nextSongByMode(direction = 1) {
  if (!state.songs.length) return null;
  const index = selectedSongIndex();
  if (state.playbackMode === "shuffle" && state.songs.length > 1) {
    const pool = state.songs.filter((song) => song.id !== state.selectedSongId);
    return pool[Math.floor(Math.random() * pool.length)] || null;
  }
  const next = state.songs[index + direction];
  if (next) return next;
  if (state.playbackMode === "repeat") {
    return direction > 0 ? state.songs[0] : state.songs[state.songs.length - 1];
  }
  return null;
}

async function stepTrack(direction) {
  const nextSong = nextSongByMode(direction);
  if (!nextSong) return;
  await selectSong(nextSong.id, { autoplay: true });
}

function updatePlaylistInState(playlistId, updater) {
  const index = state.playlists.findIndex((item) => item.id === playlistId);
  if (index < 0) return;
  state.playlists[index] = updater(state.playlists[index]);
  savePlaylists();
}

function addSongToPlaylist(songId, playlistId) {
  updatePlaylistInState(playlistId, (playlist) => ({
    ...playlist,
    songIds: playlist.songIds.includes(songId) ? playlist.songIds : [...playlist.songIds, songId],
  }));
  renderPlaylists();
}

function removeSongFromCurrentPlaylist(songId) {
  const playlist = currentPlaylist();
  if (!playlist) return;
  updatePlaylistInState(playlist.id, (item) => ({
    ...item,
    songIds: item.songIds.filter((id) => id !== songId),
  }));
  loadCollectionView();
}

function createPlaylist(name) {
  const cleanName = sanitizeText(name);
  if (!cleanName) return;
  const id = `${slugify(cleanName)}-${Date.now()}`;
  state.playlists.unshift({ id, name: cleanName, songIds: [] });
  savePlaylists();
  nodes.playlistInput.value = "";
  renderPlaylists();
}

function deletePlaylist(playlistId) {
  state.playlists = state.playlists.filter((playlist) => playlist.id !== playlistId);
  savePlaylists();
  if (state.currentView === "playlist" && state.currentPlaylistId === playlistId) {
    state.currentView = "all";
    state.currentPlaylistId = null;
    loadLibrary({ reset: true });
    return;
  }
  renderPlaylists();
  renderSongs();
}

function toggleFavoriteForSelectedSong() {
  const song = selectedSong();
  if (!song) return;
  if (isFavorite(song.id)) {
    state.favorites = state.favorites.filter((item) => item.id !== song.id);
  } else {
    state.favorites.unshift({ id: song.id, title: song.title, composer: song.composer });
  }
  saveFavorites();
  renderFavorites();
  updateTransportState();
  if (state.currentView === "favorites") loadCollectionView();
}

function removeFavorite(songId) {
  state.favorites = state.favorites.filter((item) => item.id !== songId);
  saveFavorites();
  if (state.currentView === "favorites") {
    loadCollectionView();
    return;
  }
  renderFavorites();
  updateTransportState();
}

function moveFavoriteToIndex(songId, targetIndex) {
  const sourceIndex = state.favorites.findIndex((item) => item.id === songId);
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= state.favorites.length || sourceIndex === targetIndex) return;
  const [item] = state.favorites.splice(sourceIndex, 1);
  state.favorites.splice(targetIndex, 0, item);
  saveFavorites();
  renderFavorites();
}

async function switchView(view, playlistId = null) {
  state.currentView = view;
  state.currentPlaylistId = playlistId;
  state.offset = 0;
  if (view === "all") {
    await loadLibrary({ reset: true });
    return;
  }
  await loadCollectionView();
}

async function loadAppState() {
  const payload = await fetchJson("/api/app-state");
  state.summary = payload.summary || state.summary;
  replaceOptions(nodes.decadeFilter, "All decades", payload.filters?.decades || []);
  nodes.decadeFilter.value = state.decade;
  nodes.localSongs.checked = state.localSongs;
  const localToggle = nodes.localSongs.closest(".toggle-wrap");
  if (localToggle) {
    localToggle.hidden = payload.features?.localLibrary === false;
    if (payload.features?.localLibrary === false) {
      state.localSongs = false;
      nodes.localSongs.checked = false;
    }
  }
  nodes.albumCount.textContent = String(state.summary.albumCount || 0);
  nodes.trackCount.textContent = String(state.summary.trackCount || 0);
}

async function loadLibrary({ reset = false } = {}) {
  if (state.currentView !== "all") {
    await loadCollectionView();
    return;
  }
  if (state.loading) return;
  state.loading = true;
  try {
    const params = new URLSearchParams({
      query: state.query,
      decade: state.decade,
      localSongs: state.localSongs ? "true" : "false",
      offset: reset ? "0" : String(state.offset),
      limit: String(state.limit),
    });
    const payload = await fetchJson(`/api/library?${params.toString()}`);
    const songs = payload.songs || [];
    if (reset) {
      state.songs = songs;
      state.offset = songs.length;
    } else {
      state.songs = [...state.songs, ...songs];
      state.offset += songs.length;
    }
    cacheSongs(songs);
    state.songs.forEach(syncFavoriteSnapshot);
    state.totalSongs = payload.total || state.songs.length;
    state.hasMore = Boolean(payload.hasMore);
    if (!state.selectedSongId && state.songs.length) state.selectedSongId = state.songs[0].id;
    renderSongs();
    if (reset) prefetchSongIds(state.songs.slice(0, 4).map((song) => song.id));
  } finally {
    state.loading = false;
  }
}

function scheduleSearch() {
  window.clearTimeout(searchDebounce);
  searchDebounce = window.setTimeout(() => {
    state.offset = 0;
    if (state.currentView === "all") {
      loadLibrary({ reset: true });
    } else {
      loadCollectionView();
    }
  }, 160);
}

async function togglePlayback() {
  if (!selectedSong()) return;
  if (nodes.audioPlayer.paused) {
    await playCurrentSong();
    return;
  }
  nodes.audioPlayer.pause();
  nodes.playToggle.textContent = "Play";
}

function bindEvents() {
  nodes.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value;
    scheduleSearch();
  });

  nodes.decadeFilter.addEventListener("change", (event) => {
    state.decade = event.target.value;
    state.offset = 0;
    if (state.currentView === "all") loadLibrary({ reset: true });
    else loadCollectionView();
  });

  nodes.localSongs.addEventListener("change", (event) => {
    state.localSongs = event.target.checked;
    state.offset = 0;
    if (state.currentView === "all") loadLibrary({ reset: true });
    else loadCollectionView();
  });

  nodes.favoriteSort.addEventListener("change", (event) => {
    state.favoriteSort = event.target.value;
    saveFavoriteSort();
    renderFavorites();
    if (state.currentView === "favorites") loadCollectionView();
  });

  nodes.favoritesCard.addEventListener("click", () => {
    setMobileMenuOpen(false);
    switchView("favorites");
  });

  nodes.showAllRail.addEventListener("click", () => {
    setMobileMenuOpen(false);
    switchView("all");
  });

  nodes.loadMore.addEventListener("click", () => loadLibrary({ reset: false }));

  nodes.refreshButton.addEventListener("click", async () => {
    await loadAppState();
    await loadLibrary({ reset: true });
  });

  nodes.playlistForm.addEventListener("submit", (event) => {
    event.preventDefault();
    createPlaylist(nodes.playlistInput.value);
  });

  nodes.songList.addEventListener("click", (event) => {
    const songMain = event.target.closest(".song-main");
    if (songMain) {
      const row = songMain.closest(".song-row");
      selectSong(row.dataset.songId, { autoplay: true });
      return;
    }

    const remove = event.target.closest(".song-remove");
    if (remove) {
      const row = remove.closest(".song-row");
      removeSongFromCurrentPlaylist(row.dataset.songId);
    }
  });

  nodes.songList.addEventListener("change", (event) => {
    const picker = event.target.closest(".playlist-pick");
    if (!picker || !picker.value) return;
    const row = picker.closest(".song-row");
    addSongToPlaylist(row.dataset.songId, picker.value);
    picker.value = "";
  });

  nodes.songList.addEventListener("mouseover", (event) => {
    const row = event.target.closest(".song-row");
    if (!row) return;
    prefetchSongIds([row.dataset.songId]);
  });

  nodes.playToggle.addEventListener("click", togglePlayback);
  nodes.previousTrack.addEventListener("click", () => stepTrack(-1));
  nodes.nextTrack.addEventListener("click", () => stepTrack(1));
  nodes.playbackMode.addEventListener("change", (event) => {
    state.playbackMode = event.target.value;
    nodes.audioPlayer.loop = state.playbackMode === "loop";
    updateTransportState();
  });
  nodes.speedSelect.addEventListener("change", (event) => {
    state.playbackSpeed = Number(event.target.value) || 1;
    nodes.audioPlayer.playbackRate = state.playbackSpeed;
  });
  nodes.volumeControl.addEventListener("input", (event) => {
    const nextVolume = Math.min(1, Math.max(0, Number(event.target.value) / 100));
    nodes.audioPlayer.volume = nextVolume;
  });
  nodes.favoriteToggle.addEventListener("click", toggleFavoriteForSelectedSong);

  nodes.seekBar.addEventListener("input", () => {
    isSeeking = true;
    const duration = nodes.audioPlayer.duration;
    const percent = Number(nodes.seekBar.value) / 100;
    nodes.currentTime.textContent = Number.isFinite(duration) ? formatTime(duration * percent) : "0:00";
  });

  nodes.seekBar.addEventListener("change", () => {
    const duration = nodes.audioPlayer.duration;
    if (Number.isFinite(duration) && duration > 0) {
      nodes.audioPlayer.currentTime = (Number(nodes.seekBar.value) / 100) * duration;
    }
    isSeeking = false;
    updateTransportState();
  });

  nodes.audioPlayer.addEventListener("play", () => {
    renderTransportLabels();
  });

  nodes.audioPlayer.addEventListener("pause", () => {
    renderTransportLabels();
  });

  nodes.audioPlayer.addEventListener("loadedmetadata", updateTransportState);
  nodes.audioPlayer.addEventListener("timeupdate", updateTransportState);
  nodes.audioPlayer.addEventListener("error", () => {
    const song = selectedSong();
    if (song && state.playbackCandidates.length > 1) {
      const [, ...rest] = state.playbackCandidates;
      state.playbackCandidates = rest;
      nodes.audioPlayer.src = rest[0];
      nodes.audioPlayer.load();
      void playCurrentSong();
      return;
    }
    renderTransportLabels();
    setPlaybackStatus("");
  });

  nodes.audioPlayer.addEventListener("ended", async () => {
    if (state.playbackMode === "loop") return;
    const nextSong = nextSongByMode(1);
    if (nextSong) await selectSong(nextSong.id, { autoplay: true });
  });

  nodes.playlistList.addEventListener("click", (event) => {
    const row = event.target.closest(".playlist-row");
    if (!row) return;
    const playlistId = row.dataset.playlistId;
    if (event.target.closest(".playlist-remove")) {
      deletePlaylist(playlistId);
      return;
    }
    if (event.target.closest(".playlist-main")) {
      setMobileMenuOpen(false);
      switchView("playlist", playlistId);
    }
  });

  nodes.mobileMenuToggle?.addEventListener("click", () => {
    setMobileMenuOpen(!mobileMenuOpen);
  });

  nodes.mobileMenuBackdrop?.addEventListener("click", () => {
    setMobileMenuOpen(false);
  });
}

async function bootstrap() {
  loadFavorites();
  loadPlaylists();
  await loadOfficialPlaylists();
  bindEvents();
  renderFavorites();
  renderPlaylists();
  renderTransportLabels();
  nodes.audioPlayer.volume = 0.85;
  nodes.volumeControl.value = "85";
  mobileMediaQuery.addEventListener("change", () => {
    renderTransportLabels();
    if (!mobileMediaQuery.matches) setMobileMenuOpen(false);
  });
  await loadAppState();
  await loadLibrary({ reset: true });
  postJson("/api/warmup", { limit: 8 }).catch(() => {});
}

bootstrap();
