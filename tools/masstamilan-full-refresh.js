/*
  MassTamilan full-catalog refresh
  Run this in the browser console while on https://www.masstamilan.dev
  after Cloudflare verification has completed.

  It re-scrapes the full album catalog and overwrites stored albums in the
  local Sruthi catalog, so expired 128 kbps / 320 kbps links are refreshed
  in one pass.
*/

(async () => {
  const DEFAULTS = {
    startPage: 1,
    endPage: 480,
    pageDelayMs: 250,
    albumDelayMs: 200,
    sleepJitterMs: 180,
    batchSize: 12,
    concurrency: Math.min(Math.max(2, navigator.hardwareConcurrency || 4), 8),
    fetchRetries: 3,
    retryBaseDelayMs: 800,
    apiBase: "http://127.0.0.1:8000",
  };
  const CONFIG = { ...DEFAULTS, ...(window.SRUTHI_SCRAPER_CONFIG || {}) };
  const START_PAGE = CONFIG.startPage;
  const END_PAGE = CONFIG.endPage;
  const PAGE_DELAY_MS = CONFIG.pageDelayMs;
  const ALBUM_DELAY_MS = CONFIG.albumDelayMs;
  const SLEEP_JITTER_MS = CONFIG.sleepJitterMs;
  const BATCH_SIZE = CONFIG.batchSize;
  const CONCURRENCY = CONFIG.concurrency;
  const FETCH_RETRIES = CONFIG.fetchRetries;
  const RETRY_BASE_DELAY_MS = CONFIG.retryBaseDelayMs;
  const API_BASE = CONFIG.apiBase;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const parser = new DOMParser();
  const randomDelay = (base, jitter = SLEEP_JITTER_MS) => base + Math.floor(Math.random() * jitter);

  function toAbsolute(url) {
    return new URL(url, location.origin).toString();
  }

  function isChallengePage(html) {
    const lowered = (html || "").toLowerCase();
    return lowered.includes("just a moment") || lowered.includes("cf-browser-verification") || lowered.includes("cloudflare");
  }

  async function withRetry(label, task) {
    let lastError = null;
    for (let attempt = 1; attempt <= FETCH_RETRIES; attempt += 1) {
      try {
        return await task(attempt);
      } catch (error) {
        lastError = error;
        if (attempt === FETCH_RETRIES) break;
        const delay = randomDelay(RETRY_BASE_DELAY_MS * attempt);
        console.warn(`${label} failed on attempt ${attempt}/${FETCH_RETRIES}. Retrying in ${delay}ms.`, error);
        await sleep(delay);
      }
    }
    throw lastError;
  }

  async function fetchDocument(url) {
    return withRetry(`fetch ${url}`, async () => {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        throw new Error(`Request failed: ${response.status} ${url}`);
      }

      const html = await response.text();
      if (isChallengePage(html)) {
        throw new Error(`Challenge page detected for ${url}`);
      }
      return parser.parseFromString(html, "text/html");
    });
  }

  async function postBatch(albums) {
    return withRetry(`post batch (${albums.length})`, async () => {
      const response = await fetch(`${API_BASE}/api/catalog/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ albums }),
      });

      if (!response.ok) {
        throw new Error(`Local ingest failed: ${response.status}`);
      }

      return response.json();
    });
  }

  function uniqueBy(items, keyFn) {
    const seen = new Set();
    return items.filter((item) => {
      const key = keyFn(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractBoundedValue(text, label, nextLabels = []) {
    const boundaries = [
      ...nextLabels.map((item) => `${escapeRegex(item)}:`),
      "Download\\b",
      "Track Name\\b",
      "window\\.albumTracks\\b",
      "Latest from\\b",
      "Trending at\\b",
      "Browse by\\b",
      "Incoming Search Terms\\b",
    ];
    const pattern = new RegExp(
      `${escapeRegex(label)}:\\s*(.+?)(?=\\s+(?:${boundaries.join("|")})|$)`,
      "i"
    );
    const match = cleanText(text).match(pattern);
    return match ? cleanText(match[1]) : null;
  }

  function normalizeKey(value) {
    return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }

  function detectBitrate(label, url) {
    const labelText = cleanText(label).toLowerCase();
    const urlText = cleanText(url).toLowerCase();
    if (urlText.includes("/p320_cdn/") || urlText.includes("/d320_cdn/") || /\b320\s*kbps\b/.test(labelText)) return 320;
    if (urlText.includes("/p128_cdn/") || urlText.includes("/d128_cdn/") || /\b128\s*kbps\b/.test(labelText)) return 128;
    return null;
  }

  function inferBitrateUrl(url, bitrate) {
    if (!url) return null;
    return url.replace(/\/p(?:128|320)_cdn\//i, `/p${bitrate}_cdn/`);
  }

  function normalizeDownloadLinks(downloadLinks, fallbackUrl) {
    const normalized = [];
    const seen = new Set();
    let audio128Url = null;
    let audio320Url = null;

    function pushLink(label, url, bitrate) {
      if (!url || seen.has(url)) return;
      seen.add(url);
      normalized.push({
        label: cleanText(label) || (bitrate ? `${bitrate}kbps` : "Download"),
        url: toAbsolute(url),
        bitrate,
      });
    }

    downloadLinks.forEach((item) => {
      const url = toAbsolute(item.url);
      const bitrate = detectBitrate(item.label, url);
      pushLink(item.label, url, bitrate);
      if (bitrate === 128 && !audio128Url) audio128Url = url;
      if (bitrate === 320 && !audio320Url) audio320Url = url;
    });

    if (fallbackUrl) {
      const absolute = toAbsolute(fallbackUrl);
      if (absolute.includes("/p128_cdn/") && !audio128Url) audio128Url = absolute;
      if (absolute.includes("/p320_cdn/") && !audio320Url) audio320Url = absolute;
    }

    if (audio128Url && !audio320Url) audio320Url = inferBitrateUrl(audio128Url, 320);
    if (audio320Url && !audio128Url) audio128Url = inferBitrateUrl(audio320Url, 128);

    if (audio320Url) pushLink("320kbps", audio320Url, 320);
    if (audio128Url) pushLink("128kbps", audio128Url, 128);

    normalized.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return {
      downloadLinks: normalized,
      audio128Url,
      audio320Url,
      audioUrl: audio320Url || audio128Url || null,
    };
  }

  function extractAlbumTracksFromScripts(doc) {
    for (const script of doc.querySelectorAll("script")) {
      const text = script.textContent || "";
      const match = text.match(/window\.albumTracks\s*=\s*(\[.*?\]);/s);
      if (!match) continue;
      try {
        return JSON.parse(match[1]);
      } catch (_) {
        return [];
      }
    }
    return [];
  }

  function collectTrackSections(doc, albumTitle) {
    const sections = new Map();
    const trackHeadings = [...doc.querySelectorAll("h2 a, h2")].filter((node) => {
      const text = cleanText(node.textContent);
      if (!text || text === albumTitle) return false;
      if (/Download .* songs in RAR\/ZIP format/i.test(text)) return false;
      if (/Songs Download MassTamilan/i.test(text)) return false;
      if (/Other .* Songs Download/i.test(text)) return false;
      return true;
    });

    trackHeadings.forEach((heading, index) => {
      const title = cleanText(heading.textContent);
      const key = normalizeKey(title);
      const details = [];
      const downloadLinks = [];
      let cursor =
        heading.parentElement?.tagName === "A"
          ? heading.parentElement.nextElementSibling
          : heading.nextElementSibling;

      while (cursor) {
        if (cursor.matches("h2") || cursor.querySelector("h2")) break;
        const text = cleanText(cursor.textContent);
        if (!text) {
          cursor = cursor.nextElementSibling;
          continue;
        }
        if (/^###|^####|^Latest from|^Trending at|^Browse by/i.test(text)) break;

        details.push(text);
        cursor.querySelectorAll?.("a[href]").forEach((link) => {
          const href = link.getAttribute("href") || "";
          if (/\.mp3|128kbps|320kbps/i.test(cleanText(link.textContent)) || /\.mp3/i.test(href)) {
            downloadLinks.push({
              label: cleanText(link.textContent),
              url: toAbsolute(link.href),
            });
          }
        });

        if (/Downloads:/i.test(text)) break;
        cursor = cursor.nextElementSibling;
      }

      const joined = details.join(" ");
      const existing = sections.get(key);
      const nextSection = {
        id: `${albumTitle}-${index + 1}-${key}`,
        title,
        songPageUrl: heading.closest("a")?.href ? toAbsolute(heading.closest("a").href) : null,
        singers: extractBoundedValue(joined, "Singers", ["Length", "Downloads"]),
        length: extractBoundedValue(joined, "Length", ["Downloads"]),
        downloads: extractBoundedValue(joined, "Downloads"),
        downloadLinks: uniqueBy(downloadLinks, (item) => item.url),
      };
      sections.set(key, {
        ...(existing || {}),
        ...nextSection,
        songPageUrl: nextSection.songPageUrl || existing?.songPageUrl || null,
        downloadLinks: uniqueBy([...(existing?.downloadLinks || []), ...nextSection.downloadLinks], (item) => item.url),
      });
    });

    return sections;
  }

  function parseListingPage(doc, pageNumber) {
    const links = [...doc.querySelectorAll('a[href*="/"]')];
    const candidates = links
      .map((link) => {
        const href = link.getAttribute("href");
        const text = cleanText(link.textContent);
        if (!href || !text) return null;
        if (href.includes("/tamil-songs")) return null;
        if (/Search|Latest Updates|Movie Index|Telegram|Privacy Policy|Terms of use|Disclaimer|Contact/i.test(text)) {
          return null;
        }
        if (!/(Starring:|Music:|Director:)/i.test(text)) return null;

        return {
          title: cleanText(text.split("Starring:")[0]),
          url: toAbsolute(href),
          pageNumber,
        };
      })
      .filter(Boolean);

    return uniqueBy(candidates, (item) => item.url);
  }

  function extractTrackIdFromUrl(url) {
    const match = cleanText(url).match(/\/(?:p128|p320)_cdn\/(\d+)(?:$|[/?#])/i);
    return match ? match[1] : null;
  }

  function collectGlobalTrackLinks(doc) {
    const byTrackId = new Map();
    doc.querySelectorAll("a[href]").forEach((link) => {
      const href = link.href || link.getAttribute("href") || "";
      const bitrate = detectBitrate(link.textContent, href);
      const trackId = extractTrackIdFromUrl(href);
      if (!trackId || !bitrate) return;
      if (!byTrackId.has(trackId)) byTrackId.set(trackId, []);
      byTrackId.get(trackId).push({
        label: cleanText(link.textContent) || `${bitrate}kbps`,
        url: toAbsolute(href),
        bitrate,
      });
    });
    return byTrackId;
  }

  function parseAlbumPage(doc, albumSeed) {
    const fullText = cleanText(doc.body.textContent);
    const infoText = cleanText(fullText.split("Track Name")[0] || fullText);
    const year = extractBoundedValue(infoText, "Year");
    const composer = extractBoundedValue(infoText, "Music", ["Director", "Lyricists", "Year", "Language"]);
    const director = extractBoundedValue(infoText, "Director", ["Lyricists", "Year", "Language"]);
    const starring = extractBoundedValue(infoText, "Starring", ["Music", "Director", "Lyricists", "Year", "Language"]);
    const lyricists = extractBoundedValue(infoText, "Lyricists", ["Year", "Language"]);

    const zipLinks = [...doc.querySelectorAll('a[href$=".zip"], a[href*=".zip?"]')].map((link) => ({
      label: cleanText(link.textContent),
      url: toAbsolute(link.href),
    }));

    const sectionMap = collectTrackSections(doc, albumSeed.title);
    const globalTrackLinks = collectGlobalTrackLinks(doc);
    const scriptTracks = extractAlbumTracksFromScripts(doc);
    const tracks = [];

    if (scriptTracks.length) {
      scriptTracks.forEach((item, index) => {
        const section = sectionMap.get(normalizeKey(item.name)) || {};
        const mergedDownloadLinks = [
          ...(section.downloadLinks || []),
          ...(globalTrackLinks.get(String(item.id)) || []),
        ];
        const links = normalizeDownloadLinks(mergedDownloadLinks, item.dl_path);
        tracks.push({
          id: String(item.id || `${albumSeed.pageNumber}-${index + 1}-${normalizeKey(item.name)}`),
          title: cleanText(item.name),
          songPageUrl: section.songPageUrl || albumSeed.url,
          singers: section.singers || cleanText(item.artists),
          length: section.length || null,
          downloads: section.downloads || null,
          artist: section.singers || cleanText(item.artists),
          composer,
          movie: cleanText(item.m_name || albumSeed.title),
          year: year ? Number.parseInt(year, 10) : null,
          imageUrl: item.img_name ? toAbsolute(`/uploads/album/${item.img_name}.jpg`) : null,
          downloadLinks: links.downloadLinks,
          audio128Url: links.audio128Url,
          audio320Url: links.audio320Url,
          audioUrl: links.audioUrl,
          spotify: {
            album: null,
            popularity: null,
            previewAvailable: Boolean(links.audioUrl),
          },
        });
      });
    } else {
      sectionMap.forEach((section, key) => {
        const links = normalizeDownloadLinks(section.downloadLinks || [], null);
        tracks.push({
          id: section.id || `${albumSeed.pageNumber}-${key}`,
          title: section.title,
          songPageUrl: section.songPageUrl || albumSeed.url,
          singers: section.singers || null,
          length: section.length || null,
          downloads: section.downloads || null,
          artist: section.singers || null,
          composer,
          movie: albumSeed.title,
          year: year ? Number.parseInt(year, 10) : null,
          imageUrl: null,
          downloadLinks: links.downloadLinks,
          audio128Url: links.audio128Url,
          audio320Url: links.audio320Url,
          audioUrl: links.audioUrl,
          spotify: {
            album: null,
            popularity: null,
            previewAvailable: Boolean(links.audioUrl),
          },
        });
      });
    }

    return {
      title: albumSeed.title,
      url: albumSeed.url,
      pageNumber: albumSeed.pageNumber,
      year: year ? Number.parseInt(year, 10) : null,
      musicDirector: composer,
      director,
      starring,
      lyricists,
      zipLinks,
      tracks: uniqueBy(tracks, (item) => `${item.id}::${item.songPageUrl || ""}`),
    };
  }

  async function collectAlbumSeeds() {
    const albumSeeds = [];
    for (let page = START_PAGE; page <= END_PAGE; page += 1) {
      const doc = await fetchDocument(`/tamil-songs?page=${page}`);
      const parsed = parseListingPage(doc, page);
      albumSeeds.push(...parsed);
      console.log(`Listing page ${page}/${END_PAGE}: +${parsed.length} albums`);
      await sleep(randomDelay(PAGE_DELAY_MS));
    }
    return uniqueBy(albumSeeds, (item) => item.url);
  }

  async function fetchAlbumWithJitter(album, index, total) {
    await sleep(randomDelay(ALBUM_DELAY_MS * ((index % CONCURRENCY) + 1)));
    const doc = await fetchDocument(album.url);
    const parsed = parseAlbumPage(doc, album);
    console.log(`Album ${index + 1}/${total}: ${parsed.title} (${parsed.tracks.length} tracks)`);
    return parsed;
  }

  async function processChunk(chunk, startIndex, total) {
    const settled = await Promise.allSettled(
      chunk.map((album, chunkIndex) => fetchAlbumWithJitter(album, startIndex + chunkIndex, total))
    );

    const successes = [];
    settled.forEach((result, idx) => {
      const album = chunk[idx];
      if (result.status === "fulfilled") {
        successes.push(result.value);
        return;
      }
      console.error(`Failed album: ${album.url}`, result.reason);
    });

    if (successes.length) {
      const result = await postBatch(successes);
      console.log(
        `Uploaded batch of ${successes.length}. Local catalog now has ${result.savedAlbums} albums and ${result.savedTracks} tracks.`
      );
    }
  }

  console.log(`Collecting full album list from pages ${START_PAGE}-${END_PAGE}...`);
  console.log(`Using concurrency=${CONCURRENCY}, batchSize=${BATCH_SIZE}, retries=${FETCH_RETRIES}`);
  const albums = await collectAlbumSeeds();
  console.log(`Refreshing ${albums.length} albums into the local catalog.`);

  for (let index = 0; index < albums.length; index += BATCH_SIZE) {
    const chunk = albums.slice(index, index + BATCH_SIZE);
    await processChunk(chunk, index, albums.length);
    await sleep(randomDelay(ALBUM_DELAY_MS));
  }

  console.log("Full catalog refresh complete. Refresh Sruthi to use the newest stored links.");
})();
