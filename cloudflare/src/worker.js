const DEFAULT_SYNC_PATH = "/sruthi-sync.json";
const SITE_ORIGIN = "https://www.masstamilan.dev";
const TELUGU_SITE_ORIGIN = "https://masstelugu.com";
const TELUGU_ID_PREFIX = "telugu:";
const TELUGU_LIBRARY_LIMIT = 2000;
const HOMEPAGE_RECENT_WINDOW_DAYS = 30;
const DEFAULT_TAMIL_OFFICIAL_PLAYLISTS = [];

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
  return Boolean(env?.TELUGU_DB || (env?.TELUGU_SERVICE && typeof env.TELUGU_SERVICE.fetch === "function") || teluguApiOrigin(env));
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
  return fetch(`${base}${path}`, { signal: AbortSignal.timeout(10000), ...init });
}

function decorateTeluguSong(song, env = null) {
  if (!song?.id) return null;
  const prefixedId = prefixTeluguSongId(song.id);
  const teluguOrigin = cleanText(env ? teluguApiOrigin(env) : "");
  const audioUrl = teluguOrigin
    ? `${teluguOrigin}/api/stream/${encodeURIComponent(cleanText(song.id))}`
    : `/api/stream/${prefixedId}`;
  return {
    ...song,
    id: prefixedId,
    audioUrl,
  };
}

async function fetchTeluguAppState(env) {
  if (env.TELUGU_DB) {
    const [albumCountRow, trackCountRow, updatedRow, decadeRows] = await Promise.all([
      env.TELUGU_DB.prepare("SELECT COUNT(*) AS count FROM albums").first(),
      env.TELUGU_DB.prepare("SELECT COUNT(*) AS count FROM songs").first(),
      env.TELUGU_DB.prepare("SELECT MAX(updated_at) AS updatedAt FROM songs").first(),
      env.TELUGU_DB.prepare(
        `
        SELECT DISTINCT ((year / 10) * 10) AS decade
        FROM songs
        WHERE year > 0
        ORDER BY decade ASC
        `,
      ).all(),
    ]);
    return {
      summary: {
        albumCount: Number(albumCountRow?.count || 0),
        trackCount: Number(trackCountRow?.count || 0),
      },
      filters: {
        decades: (decadeRows.results || []).map((row) => `${row.decade}s`).filter(Boolean),
        moods: ["Imported"],
      },
      updatedAt: updatedRow?.updatedAt || null,
    };
  }
  try {
    const response = await fetchTeluguResponse(env, "/api/app-state");
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchTeluguLibrary(env, { query, movie, decade, offset = 0, limit = TELUGU_LIBRARY_LIMIT }) {
  if (env.TELUGU_DB) {
    // We can't easily call handleApi internally, so we use queryLocalLibrary but on TELUGU_DB
    const payload = await queryLocalLibrary(env, { query, movie, decade, offset, limit }, env.TELUGU_DB);
    return {
      songs: (payload.songs || []).map(decorateTeluguSong),
      total: payload.total,
    };
  }

  if (!env.TELUGU_SERVICE && !teluguApiOrigin(env)) {
    return { songs: [], total: 0 };
  }

  const params = new URLSearchParams({
    query: cleanText(query),
    movie: cleanText(movie),
    decade: cleanText(decade) || "all",
    offset: String(Number(offset) || 0),
    limit: String(Number(limit) || TELUGU_LIBRARY_LIMIT),
  });

  try {
    const response = await fetchTeluguResponse(env, `/api/library?${params.toString()}`);
    if (!response.ok) return { songs: [], total: 0 };
    const payload = await response.json();
    return {
      songs: (payload.songs || []).map(decorateTeluguSong).filter(Boolean),
      total: Number(payload.total || 0),
    };
  } catch {
    return { songs: [], total: 0 };
  }
}

async function fetchTeluguSong(env, songId) {
  const rawId = rawTeluguSongId(songId);
  if (!rawId) return null;

  if (env.TELUGU_DB) {
    const row = await env.TELUGU_DB.prepare(
      `
      SELECT id, album_url, title, artist, composer, movie, year, mood,
             song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
             remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
      FROM songs
      WHERE id = ?
      `,
    ).bind(rawId).first();
    if (!row) return null;
    return decorateTeluguSong(rowToSong(row), env);
  }

  if (!env.TELUGU_SERVICE && !teluguApiOrigin(env)) {
    return null;
  }

  try {
    const response = await fetchTeluguResponse(env, `/api/song?id=${encodeURIComponent(rawId)}`);
    if (!response.ok) return null;
    const payload = await response.json();
    return decorateTeluguSong(payload, env);
  } catch {
    return null;
  }
}

async function fetchArtworkResponse(env, request, songId) {
  const isTelugu = isTeluguSongId(songId);
  const language = isTelugu ? "telugu" : "tamil";
  const song = isTelugu
    ? await fetchTeluguSong(env, songId)
    : await (async () => {
        const row = await env.DB.prepare(
          `
          SELECT id, album_url, title, artist, composer, movie, year, mood,
                 song_page_url, source_url, image_url, audio_128_url, audio_320_url,
                 remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
          FROM songs
          WHERE id = ?
          `,
        ).bind(songId).first();
        return row ? rowToSong(row) : null;
      })();

  const originalImageUrl = cleanText(song?.imageUrl || song?.image_url);
  const candidates = [originalImageUrl];
  const pageCandidates = await fetchPageArtworkCandidates(song);
  candidates.push(...pageCandidates);
  const fallbackArtwork = await fetchItunesArtworkCandidate(song, language);
  if (fallbackArtwork) {
    candidates.push(fallbackArtwork);
  }

  for (const rawImageUrl of candidates) {
    const imageUrl = cleanText(rawImageUrl);
    if (!imageUrl) continue;
    try {
      const referer = cleanText(song?.albumUrl || song?.sourceUrl || imageUrl);
      const response = await fetch(imageUrl, {
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          Referer: referer,
          Origin: originFromUrl(referer),
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      });
      if (!response.ok) {
        continue;
      }
      if (imageUrl !== originalImageUrl) {
        ctxWaitUntilSafe(persistSongArtwork(env, songId, imageUrl));
      }
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "public, max-age=86400");
      return withCors(new Response(response.body, { status: response.status, headers }));
    } catch {
      continue;
    }
  }

  return env.ASSETS.fetch(new Request(new URL("/Sruthi_kutty.jpg", request.url), request));
}

function metadataKey(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function decodeHtmlEntityText(value) {
  return cleanText(value)
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function extractArtworkCandidatesFromHtml(html, baseUrl = SITE_ORIGIN) {
  if (!html) return [];
  const matches = [];
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/gi,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/gi,
    /"image"\s*:\s*"([^"]+)"/gi,
    /(?:src|href)=["']([^"']*\/uploads\/album\/[^"']+\.(?:jpg|jpeg|png|webp))["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const candidate = absoluteUrl(decodeHtmlEntityText(match[1]), baseUrl);
      if (!candidate) continue;
      if (candidate.includes("/cdn-cgi/") || candidate.includes("challenges.cloudflare.com")) continue;
      matches.push(candidate);
    }
  }
  return unique(matches);
}

