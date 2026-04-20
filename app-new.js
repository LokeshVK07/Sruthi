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
  albumFilter: "",
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
  queue: [],
  shuffleOrder: [],
  shuffleCursor: -1,
  summary: {
    albumCount: 0,
    trackCount: 0,
  },
  volumeLevel: 0.85,
  hiddenOfficialPlaylistSongs: {},
};

const nodes = {
  searchInput: document.querySelector("#search-input"),
  decadeFilter: document.querySelector("#decade-filter"),
  localSongs: document.querySelector("#local-songs"),
  mobileMenuToggle: document.querySelector("#mobile-menu-toggle"),
  mobileMenuBackdrop: document.querySelector("#mobile-menu-backdrop"),
  sideRail: document.querySelector("#side-rail"),
  playerBar: document.querySelector(".player-bar"),
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
  queueToggle: document.querySelector("#queue-toggle"),
  queuePanel: document.querySelector("#queue-panel"),
  queueCount: document.querySelector("#queue-count"),
  queueNowPlaying: document.querySelector("#queue-now-playing"),
  queueList: document.querySelector("#queue-list"),
  queueClose: document.querySelector("#queue-close"),
  queueClear: document.querySelector("#queue-clear"),
  queueBackdrop: document.querySelector("#queue-backdrop"),
  mobileModeToggle: document.querySelector("#mobile-mode-toggle"),
  mobileSpeedToggle: document.querySelector("#mobile-speed-toggle"),
  mobilePlayerMinimize: document.querySelector("#mobile-player-minimize"),
  playerAvatar: document.querySelector("#player-avatar"),
  speedSelect: document.querySelector("#speed-select"),
  volumeControl: document.querySelector("#volume-control"),
  volumeValue: document.querySelector("#volume-value"),
  mobileMiniPlayer: document.querySelector("#mobile-mini-player"),
  mobileMiniOpen: document.querySelector("#mobile-mini-open"),
  mobileMiniToggle: document.querySelector("#mobile-mini-toggle"),
  mobileMiniTitle: document.querySelector("#mobile-mini-title"),
  mobileMiniArtist: document.querySelector("#mobile-mini-artist"),
  mobileMiniArtImage: document.querySelector("#mobile-mini-art-image"),
  mobileMiniProgressBar: document.querySelector("#mobile-mini-progress-bar"),
  mobilePlayerPlaylistSelect: document.querySelector("#mobile-player-playlist"),
  songContextMenu: document.querySelector("#song-context-menu"),
  appToast: document.querySelector("#app-toast"),
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
const QUEUE_KEY = "sruthi-queue";
const OFFICIAL_PLAYLIST_HIDDEN_KEY = "sruthi-official-playlist-hidden";
let searchDebounce = null;
let isSeeking = false;
let mobileMenuOpen = false;
let mobilePlayerExpanded = false;
let mobilePlayerDrag = null;
let queuePanelOpen = false;
let activeSongMenuId = null;
const mobileMediaQuery = window.matchMedia("(max-width: 720px)");
let mediaPositionRaf = null;
let toastTimer = null;
const PLAYBACK_DEBUG_PREFIX = "[Sruthi Playback]";

// ─── Next-Track Preloader ────────────────────────────────────────────────────
// A hidden <audio> element that pre-loads the NEXT song while the current one
// is still playing. When the current track ends (even in a background/minimized
// tab), we can swap the buffer in and call .play() synchronously — no async
// fetch, no DOM blocking, no browser throttling issues.
const prefetchAudio = new Audio();
prefetchAudio.preload = "auto";
prefetchAudio.volume = 0; // silent — just pre-buffering
let prefetchedSongId = null;  // which song is currently loaded into prefetchAudio
let prefetchScheduled = false;


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

function clampVolume(value) {
  if (!Number.isFinite(value)) return 0.85;
  return Math.min(1, Math.max(0, value));
}

function setPlaybackStatus(text = "") {
  nodes.playbackStatus.textContent = text;
  nodes.playbackStatus.hidden = !text;
}

function currentArtworkUrl() {
  return new URL("./Sruthi_kutty.jpg", window.location.href).toString();
}

function artworkUrlForSong(song) {
  return currentArtworkUrl();
}

function syncVolumeUi() {
  const percent = Math.round(clampVolume(state.volumeLevel) * 100);
  nodes.volumeControl.value = String(percent);
  if (nodes.volumeValue) nodes.volumeValue.textContent = `${percent}%`;
}

function queueContains(songId) {
  return state.queue.includes(songId);
}

function playbackModeMeta(mode) {
  const map = {
    normal: { icon: "↻", label: "Normal" },
    shuffle: { icon: "🔀", label: "Shuffle" },
    repeat: { icon: "🔁", label: "Repeat" },
    loop: { icon: "🔂", label: "Loop One" },
  };
  return map[mode] || map.normal;
}

function nextPlaybackMode(mode) {
  const order = ["normal", "shuffle", "repeat", "loop"];
  const index = order.indexOf(mode);
  return order[(index + 1 + order.length) % order.length];
}

function nextPlaybackSpeed(speed) {
  const options = [0.75, 1, 1.25, 1.5, 2];
  const currentIndex = Math.max(0, options.findIndex((value) => Number(value) === Number(speed)));
  return options[(currentIndex + 1) % options.length];
}

function showToast(message) {
  if (!nodes.appToast) return;
  window.clearTimeout(toastTimer);
  nodes.appToast.textContent = message;
  nodes.appToast.classList.remove("hidden");
  nodes.appToast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => {
    nodes.appToast.classList.remove("is-visible");
    nodes.appToast.classList.add("hidden");
  }, 1800);
}

function logPlaybackDebug(event, details = {}) {
  try {
    console.info(PLAYBACK_DEBUG_PREFIX, event, details);
  } catch (_) {
    // ignore console failures
  }
}

function iconMarkup(name) {
  const icons = {
    previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6zM18.5 6.8v10.4c0 .8-.9 1.3-1.6.8l-7-5.2a1 1 0 0 1 0-1.6l7-5.2c.7-.5 1.6 0 1.6.8z" fill="currentColor"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 5h2v14h-2zM5.5 6.8v10.4c0 .8.9 1.3 1.6.8l7-5.2a1 1 0 0 0 0-1.6l-7-5.2c-.7-.5-1.6 0-1.6.8z" fill="currentColor"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.7 5.4 18 11.2a1 1 0 0 1 0 1.6l-9.3 5.8A1 1 0 0 1 7 17.7V6.3a1 1 0 0 1 1.7-.9z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3v14H7zm7 0h3v14h-3z" fill="currentColor"/></svg>',
    favorite: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 20.4-1.4-1.3C5.4 14.2 2 11.1 2 7.3 2 4.4 4.2 2 7.1 2c1.7 0 3.3.8 4.3 2.1C12.5 2.8 14.1 2 15.8 2 18.8 2 21 4.4 21 7.3c0 3.8-3.4 6.9-8.6 11.8L12 20.4Z" fill="currentColor"/></svg>',
    favoriteFilled: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 21.2-1.1-1C5.2 15 2 12 2 8.1 2 5.2 4.2 3 7.1 3c1.8 0 3.4.9 4.4 2.2C12.5 3.9 14.1 3 15.9 3 18.8 3 21 5.2 21 8.1c0 3.9-3.2 6.9-8.9 12.1l-1.1 1Z" fill="currentColor"/></svg>',
    queue: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14v2H5zm0 4h14v2H5zm0 4h10v2H5z" fill="currentColor"/></svg>',
  };
  return icons[name] || "";
}

