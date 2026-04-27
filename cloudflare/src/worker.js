const SITE_ORIGIN = "https://www.masstamilan.dev";
const DEFAULT_SYNC_PATH = "/sruthi-sync.json";
const TELUGU_ID_PREFIX = "telugu:";
const TELUGU_LIBRARY_LIMIT = 2000;
const HOMEPAGE_RECENT_WINDOW_DAYS = 30;
const DEFAULT_TAMIL_OFFICIAL_PLAYLISTS = [
  { id: "top-100", name: "Top 100", sourceUrl: "https://www.masstamilan.dev/playlists/top-100-songs" },
  { id: "bgm-50", name: "BGM 50", sourceUrl: "https://www.masstamilan.dev/playlists/top-50-bgm-songs" },
  { id: "sai-top-50", name: "Sai Top 50", sourceUrl: "https://www.masstamilan.dev/playlists/sai-abhyankkar-top-50-songs" },
  { id: "sean-roldan-top-50", name: "Sean Roldan Top 50", sourceUrl: "https://www.masstamilan.dev/playlists/sean-roldan-top-50-songs" },
  { id: "vijay-antony-top-50", name: "Vijay Antony Top 50", sourceUrl: "https://www.masstamilan.dev/playlists/vijay-antony-top-50-songs" },
  { id: "hiphop-tamizha-kuthu", name: "Hiphop Tamizha Kuthu", sourceUrl: "https://www.masstamilan.dev/playlists/hiphop-tamizha-top-50-songs" },
  { id: "deva-top-50", name: "Deva Top 50", sourceUrl: "https://www.masstamilan.dev/playlists/deva-top-50-songs" },
  { id: "anirudh-maxxx", name: "Anirudh Maxxx", sourceUrl: "https://www.masstamilan.dev/playlists/anirudh-ravichander-top-50-songs" },
  { id: "santhosh-narayanan-melody", name: "Santhosh Narayanan Melody", sourceUrl: "https://www.masstamilan.dev/playlists/santhosh-narayanan-top-50-songs" },
  { id: "arr-top-50", name: "ARR Top 50", sourceUrl: "https://www.masstamilan.dev/playlists/a-r-rahman-top-50-songs" },
  { id: "ilaiyaraaja-top-50", name: "Ilaiyaraaja Top 50", sourceUrl: "https://www.masstamilan.dev/playlists/ilaiyaraaja-top-50-songs" },
  { id: "imman-top-50", name: "Imman Top 50", sourceUrl: "https://www.masstamilan.dev/playlists/d-imman-top-50-songs" },
  { id: "yuvan-top-50", name: "Yuvan Top 50", sourceUrl: "https://www.masstamilan.dev/playlists/yuvan-shankar-raja-top-50-songs" },
  { id: "harris-hits", name: "Harris Hits", sourceUrl: "https://www.masstamilan.dev/playlists/harris-jayaraj-top-50-songs" },
  { id: "g-v-prakash-top-50", name: "G. V. Prakash Top 50", sourceUrl: "https://www.masstamilan.dev/playlists/g-v-prakash-kumar-top-50-songs" },
];

function catalogLanguage(env) {
  return cleanText(env?.CATALOG_LANGUAGE).toLowerCase() === "telugu" ? "telugu" : "tamil";
}

function defaultOfficialPlaylists(env) {
  return catalogLanguage(env) === "telugu" ? [] : DEFAULT_TAMIL_OFFICIAL_PLAYLISTS;
}

function teluguApiOrigin(env) {
  if (catalogLanguage(env) !== "tamil") return "";
  return cleanText(env?.TELUGU_API_ORIGIN);
}

function teluguAggregationEnabled(env) {
  return Boolean(teluguApiOrigin(env));
}

function isTeluguSongId(songId) {
  return cleanText(songId).startsWith(TELUGU_ID_PREFIX);
}

function rawTeluguSongId(songId) {
  return cleanText(songId).slice(TELUGU_ID_PREFIX.length);
}

function prefixTeluguSongId(songId) {
  const raw = cleanText(songId);
  return raw ? `${TELUGU_ID_PREFIX}${raw}` : "";
}

async function fetchRemoteJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Remote request failed with ${response.status}`);
  }
  return response.json();
}

async function fetchTeluguResponse(env, path, init = {}) {
  if (env.TELUGU_SERVICE && typeof env.TELUGU_SERVICE.fetch === "function") {
    return env.TELUGU_SERVICE.fetch(new Request(`https://telugu.internal${path}`, init));
  }
  const base = teluguApiOrigin(env);
  if (!base) {
    throw new Error("Telugu catalog is unavailable.");
  }
  return fetch(`${base}${path}`, init);
}

function decorateTeluguSong(song) {
  if (!song?.id) return null;
  const prefixedId = prefixTeluguSongId(song.id);
  return {
    ...song,
    id: prefixedId,
    audioUrl: `/api/stream/${prefixedId}`,
  };
}

async function fetchTeluguAppState(env) {
  try {
    const response = await fetchTeluguResponse(env, "/api/app-state");
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchTeluguLibrary(env, { query, movie, decade }) {
  if (!env.TELUGU_SERVICE && !teluguApiOrigin(env)) {
    return { songs: [], total: 0 };
  }
  const params = new URLSearchParams({
    query,
    movie,
    decade,
    localSongs: "false",
    offset: "0",
    limit: String(TELUGU_LIBRARY_LIMIT),
  });
  try {
    const response = await fetchTeluguResponse(env, `/api/library?${params.toString()}`);
    if (!response.ok) return { songs: [], total: 0 };
    const payload = await response.json();
    const songs = Array.isArray(payload?.songs) ? payload.songs.map(decorateTeluguSong).filter(Boolean) : [];
    return {
      songs,
      total: Number(payload?.total || songs.length),
    };
  } catch {
    return { songs: [], total: 0 };
  }
}

async function fetchTeluguSong(env, songId) {
  const rawId = rawTeluguSongId(songId);
  if ((!env.TELUGU_SERVICE && !teluguApiOrigin(env)) || !rawId) return null;
  try {
    const response = await fetchTeluguResponse(env, `/api/song?id=${encodeURIComponent(rawId)}`);
    if (!response.ok) return null;
    const payload = await response.json();
    return decorateTeluguSong(payload);
  } catch {
    return null;
  }
}

async function fetchTeluguSongsBatch(env, ids) {
  if ((!env.TELUGU_SERVICE && !teluguApiOrigin(env)) || !ids.length) return [];
  const rawIds = ids.map(rawTeluguSongId).filter(Boolean);
  if (!rawIds.length) return [];
  try {
    const response = await fetchTeluguResponse(env, "/api/songs-batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids: rawIds }),
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload?.songs) ? payload.songs.map(decorateTeluguSong).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function proxyTeluguJson(env, path, init = {}) {
  const base = teluguApiOrigin(env);
  if (!base) return json({ error: "Telugu catalog is unavailable." }, 502);
  try {
    const payload = await fetchRemoteJson(`${base}${path}`, init);
    return json(payload);
  } catch {
    return json({ error: "Telugu catalog is unavailable." }, 502);
  }
}

async function proxyTeluguStream(env, request, rawId) {
  if ((!env.TELUGU_SERVICE && !teluguApiOrigin(env)) || !rawId) return json({ error: "Song not found." }, 404);
  const headers = new Headers();
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);
  const upstream = await fetchTeluguResponse(env, `/api/stream/${encodeURIComponent(rawId)}`, {
    method: "GET",
    headers,
    redirect: "follow",
  }).catch(() => null);
  if (!upstream) return json({ error: "Upstream stream unavailable." }, 502);
  return withCors(upstream);
}

async function prefetchTeluguSongs(env, ids) {
  const rawIds = ids.map(rawTeluguSongId).filter(Boolean);
  if ((!env.TELUGU_SERVICE && !teluguApiOrigin(env)) || !rawIds.length) return 0;
  try {
    const response = await fetchTeluguResponse(env, "/api/prefetch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids: rawIds }),
    });
    if (!response.ok) return 0;
    const payload = await response.json();
    return Number(payload?.queued || 0);
  } catch {
    return 0;
  }
}

async function prefetchTeluguAlbum(env, songId, limit) {
  const rawId = rawTeluguSongId(songId);
  if ((!env.TELUGU_SERVICE && !teluguApiOrigin(env)) || !rawId) return 0;
  try {
    const response = await fetchTeluguResponse(env, "/api/prefetch/album", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ songId: rawId, limit }),
    });
    if (!response.ok) return 0;
    const payload = await response.json();
    return Number(payload?.queued || 0);
  } catch {
    return 0;
  }
}