async function fetchPageArtworkCandidates(song) {
  const candidates = [];
  const pages = unique([song?.albumUrl, song?.sourceUrl, song?.songPageUrl].map(cleanText).filter(Boolean));
  for (const pageUrl of pages) {
    const html = await fetchText(pageUrl);
    if (!html) continue;
    const extracted = extractArtworkCandidatesFromHtml(html, pageUrl);
    if (extracted.length) {
      candidates.push(...extracted);
      break;
    }
  }
  return unique(candidates);
}

function upgradeItunesArtworkUrl(url) {
  const text = cleanText(url);
  if (!text) return "";
  return text.replace(/\/\d+x\d+bb(?:-\d+)?\.(jpg|png)$/i, "/1200x1200bb.$1");
}

function scoreItunesResult(song, item, language = "tamil") {
  const titleKey = metadataKey(song?.title);
  const movieKey = metadataKey(song?.movie);
  const composerKey = metadataKey(song?.composer);
  const trackKey = metadataKey(item?.trackName || item?.collectionName);
  const collectionKey = metadataKey(item?.collectionName);
  const artistKey = metadataKey(item?.artistName);
  const genreKey = metadataKey(item?.primaryGenreName);
  let score = 0;
  if (titleKey && trackKey === titleKey) score += 120;
  else if (titleKey && trackKey.includes(titleKey)) score += 70;
  if (movieKey && collectionKey === movieKey) score += 90;
  else if (movieKey && collectionKey.includes(movieKey)) score += 60;
  if (composerKey && artistKey.includes(composerKey)) score += 25;
  if (genreKey === language) score += 20;
  if (Number(item?.trackCount || 0) > 0) score += Math.min(10, Number(item.trackCount || 0));
  return score;
}