function syncMobilePlayerUi() {
  const song = selectedSong();
  const hasSong = Boolean(song);
  const shouldUseMobile = mobileMediaQuery.matches;
  if (nodes.mobileMiniPlayer) {
    nodes.mobileMiniPlayer.hidden = !hasSong || !shouldUseMobile || mobilePlayerExpanded;
  }
  document.body.classList.toggle("has-mobile-player", hasSong && shouldUseMobile);
  document.body.classList.toggle("mobile-player-expanded", hasSong && shouldUseMobile && mobilePlayerExpanded);

  if (!hasSong || !shouldUseMobile) {
    if (nodes.mobileMiniArtImage) nodes.mobileMiniArtImage.src = currentArtworkUrl();
    mobilePlayerExpanded = false;
    return;
  }

  nodes.mobileMiniTitle.textContent = song.title;
  nodes.mobileMiniArtist.textContent = song.artist || song.composer || "Unknown artist";
  if (nodes.mobileMiniArtImage) nodes.mobileMiniArtImage.src = artworkUrlForSong(song);
  const playing = !nodes.audioPlayer.paused;
  nodes.mobileMiniToggle.innerHTML = iconMarkup(playing ? "pause" : "play");
  nodes.mobileMiniToggle.setAttribute("aria-label", playing ? "Pause" : "Play");
}

function syncMiniPlayerProgress() {
  if (!nodes.mobileMiniProgressBar) return;
  const duration = nodes.audioPlayer.duration;
  const currentTime = nodes.audioPlayer.currentTime;
  const percent = Number.isFinite(duration) && duration > 0 ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;
  nodes.mobileMiniProgressBar.style.width = `${percent}%`;
}

function setMobilePlayerExpanded(expanded) {
  mobilePlayerExpanded = Boolean(expanded && mobileMediaQuery.matches && selectedSong());
  if (!mobilePlayerExpanded && nodes.playerBar) {
    nodes.playerBar.style.removeProperty("--player-drag-offset");
    nodes.playerBar.classList.remove("is-dragging");
  }
  syncMobilePlayerUi();
}

function startMobilePlayerDrag(startY) {
  if (!mobileMediaQuery.matches || !mobilePlayerExpanded || !nodes.playerBar) return;
  mobilePlayerDrag = { startY, offset: 0 };
  nodes.playerBar.classList.add("is-dragging");
}

function updateMobilePlayerDrag(currentY) {
  if (!mobilePlayerDrag || !nodes.playerBar) return;
  const offset = Math.max(0, currentY - mobilePlayerDrag.startY);
  mobilePlayerDrag.offset = offset;
  nodes.playerBar.style.setProperty("--player-drag-offset", `${offset}px`);
}

function endMobilePlayerDrag() {
  if (!mobilePlayerDrag || !nodes.playerBar) return;
  const shouldClose = mobilePlayerDrag.offset > 110;
  nodes.playerBar.classList.remove("is-dragging");
  nodes.playerBar.style.removeProperty("--player-drag-offset");
  mobilePlayerDrag = null;
  if (shouldClose) {
    setMobilePlayerExpanded(false);
  }
}

function updateMediaSessionPosition() {
  if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setPositionState !== "function") return;
  const duration = nodes.audioPlayer.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: nodes.audioPlayer.playbackRate || 1,
      position: Math.min(duration, Math.max(0, nodes.audioPlayer.currentTime || 0)),
    });
  } catch (_) {
    // ignore unsupported states
  }
}

function scheduleMediaSessionPosition() {
  if (mediaPositionRaf) return;
  mediaPositionRaf = window.requestAnimationFrame(() => {
    mediaPositionRaf = null;
    updateMediaSessionPosition();
  });
}

const playerAPI = {
  play: () => playCurrentSong(),
  pause: () => nodes.audioPlayer.pause(),
  togglePlayPause: () => togglePlayback(),
  next: () => stepTrack(1),
  previous: () => stepTrack(-1),
  seekBy: (seconds) => {
    const duration = Number.isFinite(nodes.audioPlayer.duration) ? nodes.audioPlayer.duration : Number.MAX_SAFE_INTEGER;
    nodes.audioPlayer.currentTime = Math.max(0, Math.min(duration, (nodes.audioPlayer.currentTime || 0) + seconds));
    updateTransportState();
  },
  volumeUp: () => applyVolume(state.volumeLevel + 0.1),
  volumeDown: () => applyVolume(state.volumeLevel - 0.1),
  toggleMute: () => applyVolume(state.volumeLevel > 0 ? 0 : 0.85),
  toggleShuffle: () => {
    setPlaybackMode(state.playbackMode === 'shuffle' ? 'normal' : 'shuffle');
    if (nodes.playbackMode) nodes.playbackMode.value = state.playbackMode;
    showToast(playbackModeMeta(state.playbackMode).label);
  },
  cycleRepeatMode: () => {
    const nextMode = state.playbackMode === 'repeat' ? 'loop' : (state.playbackMode === 'loop' ? 'normal' : 'repeat');
    setPlaybackMode(nextMode);
    if (nodes.playbackMode) nodes.playbackMode.value = state.playbackMode;
    showToast(playbackModeMeta(state.playbackMode).label);
  },
  toggleLike: () => toggleFavoriteForSelectedSong(),
  toggleFullscreen: () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  },
  focusSearch: () => {
    if (nodes.searchInput) nodes.searchInput.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  toggleQueue: () => {
    if (nodes.queueToggle && nodes.queuePanel) {
      nodes.queueToggle.click();
    } else {
      const nextOpen = !queuePanelOpen;
      setQueuePanelOpen(nextOpen);
      if (nextOpen) ensureQueueSongsCached().then(() => renderQueuePanel());
    }
  },
  closePanels: () => {
    setQueuePanelOpen(false);
    closeSongContextMenu();
    const modal = document.getElementById("shortcuts-modal");
    if (modal) modal.hidden = true;
  },
  get isPlaying() { return !nodes.audioPlayer.paused; },
  get currentTrack() {
    const song = selectedSong();
    return song ? {
      title: song.title || "Sruthi",
      artist: song.artist || song.composer || "Tamil Music Vault",
      album: song.movie || "Sruthi",
      artwork: [{ src: artworkUrlForSong(song), sizes: "512x512", type: "image/jpeg" }]
    } : null;
  }
};

function updateMetadata(track) {
  if (!("mediaSession" in navigator)) return;
  if (!track) {
    navigator.mediaSession.metadata = null;
    return;
  }
  try {
    navigator.mediaSession.metadata = new MediaMetadata(track);
  } catch (_) {}
}

function updatePlaybackState(player) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = player.isPlaying ? "playing" : "paused";
  updateMediaSessionPosition();
}

function setupMediaSession(player) {
  if (!("mediaSession" in navigator)) return;
  const bindings = {
    play: () => player.play(),
    pause: () => player.pause(),
    // nexttrack / previoustrack use a dedicated background-safe handler so that
    // car stereos, Bluetooth speakers, and the OS notification bar all work
    // correctly even when the tab is minimized or switched away.
    previoustrack: () => stepTrackFromExternal(-1),
    nexttrack:     () => stepTrackFromExternal(1),
    seekbackward: (details) => player.seekBy(-(details?.seekOffset || 10)),
    seekforward:  (details) => player.seekBy(details?.seekOffset || 10),
    seekto: (details) => {
      if (Number.isFinite(details?.seekTime)) {
        nodes.audioPlayer.currentTime = details.seekTime;
        updateTransportState();
      }
    }
  };
  Object.entries(bindings).forEach(([action, handler]) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {}
  });
}

function setupKeyboardShortcuts(player) {
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target.matches("input, textarea, [contenteditable]")) return;
    
    switch (event.key) {
      case " ":
      case "k": case "K":
        event.preventDefault();
        player.togglePlayPause();
        break;
      case "ArrowRight":
      case "n": case "N":
        player.next();
        break;
      case "ArrowLeft":
      case "p": case "P":
        player.previous();
        break;
      case "ArrowUp":
        event.preventDefault();
        player.volumeUp();
        break;
      case "ArrowDown":
        event.preventDefault();
        player.volumeDown();
        break;
      case "m": case "M":
        player.toggleMute();
        break;
      case "j": case "J":
        player.seekBy(-10);
        break;
      case "f": case "F":
        player.toggleFullscreen();
        break;
      case "s": case "S":
        player.toggleShuffle();
        break;
      case "r": case "R":
        player.cycleRepeatMode();
        break;
      case "l": case "L":
        player.toggleLike();
        break;
      case "/":
        event.preventDefault();
        player.focusSearch();
        break;
      case "q": case "Q":
        player.toggleQueue();
        break;
      case "?": {
        const modal = document.getElementById("shortcuts-modal");
        if (modal) modal.hidden = !modal.hidden;
        break;
      }
    }
  });
}

