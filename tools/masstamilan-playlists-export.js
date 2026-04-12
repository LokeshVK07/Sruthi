(() => {
  const ORIGIN = location.origin;

  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const absolute = (value) => {
    try {
      return new URL(value, ORIGIN).toString();
    } catch {
      return "";
    }
  };
  const slugify = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  async function fetchDocument(url) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`Failed ${response.status} for ${url}`);
    const html = await response.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  function extractPlaylistLinks(doc) {
    return [...new Set(
      [...doc.querySelectorAll('a[href*="/playlists/"]')]
        .map((anchor) => absolute(anchor.getAttribute("href")))
        .filter((href) => href && !href.includes("/playlists?"))
    )];
  }

  function extractSongs(doc) {
    const trackPayloadSongs = extractWindowTracks(doc);
    if (trackPayloadSongs.length) return trackPayloadSongs;

    const linkedSongs = extractLinkedSongs(doc);
    if (linkedSongs.length) return linkedSongs;

    const queueSongs = extractQueueSongs(doc);
    if (queueSongs.length) return queueSongs;

    return [];
  }

  function extractWindowTracks(doc) {
    const scripts = [...doc.querySelectorAll("script")];
    for (const script of scripts) {
      const text = script.textContent || "";
      const literal = extractTracksLiteral(text);
      if (!literal) continue;
      try {
        const decodedText = JSON.parse(literal);
        const decoded = JSON.parse(decodedText);
        if (!Array.isArray(decoded)) continue;
        return dedupeSongs(
          decoded.map((track) => ({
            id: String(track?.id || "").trim(),
            title: clean(track?.name),
            movie: clean(track?.m_name),
            artist: clean(track?.artists),
            composer: clean(track?.music),
            imageUrl: clean(track?.img_name) ? `${ORIGIN}/i5/${clean(track.img_name)}.jpg` : "",
            audio320Url: absolute(track?.dl_path),
          })),
        );
      } catch (error) {
        console.warn("Failed to parse window.tracks", error);
      }
    }
    return [];
  }

  function extractTracksLiteral(text) {
    const marker = "window.tracks = JSON.parse(";
    const start = text.indexOf(marker);
    if (start < 0) return "";
    let index = start + marker.length;
    while (/\s/.test(text[index] || "")) index += 1;
    const quote = text[index];
    if (quote !== '"' && quote !== "'") return "";

    let escaped = false;
    let literal = quote;
    for (let cursor = index + 1; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      literal += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        return literal;
      }
    }
    return "";
  }

  function extractLinkedSongs(doc) {
    const rows = [];
    const anchors = [...doc.querySelectorAll('a[href*="mp3-song"], a[href*="/songs/"], a[href*="-songs"]')];
    anchors.forEach((anchor) => {
      const title = clean(anchor.textContent);
      const songPageUrl = absolute(anchor.getAttribute("href"));
      if (!title || !songPageUrl) return;
      const card = anchor.closest("tr, li, .song, .song-item, .track, .track-item, .card, .list-group-item, .playlist-song");
      const text = clean(card?.textContent || "");
      const movieMatch = text.match(/(?:•|-)\s+([A-Za-z0-9 &().,'/-]{2,})$/);
      rows.push({
        songPageUrl,
        title,
        movie: clean(movieMatch?.[1] || ""),
      });
    });
    return dedupeSongs(rows);
  }

  function extractQueueSongs(doc) {
    const candidates = [
      ...doc.querySelectorAll("textarea, pre, .queue, .jp-playlist, .playlist-box, .playlist-queue, .song-list, .track-list"),
    ];
    const blocks = candidates
      .map((node) => ("value" in node ? node.value : node.textContent))
      .map(clean)
      .filter(Boolean);

    if (!blocks.length) {
      blocks.push(clean(doc.body.innerText || ""));
    }

    const rows = [];
    blocks.forEach((block) => {
      block.split(/\n+/).forEach((line) => {
        const parsed = parseQueueLine(line);
        if (parsed) rows.push(parsed);
      });
    });
    return dedupeSongs(rows);
  }

  function parseQueueLine(line) {
    const text = clean(line);
    if (!text) return null;
    const stripped = clean(text.replace(/^\d+\.\s*/, ""));
    if (!stripped || stripped.length < 2) return null;
    if (/^(feedback|queue|last refreshed|artists?:|music:|download)$/i.test(stripped)) return null;

    const fromMatch = stripped.match(/^(.+?)\s+\(From\s+"([^"]+)"\)$/i);
    if (fromMatch) {
      return {
        title: clean(fromMatch[1]),
        movie: clean(fromMatch[2]),
      };
    }

    const inner = stripped.match(/^(.+?)\s+\((.+)\)$/);
    if (inner) {
      const title = clean(inner[1]);
      const hint = clean(inner[2]
        .replace(/\bOriginal Background Score\b/gi, "")
        .replace(/\bBackground Score\b/gi, "")
        .replace(/\bBGM\b/gi, "")
        .replace(/\bTheme\b/gi, "")
        .replace(/\bAdditional Songs\b/gi, "")
      );
      return {
        title,
        movie: hint,
      };
    }

    return { title: stripped, movie: "" };
  }

  function dedupeSongs(rows) {
    const deduped = [];
    const seen = new Set();
    rows.forEach((row) => {
      const key = `${clean(row.id)}|${clean(row.songPageUrl)}|${clean(row.title).toLowerCase()}|${clean(row.movie).toLowerCase()}`;
      if (!clean(row.title) || seen.has(key)) return;
      seen.add(key);
      deduped.push({
        id: clean(row.id || ""),
        songPageUrl: clean(row.songPageUrl || ""),
        title: clean(row.title),
        movie: clean(row.movie || ""),
        artist: clean(row.artist || ""),
        composer: clean(row.composer || ""),
        imageUrl: clean(row.imageUrl || ""),
        audio320Url: clean(row.audio320Url || ""),
      });
    });
    return deduped;
  }

  async function buildPlaylist(url) {
    const doc = await fetchDocument(url);
    const title =
      clean(doc.querySelector("h1")?.textContent) ||
      clean(doc.title.replace(/\s*-\s*MassTamilan.*$/i, "")) ||
      slugify(url);
    return {
      id: slugify(title) || slugify(url.split("/").pop()),
      name: title,
      sourceUrl: url,
      songs: extractSongs(doc),
    };
  }

  async function run() {
    const listingDoc = document;
    const links = location.pathname.includes("/playlists/")
      ? [location.href]
      : extractPlaylistLinks(listingDoc);

    if (!links.length) {
      console.warn("No playlist links found on this page.");
      return;
    }

    const playlists = [];
    for (const [index, url] of links.entries()) {
      try {
        const playlist = await buildPlaylist(url);
        playlists.push(playlist);
        console.log(`Playlist ${index + 1}/${links.length}: ${playlist.name} (${playlist.songs.length} songs)`);
      } catch (error) {
        console.warn(`Skipped ${url}:`, error.message || error);
      }
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      playlists,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = "masstamilan-playlists-export.json";
    anchor.click();
    URL.revokeObjectURL(downloadUrl);
    console.log(`Exported ${playlists.length} playlists.`);
  }

  run();
})();