async function fetchItunesArtworkCandidate(song, language = "tamil") {
  const terms = [];
  const title = cleanText(song?.title);
  const movie = cleanText(song?.movie);
  const composer = cleanText(song?.composer);
  const langLabel = language.charAt(0).toUpperCase() + language.slice(1);

  if (title || movie) terms.push({ entity: "song", term: [title, movie, composer, langLabel].filter(Boolean).join(" ") });
  if (movie) terms.push({ entity: "album", term: [movie, composer, langLabel].filter(Boolean).join(" ") });

  let bestUrl = "";
  let bestScore = 0;
  for (const { entity, term } of terms) {
    if (!term) continue;
    try {
      const response = await fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${encodeURIComponent(entity)}&country=IN&limit=10`,
        { headers: { Accept: "application/json" } },
      );
      if (!response.ok) continue;
      const payload = await response.json();
      for (const item of Array.isArray(payload?.results) ? payload.results : []) {
        const artworkUrl = upgradeItunesArtworkUrl(item?.artworkUrl100 || item?.artworkUrl60);
        if (!artworkUrl) continue;
        const score = scoreItunesResult(song, item, language);
        if (score > bestScore) {
          bestScore = score;
          bestUrl = artworkUrl;
        }
      }
    } catch {
      continue;
    }
  }
  return bestScore >= 80 ? bestUrl : "";
}

function ctxWaitUntilSafe(promise) {
  promise.catch(() => {});
}

async function persistSongArtwork(env, songId, imageUrl) {
  const cleanSongId = cleanText(songId);
  const updatedAt = nowIso();
  if (isTeluguSongId(cleanSongId)) {
    if (!env.TELUGU_DB) return;
    await env.TELUGU_DB.prepare("UPDATE songs SET image_url = ?, updated_at = ? WHERE id = ?")
      .bind(imageUrl, updatedAt, rawTeluguSongId(cleanSongId))
      .run();
    return;
  }
  await env.DB.prepare("UPDATE songs SET image_url = ?, updated_at = ? WHERE id = ?")
    .bind(imageUrl, updatedAt, cleanSongId)
    .run();
}

async function fetchTeluguSongsBatch(env, ids) {
  const rawIds = ids.map(rawTeluguSongId).filter(Boolean);
  if (!rawIds.length) return [];

  if (env.TELUGU_DB) {
    const chunkSize = 90;
    const songs = [];
    for (let offset = 0; offset < rawIds.length; offset += chunkSize) {
      const chunk = rawIds.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = await env.TELUGU_DB.prepare(
        `
        SELECT id, album_url, title, artist, composer, movie, year, mood,
               song_page_url, source_url, image_url, audio_128_url, audio_320_url,
               remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
        FROM songs
        WHERE id IN (${placeholders})
        `,
      ).bind(...chunk).all();
      songs.push(...(result.results || []).map((row) => decorateTeluguSong(rowToSong(row), env)));
    }
    return songs;
  }

  if (!env.TELUGU_SERVICE && !teluguApiOrigin(env)) return [];

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
    return (payload.songs || []).map(decorateTeluguSong).filter(Boolean);
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
  if (!rawId) return json({ error: "Song not found." }, 404);
  if (!env.TELUGU_SERVICE && !teluguApiOrigin(env)) return json({ error: "Telugu stream unavailable." }, 503);
  const upstream = await fetchTeluguResponse(env, `/api/stream/${encodeURIComponent(rawId)}`, {
    method: "GET",
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

async function queryLocalLibrary(env, { query, movie, decade, offset, limit }, targetDb = null) {
  const db = targetDb || env.DB;
  const bindings = [];
  const filters = [
    "link_status != 'inactive'",
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

  const countStmt = db.prepare(`SELECT COUNT(*) AS count FROM songs ${whereClause}`).bind(...bindings);
  const rankBindings = query
    ? [query, `${query}%`, query, `${query}%`, query, `${query}%`, query, `${query}%`, query, query, query, query]
    : [];
  const rowsBindings = homepage
    ? [...bindings, homepageRecentCutoffIso(), homepageRecentCutoffIso(), limit, offset]
    : [...bindings, ...rankBindings, limit, offset];
  const rowsStmt = db.prepare(
    `
    SELECT id, album_url, title, artist, composer, movie, year, mood,
           song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
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
      env.DB.prepare("SELECT COUNT(*) AS count FROM songs WHERE link_status != 'inactive'").first(),
      env.DB.prepare("SELECT MAX(updated_at) AS updatedAt FROM songs WHERE link_status != 'inactive'").first(),
      env.DB.prepare(
        `
        SELECT DISTINCT ((year / 10) * 10) AS decade
        FROM songs
        WHERE year > 0 AND link_status != 'inactive'
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

  if (url.pathname === "/api/artwork") {
    const songId = cleanText(url.searchParams.get("id"));
    if (!songId) {
      return env.ASSETS.fetch(new Request(new URL("/Sruthi_kutty.jpg", url), request));
    }
    return fetchArtworkResponse(env, request, songId);
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
    const playlists = await listOfficialPlaylists(env, { includeSongIds: false });
    return json({ playlists });
  }

  if (url.pathname === "/api/playlist") {
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
             song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
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
               song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
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
             song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
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

  if (isTeluguSongId(songId)) {
    const rawId = rawTeluguSongId(songId);
    if ((env.TELUGU_SERVICE || teluguApiOrigin(env)) && rawId) {
      return proxyTeluguStream(env, request, rawId);
    }
    if (env.TELUGU_DB && rawId) {
      let row = await env.TELUGU_DB.prepare(
        `
        SELECT id, album_url, title, artist, composer, movie, year, mood,
               song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
               remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
        FROM songs
        WHERE id = ?
        `,
      ).bind(rawId).first();
      if (row) {
        let response = await tryAudioCandidates(row, request, true);
        if (response && !range) {
          ctx?.waitUntil(caches.default.put(request, response.clone()));
        }
        if (response) return response;

        const refreshed = await tryRefreshSongLink(env, row, env.TELUGU_DB);
        if (refreshed) {
          row = refreshed;
          response = await tryAudioCandidates(row, request, true);
          if (response && !range) {
            ctx?.waitUntil(caches.default.put(request, response.clone()));
          }
          if (response) return response;
        }
      }
    }
    return proxyTeluguStream(env, request, rawId);
  }

  const db = env.DB;
  if (!db) {
    return json({ error: "Upstream stream unavailable." }, 502);
  }

  let row = await db.prepare(
    `
    SELECT id, album_url, title, artist, composer, movie, year, mood,
           song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
           remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
    FROM songs
    WHERE id = ?
    `,
  ).bind(songId).first();

  if (!row) return json({ error: "Song not found." }, 404);

  // Start fresh-token fetch in parallel so it's ready if stored token fails
  const freshUrlPromise = fetchFreshAudioUrl(row);

  let response = await tryAudioCandidates(row, request, false);
  if (response) {
    if (!range) ctx?.waitUntil(caches.default.put(request, response.clone()));
    return response;
  }

  // Stored token failed — use fresh URL already being fetched in parallel
  const freshUrl = await freshUrlPromise;
  if (freshUrl) {
    const freshRow = {
      ...row,
      audio_url: freshUrl,
      audio_320_url: freshUrl,
      audio_128_url: freshUrl.replace("/p320_cdn/", "/p128_cdn/"),
      remote_audio_320_url: freshUrl,
      remote_audio_128_url: freshUrl.replace("/p320_cdn/", "/p128_cdn/"),
    };
    response = await tryAudioCandidates(freshRow, request, false);
    if (response) {
      if (!range) ctx?.waitUntil(caches.default.put(request, response.clone()));
      ctx?.waitUntil(tryRefreshSongLink(env, row));
      return response;
    }
  }

  // Last resort: full refresh (writes to D1 for next time)
  const refreshed = await tryRefreshSongLink(env, row);
  if (refreshed) {
    response = await tryAudioCandidates(refreshed, request, false);
    if (response) {
      if (!range) ctx?.waitUntil(caches.default.put(request, response.clone()));
      return response;
    }
  }

  return json({ error: "Stream currently unavailable. Please try again later." }, 503);
}

async function tryAudioCandidates(row, request, isTelugu = false) {
  const range = request.headers.get("Range");
  const defaultBase = isTelugu ? TELUGU_SITE_ORIGIN : SITE_ORIGIN;
  const baseUrl = cleanText(row.album_url || row.song_page_url || row.source_url || defaultBase);
  // album_url first — it's the most reliable referer for MassTamilan's CDN
  const referers = unique([
    absoluteUrl(row.album_url, defaultBase),
    absoluteUrl(row.song_page_url, defaultBase),
    absoluteUrl(row.source_url, defaultBase),
    absoluteUrl(baseUrl, defaultBase),
  ].filter(Boolean));
  const seen = new Set();
  // 320kbps first (audio_url is always 320), then 128 as fallback
  const candidates = [
    row.audio_url,
    row.audio_320_url,
    row.remote_audio_320_url,
    row.audio_128_url,
    row.remote_audio_128_url,
  ].filter(Boolean);

  // Fast path: try the best candidate with the best referer first
  const fastTarget = absoluteUrl(candidates[0], baseUrl);
  if (fastTarget) {
    seen.add(fastTarget);
    const quick = await fetchAudio(fastTarget, referers[0], range);
    if (quick) return quick;
  }

  // Full fallback: try all remaining candidates × all referers
  for (const candidate of candidates) {
    const target = absoluteUrl(candidate, baseUrl);
    if (!target || seen.has(target)) continue;
    seen.add(target);
    for (const referer of referers) {
      const upstream = await fetchAudio(target, referer, range);
      if (upstream) return upstream;
    }
  }
  return null;
}

async function fetchAudio(target, albumUrl, rangeHeader) {
  const referer = cleanText(albumUrl) || SITE_ORIGIN;
  const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
  const rangeModes = rangeHeader ? [rangeHeader, ""] : [""];

  for (const requestedRange of rangeModes) {
    const maxAttempts = requestedRange ? 1 : 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const headers = new Headers({
        Accept: "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: referer,
        Origin: originFromUrl(referer, SITE_ORIGIN),
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      });
      if (requestedRange) headers.set("Range", requestedRange);

      const controller = new AbortController();
      const connectTimeout = setTimeout(() => controller.abort(), 10000);
      let response;
      try {
        response = await fetch(target, {
          method: "GET",
          headers,
          redirect: "follow",
          signal: controller.signal,
        });
      } catch {
        response = null;
      } finally {
        clearTimeout(connectTimeout);
      }

      if (!response) {
        if (attempt < maxAttempts) await sleep(300 * attempt);
        continue;
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (response.ok && !contentType.includes("text/html") && !contentType.includes("text/plain")) {
        const outHeaders = new Headers(corsHeaders());
        outHeaders.set("Content-Type", response.headers.get("content-type") || "audio/mpeg");
        if (response.headers.get("content-length")) outHeaders.set("Content-Length", response.headers.get("content-length"));
        if (response.headers.get("content-range")) outHeaders.set("Content-Range", response.headers.get("content-range"));
        outHeaders.set("Accept-Ranges", response.headers.get("accept-ranges") || "bytes");
        if (!requestedRange) outHeaders.set("Cache-Control", "public, max-age=3600");
        return new Response(response.body, {
          status: response.status,
          headers: outHeaders,
        });
      }

      // 4xx errors (except retryable ones like 429) are permanent — don't retry
      if (response.status >= 400 && response.status < 500 && !retryableStatuses.has(response.status)) {
        break;
      }
      if (!retryableStatuses.has(response.status) && !contentType.includes("text/html")) {
        break;
      }

      if (attempt < maxAttempts) {
        const retryAfter = Math.max(0, toInt(response.headers.get("retry-after"), 0));
        const waitMs = retryAfter > 0 ? Math.min(retryAfter, 1) * 1000 : 350 * attempt;
        await sleep(waitMs);
      }
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFreshAudioUrl(row) {
  const albumUrl = cleanText(row.album_url);
  if (!albumUrl) return null;
  const html = await fetchText(albumUrl);
  if (!html || !html.includes("window.albumTracks")) return null;
  const tracks = extractAlbumTracks(html);
  if (!tracks.length) return null;
  const songPageUrl = cleanText(row.song_page_url);
  const songId = cleanText(row.id);
  const track =
    (songPageUrl && tracks.find(t => cleanText(t.songPageUrl) === songPageUrl)) ||
    tracks.find(t => String(t.id) === songId);
  if (!track) return null;
  const dl = cleanText(track.dl_path);
  if (!dl) return null;
  return dl.includes("/p320_cdn/") ? dl : dl.includes("/p128_cdn/") ? dl.replace("/p128_cdn/", "/p320_cdn/") : dl;
}

async function tryRefreshSongLink(env, row, dbOverride = null) {
  if (!row?.id) return null;
  const db = dbOverride || env.DB;
  const rawId = row.id;
  if (!db) return null;

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

    // We call refreshAlbum with the appropriate DB binding.
    const refreshed = await refreshAlbum(env, albumUrl, albumHtml, db);
    if (!refreshed) continue;
    
    return db.prepare(
      `
      SELECT id, album_url, title, artist, composer, movie, year, mood,
             song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
             remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
      FROM songs
      WHERE id = ?
      `,
    ).bind(rawId).first();
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
      CREATE TABLE IF NOT EXISTS playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT,
        category TEXT NOT NULL,
        cover_url TEXT,
        tags TEXT,
        is_featured INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
      `,
    ),
    env.DB.prepare(
      `
      CREATE TABLE IF NOT EXISTS playlist_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id INTEGER NOT NULL,
        song_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(playlist_id, song_id),
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
      )
      `,
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist_id ON playlist_items(playlist_id)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_playlist_items_song_id ON playlist_items(song_id)"),
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
  const playlists = [];
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
    description: cleanText(playlist?.description),
    category: cleanText(playlist?.category) || "Imported",
    coverUrl: absoluteUrl(playlist?.coverUrl || playlist?.cover_url || playlist?.imageUrl),
    tags: cleanText(playlist?.tags),
    isFeatured: Boolean(playlist?.isFeatured || playlist?.is_featured),
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
      song_page_url = COALESCE(NULLIF(excluded.song_page_url, ''), song_page_url),
      source_url = COALESCE(NULLIF(excluded.source_url, ''), source_url),
      image_url = COALESCE(NULLIF(excluded.image_url, ''), image_url),
      audio_url = COALESCE(NULLIF(excluded.audio_url, ''), audio_url),
      audio_128_url = COALESCE(NULLIF(excluded.audio_128_url, ''), audio_128_url),
      audio_320_url = COALESCE(NULLIF(excluded.audio_320_url, ''), audio_320_url),
      remote_audio_128_url = COALESCE(NULLIF(excluded.remote_audio_128_url, ''), remote_audio_128_url),
      remote_audio_320_url = COALESCE(NULLIF(excluded.remote_audio_320_url, ''), remote_audio_320_url),
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
  const slug = cleanText(playlist.id || slugValue(playlist.name));
  const now = cleanText(playlist.updatedAt) || nowIso();
  const existing = await env.DB.prepare(
    `
    SELECT id
    FROM playlists
    WHERE slug = ?
    LIMIT 1
    `,
  ).bind(slug).first();

  let playlistDbId = Number(existing?.id || 0);
  if (playlistDbId) {
    await env.DB.prepare(
      `
      UPDATE playlists
      SET name = ?, description = ?, category = ?, cover_url = ?, tags = ?, is_featured = ?, updated_at = ?
      WHERE id = ?
      `,
    ).bind(
      playlist.name,
      cleanText(playlist.description),
      cleanText(playlist.category) || "Imported",
      cleanText(playlist.coverUrl),
      cleanText(playlist.tags),
      Number(playlist.isFeatured ? 1 : 0),
      now,
      playlistDbId,
    ).run();
  } else {
    const insert = await env.DB.prepare(
      `
      INSERT INTO playlists (
        name, slug, description, category, cover_url, tags, is_featured, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).bind(
      playlist.name,
      slug,
      cleanText(playlist.description),
      cleanText(playlist.category) || "Imported",
      cleanText(playlist.coverUrl),
      cleanText(playlist.tags),
      Number(playlist.isFeatured ? 1 : 0),
      now,
      now,
    ).run();
    playlistDbId = Number(insert.meta?.last_row_id || 0);
  }

  if (!playlistDbId) return;

  if (!resolvedSongIds.length) return;
  const existingRows = await env.DB.prepare(
    `
    SELECT song_id
    FROM playlist_items
    WHERE playlist_id = ?
    `,
  ).bind(playlistDbId).all();
  const existingSongIds = new Set((existingRows.results || []).map((row) => cleanText(row.song_id)).filter(Boolean));
  const previousCount = existingSongIds.size;
  let remainingNewSlots = Math.max(0, 100 - previousCount);
  const statements = resolvedSongIds.map((songId, index) =>
    env.DB.prepare(
      `
      INSERT INTO playlist_items (playlist_id, song_id, position, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(playlist_id, song_id) DO UPDATE SET
        position = excluded.position
      `,
    ).bind(playlistDbId, songId, index + 1, now)
  ).filter((statement, index) => {
    const songId = resolvedSongIds[index];
    if (existingSongIds.has(songId)) return true;
    if (remainingNewSlots <= 0) return false;
    remainingNewSlots -= 1;
    return true;
  });
  if (!statements.length) return;
  await db.batch(statements);
}

async function listOfficialPlaylists(env, { includeSongIds = true } = {}) {
  await ensureOfficialPlaylistTables(env);
  const rows = await env.DB.prepare(
    `
    SELECT
      p.id,
      p.name,
      p.slug,
      p.description,
      p.category,
      p.cover_url,
      p.tags,
      p.is_featured,
      p.created_at,
      p.updated_at,
      COUNT(pi.song_id) AS song_count
    FROM playlists p
    LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
    GROUP BY
      p.id, p.name, p.slug, p.description, p.category, p.cover_url,
      p.tags, p.is_featured, p.created_at, p.updated_at
    ORDER BY
      CASE WHEN lower(p.slug) = 'vijay-hits' THEN 0 ELSE 1 END ASC,
      lower(p.category) ASC,
      lower(p.name) ASC
    `,
  ).all();
  const results = rows.results || [];
  const playlists = [];
  for (const row of results) {
    const songIds = includeSongIds ? await officialPlaylistSongIds(env, row.slug) : [];
    playlists.push({
      id: cleanText(row.slug),
      name: cleanText(row.name),
      description: cleanText(row.description),
      category: cleanText(row.category),
      coverUrl: cleanText(row.cover_url),
      tags: cleanText(row.tags),
      isFeatured: Number(row.is_featured || 0),
      createdAt: cleanText(row.created_at),
      updatedAt: cleanText(row.updated_at),
      songIds,
      songCount: includeSongIds ? songIds.length : Number(row.song_count || 0),
      official: true,
    });
  }
  return playlists;
}

async function officialPlaylistSongIds(env, playlistSlug) {
  const songs = await env.DB.prepare(
    `
    SELECT pi.song_id
    FROM playlist_items pi
    JOIN playlists p ON p.id = pi.playlist_id
    WHERE p.slug = ?
    ORDER BY pi.position ASC, pi.song_id ASC
    `,
  ).bind(playlistSlug).all();
  return (songs.results || []).map((item) => cleanText(item.song_id)).filter(Boolean);
}

async function loadOfficialPlaylistDetail(env, playlistId) {
  await ensureOfficialPlaylistTables(env);
  const row = await env.DB.prepare(
    `
    SELECT
      id,
      name,
      slug,
      description,
      category,
      cover_url,
      tags,
      is_featured,
      created_at,
      updated_at
    FROM playlists
    WHERE slug = ?
    LIMIT 1
    `,
  ).bind(playlistId).first();
  if (!row) return null;

  const songIds = await officialPlaylistSongIds(env, cleanText(row.slug));
  const songs = await loadSongsByIds(env, songIds);
  return {
    id: cleanText(row.slug),
    name: cleanText(row.name),
    description: cleanText(row.description),
    category: cleanText(row.category),
    coverUrl: cleanText(row.cover_url),
    tags: cleanText(row.tags),
    isFeatured: Number(row.is_featured || 0),
    createdAt: cleanText(row.created_at),
    updatedAt: cleanText(row.updated_at),
    songCount: songIds.length,
    songIds: songs.map((song) => song.id),
    songs,
    official: true,
  };
}

async function loadSongsByIds(env, ids) {
  const uniqueIds = [...new Set((ids || []).map(cleanText).filter(Boolean))];
  if (!uniqueIds.length) return [];

  const tamilIds = uniqueIds.filter(id => !isTeluguSongId(id));
  const teluguIds = uniqueIds.filter(id => isTeluguSongId(id));
  const byId = new Map();

  if (tamilIds.length) {
    const chunkSize = 90;
    for (let offset = 0; offset < tamilIds.length; offset += chunkSize) {
      const chunk = tamilIds.slice(offset, offset + chunkSize);
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
      (result.results || []).forEach(row => byId.set(cleanText(row.id), rowToSong(row)));
    }
  }

  if (teluguIds.length) {
    if (env.TELUGU_DB) {
      const rawIds = teluguIds.map(rawTeluguSongId).filter(Boolean);
      const chunkSize = 90;
      for (let offset = 0; offset < rawIds.length; offset += chunkSize) {
        const chunk = rawIds.slice(offset, offset + chunkSize);
        const placeholders = chunk.map(() => "?").join(", ");
        const result = await env.TELUGU_DB.prepare(
          `
          SELECT id, album_url, title, artist, composer, movie, year, mood,
                 song_page_url, source_url, image_url, audio_128_url, audio_320_url,
                 remote_audio_128_url, remote_audio_320_url, last_refreshed_at, link_status
          FROM songs
          WHERE id IN (${placeholders})
          `,
        ).bind(...chunk).all();
        (result.results || []).forEach(row => {
          const song = decorateTeluguSong(rowToSong(row), env);
          if (song) byId.set(song.id, song);
        });
      }
    } else {
      const teluguSongs = await fetchTeluguSongsBatch(env, teluguIds);
      teluguSongs.forEach(song => byId.set(song.id, song));
    }
  }

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

async function refreshAlbum(env, albumUrl, html, dbOverride = null) {
  const db = dbOverride || env.DB;
  const albumTracks = extractAlbumTracks(html);
  if (!albumTracks.length) return false;
  const existingRows = await db.prepare(
    `
    SELECT id, title, song_page_url
    FROM songs
    WHERE album_url = ?
    `,
  ).bind(albumUrl).all();
  const existingByPageUrl = new Map();
  const existingByTitleKey = new Map();
  for (const row of existingRows.results || []) {
    const pageUrl = cleanText(row.song_page_url);
    if (pageUrl && pageUrl !== albumUrl && !existingByPageUrl.has(pageUrl)) {
      existingByPageUrl.set(pageUrl, row);
    }
    const titleKey = songIdentityKey(row.title);
    if (!titleKey) continue;
    const bucket = existingByTitleKey.get(titleKey) || [];
    bucket.push(row);
    existingByTitleKey.set(titleKey, bucket);
  }

  const albumTitle = parseAlbumTitle(html) || "Untitled album";
  const year = parseYear(html, albumUrl);
  const composer = parseMusicDirector(html) || "Unknown composer";
  const updatedAt = new Date().toISOString();

  const statements = [];
  statements.push(
    db.prepare(
      `
      INSERT INTO albums (
        url, title, page_number, year, music_director, director, starring, lyricists,
        zip_links_json, track_count, updated_at
      ) VALUES (?, ?, 0, ?, ?, '', '', '', '[]', ?, ?)
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
    ).bind(albumUrl, albumTitle, year, composer, albumTracks.length, updatedAt),
  );

  for (const track of albumTracks) {
    const payload = buildTrackPayload(track, {
      albumUrl,
      albumTitle,
      composer,
      year,
      updatedAt,
      existingByPageUrl,
      existingByTitleKey,
    });
    statements.push(
      db.prepare(
        `
        INSERT INTO songs (
          id, album_url, title, artist, singers, composer, movie, year, mood,
          song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
          remote_audio_128_url, remote_audio_320_url, local_audio_128_url, local_audio_320_url,
          download_links_json, spotify_json, last_refreshed_at, link_status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Imported', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, '{}', ?, 'fresh', ?)
        ON CONFLICT(id) DO UPDATE SET
          album_url = excluded.album_url,
          title = excluded.title,
          artist = excluded.artist,
          singers = excluded.singers,
          composer = excluded.composer,
          movie = excluded.movie,
          year = excluded.year,
          mood = excluded.mood,
          song_page_url = COALESCE(NULLIF(excluded.song_page_url, ''), song_page_url),
          source_url = COALESCE(NULLIF(excluded.source_url, ''), source_url),
          image_url = COALESCE(NULLIF(excluded.image_url, ''), image_url),
          audio_url = COALESCE(NULLIF(excluded.audio_url, ''), audio_url),
          audio_128_url = COALESCE(NULLIF(excluded.audio_128_url, ''), audio_128_url),
          audio_320_url = COALESCE(NULLIF(excluded.audio_320_url, ''), audio_320_url),
          remote_audio_128_url = COALESCE(NULLIF(excluded.remote_audio_128_url, ''), remote_audio_128_url),
          remote_audio_320_url = COALESCE(NULLIF(excluded.remote_audio_320_url, ''), remote_audio_320_url),
          local_audio_128_url = excluded.local_audio_128_url,
          local_audio_320_url = excluded.local_audio_320_url,
          download_links_json = excluded.download_links_json,
          spotify_json = excluded.spotify_json,
          last_refreshed_at = excluded.last_refreshed_at,
          link_status = 'fresh',
          updated_at = excluded.updated_at
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

  const refreshedSongIds = albumTracks
    .map((track) => {
      const payload = buildTrackPayload(track, {
        albumUrl,
        albumTitle,
        composer,
        year,
        updatedAt,
        existingByPageUrl,
        existingByTitleKey,
      });
      return cleanText(payload.id);
    })
    .filter(Boolean);
  const staleSongIds = (existingRows.results || [])
    .map((row) => cleanText(row.id))
    .filter((songId) => songId && !refreshedSongIds.includes(songId));
  if (staleSongIds.length) {
    const placeholders = staleSongIds.map(() => "?").join(", ");
    statements.push(
      db.prepare(
        `UPDATE songs SET link_status = 'inactive', updated_at = ? WHERE album_url = ? AND id IN (${placeholders})`,
      ).bind(updatedAt, albumUrl, ...staleSongIds),
    );
  }

  statements.push(
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('updatedAt', ?)").bind(updatedAt),
  );
  await db.batch(statements);
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
  const songPageUrl = cleanText(track.songPageUrl) || context.albumUrl;
  const existingMatch = resolveExistingAlbumSong(context, {
    title: cleanText(track.name),
    songPageUrl,
  });
  return {
    id: cleanText(existingMatch?.id) || String(track.id),
    album_url: context.albumUrl,
    title: cleanText(track.name) || "Untitled",
    artist: cleanText(track.artists) || "Unknown artist",
    composer: context.composer,
    movie: cleanText(track.m_name) || context.albumTitle,
    year: context.year,
    song_page_url: songPageUrl,
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

function songIdentityKey(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function resolveExistingAlbumSong(context, track) {
  const pageUrl = cleanText(track.songPageUrl);
  if (pageUrl && pageUrl !== context.albumUrl && context.existingByPageUrl?.has(pageUrl)) {
    return context.existingByPageUrl.get(pageUrl);
  }
  const titleKey = songIdentityKey(track.title);
  if (!titleKey) return null;
  const matches = context.existingByTitleKey?.get(titleKey) || [];
  if (matches.length === 1) return matches[0];
  return null;
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
  try {
    const response = await fetch(target, {
      signal: AbortSignal.timeout(8000),
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
  } catch {
    return "";
  }
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