function syncMediaSession() {
  updatePlaybackState(playerAPI);
  const track = playerAPI.currentTrack;
  updateMetadata(track);
}

function bindMediaSessionHandlers() {
  setupMediaSession(playerAPI);
  setupKeyboardShortcuts(playerAPI);
}

async function applyVolume(nextVolume) {
  state.volumeLevel = clampVolume(nextVolume);
  nodes.audioPlayer.volume = state.volumeLevel;
  syncVolumeUi();
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

function getContext() {
  return state.songs.map(s => s.id);
}

function rebuildShuffleOrder() {
  const ids = getContext().filter(Boolean);
  if (!ids.length) {
    state.shuffleOrder = [];
    state.shuffleCursor = -1;
    return;
  }
  const currentId = state.selectedSongId;
  const remaining = ids.filter((id) => id !== currentId);
  for (let index = remaining.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [remaining[index], remaining[swapIndex]] = [remaining[swapIndex], remaining[index]];
  }
  state.shuffleOrder = currentId && ids.includes(currentId) ? [currentId, ...remaining] : remaining;
  state.shuffleCursor = currentId ? state.shuffleOrder.indexOf(currentId) : 0;
}

function ensureShuffleCursor() {
  if (state.playbackMode !== "shuffle") return;
  const songIds = getContext();
  if (
    !state.shuffleOrder.length ||
    state.shuffleOrder.length !== songIds.length ||
    state.shuffleOrder.some((id) => !songIds.includes(id))
  ) {
    rebuildShuffleOrder();
    return;
  }
  state.shuffleCursor = state.shuffleOrder.indexOf(state.selectedSongId);
  if (state.shuffleCursor < 0) {
    rebuildShuffleOrder();
  }
}

function setPlaybackMode(mode) {
  state.playbackMode = mode;
  if (state.playbackMode === "shuffle") {
    ensureShuffleCursor();
  }
  nodes.audioPlayer.loop = state.playbackMode === "loop";
  updateTransportState();
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

function hiddenSongIdsForPlaylist(playlistId) {
  return new Set(state.hiddenOfficialPlaylistSongs[playlistId] || []);
}

function applyOfficialPlaylistVisibility(playlist, songIds) {
  if (!playlist?.official) return [...songIds];
  const hidden = hiddenSongIdsForPlaylist(playlist.id);
  return songIds.filter((songId) => !hidden.has(songId));
}

function currentCollectionTitle() {
  if (state.currentView === "favorites") return "Favourites";
  if (state.currentView === "playlist") {
    const playlist = currentPlaylist();
    return playlist?.official ? officialPlaylistDisplayName(playlist.name) : playlist?.name || "Playlist";
  }
  if (state.albumFilter) return state.albumFilter;
  return "Song Collection";
}

async function openAlbumView(movieName) {
  const movie = sanitizeText(movieName);
  if (!movie) return;
  if (mobileMediaQuery.matches) {
    setMobilePlayerExpanded(false);
  }
  state.currentView = "all";
  state.currentPlaylistId = null;
  state.albumFilter = movie;
  state.query = "";
  state.offset = 0;
  if (nodes.searchInput) nodes.searchInput.value = "";
  renderFavorites();
  renderPlaylists();
  window.scrollTo({ top: 0, behavior: "smooth" });
  await loadLibrary({ reset: true });
}

function renderMobilePlayerPlaylistPicker() {
  if (!nodes.mobilePlayerPlaylistSelect) return;
  const picker = nodes.mobilePlayerPlaylistSelect;
  picker.innerHTML = "";
  picker.append(new Option("Add to playlist", ""));
  state.playlists.forEach((playlist) => picker.append(new Option(playlist.name, playlist.id)));
  picker.disabled = !state.playlists.length || !state.selectedSongId;
  picker.value = "";
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

function saveQueue() {
  window.localStorage.setItem(QUEUE_KEY, JSON.stringify(state.queue));
}

function saveHiddenOfficialPlaylistSongs() {
  window.localStorage.setItem(OFFICIAL_PLAYLIST_HIDDEN_KEY, JSON.stringify(state.hiddenOfficialPlaylistSongs));
}

function loadQueue() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(QUEUE_KEY) || "[]");
    state.queue = Array.isArray(stored) ? stored.filter(Boolean) : [];
  } catch (_) {
    state.queue = [];
  }
}