function librarySortValue(song, query) {
  const normalizedQuery = cleanText(query).toLowerCase();
  if (!normalizedQuery) {
    return 10;
  }
  const title = cleanText(song?.title).toLowerCase();
  const movie = cleanText(song?.movie).toLowerCase();
  const artist = cleanText(song?.artist).toLowerCase();
  const composer = cleanText(song?.composer).toLowerCase();
  if (title === normalizedQuery) return 0;
  if (title.startsWith(normalizedQuery)) return 1;
  if (movie === normalizedQuery) return 2;
  if (movie.startsWith(normalizedQuery)) return 3;
  if (artist === normalizedQuery || artist.startsWith(normalizedQuery)) return 4;
  if (composer === normalizedQuery || composer.startsWith(normalizedQuery)) return 5;
  if (title.includes(normalizedQuery)) return 6;
  if (movie.includes(normalizedQuery)) return 7;
  if (artist.includes(normalizedQuery)) return 8;
  if (composer.includes(normalizedQuery)) return 9;
  return 10;
}

function isHomepageLibraryRequest({ query, movie, decade }) {
  return !cleanText(query) && !cleanText(movie) && cleanText(decade || "all") === "all";
}

function homepageSeedNumber() {
  const now = new Date();
  return (
    (now.getUTCFullYear() * 10000)
    + ((now.getUTCMonth() + 1) * 100)
    + now.getUTCDate()
  );
}

