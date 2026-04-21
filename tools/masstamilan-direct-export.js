/*
  MassTamilan direct exporter
  Run this in the browser console while on https://www.masstamilan.dev
  after Cloudflare verification has completed.

  It sends album batches directly to your local site server at http://127.0.0.1:8000
  so there are no JSON downloads.
*/

(async () => {
  function inferSourceConfig(origin) {
    const host = new URL(origin, location.origin).hostname.toLowerCase();
    if (host.includes("masstelugu.com")) {
      return {
        sourceName: "MassTelugu",
        listingPathTemplate: "/telugu-songs?page={page}",
        movieIndexPath: "/movie-index",
      };
    }
    return {
      sourceName: "MassTamilan",
      listingPathTemplate: "/tamil-songs?page={page}",
      movieIndexPath: "/movie-index",
    };
  }

  const SOURCE = inferSourceConfig(location.origin);
  const DEFAULTS = {
    startPage: 1,
    endPage: null,
    pageDelayMs: 250,
    albumDelayMs: 250,
    sleepJitterMs: 180,
    batchSize: 10,
    concurrency: Math.min(Math.max(2, navigator.hardwareConcurrency || 4), 8),
    fetchRetries: 3,
    retryBaseDelayMs: 800,
    apiBase: "http://127.0.0.1:8000",
    includeTagIndex: false,
    movieIndexStopAfterKnownPages: 120,
    listingPathTemplate: SOURCE.listingPathTemplate,
    movieIndexPath: SOURCE.movieIndexPath,
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
  const INCLUDE_TAG_INDEX = Boolean(CONFIG.includeTagIndex);
  const MOVIE_INDEX_STOP_AFTER_KNOWN_PAGES = Math.max(1, Number(CONFIG.movieIndexStopAfterKnownPages || 120));
  const LISTING_PATH_TEMPLATE = CONFIG.listingPathTemplate;
  const LISTING_BASE_PATH = LISTING_PATH_TEMPLATE.split("?")[0];
  const MOVIE_INDEX_PATH = CONFIG.movieIndexPath;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const parser = new DOMParser();
  const randomDelay = (base, jitter = SLEEP_JITTER_MS) => base + Math.floor(Math.random() * jitter);

  function buildListingUrl(page) {
    return LISTING_PATH_TEMPLATE.replace("{page}", String(page));
  }

  function toAbsolute(url) {
    return new URL(url, location.origin).toString();
  }

  function isChallengePage(html) {
    const lowered = (html || "").toLowerCase();
    return (
      lowered.includes("just a moment") ||
      lowered.includes("cf-browser-verification") ||
      lowered.includes("checking your browser") ||
      lowered.includes("enable javascript and cookies to continue")
    );
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
        body: JSON.stringify({ source: location.origin, albums }),
      });

      if (!response.ok) {
        throw new Error(`Local ingest failed: ${response.status}`);
      }

      return response.json();
    });
  }

  async function fetchProcessedUrls() {
    const response = await fetch(`${API_BASE}/api/processed`);
    if (!response.ok) {
      throw new Error(`Could not read local ingestion state: ${response.status}`);
    }

    const payload = await response.json();
    return new Set(payload.processedUrls || []);
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

  function getValueByLabel(text, label) {
    const pattern = new RegExp(`${label}:\\s*(.+)`, "i");
    const match = text.match(pattern);
    return match ? cleanText(match[1]) : null;
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
        if (href.includes(LISTING_BASE_PATH)) return null;
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

  function parseTotalPages(doc) {
    const pages = new Set([START_PAGE]);
    doc.querySelectorAll('a[href*="page="]').forEach((link) => {
      const href = link.getAttribute("href") || "";
      const match = href.match(/[?&]page=(\d+)/);
      if (match) pages.add(Number.parseInt(match[1], 10));
    });
    return Math.max(...pages);
  }

  function parseMovieIndexEntryPaths(doc) {
    const paths = [];
    doc.querySelectorAll("a[href]").forEach((link) => {
      const href = cleanText(link.getAttribute("href"));
      if (!href) return;
      if (href.includes("/browse-by-year/")) {
        paths.push(toAbsolute(href));
        return;
      }
      if (INCLUDE_TAG_INDEX && href.startsWith("/tag/")) {
        paths.push(toAbsolute(href));
      }
    });
    return uniqueBy(paths.filter(Boolean), (item) => item);
  }

  function makeSeed(title, href, pageNumber = 0) {
    const url = toAbsolute(href);
    if (!url) return null;
    return {
      title: cleanText(title),
      url,
      pageNumber,
    };
  }

  function parseDirectoryAlbumSeeds(doc, pageNumber = 0) {
    const candidates = [];
    doc.querySelectorAll("a[href]").forEach((link) => {
      const href = cleanText(link.getAttribute("href"));
      const text = cleanText(link.textContent);
      if (!href || !text) return;
      if (href.startsWith("#") || href.includes("/movie-index") || href.includes("/browse-by-year/") || href.startsWith("/tag/")) return;
      if (/Search|Latest Updates|Movie Index|Telegram|Privacy Policy|Terms of use|Disclaimer|Contact|Tamil Songs|Hindi Songs|Telugu Songs|Malayalam Songs/i.test(text)) return;
      if (!/(Starring:|Music:|Director:)/i.test(text)) return;
      const seed = makeSeed(text.split("Starring:")[0], href, pageNumber);
      if (seed) candidates.push(seed);
    });
    return uniqueBy(candidates, (item) => item.url);
  }

  function parseDirectoryPaginationPaths(doc, currentUrl) {
    const current = new URL(currentUrl, location.origin);
    const currentBase = `${current.origin}${current.pathname}`;
    const pagination = [];
    doc.querySelectorAll("a[href]").forEach((link) => {
      const href = cleanText(link.getAttribute("href"));
      const text = cleanText(link.textContent);
      if (!href || !text) return;
      if (!/^(?:[<>]|\d+)$/.test(text)) return;
      const absolute = toAbsolute(href);
      if (!absolute || absolute === currentUrl) return;
      const parsed = new URL(absolute, location.origin);
      const absoluteBase = `${parsed.origin}${parsed.pathname}`;
      if (absoluteBase !== currentBase) return;
      pagination.push(absolute);
    });
    return uniqueBy(pagination, (item) => item);
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

  console.log(`Collecting ${SOURCE.sourceName} listing pages...`);
  console.log(`Using concurrency=${CONCURRENCY}, batchSize=${BATCH_SIZE}, retries=${FETCH_RETRIES}`);
  const processedUrls = await fetchProcessedUrls();
  const listingAlbumSeeds = [];
  const firstListingDoc = await fetchDocument(buildListingUrl(START_PAGE));
  const detectedTotalPages = parseTotalPages(firstListingDoc);
  const listingEndPage = END_PAGE == null ? detectedTotalPages : END_PAGE;
  listingAlbumSeeds.push(...parseListingPage(firstListingDoc, START_PAGE));
  console.log(`Listing page ${START_PAGE}/${listingEndPage}: +${listingAlbumSeeds.length} albums`);
  await sleep(randomDelay(PAGE_DELAY_MS));

  for (let page = START_PAGE + 1; page <= listingEndPage; page += 1) {
    const doc = await fetchDocument(buildListingUrl(page));
    const parsed = parseListingPage(doc, page);
    listingAlbumSeeds.push(...parsed);
    console.log(`Listing page ${page}/${listingEndPage}: +${parsed.length} albums`);
    await sleep(randomDelay(PAGE_DELAY_MS));
  }

  const movieIndexAlbums = [];
  const seenMovieIndexPages = new Set();
  const seenMovieIndexAlbums = new Set();
  let consecutiveKnownPages = 0;
  let movieIndexPageNumber = 0;
  const movieIndexDoc = await fetchDocument(MOVIE_INDEX_PATH);
  const movieIndexQueue = parseMovieIndexEntryPaths(movieIndexDoc);
  while (movieIndexQueue.length) {
    const pageUrl = movieIndexQueue.shift();
    if (!pageUrl || seenMovieIndexPages.has(pageUrl)) continue;
    seenMovieIndexPages.add(pageUrl);
    movieIndexPageNumber += 1;
    const doc = await fetchDocument(pageUrl);
    const parsed = parseDirectoryAlbumSeeds(doc, movieIndexPageNumber);
    let newOnPage = 0;
    parsed.forEach((seed) => {
      if (seenMovieIndexAlbums.has(seed.url)) return;
      seenMovieIndexAlbums.add(seed.url);
      movieIndexAlbums.push(seed);
      if (!processedUrls.has(seed.url)) newOnPage += 1;
    });
    console.log(`Movie index page ${movieIndexPageNumber}: +${parsed.length} albums (${newOnPage} new)`);
    consecutiveKnownPages = newOnPage === 0 ? consecutiveKnownPages + 1 : 0;
    if (consecutiveKnownPages >= MOVIE_INDEX_STOP_AFTER_KNOWN_PAGES) {
      console.log(`Stopping movie-index crawl after ${consecutiveKnownPages} pages with no new albums.`);
      break;
    }
    parseDirectoryPaginationPaths(doc, pageUrl).forEach((nextPage) => {
      if (!seenMovieIndexPages.has(nextPage)) movieIndexQueue.push(nextPage);
    });
    await sleep(randomDelay(PAGE_DELAY_MS));
  }

  const uniqueAlbums = uniqueBy([...listingAlbumSeeds, ...movieIndexAlbums], (item) => item.url);
  const remainingAlbums = uniqueAlbums.filter((album) => !processedUrls.has(album.url));
  console.log(
    `Found ${uniqueAlbums.length} album pages (${listingAlbumSeeds.length} listing, ${movieIndexAlbums.length} movie index). ${processedUrls.size} already stored locally. ${remainingAlbums.length} remaining.`
  );

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

  for (let index = 0; index < remainingAlbums.length; index += BATCH_SIZE) {
    const chunk = remainingAlbums.slice(index, index + BATCH_SIZE);
    await processChunk(chunk, index, remainingAlbums.length);
    await sleep(randomDelay(ALBUM_DELAY_MS));
  }

  console.log("Direct export complete. Refresh the local site if it is not already updating.");
})();