function loadHiddenOfficialPlaylistSongs() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(OFFICIAL_PLAYLIST_HIDDEN_KEY) || "{}");
    state.hiddenOfficialPlaylistSongs = stored && typeof stored === "object" ? stored : {};
  } catch (_) {
    state.hiddenOfficialPlaylistSongs = {};
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
            songIds: applyOfficialPlaylistVisibility(
              { id: sanitizeText(playlist.id), official: true },
              Array.isArray(playlist.songIds) ? playlist.songIds.filter(Boolean) : [],
            ),
            songCount: Math.max(
              0,
              Number(playlist.songCount || (Array.isArray(playlist.songIds) ? playlist.songIds.length : 0))
                - hiddenSongIdsForPlaylist(sanitizeText(playlist.id)).size,
            ),
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

function songSnapshotById(songId) {
  return state.songCache.get(songId)
    || state.songs.find((song) => song.id === songId)
    || state.favorites.find((song) => song.id === songId)
    || null;
}

function queuedSongs() {
  return state.queue.map((songId) => ({
    id: songId,
    song: songSnapshotById(songId),
  }));
}

async function ensureQueueSongsCached() {
  await ensureSongsCached(state.queue.slice(0, 60));
}

function closeSongContextMenu() {
  activeSongMenuId = null;
  document.querySelectorAll(".song-menu-toggle.is-active").forEach((button) => button.classList.remove("is-active"));
  if (!nodes.songContextMenu) return;
  nodes.songContextMenu.classList.add("hidden");
  nodes.songContextMenu.setAttribute("aria-hidden", "true");
}

function setQueuePanelOpen(nextOpen) {
  queuePanelOpen = Boolean(nextOpen);
  document.body.classList.toggle("queue-panel-open", queuePanelOpen);
  renderQueuePanel();
}

function positionQueuePanel() {
  if (!nodes.queuePanel || !nodes.queueToggle || nodes.queuePanel.hidden) return;
  nodes.queuePanel.style.left = "";
  nodes.queuePanel.style.top = "";
  nodes.queuePanel.style.right = "";
  nodes.queuePanel.style.bottom = "";
  if (mobileMediaQuery.matches) return;

  const triggerRect = nodes.queueToggle.getBoundingClientRect();
  const panelRect = nodes.queuePanel.getBoundingClientRect();
  const gap = 10;
  const width = panelRect.width || 420;
  const height = Math.min(panelRect.height || 260, 300);
  const left = Math.min(
    window.innerWidth - width - 16,
    Math.max(16, triggerRect.right - width),
  );
  const top = Math.max(88, triggerRect.top - height - gap);
  nodes.queuePanel.style.left = `${left}px`;
  nodes.queuePanel.style.top = `${top}px`;
}

function positionSongContextMenu(anchor) {
  if (!nodes.songContextMenu || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const menu = nodes.songContextMenu;
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.classList.remove("hidden");
  menu.setAttribute("aria-hidden", "false");
  const width = menu.offsetWidth || 180;
  const height = menu.offsetHeight || 120;
  const left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.right - width));
  const top = Math.min(window.innerHeight - height - 12, rect.bottom + 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function openSongContextMenu(songId, anchor) {
  activeSongMenuId = songId;
  document.querySelectorAll(".song-menu-toggle.is-active").forEach((button) => button.classList.remove("is-active"));
  anchor?.classList.add("is-active");
  const favoriteLabel = nodes.songContextMenu?.querySelector('[data-action="favorite"] .song-context-label');
  const favoriteIcon = nodes.songContextMenu?.querySelector('[data-action="favorite"] .song-context-icon');
  const queueLabel = nodes.songContextMenu?.querySelector('[data-action="queue"] .song-context-label');
  const queueIcon = nodes.songContextMenu?.querySelector('[data-action="queue"] .song-context-icon');
  if (favoriteLabel) favoriteLabel.textContent = isFavorite(songId) ? "Saved" : "Favourites";
  if (favoriteIcon) favoriteIcon.textContent = isFavorite(songId) ? "♥" : "♡";
  if (queueLabel) queueLabel.textContent = queueContains(songId) ? "Queued" : "Queue";
  if (queueIcon) queueIcon.textContent = queueContains(songId) ? "✓" : "☰";
  positionSongContextMenu(anchor);
}

let queueSortable = null;

function renderQueuePanel() {
  if (!nodes.queuePanel || !nodes.queueList || !nodes.queueCount || !nodes.queueToggle) return;
  const songs = queuedSongs();
  nodes.queueCount.textContent = `${state.queue.length}`;
  nodes.queueToggle.setAttribute("aria-expanded", queuePanelOpen ? "true" : "false");
  nodes.queueToggle.dataset.count = state.queue.length ? String(state.queue.length) : "";
  nodes.queueToggle.title = state.queue.length ? `Show queue (${state.queue.length})` : "Show queue";
  nodes.queueToggle.classList.toggle("is-open", queuePanelOpen);
  nodes.queuePanel.hidden = !queuePanelOpen;
  
  if (nodes.queueClear) nodes.queueClear.style.display = state.queue.length ? "inline-block" : "none";
  if (nodes.queueBackdrop) nodes.queueBackdrop.hidden = !queuePanelOpen || !mobileMediaQuery.matches;
  
  if (nodes.queueNowPlaying) {
    nodes.queueNowPlaying.innerHTML = "";
    if (state.selectedSongId) {
      const nowSong = state.songCache.get(state.selectedSongId);
      nodes.queueNowPlaying.innerHTML = `
        <div class="queue-section-header">Now Playing</div>
        <div class="queue-row is-now-playing">
          <div class="queue-main">
            <span class="queue-copy">
              <strong>${nowSong?.title || state.selectedSongId}</strong>
            </span>
          </div>
        </div>
      `;
    }
  }

  let manualList = nodes.queueList.querySelector('.manual-list');
  if (!manualList) {
    manualList = document.createElement("div");
    manualList.className = "manual-list queue-group";
    nodes.queueList.append(manualList);
  }
  manualList.innerHTML = "";
  
  if (state.queue.length) {
    const queueHeader = document.createElement("div");
    queueHeader.className = "queue-section-header manual-header";
    queueHeader.textContent = "Up Next";
    manualList.append(queueHeader);
    
    songs.forEach((entry, index) => {
      const song = entry.song;
      const row = document.createElement("div");
      row.className = "queue-row is-manual";
      row.dataset.songId = entry.id;
      row.innerHTML = `
        <div class="drag-handle" aria-hidden="true">☰</div>
        <button class="queue-main" type="button" style="grid-column: 2 / 2;">
          <span class="queue-copy">
            <strong>${song?.title || entry.id}</strong>
          </span>
        </button>
        <button class="queue-remove" type="button" aria-label="Remove from queue">×</button>
      `;
      manualList.append(row);
    });
  }

  const contextIds = getContext();
  const currentIndex = contextIds.indexOf(state.selectedSongId);
  const upcomings = (currentIndex >= 0 ? contextIds.slice(currentIndex + 1) : contextIds)
                      .filter(id => !state.queue.includes(id));
  let contextList = nodes.queueList.querySelector('.context-list');
  if (!contextList) {
    contextList = document.createElement("div");
    contextList.className = "context-list queue-group";
    nodes.queueList.append(contextList);
  }
  contextList.innerHTML = "";

  if (upcomings.length) {
    const contextHeader = document.createElement("div");
    contextHeader.className = "queue-section-header context-header";
    contextHeader.textContent = "Next From Context";
    contextList.append(contextHeader);

    upcomings.forEach((id) => {
      const song = state.songCache.get(id);
      const row = document.createElement("div");
      row.className = "queue-row is-context";
      row.dataset.songId = id;
      row.innerHTML = `
        <div class="drag-handle" aria-hidden="true">☰</div>
        <button class="queue-main" type="button" style="grid-column: 2 / 2;">
          <span class="queue-copy">
            <strong>${song?.title || id}</strong>
          </span>
        </button>
        <button class="queue-remove" type="button" aria-label="Skip track">×</button>
      `;
      contextList.append(row);
    });
  }

  const oldEmpty = nodes.queueList.querySelector('.queue-empty');
  if (oldEmpty) oldEmpty.remove();

  if (!state.queue.length && !upcomings.length) {
    const empty = document.createElement("div");
    empty.className = "queue-empty";
    empty.textContent = "No songs in queue yet.";
    nodes.queueList.append(empty);
  }

  positionQueuePanel();

  if (window.Sortable && queuePanelOpen) {
    if (!window.manualSortable && manualList) {
      window.manualSortable = new Sortable(manualList, {
        group: 'queue',
        animation: 150,
        handle: '.drag-handle',
        draggable: '.queue-row',
        ghostClass: 'sortable-ghost',
        onEnd: function () {
          const domNodes = Array.from(nodes.queueList.querySelectorAll('.queue-row'));
          state.queue = domNodes.map(el => el.dataset.songId);
          saveQueue();
          renderSongs();
          renderQueuePanel();
        }
      });
    }
    if (!window.contextSortable && contextList) {
      window.contextSortable = new Sortable(contextList, {
        group: 'queue',
        animation: 150,
        handle: '.drag-handle',
        draggable: '.queue-row',
        ghostClass: 'sortable-ghost',
        onEnd: function () {
          const domNodes = Array.from(nodes.queueList.querySelectorAll('.queue-row'));
          state.queue = domNodes.map(el => el.dataset.songId);
          saveQueue();
          renderSongs();
          renderQueuePanel();
        }
      });
    }
  }
}

async function addSongToQueue(songId) {
  if (!songId) return;
  state.queue = [songId, ...state.queue.filter((id) => id !== songId)];
  saveQueue();
  showToast("Added to play next");
  await ensureSongsCached([songId]);
  renderQueuePanel();
  renderSongs();
}

function removeSongFromQueue(songId) {
  state.queue = state.queue.filter((id) => id !== songId);
  saveQueue();
  renderQueuePanel();
  renderSongs();
}

function clearQueue() {
  state.queue = [];
  saveQueue();
  renderQueuePanel();
  renderSongs();
}

function orderedFavorites() {
  const items = [...state.favorites];
  switch (state.favoriteSort) {
    case "recent":
      return items.reverse();
    case "title":
      return items.sort((a, b) => sanitizeText(a.title).localeCompare(sanitizeText(b.title)));
    case "composer":
      return items.sort((a, b) => {
        const composerRank = sanitizeText(a.composer).localeCompare(sanitizeText(b.composer));
        return composerRank || sanitizeText(a.title).localeCompare(sanitizeText(b.title));
      });
    case "manual":
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

  const ctx = getContext();
  const hasSongs = ctx.length > 0;
  const queueHasSongs = state.queue.length > 0;
  nodes.previousTrack.disabled = !hasSongs;
  nodes.nextTrack.disabled = !(hasSongs || queueHasSongs);
  nodes.favoriteToggle.classList.toggle("is-active", isFavorite(state.selectedSongId));
  nodes.favoriteToggle.textContent = mobileMediaQuery.matches
    ? (isFavorite(state.selectedSongId) ? "♥" : "♡")
    : (isFavorite(state.selectedSongId) ? "♥" : "♡");
  nodes.speedSelect.value = String(state.playbackSpeed);
  nodes.playbackMode.value = state.playbackMode;
  if (nodes.mobileModeToggle) {
    const modeMeta = playbackModeMeta(state.playbackMode);
    nodes.mobileModeToggle.textContent = modeMeta.icon;
    nodes.mobileModeToggle.setAttribute("aria-label", modeMeta.label);
    nodes.mobileModeToggle.title = modeMeta.label;
  }
  if (nodes.mobileSpeedToggle) {
    const speedLabel = `${Number(state.playbackSpeed).toString().replace(/\.0$/, "")}x`;
    nodes.mobileSpeedToggle.textContent = speedLabel;
    nodes.mobileSpeedToggle.setAttribute("aria-label", `Playback speed ${speedLabel}`);
    nodes.mobileSpeedToggle.title = `Playback speed ${speedLabel}`;
  }
  syncVolumeUi();
  syncMiniPlayerProgress();

  renderTransportLabels();
  syncMobilePlayerUi();
  syncMediaSession();
}

function renderTransportLabels() {
  const playing = !nodes.audioPlayer.paused;
  nodes.previousTrack.innerHTML = iconMarkup("previous");
  nodes.nextTrack.innerHTML = iconMarkup("next");
  nodes.playToggle.innerHTML = iconMarkup(playing ? "pause" : "play");
  if (nodes.favoriteToggle) {
    const saved = isFavorite(state.selectedSongId);
    nodes.favoriteToggle.innerHTML = iconMarkup(saved ? "favoriteFilled" : "favorite");
    nodes.favoriteToggle.setAttribute("aria-label", saved ? "Remove from favourites" : "Add to favourites");
    nodes.favoriteToggle.title = saved ? "Saved to favourites" : "Add to favourites";
  }
  if (nodes.queueToggle) {
    nodes.queueToggle.innerHTML = iconMarkup("queue");
  }
  nodes.previousTrack.setAttribute("aria-label", "Previous track");
  nodes.nextTrack.setAttribute("aria-label", "Next track");
  nodes.playToggle.setAttribute("aria-label", playing ? "Pause" : "Play");
  if (nodes.mobileMiniToggle) {
    nodes.mobileMiniToggle.innerHTML = iconMarkup(playing ? "pause" : "play");
    nodes.mobileMiniToggle.setAttribute("aria-label", playing ? "Pause" : "Play");
  }
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
      if (!state.query) return 0;
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
        const songIds = applyOfficialPlaylistVisibility(playlist, songs.map((song) => song.id).filter(Boolean));
        cacheSongs(songs);
        songs.forEach(syncFavoriteSnapshot);
        playlist.songIds = songIds;
        playlist.songCount = songIds.length;
        const rawSongs = songIds.map((songId) => state.songCache.get(songId)).filter(Boolean);
        const displayName = officialPlaylistDisplayName(playlist.name);
        let filtered = rawSongs;

        // Strict composer filtering for "Hits" playlists
        if (displayName.endsWith(" Hits")) {
          const targetComposer = displayName.replace(" Hits", "").toLowerCase().trim();
          filtered = rawSongs.filter(song => {
            const songComposer = (song.composer || "").toLowerCase();
            const songArtist = (song.artist || "").toLowerCase();
            return songComposer.includes(targetComposer) || songArtist.includes(targetComposer);
          });
        }

        filtered = filterClientSongs(filtered);
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
  const menuButton = row.querySelector(".song-menu-toggle");
  if (menuButton) {
    menuButton.textContent = "⋯";
    menuButton.setAttribute("aria-label", `Song actions for ${song.title}`);
    menuButton.classList.toggle("is-active", activeSongMenuId === song.id);
  }
}

function renderSongs() {
  nodes.songList.innerHTML = "";
  nodes.resultCount.textContent = `${state.totalSongs} songs`;
  nodes.collectionTitle.textContent = currentCollectionTitle();
  nodes.collectionSortWrap.classList.toggle("hidden", state.currentView !== "favorites");
  nodes.showAllRail.classList.remove("hidden");
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
  renderQueuePanel();
}

function renderSelectedSong() {
  const song = selectedSong();
  if (!song) {
    nodes.nowTitle.textContent = "Choose a song";
    nodes.nowArtist.textContent = "Select a track from the library.";
    nodes.nowMovie.textContent = "-";
    nodes.nowMovie.disabled = true;
    nodes.nowYear.textContent = "-";
    nodes.nowComposer.textContent = "-";
    if (nodes.playerAvatar) nodes.playerAvatar.src = currentArtworkUrl();
    if (nodes.mobileMiniArtImage) nodes.mobileMiniArtImage.src = currentArtworkUrl();
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
    setMobilePlayerExpanded(false);
    updateTransportState();
    return;
  }

  nodes.nowTitle.textContent = song.title;
  nodes.nowArtist.textContent = song.artist;
  nodes.nowMovie.textContent = song.movie || "-";
  nodes.nowMovie.title = song.movie || "";
  nodes.nowMovie.disabled = !sanitizeText(song.movie);
  nodes.nowYear.textContent = song.year || "-";
  nodes.nowYear.title = song.year ? String(song.year) : "";
  nodes.nowComposer.textContent = song.composer || "-";
  nodes.nowComposer.title = song.composer || "";
  if (nodes.playerAvatar) nodes.playerAvatar.src = artworkUrlForSong(song);
  if (nodes.mobileMiniArtImage) nodes.mobileMiniArtImage.src = artworkUrlForSong(song);
  renderMobilePlayerPlaylistPicker();
  state.playbackCandidates = playbackCandidatesForSong(song);
  const playbackUrl = state.playbackCandidates[0] || "";
  if (playbackUrl) {
    const absolute = new URL(playbackUrl, window.location.origin).toString();
    if (nodes.audioPlayer.src !== absolute) {
      logPlaybackDebug("source-assigned", {
        songId: song.id,
        title: song.title,
        src: playbackUrl,
      });
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

function assignAudioSource(song, reason = "unknown") {
  if (!song) return false;
  state.playbackCandidates = playbackCandidatesForSong(song);
  const playbackUrl = state.playbackCandidates[0] || "";
  if (!playbackUrl) return false;
  const absolute = new URL(playbackUrl, window.location.origin).toString();
  if (nodes.audioPlayer.src !== absolute) {
    logPlaybackDebug("next-track-source-assigned", {
      reason,
      songId: song.id,
      title: song.title,
      src: playbackUrl,
    });
    nodes.audioPlayer.src = playbackUrl;
    nodes.audioPlayer.load();
  }
  nodes.audioPlayer.loop = state.playbackMode === "loop";
  nodes.audioPlayer.playbackRate = state.playbackSpeed;
  return true;
}

async function playCurrentSong({ waitForReady = true, reason = "manual" } = {}) {
  const song = selectedSong();
  if (!song || !playbackUrlForSong(song)) return;
  try {
    if (waitForReady) {
      await waitForPlayableAudio();
    }
    logPlaybackDebug("play-attempt", {
      reason,
      songId: song.id,
      title: song.title,
      src: nodes.audioPlayer.currentSrc || playbackUrlForSong(song),
      readyState: nodes.audioPlayer.readyState,
    });
    await nodes.audioPlayer.play();
    logPlaybackDebug("play-succeeded", {
      songId: song.id,
      title: song.title,
      currentTime: nodes.audioPlayer.currentTime,
    });
    nodes.playToggle.textContent = "Pause";
  } catch (error) {
    logPlaybackDebug("play-failed", {
      songId: song.id,
      title: song.title,
      message: error?.message || String(error),
      name: error?.name || "Error",
    });
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
  // Reset prefetch state so the preloader re-runs for the new song's next track
  prefetchScheduled = false;
  prefetchedSongId = null;
  state.selectedSongId = songId;
  if (state.playbackMode === "shuffle") {
    ensureShuffleCursor();
  }
  renderQueuePanel();
  renderSongs();
  if (mobileMediaQuery.matches) {
    setMobilePlayerExpanded(true);
  }
  const song = selectedSong();
  if (song) {
    assignAudioSource(song, autoplay ? "autoplay-select" : "select");
    syncMediaSession();
  }
  const index = selectedSongIndex();
  prefetchSongIds([songId, state.songs[index - 1]?.id, state.songs[index + 1]?.id]);
  // Eagerly cache adjacent songs so external controls (car/Bluetooth) always have URLs
  void preCacheAdjacentSongs();
  if (autoplay) await playCurrentSong({ waitForReady: false, reason: "select-song" });
}

function getNextIndex() {
  const ctx = getContext();
  if (!ctx.length) return -1;
  const currentIndex = ctx.indexOf(state.selectedSongId);
  if (currentIndex < 0) return 0;
  if (state.playbackMode === "loop") return currentIndex;
  if (state.playbackMode === "shuffle") {
    ensureShuffleCursor();
    const nextCursor = state.shuffleCursor + 1;
    if (nextCursor < state.shuffleOrder.length) {
      const nextId = state.shuffleOrder[nextCursor];
      return ctx.indexOf(nextId);
    }
    if (state.playbackMode === "repeat") return currentIndex;
    if (ctx.length > 1) {
      rebuildShuffleOrder();
      if (state.playbackMode === "shuffle" && state.shuffleOrder.length) {
        const nextId = state.shuffleOrder[Math.min(1, state.shuffleOrder.length - 1)];
        return ctx.indexOf(nextId);
      }
    }
    return state.playbackMode === "repeat" ? 0 : -1;
  }
  if (currentIndex + 1 < ctx.length) return currentIndex + 1;
  if (state.playbackMode === "repeat") return 0;
  return -1;
}

function getPrevIndex() {
  const ctx = getContext();
  if (!ctx.length) return -1;
  const currentIndex = ctx.indexOf(state.selectedSongId);
  if (currentIndex < 0) return 0;
  if (state.playbackMode === "loop") return currentIndex;
  if (state.playbackMode === "shuffle") {
    ensureShuffleCursor();
    const prevCursor = state.shuffleCursor - 1;
    if (prevCursor >= 0) {
      const prevId = state.shuffleOrder[prevCursor];
      return ctx.indexOf(prevId);
    }
    return state.playbackMode === "repeat" ? currentIndex : -1;
  }
  if (currentIndex > 0) return currentIndex - 1;
  if (state.playbackMode === "repeat") return ctx.length - 1;
  return -1;
}

function generateSimilarSongs(sourceSong, limit = 15) {
  if (!sourceSong) return [];
  const songs = [...state.songCache.values()];
  const avoidIds = new Set([...state.queue, state.selectedSongId, sourceSong.id]);
  const candidates = songs.filter(song => {
    if (avoidIds.has(song.id)) return false;
    let match = false;
    // Prefer composer match if available
    if (sourceSong.composer && song.composer && sanitizeText(song.composer).includes(sanitizeText(sourceSong.composer))) match = true;
    // Fallback to album or year
    if (sourceSong.album && song.album === sourceSong.album) match = true;
    if (sourceSong.year && song.year === sourceSong.year) match = true;
    return match;
  });
  
  // Deterministic randomize
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, limit);
}

function nextSongByMode(direction = 1) {
  const ctx = getContext();
  if (!ctx.length) return null;
  if (direction > 0 && state.queue.length) {
    const nextQueuedId = state.queue.shift();
    saveQueue();
    renderQueuePanel();
    return state.songCache.get(nextQueuedId) || null;
  }
  const targetIndex = direction > 0 ? getNextIndex() : getPrevIndex();
  
  if (direction > 0 && targetIndex < 0) {
    const similar = generateSimilarSongs(selectedSong());
    if (similar.length) {
      state.queue = similar.map(s => s.id);
      const nextQueuedId = state.queue.shift();
      saveQueue();
      renderQueuePanel();
      return state.songCache.get(nextQueuedId) || null;
    }
  }

  if (targetIndex < 0) return null;
  const nextId = ctx[targetIndex];
  return state.songCache.get(nextId) || null;
}

// ─── Background-safe external track step ──────────────────────────────────────
// Called by car stereo / Bluetooth speaker / OS notification bar controls via
// the MediaSession API. The tab may be minimized or in the background when this
// fires. Requirements:
//   1. ZERO async blocking before play() — no waitForReady, no canplay wait
//   2. Update navigator.mediaSession.metadata BEFORE play() so the notification
//      bar shows the new song title/artist immediately
//   3. Defer all heavy DOM work (renderSongs, renderQueuePanel) to after play()
async function stepTrackFromExternal(direction) {
  const nextSong = nextSongByMode(direction);
  if (!nextSong) {
    logPlaybackDebug("external-step-no-next", { direction });
    return;
  }

  const url = playbackUrlForSong(nextSong);
  if (!url) {
    // Song URL not in cache — fetch it then retry once
    logPlaybackDebug("external-step-url-missing", { songId: nextSong.id });
    try {
      await fetchSongById(nextSong.id);
    } catch (_) {}
    const reloaded = state.songCache.get(nextSong.id);
    const retryUrl = reloaded ? playbackUrlForSong(reloaded) : "";
    if (!retryUrl) return;
    // Recurse with the data now available
    return stepTrackFromExternal(direction);
  }

  logPlaybackDebug("external-step", { direction, songId: nextSong.id, title: nextSong.title });

  // ── 1. Update state synchronously ────────────────────────────────────────
  prefetchScheduled = false;
  prefetchedSongId = null;
  state.selectedSongId = nextSong.id;
  if (state.playbackMode === "shuffle") ensureShuffleCursor();

  // ── 2. Push metadata to notification bar / car display IMMEDIATELY ───────
  // This is the only thing the car stereo / lock screen cares about.
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title:   nextSong.title  || "Sruthi",
        artist:  nextSong.artist || nextSong.composer || "Tamil Music Vault",
        album:   nextSong.movie  || "Sruthi",
        artwork: [{ src: artworkUrlForSong(nextSong), sizes: "512x512", type: "image/jpeg" }],
      });
      navigator.mediaSession.playbackState = "playing";
    } catch (_) {}
  }

  // ── 3. Swap audio source and play — NO waiting for canplay ───────────────
  nodes.audioPlayer.src = url;
  nodes.audioPlayer.loop  = state.playbackMode === "loop";
  nodes.audioPlayer.playbackRate = state.playbackSpeed;
  nodes.audioPlayer.volume = state.volumeLevel;

  try {
    await nodes.audioPlayer.play();
    logPlaybackDebug("external-step-play-started", { songId: nextSong.id });
    // Update position state so the car display shows correct progress
    if ("mediaSession" in navigator && typeof navigator.mediaSession.setPositionState === "function") {
      try { navigator.mediaSession.setPositionState({ duration: 0, playbackRate: state.playbackSpeed, position: 0 }); } catch (_) {}
    }
  } catch (err) {
    logPlaybackDebug("external-step-play-failed", { message: err?.message });
  }

  // ── 4. Defer heavy DOM work so it never races with play() ────────────────
  requestAnimationFrame(() => {
    const wasExpanded = mobilePlayerExpanded;
    renderSongs();
    renderQueuePanel();
    renderSelectedSong();
    syncMediaSession();
    if (mobileMediaQuery.matches && wasExpanded) setMobilePlayerExpanded(true);
    // Pre-cache the songs around the new current position
    void preCacheAdjacentSongs();
  });
}

// Pre-cache the songs immediately surrounding the current track so that
// external controls (car, Bluetooth) can always find a URL in cache.
async function preCacheAdjacentSongs() {
  const index = selectedSongIndex();
  if (index < 0) return;
  const nearby = [
    state.songs[index + 1]?.id,
    state.songs[index + 2]?.id,
    state.songs[index + 3]?.id,
    state.songs[index - 1]?.id,
    state.songs[index - 2]?.id,
  ].filter(Boolean);
  if (nearby.length) {
    await ensureSongsCached(nearby).catch(() => {});
  }
}

// ─── Next-track pre-loading ───────────────────────────────────────────────────
// Called during timeupdate when ~30 s remain. Loads the next song URL into
// the silent prefetchAudio element so it is buffered before the current track
// ends — meaning handleTrackEnd can swap and play without any async gap.
function scheduleNextTrackPrefetch() {
  if (prefetchScheduled) return;
  const song = selectedSong();
  if (!song) return;
  const duration = nodes.audioPlayer.duration;
  const currentTime = nodes.audioPlayer.currentTime;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const remaining = duration - currentTime;
  if (remaining > 35) return; // only start when 35 s or less remain

  prefetchScheduled = true;

  // Work out which song comes next (mirrors nextSongByMode logic but read-only)
  const peek = peekNextSong();
  if (!peek || peek.id === prefetchedSongId) return;

  const url = playbackUrlForSong(peek);
  if (!url) return;

  logPlaybackDebug("prefetch-next-track", { songId: peek.id, title: peek.title, remaining });
  prefetchedSongId = peek.id;
  prefetchAudio.src = url;
  prefetchAudio.load();
}

// Read-only version of nextSongByMode — does NOT mutate queue or shuffle state.
function peekNextSong() {
  const ctx = getContext();
  if (!ctx.length) return null;
  // Queue takes priority
  if (state.queue.length) {
    return state.songCache.get(state.queue[0]) || null;
  }
  const currentIndex = ctx.indexOf(state.selectedSongId);
  if (state.playbackMode === "loop") return state.songCache.get(ctx[currentIndex]) || null;
  if (state.playbackMode === "shuffle") {
    const nextCursor = state.shuffleCursor + 1;
    if (nextCursor < state.shuffleOrder.length) {
      return state.songCache.get(state.shuffleOrder[nextCursor]) || null;
    }
    return null;
  }
  const nextIdx = currentIndex + 1;
  if (nextIdx < ctx.length) return state.songCache.get(ctx[nextIdx]) || null;
  if (state.playbackMode === "repeat") return state.songCache.get(ctx[0]) || null;
  return null;
}

async function handleTrackEnd() {
  logPlaybackDebug("audio-ended", {
    songId: state.selectedSongId,
    title: selectedSong()?.title || "",
  });

  const nextSong = nextSongByMode(1);
  if (!nextSong) {
    logPlaybackDebug("next-track-resolved", { resolved: false, reason: "no-next-track" });
    nodes.audioPlayer.pause();
    updateTransportState();
    return;
  }

  logPlaybackDebug("next-track-resolved", {
    resolved: true,
    nextSongId: nextSong.id,
    nextTitle: nextSong.title,
    usedPrefetch: prefetchedSongId === nextSong.id,
  });

  // ── Critical path: do the MINIMUM to get audio playing immediately.
  // DOM renders are deferred so they never block the play() call.
  state.selectedSongId = nextSong.id;
  prefetchScheduled = false; // reset for the new track

  if (state.playbackMode === "shuffle") ensureShuffleCursor();

  const url = playbackUrlForSong(nextSong);
  if (!url) {
    updateTransportState();
    return;
  }

  // If the prefetchAudio has this track buffered, swap it into the main player
  // by just updating src (the browser keeps the buffered data).
  nodes.audioPlayer.src = url;
  nodes.audioPlayer.loop = state.playbackMode === "loop";
  nodes.audioPlayer.playbackRate = state.playbackSpeed;
  nodes.audioPlayer.volume = state.volumeLevel;

  // play() even in a background tab — browsers allow this for <audio> that
  // was already playing (autoplay policy satisfied by previous user gesture).
  try {
    await nodes.audioPlayer.play();
    logPlaybackDebug("next-track-play-started", { songId: nextSong.id });
  } catch (err) {
    logPlaybackDebug("next-track-play-failed", { message: err?.message });
  }

  // Defer heavy DOM work so it never races with play()
  requestAnimationFrame(() => {
    const wasExpanded = mobilePlayerExpanded;
    renderSongs();
    renderQueuePanel();
    renderSelectedSong();
    syncMediaSession();
    if (mobileMediaQuery.matches && wasExpanded) setMobilePlayerExpanded(true);
  });
}

async function stepTrack(direction) {
  if (direction < 0 && (nodes.audioPlayer.currentTime || 0) > 3) {
    nodes.audioPlayer.currentTime = 0;
    updateTransportState();
    return;
  }
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
  if (playlist.official) {
    const hidden = new Set(state.hiddenOfficialPlaylistSongs[playlist.id] || []);
    hidden.add(songId);
    state.hiddenOfficialPlaylistSongs[playlist.id] = [...hidden];
    saveHiddenOfficialPlaylistSongs();
    playlist.songIds = (playlist.songIds || []).filter((id) => id !== songId);
    playlist.songCount = Math.max(0, Number(playlist.songCount || 0) - 1);
    if (state.queue.includes(songId)) {
      removeSongFromQueue(songId);
    }
    renderPlaylists();
    loadCollectionView();
    return;
  }
  updatePlaylistInState(playlist.id, (item) => ({
    ...item,
    songIds: item.songIds.filter((id) => id !== songId),
  }));
  if (state.queue.includes(songId)) {
    removeSongFromQueue(songId);
  }
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
    showToast("Removed from favourites");
  } else {
    state.favorites.unshift({ id: song.id, title: song.title, composer: song.composer });
    showToast("Added to favourites");
  }
  saveFavorites();
  renderFavorites();
  updateTransportState();
  if (state.currentView === "favorites") loadCollectionView();
}

async function toggleFavoriteBySongId(songId) {
  if (!songId) return;
  if (!state.songCache.has(songId)) {
    try {
      await fetchSongById(songId);
    } catch (_) {
      return;
    }
  }
  const song = state.songCache.get(songId);
  if (!song) return;
  if (isFavorite(songId)) {
    state.favorites = state.favorites.filter((item) => item.id !== songId);
    showToast("Removed from favourites");
  } else {
    state.favorites.unshift({ id: song.id, title: song.title, composer: song.composer });
    showToast("Added to favourites");
  }
  saveFavorites();
  renderFavorites();
  if (state.currentView === "favorites") {
    await loadCollectionView();
  } else {
    renderSongs();
  }
  if (state.selectedSongId === songId) {
    updateTransportState();
  }
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
  state.albumFilter = "";
  state.offset = 0;
  state.query = "";
  if (nodes.searchInput) nodes.searchInput.value = "";
  renderFavorites();
  renderPlaylists();
  if (view === "playlist") {
    state.songs = [];
    state.totalSongs = currentPlaylist()?.songCount || 0;
    renderSongs();
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "all") {
    await loadLibrary({ reset: true });
    return;
  }
  await loadCollectionView();
}

async function refreshCurrentView() {
  state.songs = [];
  state.songCache.clear();
  state.offset = 0;
  state.hasMore = false;
  state.loading = false;
  await loadAppState();
  await loadOfficialPlaylists();
  renderPlaylists();
  renderFavorites();
  renderSongs();
  if (state.currentView === "all") {
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
      movie: state.albumFilter,
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
    syncMobilePlayerUi();
    return;
  }
  nodes.audioPlayer.pause();
  renderTransportLabels();
  syncMobilePlayerUi();
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
    nodes.refreshButton.disabled = true;
    try {
      await refreshCurrentView();
    } finally {
      nodes.refreshButton.disabled = false;
    }
  });

  nodes.playlistForm.addEventListener("submit", (event) => {
    event.preventDefault();
    createPlaylist(nodes.playlistInput.value);
  });

  nodes.songList.addEventListener("click", async (event) => {
    const menuToggle = event.target.closest(".song-menu-toggle");
    if (menuToggle) {
      const row = menuToggle.closest(".song-row");
      if (!row) return;
      if (activeSongMenuId === row.dataset.songId && !nodes.songContextMenu.classList.contains("hidden")) {
        closeSongContextMenu();
      } else {
        openSongContextMenu(row.dataset.songId, menuToggle);
      }
      return;
    }

    const songMain = event.target.closest(".song-main");
    if (songMain) {
      const row = songMain.closest(".song-row");
      closeSongContextMenu();
      await selectSong(row.dataset.songId, { autoplay: true });
      if (mobileMediaQuery.matches) {
        setMobilePlayerExpanded(true);
      }
      return;
    }

    const remove = event.target.closest(".song-remove");
    if (remove) {
      const row = remove.closest(".song-row");
      removeSongFromCurrentPlaylist(row.dataset.songId);
      closeSongContextMenu();
    }
  });

  nodes.songList.addEventListener("change", (event) => {
    const picker = event.target.closest(".playlist-pick");
    if (!picker || !picker.value) return;
    const row = picker.closest(".song-row");
    addSongToPlaylist(row.dataset.songId, picker.value);
    picker.value = "";
  });

  nodes.mobilePlayerPlaylistSelect?.addEventListener("change", (event) => {
    const playlistId = event.target.value;
    if (!playlistId || !state.selectedSongId) return;
    addSongToPlaylist(state.selectedSongId, playlistId);
    showToast("Added to playlist");
    event.target.value = "";
  });

  nodes.songList.addEventListener("mouseover", (event) => {
    const row = event.target.closest(".song-row");
    if (!row) return;
    prefetchSongIds([row.dataset.songId]);
  });

  nodes.playToggle.addEventListener("click", togglePlayback);
  nodes.previousTrack.addEventListener("click", () => stepTrack(-1));
  nodes.nextTrack.addEventListener("click", () => stepTrack(1));
  nodes.nowMovie?.addEventListener("click", async () => {
    const song = selectedSong();
    if (!song?.movie) return;
    await openAlbumView(song.movie);
  });
  nodes.playbackMode.addEventListener("change", (event) => {
    setPlaybackMode(event.target.value);
  });
  nodes.mobileModeToggle?.addEventListener("click", () => {
    setPlaybackMode(nextPlaybackMode(state.playbackMode));
    nodes.playbackMode.value = state.playbackMode;
    showToast(playbackModeMeta(state.playbackMode).label);
  });
  nodes.speedSelect.addEventListener("change", (event) => {
    state.playbackSpeed = Number(event.target.value) || 1;
    nodes.audioPlayer.playbackRate = state.playbackSpeed;
    updateTransportState();
  });
  nodes.mobileSpeedToggle?.addEventListener("click", () => {
    state.playbackSpeed = nextPlaybackSpeed(state.playbackSpeed);
    nodes.speedSelect.value = String(state.playbackSpeed);
    nodes.audioPlayer.playbackRate = state.playbackSpeed;
    updateTransportState();
    showToast(`Speed ${state.playbackSpeed}x`);
  });
  nodes.volumeControl.addEventListener("input", (event) => {
    void applyVolume(Number(event.target.value) / 100);
  });
  nodes.favoriteToggle.addEventListener("click", toggleFavoriteForSelectedSong);
  nodes.queueToggle?.addEventListener("click", async (event) => {
    event.stopPropagation();
    const nextOpen = !queuePanelOpen;
    setQueuePanelOpen(nextOpen);
    if (nextOpen) {
      void ensureQueueSongsCached().then(() => renderQueuePanel());
    }
  });

  nodes.queueClose?.addEventListener("click", (event) => {
    event.stopPropagation();
    setQueuePanelOpen(false);
  });

  nodes.queueClear?.addEventListener("click", (event) => {
    event.stopPropagation();
    clearQueue();
  });

  nodes.queueBackdrop?.addEventListener("click", () => {
    setQueuePanelOpen(false);
  });

  nodes.queueList?.addEventListener("click", async (event) => {
    event.stopPropagation();
    const row = event.target.closest(".queue-row");
    if (!row) return;
    const songId = row.dataset.songId;
    if (event.target.closest(".queue-remove")) {
      removeSongFromQueue(songId);
      return;
    }
    setQueuePanelOpen(false);
    
    if (row.classList.contains("is-manual")) {
      const queueIndex = state.queue.indexOf(songId);
      if (queueIndex >= 0) {
        state.queue = state.queue.slice(queueIndex + 1);
        saveQueue();
        renderQueuePanel();
      }
    }
    
    await selectSong(songId, { autoplay: true });
  });

  nodes.songContextMenu?.addEventListener("click", async (event) => {
    const action = event.target.closest("button")?.dataset.action;
    if (!action || !activeSongMenuId) return;
    const songId = activeSongMenuId;
    closeSongContextMenu();
    if (action === "favorite") {
      await toggleFavoriteBySongId(songId);
      return;
    }
    if (action === "queue") {
      await addSongToQueue(songId);
      return;
    }
  });

  document.addEventListener("click", (event) => {
    if (!nodes.songContextMenu || nodes.songContextMenu.classList.contains("hidden")) return;
    if (event.target.closest("#song-context-menu") || event.target.closest(".song-menu-toggle")) return;
    closeSongContextMenu();
  });

  document.addEventListener("click", (event) => {
    if (!queuePanelOpen) return;
    if (event.target.closest("#queue-panel") || event.target.closest("#queue-toggle")) return;
    setQueuePanelOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (queuePanelOpen) setQueuePanelOpen(false);
      if (activeSongMenuId) closeSongContextMenu();
    }
  });

  window.addEventListener("resize", () => {
    if (queuePanelOpen) positionQueuePanel();
  });

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
    syncMobilePlayerUi();
    syncMediaSession();
  });

  nodes.audioPlayer.addEventListener("pause", () => {
    renderTransportLabels();
    syncMobilePlayerUi();
    syncMediaSession();
  });

  nodes.audioPlayer.addEventListener("loadedmetadata", () => {
    updateTransportState();
    syncMediaSession();
  });
  nodes.audioPlayer.addEventListener("timeupdate", () => {
    updateTransportState();
    scheduleMediaSessionPosition();
    scheduleNextTrackPrefetch(); // pre-load next song before this one ends
  });
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
    await handleTrackEnd();
  });

  // ─── Visibility guard ────────────────────────────────────────────────────
  // Browsers fire visibilitychange when switching tabs. Some browser extensions
  // or framework code can accidentally pause audio here. This guard re-resumes
  // playback if the audio was playing before the tab was hidden.
  let wasPlayingBeforeHidden = false;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // Record whether audio was playing when we left the tab
      wasPlayingBeforeHidden = !nodes.audioPlayer.paused;
    } else {
      // Tab became visible again: if audio was playing and is now paused
      // (i.e. something interrupted it), resume it.
      if (wasPlayingBeforeHidden && nodes.audioPlayer.paused && state.selectedSongId) {
        nodes.audioPlayer.play().catch(() => {});
      }
    }
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

  nodes.mobilePlayerMinimize?.addEventListener("click", () => {
    setMobilePlayerExpanded(false);
  });

  nodes.mobilePlayerMinimize?.addEventListener("touchstart", (event) => {
    const touch = event.touches?.[0];
    if (!touch) return;
    startMobilePlayerDrag(touch.clientY);
  }, { passive: true });

  nodes.playerBar?.addEventListener("touchmove", (event) => {
    const touch = event.touches?.[0];
    if (!touch || !mobilePlayerDrag) return;
    updateMobilePlayerDrag(touch.clientY);
  }, { passive: true });

  nodes.playerBar?.addEventListener("touchend", () => {
    endMobilePlayerDrag();
  });

  nodes.playerBar?.addEventListener("touchcancel", () => {
    endMobilePlayerDrag();
  });

  nodes.mobileMiniOpen?.addEventListener("click", () => {
    setMobilePlayerExpanded(true);
  });

  nodes.mobileMiniToggle?.addEventListener("click", (event) => {
    event.stopPropagation();
    void togglePlayback();
  });
}

async function bootstrap() {
  loadFavorites();
  loadPlaylists();
  loadQueue();
  loadHiddenOfficialPlaylistSongs();
  await loadOfficialPlaylists();
  bindEvents();
  bindMediaSessionHandlers();
  renderFavorites();
  renderPlaylists();
  renderMobilePlayerPlaylistPicker();
  renderTransportLabels();
  syncVolumeUi();
  renderQueuePanel();
  void applyVolume(state.volumeLevel);
  mobileMediaQuery.addEventListener("change", () => {
    renderTransportLabels();
    if (!mobileMediaQuery.matches) {
      setMobileMenuOpen(false);
      setMobilePlayerExpanded(false);
    } else {
      syncMobilePlayerUi();
    }
  });
  await loadAppState();
  await loadLibrary({ reset: true });
  // Pre-cache songs around the initial selected song so Bluetooth/car controls
  // work immediately without any background fetch
  void preCacheAdjacentSongs();
  postJson("/api/warmup", { limit: 8 }).catch(() => {});
}

bootstrap();