function homepageRecentCutoffIso() {
  return new Date(Date.now() - HOMEPAGE_RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function homepageSongUpdatedAt(song) {
  return cleanText(song?.updatedAt || song?.lastRefreshedAt);
}

function homepageSongTimestamp(song) {
  const value = homepageSongUpdatedAt(song);
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function homepageSongIsRecent(song) {
  const updatedAt = homepageSongUpdatedAt(song);
  return Boolean(updatedAt && updatedAt >= homepageRecentCutoffIso());
}

function homepageSongIsTamil(song) {
  return !isTeluguSongId(song?.id);
}

function homepageSongRandomScore(song) {
  const source = `${homepageSeedNumber()}:${cleanText(song?.id)}:${cleanText(song?.movie)}:${cleanText(song?.title)}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function homepageSongAlbumKey(song) {
  return cleanText(song?.albumUrl || song?.movie || song?.sourceUrl || song?.id).toLowerCase();
}

function diversifyHomepageSongs(songs) {
  const buckets = new Map();
  const orderedKeys = [];
  songs.forEach((song) => {
    const key = homepageSongAlbumKey(song);
    if (!buckets.has(key)) {
      buckets.set(key, []);
      orderedKeys.push(key);
    }
    buckets.get(key).push(song);
  });
  const diversified = [];
  while (diversified.length < songs.length) {
    let appended = false;
    for (const key of orderedKeys) {
      const bucket = buckets.get(key);
      if (!bucket?.length) continue;
      diversified.push(bucket.shift());
      appended = true;
    }
    if (!appended) break;
  }
  return diversified;
}

function compareHomepageSongs(left, right) {
  const tamilDelta = Number(homepageSongIsTamil(right)) - Number(homepageSongIsTamil(left));
  if (tamilDelta) return tamilDelta;

  const recentDelta = Number(homepageSongIsRecent(right)) - Number(homepageSongIsRecent(left));
  if (recentDelta) return recentDelta;

  const updatedDelta = homepageSongTimestamp(right) - homepageSongTimestamp(left);
  if (updatedDelta && (homepageSongIsRecent(left) || homepageSongIsRecent(right))) return updatedDelta;

  const modernDelta = Number(Number(right?.year || 0) >= 2010) - Number(Number(left?.year || 0) >= 2010);
  if (modernDelta) return modernDelta;

  if (Number(left?.year || 0) >= 2010 && Number(right?.year || 0) >= 2010) {
    const randomDelta = homepageSongRandomScore(left) - homepageSongRandomScore(right);
    if (randomDelta) return randomDelta;
  }

  if (updatedDelta) return updatedDelta;
  const yearDelta = Number(right?.year || 0) - Number(left?.year || 0);
  if (yearDelta) return yearDelta;
  return cleanText(left?.title).toLowerCase().localeCompare(cleanText(right?.title).toLowerCase());
}

function compareLibrarySongs(left, right, query, options = {}) {
  if (options.homepage) {
    return compareHomepageSongs(left, right);
  }
  const rankDelta = librarySortValue(left, query) - librarySortValue(right, query);
  if (rankDelta) return rankDelta;
  const yearDelta = Number(right?.year || 0) - Number(left?.year || 0);
  if (yearDelta) return yearDelta;
  return cleanText(left?.title).toLowerCase().localeCompare(cleanText(right?.title).toLowerCase());
}

async function queryLocalLibrary(env, { query, movie, decade, offset, limit }) {
  const bindings = [];
  const filters = [
    "lower(title) NOT LIKE '%verifying you are human%'",
    "lower(title) NOT LIKE '%verification successful%'",
    "lower(movie) NOT LIKE '%www.masstamilan.dev%'",
  ];

  if (decade !== "all") {
    const decadeStart = toInt(decade, 0);
    if (decadeStart > 0) {
      filters.push("year >= ? AND year < ?");
      bindings.push(decadeStart, decadeStart + 10);
    }
  }

  if (query) {
    filters.push("(lower(title) LIKE ? OR lower(movie) LIKE ? OR lower(artist) LIKE ? OR lower(composer) LIKE ?)");
    const like = `%${query}%`;
    bindings.push(like, like, like, like);
  }

  if (movie) {
    filters.push("lower(movie) = ?");
    bindings.push(movie);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const homepage = isHomepageLibraryRequest({ query, movie, decade });
  const rankSql = query
    ? `
      CASE
        WHEN lower(title) = ? THEN 0
        WHEN lower(title) LIKE ? THEN 1
        WHEN lower(movie) = ? THEN 2
        WHEN lower(movie) LIKE ? THEN 3
        WHEN lower(artist) = ? OR lower(artist) LIKE ? THEN 4
        WHEN lower(composer) = ? OR lower(composer) LIKE ? THEN 5
        WHEN instr(lower(title), ?) > 0 THEN 6
        WHEN instr(lower(movie), ?) > 0 THEN 7
        WHEN instr(lower(artist), ?) > 0 THEN 8
        WHEN instr(lower(composer), ?) > 0 THEN 9
        ELSE 10
      END
    `
    : "10";
  const homepageOrderSql = `
    CASE WHEN coalesce(updated_at, last_refreshed_at, '') >= ? THEN 0 ELSE 1 END,
    CASE
      WHEN coalesce(updated_at, last_refreshed_at, '') >= ? THEN coalesce(updated_at, last_refreshed_at, '')
      ELSE ''
    END DESC,
    CASE WHEN year >= 2010 THEN 0 ELSE 1 END,
    CASE
      WHEN year >= 2010 THEN (
        abs(
          (coalesce(unicode(substr(id, 1, 1)), 0) * 31) +
          (coalesce(unicode(substr(id, -1, 1)), 0) * 17) +
          (coalesce(unicode(substr(title, 1, 1)), 0) * 13) +
          (coalesce(unicode(substr(movie, 1, 1)), 0) * 7) +
          ${homepageSeedNumber()}
        ) % 100000
      )
      ELSE 100000
    END ASC,
    coalesce(updated_at, last_refreshed_at, '') DESC,
    year DESC,
    lower(title) ASC
  `;

  const countStmt = env.DB.prepare(`SELECT COUNT(*) AS count FROM songs ${whereClause}`).bind(...bindings);
  const rankBindings = query
    ? [query, `${query}%`, query, `${query}%`, query, `${query}%`, query, `${query}%`, query, query, query, query]
    : [];
  const rowsBindings = homepage
    ? [...bindings, homepageRecentCutoffIso(), homepageRecentCutoffIso(), limit, offset]
    : [...bindings, ...rankBindings, limit, offset];
  const rowsStmt = env.DB.prepare(
    `
    SELECT id, album_url, title, artist, composer, movie, year, mood,
           song_page_url, source_url, image_url, audio_128_url, audio_320_url,
           remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status, updated_at
    FROM songs
    ${whereClause}
    ORDER BY ${homepage ? homepageOrderSql : `${rankSql}, year DESC, lower(title) ASC`}
    LIMIT ? OFFSET ?
    `,
  ).bind(...rowsBindings);

  const [countRow, rows] = await Promise.all([countStmt.first(), rowsStmt.all()]);
  return {
    total: Number(countRow?.count || 0),
    songs: (rows.results || []).map((row) => rowToSong(row)),
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url, ctx);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) return assetResponse;

    if (!url.pathname.includes(".")) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }

    return assetResponse;
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledSync(env));
  },
};

async function handleApi(request, env, url, ctx) {
  if (!env.DB) {
    return json({ error: "D1 binding `DB` is not configured." }, 500);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (url.pathname === "/api/app-state") {
    const [albumCountRow, trackCountRow, updatedRow, decadeRows, teluguState] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM albums").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM songs").first(),
      env.DB.prepare("SELECT MAX(updated_at) AS updatedAt FROM songs").first(),
      env.DB.prepare(
        `
        SELECT DISTINCT ((year / 10) * 10) AS decade
        FROM songs
        WHERE year > 0
        ORDER BY decade ASC
        `,
      ).all(),
      fetchTeluguAppState(env),
    ]);

    const decades = unique([
      ...(decadeRows.results || []).map((row) => `${row.decade}s`),
      ...((teluguState?.filters?.decades || []).map((item) => cleanText(item)).filter(Boolean)),
    ]).sort();
    const updatedAtCandidates = [updatedRow?.updatedAt, teluguState?.updatedAt]
      .map((value) => cleanText(value))
      .filter(Boolean)
      .sort((left, right) => new Date(right).getTime() - new Date(left).getTime());
    return json({
      summary: {
        albumCount: Number(albumCountRow?.count || 0) + Number(teluguState?.summary?.albumCount || 0),
        trackCount: Number(trackCountRow?.count || 0) + Number(teluguState?.summary?.trackCount || 0),
      },
      filters: {
        decades,
        moods: ["Imported"],
      },
      updatedAt: updatedAtCandidates[0] || null,
      refreshWorkerActive: false,
      refreshWorkerSeenAt: null,
      features: {
        localLibrary: false,
        hostedDirectAudio: true,
      },
    });
  }

  if (url.pathname === "/api/library") {
    const query = cleanText(url.searchParams.get("query")).toLowerCase();
    const movie = cleanText(url.searchParams.get("movie")).toLowerCase();
    const decade = cleanText(url.searchParams.get("decade")) || "all";
    const offset = toInt(url.searchParams.get("offset"), 0);
    const limit = Math.min(toInt(url.searchParams.get("limit"), 80), 120);
    const localSongs = (url.searchParams.get("localSongs") || "false").toLowerCase() === "true";
    const homepage = isHomepageLibraryRequest({ query, movie, decade });

    if (localSongs) {
      return json({
        songs: [],
        total: 0,
        offset,
        limit,
        hasMore: false,
      });
    }

    if (homepage) {
      const poolLimit = Math.min(Math.max(offset + (limit * 4), limit * 4), 400);
      if (!teluguAggregationEnabled(env)) {
        const payload = await queryLocalLibrary(env, { query, movie, decade, offset: 0, limit: poolLimit });
        const songs = diversifyHomepageSongs(payload.songs).slice(offset, offset + limit);
        return json({
          songs,
          total: payload.total,
          offset,
          limit,
          hasMore: offset + limit < payload.total,
        });
      }

      const [localPayload, teluguPayload] = await Promise.all([
        queryLocalLibrary(env, { query, movie, decade, offset: 0, limit: poolLimit }),
        fetchTeluguLibrary(env, { query, movie, decade }),
      ]);
      const mergedSongs = diversifyHomepageSongs(
        [...localPayload.songs, ...teluguPayload.songs]
          .sort((left, right) => compareLibrarySongs(left, right, query, { homepage: true })),
      );
      const total = localPayload.total + teluguPayload.total;
      const songs = mergedSongs.slice(offset, offset + limit);
      return json({
        songs,
        total,
        offset,
        limit,
        hasMore: offset + limit < total,
      });
    }

    if (!teluguAggregationEnabled(env)) {
      const payload = await queryLocalLibrary(env, { query, movie, decade, offset, limit });
      return json({
        songs: payload.songs,
        total: payload.total,
        offset,
        limit,
        hasMore: offset + limit < payload.total,
      });
    }

    const teluguPayload = await fetchTeluguLibrary(env, { query, movie, decade });
    const localOffset = Math.max(0, offset - teluguPayload.total);
    const localLimit = Math.max(limit, offset + limit - localOffset);
    const localPayload = await queryLocalLibrary(env, {
      query,
      movie,
      decade,
      offset: localOffset,
      limit: localLimit,
    });
    const mergedSongs = [...localPayload.songs, ...teluguPayload.songs]
      .sort((left, right) => compareLibrarySongs(left, right, query, { homepage }));
    const songs = mergedSongs.slice(offset - localOffset, offset - localOffset + limit);
    const total = localPayload.total + teluguPayload.total;
    return json({
      songs,
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
    });
  }

  if (url.pathname === "/api/song") {
    const songId = cleanText(url.searchParams.get("id"));
    if (isTeluguSongId(songId)) {
      const song = await fetchTeluguSong(env, songId);
      if (!song) return json({ error: "Song not found." }, 404);
      return json(song);
    }
    const row = await env.DB.prepare(
      `
      SELECT id, album_url, title, artist, composer, movie, year, mood,
             song_page_url, source_url, image_url, audio_128_url, audio_320_url,
             remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
      FROM songs
      WHERE id = ?
      `,
    ).bind(songId).first();

    if (!row) return json({ error: "Song not found." }, 404);
    return json(rowToSong(row));
  }

  if (url.pathname === "/api/songs-batch" && request.method === "POST") {
    const payload = await request.json().catch(() => ({}));
    const ids = Array.isArray(payload?.ids) ? [...new Set(payload.ids.map(cleanText).filter(Boolean))].slice(0, 1200) : [];
    if (!ids.length) return json({ songs: [] });
    const tamilIds = ids.filter((id) => !isTeluguSongId(id));
    const teluguIds = ids.filter((id) => isTeluguSongId(id));
    const byId = new Map();

    if (tamilIds.length) {
      const placeholders = tamilIds.map(() => "?").join(", ");
      const rows = await env.DB.prepare(
        `
        SELECT id, album_url, title, artist, composer, movie, year, mood,
               song_page_url, source_url, image_url, audio_128_url, audio_320_url,
               remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
        FROM songs
        WHERE id IN (${placeholders})
        `,
      ).bind(...tamilIds).all();
      (rows.results || []).forEach((row) => byId.set(cleanText(row.id), rowToSong(row)));
    }

    if (teluguIds.length) {
      const teluguSongs = await fetchTeluguSongsBatch(env, teluguIds);
      teluguSongs.forEach((song) => byId.set(cleanText(song.id), song));
    }

    return json({ songs: ids.map((id) => byId.get(id)).filter(Boolean) });
  }

  if (url.pathname === "/api/cache/status") {
    return json({ cachedCount: 0, inFlight: 0, refreshingAlbums: 0 });
  }

  if (url.pathname === "/api/playlists") {
    await ensureOfficialPlaylistTables(env);
    const playlists = await listOfficialPlaylists(env, { includeSongIds: false });
    return json({ playlists });
  }

  if (url.pathname === "/api/playlist") {
    await ensureOfficialPlaylistTables(env);
    const playlistId = cleanText(url.searchParams.get("id"));
    if (!playlistId) return json({ error: "Playlist id is required." }, 400);
    const playlist = await loadOfficialPlaylistDetail(env, playlistId);
    if (!playlist) return json({ error: "Playlist not found." }, 404);
    return json(playlist);
  }

  if (url.pathname === "/api/sync/status") {
    await ensureSyncTables(env);
    const row = await env.DB.prepare(
      `
      SELECT status, started_at, finished_at, albums_seen, songs_seen, message
      FROM sync_runs
      ORDER BY id DESC
      LIMIT 1
      `,
    ).first();
    return json({
      syncEnabled: Boolean(env.SYNC_FEED_URL || env.MASSTAMILAN_SYNC_FEED_URL),
      feedUrl: env.SYNC_FEED_URL || env.MASSTAMILAN_SYNC_FEED_URL || DEFAULT_SYNC_PATH,
      lastRun: row || null,
    });
  }

  if (url.pathname === "/api/admin/sync" && request.method === "POST") {
    const configuredToken = cleanText(env.SYNC_ADMIN_TOKEN);
    const suppliedToken = cleanText(request.headers.get("x-sync-token")) || cleanText(url.searchParams.get("token"));
    if (configuredToken && suppliedToken !== configuredToken) {
      return json({ error: "Unauthorized." }, 401);
    }
    const result = await runScheduledSync(env);
    return json(result, result.ok ? 200 : 500);
  }

  if (url.pathname === "/api/admin/import-playlists" && request.method === "POST") {
    const configuredToken = cleanText(env.SYNC_ADMIN_TOKEN);
    const suppliedToken = cleanText(request.headers.get("x-sync-token")) || cleanText(url.searchParams.get("token"));
    if (configuredToken && suppliedToken !== configuredToken) {
      return json({ error: "Unauthorized." }, 401);
    }
    const payload = await request.json().catch(() => ({}));
    const playlists = normalizeSyncPlaylists(payload);
    await ensureOfficialPlaylistTables(env);
    for (const playlist of playlists) {
      await upsertOfficialPlaylist(env, playlist);
    }
    return json({ ok: true, imported: playlists.length });
  }

  if (url.pathname === "/api/warmup") {
    const payload = await request.json().catch(() => ({}));
    const limit = Math.min(Math.max(Number(payload?.limit || 6), 1), 8);
    const rows = await env.DB.prepare(
      `
      SELECT id, album_url, title, artist, composer, movie, year, mood,
             song_page_url, source_url, image_url, audio_128_url, audio_320_url,
             remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
      FROM songs
      ORDER BY year DESC, lower(title) ASC
      LIMIT ?
      `,
    ).bind(limit).all();
    ctx?.waitUntil(warmSongs(env, url.origin, rows.results || []));
    return json({ ok: true, queued: (rows.results || []).length });
  }

  if (url.pathname === "/api/prefetch") {
    const payload = await request.json().catch(() => ({}));
    const ids = Array.isArray(payload?.ids) ? [...new Set(payload.ids.map(cleanText).filter(Boolean))].slice(0, 6) : [];
    if (!ids.length) return json({ ok: true, queued: 0 });
    const tamilIds = ids.filter((id) => !isTeluguSongId(id));
    const teluguIds = ids.filter((id) => isTeluguSongId(id));
    let queued = 0;

    if (tamilIds.length) {
      const placeholders = tamilIds.map(() => "?").join(", ");
      const rows = await env.DB.prepare(
        `
        SELECT id, album_url, title, artist, composer, movie, year, mood,
               song_page_url, source_url, image_url, audio_128_url, audio_320_url,
               remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
        FROM songs
        WHERE id IN (${placeholders})
        `,
      ).bind(...tamilIds).all();
      queued += (rows.results || []).length;
      ctx?.waitUntil(warmSongs(env, url.origin, rows.results || []));
    }

    if (teluguIds.length) {
      queued += await prefetchTeluguSongs(env, teluguIds);
    }

    return json({ ok: true, queued });
  }

  if (url.pathname === "/api/prefetch/album") {
    const payload = await request.json().catch(() => ({}));
    const songId = cleanText(payload?.songId);
    const limit = Math.min(Math.max(Number(payload?.limit || 4), 1), 8);
    if (!songId) return json({ ok: true, queued: 0 });
    if (isTeluguSongId(songId)) {
      const queued = await prefetchTeluguAlbum(env, songId, limit);
      return json({ ok: true, queued });
    }
    const current = await env.DB.prepare("SELECT album_url FROM songs WHERE id = ?").bind(songId).first();
    if (!current?.album_url) return json({ ok: true, queued: 0 });
    const rows = await env.DB.prepare(
      `
      SELECT id, album_url, title, artist, composer, movie, year, mood,
             song_page_url, source_url, image_url, audio_128_url, audio_320_url,
             remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
      FROM songs
      WHERE album_url = ?
      ORDER BY lower(title) ASC
      LIMIT ?
      `,
    ).bind(current.album_url, limit).all();
    ctx?.waitUntil(warmSongs(env, url.origin, rows.results || []));
    return json({ ok: true, queued: (rows.results || []).length });
  }

  if (url.pathname.startsWith("/api/stream/")) {
    const songId = cleanText(url.pathname.split("/").pop());
    if (isTeluguSongId(songId)) {
      return proxyTeluguStream(env, request, rawTeluguSongId(songId));
    }
    return handleStream(songId, request, env, ctx);
  }

  return json({ error: "Not found." }, 404);
}

async function handleStream(songId, request, env, ctx) {
  const range = request.headers.get("Range");
  if (!range) {
    const cached = await caches.default.match(request);
    if (cached) return withCors(cached);
  }

  let row = await env.DB.prepare(
    `
    SELECT id, album_url, title, artist, composer, movie, year, mood,
           song_page_url, source_url, image_url, audio_128_url, audio_320_url,
           remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
    FROM songs
    WHERE id = ?
    `,
  ).bind(songId).first();

  if (!row) return json({ error: "Song not found." }, 404);

  let response = await tryAudioCandidates(row, request);
  if (response && !range) {
    ctx?.waitUntil(caches.default.put(request, response.clone()));
  }
  if (response) return response;

  const refreshed = await tryRefreshSongLink(env, row);
  if (refreshed) {
    row = refreshed;
    response = await tryAudioCandidates(row, request);
    if (response && !range) {
      ctx?.waitUntil(caches.default.put(request, response.clone()));
    }
    if (response) return response;
  }

  return json({ error: "Upstream stream unavailable." }, 502);
}

async function tryAudioCandidates(row, request) {
  const range = request.headers.get("Range");
  const baseUrl = cleanText(row.album_url || row.song_page_url || row.source_url);
  for (const candidate of [row.audio_128_url, row.audio_320_url]) {
    const target = absoluteUrl(candidate, baseUrl);
    if (!target) continue;
    const upstream = await fetchAudio(target, row.album_url, range);
    if (upstream) return upstream;
  }
  return null;
}

async function fetchAudio(target, albumUrl, rangeHeader) {
  const headers = new Headers({
    Accept: "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: cleanText(albumUrl) || SITE_ORIGIN,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  if (rangeHeader) headers.set("Range", rangeHeader);

  const response = await fetch(target, {
    method: "GET",
    headers,
    redirect: "follow",
  });

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!response.ok) return null;
  if (contentType.includes("text/html") || contentType.includes("text/plain")) return null;

  const outHeaders = new Headers(corsHeaders());
  outHeaders.set("Content-Type", response.headers.get("content-type") || "audio/mpeg");
  if (response.headers.get("content-length")) outHeaders.set("Content-Length", response.headers.get("content-length"));
  if (response.headers.get("content-range")) outHeaders.set("Content-Range", response.headers.get("content-range"));
  outHeaders.set("Accept-Ranges", response.headers.get("accept-ranges") || "bytes");
  if (!rangeHeader) outHeaders.set("Cache-Control", "public, max-age=3600");
  return new Response(response.body, {
    status: response.status,
    headers: outHeaders,
  });
}

async function tryRefreshSongLink(env, row) {
  const candidatePages = unique([row.album_url, row.song_page_url, row.source_url].map(cleanText).filter(Boolean));
  for (const candidate of candidatePages) {
    const pageHtml = await fetchText(candidate);
    if (!pageHtml) continue;
    let albumUrl = cleanText(row.album_url);
    let albumHtml = pageHtml;
    if (!pageHtml.includes("window.albumTracks")) {
      const albumLinks = extractAlbumLinks(pageHtml, candidate);
      if (!albumLinks.length) continue;
      albumUrl = albumLinks[0];
      albumHtml = await fetchText(albumUrl);
      if (!albumHtml || !albumHtml.includes("window.albumTracks")) continue;
    }

    const refreshed = await refreshAlbum(env, albumUrl, albumHtml);
    if (!refreshed) continue;
    return env.DB.prepare(
      `
      SELECT id, album_url, title, artist, composer, movie, year, mood,
             song_page_url, source_url, image_url, audio_128_url, audio_320_url,
             remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
      FROM songs
      WHERE id = ?
      `,
    ).bind(row.id).first();
  }
  return null;
}

async function runScheduledSync(env) {
  if (!env.DB) {
    return { ok: false, error: "D1 binding `DB` is not configured." };
  }

  const feedUrl = cleanText(env.SYNC_FEED_URL || env.MASSTAMILAN_SYNC_FEED_URL || "");
  if (!feedUrl) {
    return { ok: false, error: "SYNC_FEED_URL is not configured." };
  }

  await ensureSyncTables(env);
  const startedAt = nowIso();
  const runId = await insertSyncRun(env, startedAt);

  try {
    const payload = await fetchSyncFeed(feedUrl);
    const albums = normalizeSyncPayload(payload);
    const playlists = normalizeSyncPlaylists(payload);
    let songsSeen = 0;
    for (const album of albums) {
      songsSeen += album.songs.length;
    }

    for (const album of albums) {
      await upsertAlbum(env, album);
      for (const song of album.songs) {
        await upsertSong(env, song);
      }
    }

    await ensureOfficialPlaylistTables(env);
    for (const playlist of playlists) {
      await upsertOfficialPlaylist(env, playlist);
    }

    const finishedAt = nowIso();
    await env.DB.batch([
      env.DB.prepare(
        `
        UPDATE sync_runs
        SET status = 'success',
            finished_at = ?,
            albums_seen = ?,
            songs_seen = ?,
            message = ?
        WHERE id = ?
        `,
      ).bind(finishedAt, albums.length, songsSeen, "Sync completed", runId),
      env.DB.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('last_sync_at', ?)").bind(finishedAt),
    ]);
    return { ok: true, albumsSeen: albums.length, songsSeen, playlistsSeen: playlists.length };
  } catch (error) {
    const finishedAt = nowIso();
    const message = cleanText(error?.message || "Sync failed");
    await env.DB.prepare(
      `
      UPDATE sync_runs
      SET status = 'failed',
          finished_at = ?,
          message = ?
      WHERE id = ?
      `,
    ).bind(finishedAt, message, runId).run();
    return { ok: false, error: message };
  }
}

async function ensureSyncTables(env) {
  await env.DB.batch([
    env.DB.prepare(
      `
      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        albums_seen INTEGER NOT NULL DEFAULT 0,
        songs_seen INTEGER NOT NULL DEFAULT 0,
        message TEXT
      )
      `,
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON sync_runs(started_at DESC)"),
  ]);
}

async function ensureOfficialPlaylistTables(env) {
  await env.DB.batch([
    env.DB.prepare(
      `
      CREATE TABLE IF NOT EXISTS official_playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_url TEXT,
        updated_at TEXT NOT NULL,
        song_count INTEGER NOT NULL DEFAULT 0
      )
      `,
    ),
    env.DB.prepare(
      `
      CREATE TABLE IF NOT EXISTS official_playlist_songs (
        playlist_id TEXT NOT NULL,
        song_id TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (playlist_id, song_id)
      )
      `,
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_official_playlist_songs_playlist ON official_playlist_songs(playlist_id, position)"),
  ]);
}

async function insertSyncRun(env, startedAt) {
  const result = await env.DB.prepare(
    `
    INSERT INTO sync_runs (status, started_at, finished_at, albums_seen, songs_seen, message)
    VALUES ('running', ?, NULL, 0, 0, 'Sync started')
    `,
  ).bind(startedAt).run();
  return Number(result.meta?.last_row_id || 0);
}

async function fetchSyncFeed(feedUrl) {
  const response = await fetch(feedUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) {
    throw new Error(`Feed request failed with ${response.status}`);
  }
  const payload = await response.json();
  return payload;
}

function normalizeSyncPayload(payload) {
  const albums = Array.isArray(payload?.albums) ? payload.albums : [];
  return albums
    .map((album) => normalizeAlbum(album))
    .filter((album) => album.url && album.title);
}

function normalizeSyncPlaylists(payload) {
  const playlists = Array.isArray(payload?.playlists) ? payload.playlists : [];
  return playlists
    .map((playlist) => normalizePlaylist(playlist))
    .filter((playlist) => playlist.id && playlist.name);
}

function normalizeAlbum(album) {
  const url = cleanText(album?.url || album?.albumUrl || album?.sourceUrl);
  const title = cleanText(album?.title || album?.movie || "");
  const year = inferYearFromValues([
    album?.year,
    url,
    title,
    album?.imageUrl,
  ]);
  const songs = Array.isArray(album?.songs || album?.tracks) ? (album.songs || album.tracks).map((song, index) => normalizeSong(song, album, index)).filter((item) => item.id) : [];
  return {
    url,
    title,
    pageNumber: toInt(album?.pageNumber, 0),
    year,
    musicDirector: cleanText(album?.musicDirector || album?.composer),
    director: cleanText(album?.director),
    starring: cleanText(album?.starring),
    lyricists: cleanText(album?.lyricists),
    zipLinksJson: JSON.stringify(Array.isArray(album?.zipLinks) ? album.zipLinks : []),
    trackCount: songs.length,
    updatedAt: cleanText(album?.updatedAt) || nowIso(),
    songs,
  };
}

function normalizeSong(song, album, index) {
  const albumUrl = cleanText(album?.url || album?.albumUrl || album?.sourceUrl);
  const title = cleanText(song?.title || song?.name);
  const id = cleanText(song?.id) || stableSongId(albumUrl, title, index + 1);
  const year = inferYearFromValues([
    song?.year,
    album?.year,
    song?.movie,
    album?.title,
    albumUrl,
    song?.imageUrl,
  ]);
  const baseUrl = albumUrl || song?.sourceUrl || song?.songPageUrl || song?.imageUrl;
  const audio128 = absoluteUrl(song?.audio128Url || song?.audio_128_url || song?.audioUrl || song?.audio_url || song?.url128, baseUrl);
  const audio320 = absoluteUrl(song?.audio320Url || song?.audio_320_url || song?.audioUrl || song?.audio_url || song?.url320, baseUrl);
  const pageUrl = absoluteUrl(song?.songPageUrl || song?.song_page_url || song?.pageUrl || song?.sourceUrl, baseUrl);
  return {
    id,
    albumUrl,
    title,
    artist: cleanText(song?.artist || song?.singers),
    singers: cleanText(song?.singers || song?.artist),
    composer: cleanText(song?.composer || album?.musicDirector || album?.composer),
    movie: cleanText(song?.movie || album?.title),
    year,
    mood: cleanText(song?.mood) || "Imported",
    songPageUrl: pageUrl,
    sourceUrl: absoluteUrl(song?.sourceUrl || pageUrl || albumUrl, baseUrl),
    imageUrl: absoluteUrl(song?.imageUrl || album?.imageUrl, baseUrl),
    audioUrl: audio128 || audio320,
    audio128Url: audio128,
    audio320Url: audio320,
    remoteAudio128Url: absoluteUrl(song?.remoteAudio128Url || song?.remote_audio_128_url, baseUrl),
    remoteAudio320Url: absoluteUrl(song?.remoteAudio320Url || song?.remote_audio_320_url, baseUrl),
    localAudio128Url: cleanText(song?.localAudio128Url || song?.local_audio_128_url),
    localAudio320Url: cleanText(song?.localAudio320Url || song?.local_audio_320_url),
    downloadLinksJson: JSON.stringify(Array.isArray(song?.downloadLinks) ? song.downloadLinks : []),
    spotifyJson: JSON.stringify(song?.spotify || song?.spotifyJson || {}),
    lastRefreshedAt: cleanText(song?.lastRefreshedAt || song?.last_refreshed_at || album?.updatedAt),
    linkStatus: cleanText(song?.linkStatus || song?.link_status) || "fresh",
    updatedAt: cleanText(song?.updatedAt || album?.updatedAt) || nowIso(),
  };
}

function normalizePlaylist(playlist) {
  const songRefs = Array.isArray(playlist?.songIds || playlist?.songs)
    ? (playlist.songIds || playlist.songs)
        .map((item) => {
          if (typeof item === "string") return { id: cleanText(item) };
          return {
            id: cleanText(item?.id || item?.songId),
            sourceUrl: absoluteUrl(item?.sourceUrl || item?.url),
            songPageUrl: absoluteUrl(item?.songPageUrl || item?.song_page_url),
            title: cleanText(item?.title || item?.name),
            movie: cleanText(item?.movie || item?.album),
          };
        })
        .filter((item) => item.id || item.sourceUrl || item.songPageUrl || item.title)
    : [];
  return {
    id: cleanText(playlist?.id) || slugValue(playlist?.name),
    name: cleanText(playlist?.name || playlist?.title),
    sourceUrl: absoluteUrl(playlist?.sourceUrl || playlist?.url),
    updatedAt: cleanText(playlist?.updatedAt) || nowIso(),
    songRefs,
  };
}

async function upsertAlbum(env, album) {
  await env.DB.prepare(
    `
    INSERT INTO albums (
      url, title, page_number, year, music_director, director, starring,
      lyricists, zip_links_json, track_count, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title = excluded.title,
      page_number = excluded.page_number,
      year = excluded.year,
      music_director = excluded.music_director,
      director = excluded.director,
      starring = excluded.starring,
      lyricists = excluded.lyricists,
      zip_links_json = excluded.zip_links_json,
      track_count = excluded.track_count,
      updated_at = excluded.updated_at
    `,
  ).bind(
    album.url,
    album.title,
    album.pageNumber,
    album.year,
    album.musicDirector,
    album.director,
    album.starring,
    album.lyricists,
    album.zipLinksJson,
    album.trackCount,
    album.updatedAt,
  ).run();
}

async function upsertSong(env, song) {
  await env.DB.prepare(
    `
    INSERT INTO songs (
      id, album_url, title, artist, singers, composer, movie, year, mood,
      song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
      remote_audio_128_url, remote_audio_320_url, local_audio_128_url, local_audio_320_url,
      download_links_json, spotify_json, last_refreshed_at, link_status, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      album_url = excluded.album_url,
      title = excluded.title,
      artist = excluded.artist,
      singers = excluded.singers,
      composer = excluded.composer,
      movie = excluded.movie,
      year = excluded.year,
      mood = excluded.mood,
      song_page_url = excluded.song_page_url,
      source_url = excluded.source_url,
      image_url = excluded.image_url,
      audio_url = excluded.audio_url,
      audio_128_url = excluded.audio_128_url,
      audio_320_url = excluded.audio_320_url,
      remote_audio_128_url = excluded.remote_audio_128_url,
      remote_audio_320_url = excluded.remote_audio_320_url,
      local_audio_128_url = excluded.local_audio_128_url,
      local_audio_320_url = excluded.local_audio_320_url,
      download_links_json = excluded.download_links_json,
      spotify_json = excluded.spotify_json,
      last_refreshed_at = excluded.last_refreshed_at,
      link_status = excluded.link_status,
      updated_at = excluded.updated_at
    `,
  ).bind(
    song.id,
    song.albumUrl,
    song.title,
    song.artist,
    song.singers,
    song.composer,
    song.movie,
    song.year,
    song.mood,
    song.songPageUrl,
    song.sourceUrl,
    song.imageUrl,
    song.audioUrl,
    song.audio128Url,
    song.audio320Url,
    song.remoteAudio128Url,
    song.remoteAudio320Url,
    song.localAudio128Url,
    song.localAudio320Url,
    song.downloadLinksJson,
    song.spotifyJson,
    song.lastRefreshedAt,
    song.linkStatus,
    song.updatedAt,
  ).run();
}

async function upsertOfficialPlaylist(env, playlist) {
  const resolvedSongIds = await resolvePlaylistSongIds(env, playlist.songRefs || []);
  await env.DB.prepare(
    `
    INSERT INTO official_playlists (id, name, source_url, updated_at, song_count)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      source_url = excluded.source_url,
      updated_at = excluded.updated_at,
      song_count = excluded.song_count
    `,
  ).bind(
    playlist.id,
    playlist.name,
    playlist.sourceUrl,
    playlist.updatedAt,
    resolvedSongIds.length,
  ).run();

  await env.DB.prepare("DELETE FROM official_playlist_songs WHERE playlist_id = ?").bind(playlist.id).run();
  const statements = resolvedSongIds.map((songId, index) =>
    env.DB.prepare(
      `
      INSERT OR REPLACE INTO official_playlist_songs (playlist_id, song_id, position)
      VALUES (?, ?, ?)
      `,
    ).bind(playlist.id, songId, index),
  );
  if (statements.length) {
    await env.DB.batch(statements);
  }
}

async function listOfficialPlaylists(env, { includeSongIds = true } = {}) {
  const rows = await env.DB.prepare(
    `
    SELECT id, name, source_url, updated_at, song_count
    FROM official_playlists
    ORDER BY lower(name) ASC
    `,
  ).all();
  const defaults = defaultOfficialPlaylists(env);
  const results = (rows.results || []).length ? (rows.results || []) : defaults.map((playlist) => ({
    id: playlist.id,
    name: playlist.name,
    source_url: playlist.sourceUrl,
    updated_at: null,
    song_count: 0,
  }));
  const playlists = [];
  for (const row of results) {
    let songIds = [];
    let songCount = Number(row.song_count || 0);
    if (includeSongIds) {
      songIds = await officialPlaylistSongIds(env, row.id, cleanText(row.name));
      songCount = songIds.length;
    } else if (!songCount) {
      songCount = (await derivePlaylistSongIdsFromName(env, cleanText(row.name))).length;
    }
    playlists.push({
      id: row.id,
      name: cleanText(row.name),
      sourceUrl: cleanText(row.source_url),
      updatedAt: row.updated_at || null,
      songIds,
      songCount,
      official: true,
    });
  }
  return playlists;
}

async function officialPlaylistSongIds(env, playlistId, playlistName = "") {
  const songs = await env.DB.prepare(
    `
    SELECT song_id
    FROM official_playlist_songs
    WHERE playlist_id = ?
    ORDER BY position ASC, song_id ASC
    `,
  ).bind(playlistId).all();
  let songIds = (songs.results || []).map((item) => cleanText(item.song_id)).filter(Boolean);
  if (!songIds.length) {
    songIds = await derivePlaylistSongIdsFromName(env, cleanText(playlistName));
  }
  return songIds;
}

async function loadOfficialPlaylistDetail(env, playlistId) {
  let row = await env.DB.prepare(
    `
    SELECT id, name, source_url, updated_at, song_count
    FROM official_playlists
    WHERE id = ?
    LIMIT 1
    `,
  ).bind(playlistId).first();
  if (!row) {
    const fallback = defaultOfficialPlaylists(env).find((playlist) => playlist.id === playlistId);
    if (!fallback) return null;
    row = {
      id: fallback.id,
      name: fallback.name,
      source_url: fallback.sourceUrl,
      updated_at: null,
      song_count: 0,
    };
  }

  const songIds = await officialPlaylistSongIds(env, playlistId, cleanText(row.name));
  const songs = await loadSongsByIds(env, songIds);
  return {
    id: row.id,
    name: cleanText(row.name),
    sourceUrl: cleanText(row.source_url),
    updatedAt: row.updated_at || null,
    songCount: songIds.length,
    songIds: songs.map((song) => song.id),
    songs,
    official: true,
  };
}

async function loadSongsByIds(env, ids) {
  const uniqueIds = [...new Set((ids || []).map(cleanText).filter(Boolean))];
  if (!uniqueIds.length) return [];
  const chunkSize = 90;
  const rows = [];
  for (let offset = 0; offset < uniqueIds.length; offset += chunkSize) {
    const chunk = uniqueIds.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await env.DB.prepare(
      `
      SELECT id, album_url, title, artist, composer, movie, year, mood,
             song_page_url, source_url, image_url, audio_128_url, audio_320_url,
             remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
      FROM songs
      WHERE id IN (${placeholders})
      `,
    ).bind(...chunk).all();
    rows.push(...(result.results || []));
  }
  const byId = new Map(rows.map((item) => [cleanText(item.id), rowToSong(item)]));
  return uniqueIds.map((id) => byId.get(id)).filter(Boolean);
}

async function derivePlaylistSongIdsFromName(env, playlistName) {
  const normalized = cleanText(playlistName).toLowerCase();
  const spec = playlistComposerAliases(normalized);
  if (!spec.aliases.length && normalized.includes("bgm")) {
    const bgmRows = await env.DB.prepare(
      `
      SELECT id
      FROM songs
      WHERE lower(title) LIKE '%theme%'
         OR lower(title) LIKE '%bgm%'
         OR lower(movie) LIKE '%bgm%'
      ORDER BY year DESC, lower(title) ASC
      `,
    ).all();
    return (bgmRows.results || []).map((row) => cleanText(row.id)).filter(Boolean);
  }
  if (!spec.aliases.length || !spec.fields.length) return [];

  const normalizeExpr = (field) => `lower(replace(replace(replace(${field}, '.', ''), ' ', ''), '-', ''))`;
  const where = spec.aliases.map(() => `(${spec.fields.map((field) => `${normalizeExpr(field)} LIKE ?`).join(" OR ")})`).join(" OR ");
  const bindings = [];
  spec.aliases.forEach((alias) => {
    const token = alias.toLowerCase().replace(/[.\s-]+/g, "");
    spec.fields.forEach(() => {
      bindings.push(`%${token}%`);
    });
  });
  const rows = await env.DB.prepare(
    `
    SELECT id
    FROM songs
    WHERE ${where}
    ORDER BY year DESC, lower(title) ASC
    `,
  ).bind(...bindings).all();
  return (rows.results || []).map((row) => cleanText(row.id)).filter(Boolean);
}

function playlistComposerAliases(name) {
  const matches = [];
  const map = [
    { match: /anirudh/, aliases: ["anirudh ravichander", "anirudh"], fields: ["composer"] },
    { match: /\barr\b|rahman/, aliases: ["a r rahman", "ar rahman", "a.r. rahman"], fields: ["composer"] },
    { match: /sean roldan/, aliases: ["sean roldan"], fields: ["composer"] },
    { match: /vijay antony/, aliases: ["vijay antony"], fields: ["composer"] },
    { match: /hiphop tamizha/, aliases: ["hiphop tamizha"], fields: ["artist"] },
    { match: /\bdeva\b/, aliases: ["deva"], fields: ["composer"] },
    { match: /ilaiyaraaja|ilayaraja/, aliases: ["ilaiyaraaja", "ilayaraja"], fields: ["composer"] },
    { match: /imman/, aliases: ["d imman", "imman"], fields: ["composer"] },
    { match: /yuvan/, aliases: ["yuvan shankar raja", "yuvan"], fields: ["composer"] },
    { match: /harris/, aliases: ["harris jayaraj", "harris"], fields: ["composer"] },
    { match: /santhosh narayanan/, aliases: ["santhosh narayanan"], fields: ["composer"] },
    { match: /g\.?\s*v\.?\s*prakash|gv prakash/, aliases: ["g v prakash", "gv prakash", "g. v. prakash"], fields: ["composer"] },
    { match: /sai top 50|sai\b/, aliases: ["sai abhyankkar", "sai"], fields: ["artist"] },
  ];
  map.forEach((entry) => {
    if (entry.match.test(name)) matches.push(entry);
  });
  return {
    aliases: unique(matches.flatMap((entry) => entry.aliases)),
    fields: unique(matches.flatMap((entry) => entry.fields || ["composer"])),
  };
}

async function resolvePlaylistSongIds(env, refs) {
  const resolved = [];
  for (const ref of refs) {
    const songId = await resolvePlaylistSongId(env, ref);
    if (songId && !resolved.includes(songId)) resolved.push(songId);
  }
  return resolved;
}

async function resolvePlaylistSongId(env, ref) {
  if (ref.id) {
    const row = await env.DB.prepare("SELECT id FROM songs WHERE id = ?").bind(ref.id).first();
    if (row?.id) return row.id;
  }

  if (ref.songPageUrl) {
    const row = await env.DB.prepare(
      "SELECT id FROM songs WHERE song_page_url = ? OR source_url = ? LIMIT 1",
    ).bind(ref.songPageUrl, ref.songPageUrl).first();
    if (row?.id) return row.id;
  }

  if (ref.sourceUrl) {
    const row = await env.DB.prepare(
      "SELECT id FROM songs WHERE source_url = ? OR song_page_url = ? LIMIT 1",
    ).bind(ref.sourceUrl, ref.sourceUrl).first();
    if (row?.id) return row.id;
  }

  if (ref.title && ref.movie) {
    const row = await env.DB.prepare(
      "SELECT id FROM songs WHERE lower(title) = ? AND lower(movie) = ? LIMIT 1",
    ).bind(ref.title.toLowerCase(), ref.movie.toLowerCase()).first();
    if (row?.id) return row.id;
  }

  if (ref.title) {
    const row = await env.DB.prepare(
      "SELECT id FROM songs WHERE lower(title) = ? LIMIT 1",
    ).bind(ref.title.toLowerCase()).first();
    if (row?.id) return row.id;
  }

  return "";
}

async function refreshAlbum(env, albumUrl, html) {
  const albumTracks = extractAlbumTracks(html);
  if (!albumTracks.length) return false;

  const albumTitle = parseAlbumTitle(html) || "Untitled album";
  const year = parseYear(html, albumUrl);
  const composer = parseMusicDirector(html) || "Unknown composer";
  const updatedAt = new Date().toISOString();

  const statements = [];
  statements.push(
    env.DB.prepare("DELETE FROM songs WHERE album_url = ?").bind(albumUrl),
    env.DB.prepare(
      `
      INSERT OR REPLACE INTO albums (
        url, title, page_number, year, music_director, director, starring, lyricists,
        zip_links_json, track_count, updated_at
      ) VALUES (?, ?, 0, ?, ?, '', '', '', '[]', ?, ?)
      `,
    ).bind(albumUrl, albumTitle, year, composer, albumTracks.length, updatedAt),
  );

  for (const track of albumTracks) {
    const payload = buildTrackPayload(track, {
      albumUrl,
      albumTitle,
      composer,
      year,
      updatedAt,
    });
    statements.push(
      env.DB.prepare(
        `
        INSERT OR REPLACE INTO songs (
          id, album_url, title, artist, singers, composer, movie, year, mood,
          song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
          remote_audio_128_url, remote_audio_320_url, local_audio_128_url, local_audio_320_url,
          download_links_json, spotify_json, last_refreshed_at, link_status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Imported', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, '{}', ?, 'fresh', ?)
        `,
      ).bind(
        payload.id,
        payload.album_url,
        payload.title,
        payload.artist,
        payload.artist,
        payload.composer,
        payload.movie,
        payload.year,
        payload.song_page_url,
        payload.source_url,
        payload.image_url,
        payload.audio_url,
        payload.audio_128_url,
        payload.audio_320_url,
        payload.remote_audio_128_url,
        payload.remote_audio_320_url,
        payload.download_links_json,
        payload.last_refreshed_at,
        payload.updated_at,
      ),
    );
  }

  statements.push(
    env.DB.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('updatedAt', ?)").bind(updatedAt),
  );
  await env.DB.batch(statements);
  return true;
}

function buildTrackPayload(track, context) {
  const primary = cleanText(track.dl_path);
  const audio128 = primary.includes("/p128_cdn/")
    ? primary
    : primary.includes("/p320_cdn/")
      ? primary.replace("/p320_cdn/", "/p128_cdn/")
      : extractBitrateLink(track.downloadLinks, 128) || "";
  const audio320 = primary.includes("/p320_cdn/")
    ? primary
    : primary.includes("/p128_cdn/")
      ? primary.replace("/p128_cdn/", "/p320_cdn/")
      : extractBitrateLink(track.downloadLinks, 320) || "";
  const downloadLinks = [];
  if (audio320) downloadLinks.push({ label: "320kbps", url: audio320, bitrate: 320 });
  if (audio128) downloadLinks.push({ label: "128kbps", url: audio128, bitrate: 128 });
  return {
    id: String(track.id),
    album_url: context.albumUrl,
    title: cleanText(track.name) || "Untitled",
    artist: cleanText(track.artists) || "Unknown artist",
    composer: context.composer,
    movie: cleanText(track.m_name) || context.albumTitle,
    year: context.year,
    song_page_url: cleanText(track.songPageUrl) || context.albumUrl,
    source_url: context.albumUrl,
    image_url: cleanText(track.img_name)
      ? absoluteUrl(`/uploads/album/${cleanText(track.img_name)}.jpg`, context.albumUrl)
      : "",
    audio_url: audio320 || audio128,
    audio_128_url: audio128,
    audio_320_url: audio320,
    remote_audio_128_url: audio128,
    remote_audio_320_url: audio320,
    download_links_json: JSON.stringify(downloadLinks),
    last_refreshed_at: context.updatedAt,
    updated_at: context.updatedAt,
  };
}

function extractBitrateLink(downloadLinks, bitrate) {
  if (!Array.isArray(downloadLinks)) return "";
  for (const item of downloadLinks) {
    if (Number(item?.bitrate) === bitrate && cleanText(item?.url)) return cleanText(item.url);
    const label = cleanText(item?.label).toLowerCase();
    if (label.includes(String(bitrate)) && cleanText(item?.url)) return cleanText(item.url);
  }
  return "";
}

async function fetchText(target) {
  if (!target) return "";
  const referer = absoluteUrl(target) || originFromUrl(target);
  const response = await fetch(target, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: referer,
      Origin: originFromUrl(referer),
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    redirect: "follow",
  });
  if (!response.ok) return "";
  return response.text();
}

function extractAlbumTracks(html) {
  const match = html.match(/window\.albumTracks\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return [];
  try {
    return JSON.parse(match[1]);
  } catch {
    return [];
  }
}

function parseAlbumTitle(html) {
  const heading = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return heading ? stripTags(heading[1]).slice(0, 180) : "";
}

function parseYear(html, albumUrl = "") {
  const match = html.match(/Year:\s*(\d{4})/i);
  return match ? Number(match[1]) : inferYear(albumUrl, html);
}

function parseMusicDirector(html) {
  const text = stripTags(html);
  const match = text.match(/Music:\s*(.+?)(?:\s+(?:Director:|Lyricists:|Year:|Language:|Starring:)|$)/i);
  return match ? cleanText(match[1]).slice(0, 160) : "";
}

function extractAlbumLinks(html, baseUrl = SITE_ORIGIN) {
  const matches = [...html.matchAll(/href=["']([^"']*?-songs(?:\?[^"']*)?)["']/gi)];
  return unique(matches.map((match) => absoluteUrl(match[1], baseUrl)).filter(Boolean));
}

function rowToSong(row) {
  const baseUrl = cleanText(row.album_url || row.song_page_url || row.source_url);
  return {
    id: row.id,
    albumUrl: absoluteUrl(row.album_url, baseUrl),
    title: cleanText(row.title),
    artist: cleanText(row.artist),
    composer: cleanText(row.composer),
    movie: cleanText(row.movie),
    year: Number(row.year || 0) || inferYear(row.album_url, row.movie, row.title, row.image_url, row.source_url),
    mood: row.mood || "Imported",
    audioUrl: `/api/stream/${row.id}`,
    audio128Url: absoluteUrl(row.audio_128_url, baseUrl),
    audio320Url: absoluteUrl(row.audio_320_url, baseUrl),
    remoteAudio128Url: absoluteUrl(row.remote_audio_128_url, baseUrl),
    remoteAudio320Url: absoluteUrl(row.remote_audio_320_url, baseUrl),
    localAudio128Url: null,
    localAudio320Url: null,
    sourceUrl: absoluteUrl(row.source_url || row.song_page_url || row.album_url, baseUrl),
    imageUrl: absoluteUrl(row.image_url, baseUrl),
    downloadLinks: [],
    spotify: {
      album: null,
      popularity: null,
      previewAvailable: Boolean(row.audio_128_url || row.audio_320_url),
    },
    updatedAt: row.updated_at || row.last_refreshed_at || null,
    lastRefreshedAt: row.last_refreshed_at || null,
    linkStatus: row.link_status || "unknown",
  };
}

function originFromUrl(value, fallback = SITE_ORIGIN) {
  const text = cleanText(value);
  if (text.startsWith("http://") || text.startsWith("https://")) {
    const parsed = new URL(text);
    return `${parsed.protocol}//${parsed.host}`;
  }
  return cleanText(fallback) || SITE_ORIGIN;
}

function absoluteUrl(value, baseValue = SITE_ORIGIN) {
  const text = cleanText(value);
  if (!text) return "";
  if (text.startsWith("http://") || text.startsWith("https://")) return text;
  const origin = originFromUrl(baseValue);
  if (text.startsWith("/")) return `${origin}${text}`;
  return `${origin}/${text}`;
}

function stableSongId(albumUrl, title, trackNumber) {
  const base = `${cleanText(albumUrl)}|${cleanText(title).toLowerCase()}|${Number(trackNumber || 0)}`;
  let hash = 0;
  for (let index = 0; index < base.length; index += 1) {
    hash = ((hash << 5) - hash + base.charCodeAt(index)) | 0;
  }
  return `sync-${Math.abs(hash)}`;
}

function inferYearFromValues(values) {
  return inferYear(...values);
}

function inferYear(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (!text) continue;
    const match = text.match(/(19|20)\d{2}/);
    if (match) return Number(match[0]);
  }
  return 0;
}

function withCors(response) {
  const headers = new Headers(response.headers);
  const extras = corsHeaders();
  for (const [key, value] of Object.entries(extras)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

async function warmSongs(env, origin, rows) {
  for (const row of rows) {
    try {
      await warmSongInCache(env, origin, row);
    } catch {
      // keep warmup best-effort
    }
  }
}

async function warmSongInCache(env, origin, row) {
  const cacheKey = new Request(`${origin}/api/stream/${row.id}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return true;

  let response = await tryAudioCandidates(row, cacheKey);
  if (!response) {
    const refreshed = await tryRefreshSongLink(env, row);
    if (refreshed) response = await tryAudioCandidates(refreshed, cacheKey);
  }
  if (!response) return false;

  await caches.default.put(cacheKey, response.clone());
  return true;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripTags(value) {
  return cleanText(String(value || "").replace(/<[^>]+>/g, " "));
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function unique(values) {
  return [...new Set(values)];
}

function nowIso() {
  return new Date().toISOString();
}

function slugValue(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || `playlist-${Date.now()}`;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Range, x-sync-token",
    "cache-control": "no-store",
  };
}
