#!/usr/bin/env python3

from html import unescape
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote_plus, urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from playlist_catalog import ensure_playlist_tables, list_playlists, load_playlist


ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env.local"


def resolve_storage_path(env_name, default_relative_path):
    configured = os.environ.get(env_name)
    if not configured:
        return ROOT / default_relative_path

    path = Path(configured)
    if path.is_absolute():
        return path
    return ROOT / path


DATA_DIR = resolve_storage_path("SRUTHI_DATA_DIR", Path("data"))
RAW_CATALOG_PATH = DATA_DIR / "catalog.json"
INDEX_PATH = DATA_DIR / "catalog-index.json"
STATUS_PATH = DATA_DIR / "catalog-status.json"
DB_PATH = DATA_DIR / "sruthi.db"
TELUGU_DATA_DIR = resolve_storage_path("SRUTHI_TELUGU_DATA_DIR", Path("data") / "telugu")
TELUGU_DB_PATH = TELUGU_DATA_DIR / "sruthi.db"
SITE_ORIGIN = "https://www.masstamilan.dev"
TELUGU_SITE_ORIGIN = "https://masstelugu.com"
TELUGU_ID_PREFIX = "telugu:"
MEDIA_DIR = resolve_storage_path("SRUTHI_MEDIA_DIR", Path("media"))
CACHE_AUDIO_DIR = resolve_storage_path("SRUTHI_CACHE_AUDIO_DIR", Path(".cache") / "audio")
UPSTREAM_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
STREAM_REFRESH_WAIT_SECONDS = 18
STREAM_REFRESH_POLL_SECONDS = 0.5
UPSTREAM_AUDIO_TIMEOUT_SECONDS = 15
UPSTREAM_PAGE_TIMEOUT_SECONDS = 18


def load_local_env():
    values = {}
    if not ENV_PATH.exists():
        return values

    for raw_line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


LOCAL_ENV = load_local_env()

SONG_INDEX = []
APP_STATE = {
    "summary": {"albumCount": 0, "trackCount": 0},
    "filters": {"decades": [], "moods": []},
    "updatedAt": None,
    "refreshWorkerActive": False,
    "refreshWorkerSeenAt": None,
}
REFRESH_QUEUE = []
REFRESH_SEEN = set()
REFRESH_RESULTS = {}
SONG_RECORD_CACHE = {}
PREFETCH_IN_FLIGHT = set()
ALBUM_REFRESH_STATUS = {}
ALBUM_REFRESH_IN_FLIGHT = set()
ALBUM_REFRESH_LOCK = threading.Lock()


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def parse_iso_datetime(value):
    text = clean_text(value)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def is_refresh_worker_active():
    seen_at = parse_iso_datetime(APP_STATE.get("refreshWorkerSeenAt"))
    if not seen_at:
        return False
    return (datetime.now(timezone.utc) - seen_at).total_seconds() <= 30


def ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def get_sqlite_connection(path):
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    return connection


def get_db_connection():
    ensure_data_dir()
    return get_sqlite_connection(DB_PATH)


def telugu_catalog_enabled():
    try:
        return TELUGU_DB_PATH.exists() and TELUGU_DB_PATH.resolve() != DB_PATH.resolve()
    except FileNotFoundError:
        return TELUGU_DB_PATH.exists()


def is_telugu_song_id(song_id):
    return clean_text(song_id).startswith(TELUGU_ID_PREFIX)


def decode_telugu_song_id(song_id):
    key = clean_text(song_id)
    if not key.startswith(TELUGU_ID_PREFIX):
        return key
    return key[len(TELUGU_ID_PREFIX) :]


def encode_telugu_song_id(song_id):
    key = clean_text(song_id)
    if not key:
        return ""
    if key.startswith(TELUGU_ID_PREFIX):
        return key
    return f"{TELUGU_ID_PREFIX}{key}"


def get_song_storage(song_id):
    key = clean_text(song_id)
    if is_telugu_song_id(key):
        return {
            "db_path": TELUGU_DB_PATH,
            "song_id": decode_telugu_song_id(key),
            "id_prefix": TELUGU_ID_PREFIX,
            "use_local_media": False,
            "source_fallback": TELUGU_SITE_ORIGIN,
        }
    return {
        "db_path": DB_PATH,
        "song_id": key,
        "id_prefix": "",
        "use_local_media": True,
        "source_fallback": SITE_ORIGIN,
    }


def ensure_db():
    with get_db_connection() as connection:
        connection.executescript(
            """
            PRAGMA journal_mode=WAL;

            CREATE TABLE IF NOT EXISTS app_meta (
              key TEXT PRIMARY KEY,
              value TEXT
            );

            CREATE TABLE IF NOT EXISTS albums (
              url TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              page_number INTEGER NOT NULL DEFAULT 0,
              year INTEGER NOT NULL DEFAULT 0,
              music_director TEXT,
              director TEXT,
              starring TEXT,
              lyricists TEXT,
              zip_links_json TEXT NOT NULL DEFAULT '[]',
              track_count INTEGER NOT NULL DEFAULT 0,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS songs (
              id TEXT PRIMARY KEY,
              album_url TEXT,
              title TEXT NOT NULL,
              artist TEXT,
              singers TEXT,
              composer TEXT,
              movie TEXT,
              year INTEGER NOT NULL DEFAULT 0,
              mood TEXT NOT NULL DEFAULT 'Imported',
              song_page_url TEXT,
              source_url TEXT,
              image_url TEXT,
              audio_url TEXT,
              audio_128_url TEXT,
              audio_320_url TEXT,
              remote_audio_128_url TEXT,
              remote_audio_320_url TEXT,
              local_audio_128_url TEXT,
              local_audio_320_url TEXT,
              download_links_json TEXT NOT NULL DEFAULT '[]',
              spotify_json TEXT NOT NULL DEFAULT '{}',
              last_refreshed_at TEXT,
              link_status TEXT NOT NULL DEFAULT 'unknown',
              updated_at TEXT NOT NULL,
              FOREIGN KEY (album_url) REFERENCES albums(url) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS download_links (
              song_id TEXT NOT NULL,
              url TEXT NOT NULL,
              label TEXT,
              bitrate INTEGER,
              PRIMARY KEY (song_id, url),
              FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_albums_page_number ON albums(page_number, title);
            CREATE INDEX IF NOT EXISTS idx_songs_album_url ON songs(album_url);
            CREATE INDEX IF NOT EXISTS idx_songs_movie_title ON songs(movie, title);
            CREATE INDEX IF NOT EXISTS idx_songs_year ON songs(year);
            CREATE INDEX IF NOT EXISTS idx_songs_link_status ON songs(link_status);
            """
        )
        ensure_playlist_tables(connection)


def ensure_media_dir():
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)


def ensure_cache_dir():
    CACHE_AUDIO_DIR.mkdir(parents=True, exist_ok=True)


def read_json(path, default):
    if not path.exists():
        return default

    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path, payload):
    ensure_data_dir()
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def clean_text(value):
    return " ".join(str(value or "").split()).strip()


def infer_year_from_sources(*values):
    for value in values:
        text = clean_text(value)
        if not text:
            continue
        match = re.search(r"(19|20)\d{2}", text)
        if match:
            year = int(match.group(0))
            if 1900 <= year <= 2100:
                return year
    return 0


def short_text(value, limit):
    text = clean_text(value)
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1].rstrip()}…"


def as_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def origin_from_url(url, default=SITE_ORIGIN):
    text = clean_text(url)
    if text.startswith("http://") or text.startswith("https://"):
        parsed = urlparse(text)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
    fallback = clean_text(default)
    return fallback or SITE_ORIGIN


def infer_catalog_source(albums, fallback=SITE_ORIGIN):
    for album in albums or []:
        origin = origin_from_url(album.get("url"))
        if origin:
            return origin
        for track in album.get("tracks", []) or []:
            for candidate in (track.get("songPageUrl"), track.get("imageUrl"), track.get("audio320Url"), track.get("audio128Url")):
                origin = origin_from_url(candidate)
                if origin:
                    return origin
    return origin_from_url(fallback)


def absolute_url(url, base_origin=None):
    text = clean_text(url)
    if not text:
        return None
    if text.startswith("http://") or text.startswith("https://"):
        return text
    origin = origin_from_url(base_origin)
    if text.startswith("/"):
        return f"{origin}{text}"
    return f"{origin}/{text.lstrip('/')}"


def metadata_key(value):
    return re.sub(r"[^a-z0-9]+", " ", clean_text(value).lower()).strip()


def upgrade_itunes_artwork_url(url):
    text = clean_text(url)
    if not text:
        return ""
    upgraded = re.sub(r"/\d+x\d+bb(?:-\d+)?\.(jpg|png)$", r"/1200x1200bb.\1", text)
    return upgraded or text


def score_itunes_result(song, item):
    title_key = metadata_key(song.get("title"))
    movie_key = metadata_key(song.get("movie"))
    composer_key = metadata_key(song.get("composer"))
    track_key = metadata_key(item.get("trackName") or item.get("collectionName"))
    collection_key = metadata_key(item.get("collectionName"))
    genre_key = metadata_key(item.get("primaryGenreName"))
    artist_key = metadata_key(item.get("artistName"))
    score = 0
    if title_key and track_key == title_key:
        score += 120
    elif title_key and title_key and title_key in track_key:
        score += 70
    if movie_key and collection_key == movie_key:
        score += 90
    elif movie_key and movie_key in collection_key:
        score += 60
    if composer_key and composer_key and composer_key in artist_key:
        score += 25
    if genre_key == "tamil":
        score += 20
    try:
        if as_int(item.get("trackCount")):
            score += min(10, as_int(item.get("trackCount")))
    except Exception:
        pass
    return score


def fetch_itunes_artwork_candidate(song):
    terms = []
    title = clean_text(song.get("title"))
    movie = clean_text(song.get("movie"))
    composer = clean_text(song.get("composer"))
    if title or movie:
        terms.append(("song", " ".join(part for part in (title, movie, composer, "Tamil") if part)))
    if movie:
        terms.append(("album", " ".join(part for part in (movie, composer, "Tamil") if part)))

    best_item = None
    best_score = 0
    for entity, term in terms:
        if not term:
            continue
        target = (
            "https://itunes.apple.com/search"
            f"?term={quote_plus(term)}&entity={quote_plus(entity)}&country=IN&limit=10"
        )
        request = Request(
            target,
            headers={
                "Accept": "application/json",
                "User-Agent": UPSTREAM_USER_AGENT,
            },
        )
        try:
            with urlopen(request, timeout=UPSTREAM_PAGE_TIMEOUT_SECONDS) as response:
                payload = json.loads(response.read().decode("utf-8", "ignore"))
        except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError):
            continue

        for item in payload.get("results", []) or []:
            artwork = upgrade_itunes_artwork_url(item.get("artworkUrl100") or item.get("artworkUrl60"))
            if not artwork:
                continue
            score = score_itunes_result(song, item)
            if score > best_score:
                best_score = score
                best_item = artwork

    return best_item if best_score >= 80 else ""


def persist_song_artwork(song_id, image_url):
    storage = get_song_storage(song_id)
    db_path = storage.get("db_path")
    if not db_path or not clean_text(image_url):
        return
    with get_sqlite_connection(db_path) as connection:
        connection.execute(
            "UPDATE songs SET image_url = ?, updated_at = ? WHERE id = ?",
            (clean_text(image_url), utc_now(), storage.get("song_id")),
        )


def infer_bitrate_url(url, bitrate):
    value = absolute_url(url)
    if not value:
        return None

    bitrate_value = str(bitrate)
    if "/p128_cdn/" in value or "/p320_cdn/" in value:
        return re.sub(r"/p(?:128|320)_cdn/", f"/p{bitrate_value}_cdn/", value)
    return value


def media_file_path(song_id, bitrate):
    return MEDIA_DIR / str(song_id) / f"{bitrate}.mp3"


def cached_audio_path(song_id):
    return CACHE_AUDIO_DIR / f"{song_id}.mp3"


def is_valid_audio_bytes(data):
    if not data:
        return False
    if data.startswith(b"ID3"):
        return True
    if data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return True
    lowered = data[:512].lower()
    if b"<!doctype html" in lowered or b"<html" in lowered or b"just a moment" in lowered:
        return False
    return False


def is_valid_audio_file(path):
    try:
        head = path.read_bytes()[:512]
    except OSError:
        return False

    return is_valid_audio_bytes(head)


def media_url(song_id, bitrate):
    path = media_file_path(song_id, bitrate)
    if path.exists() and is_valid_audio_file(path):
        return f"/media/{song_id}/{bitrate}.mp3"
    return None


def write_media_bytes(song_id, bitrate, data):
    if not is_valid_audio_bytes(data):
        raise ValueError("Uploaded payload is not a valid MP3 file.")
    target = media_file_path(song_id, bitrate)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_path = target.with_suffix(".part")
    temp_path.write_bytes(data)
    os.replace(temp_path, target)
    return media_url(song_id, bitrate)


def build_local_media_status():
    status = {"128": [], "320": []}
    if not MEDIA_DIR.exists():
        return status

    for bitrate in ("128", "320"):
        for path in sorted(MEDIA_DIR.glob(f"*/{bitrate}.mp3")):
            if is_valid_audio_file(path):
                status[bitrate].append(path.parent.name)
    return status


def public_stream_url(song_id):
    return f"/api/stream/{song_id}"


def strip_html_tags(value):
    return clean_text(re.sub(r"<[^>]+>", " ", value or ""))


def clean_display_text(value, fallback=""):
    text = strip_html_tags(unescape(value or ""))
    return text or fallback


def parse_album_title_from_html(html):
    match = re.search(r"<h1[^>]*>(.*?)</h1>", html or "", re.IGNORECASE | re.DOTALL)
    if not match:
        match = re.search(r"<title[^>]*>(.*?)</title>", html or "", re.IGNORECASE | re.DOTALL)
    return short_text(strip_html_tags(unescape(match.group(1))) if match else "", 180)


def extract_album_links_from_html(html):
    if not html:
        return []
    matches = re.findall(r'href=["\']([^"\']*?-songs(?:\?[^"\']*)?)["\']', html, re.IGNORECASE)
    links = []
    seen = set()
    for match in matches:
        url = absolute_url(unescape(match))
        if not url or url in seen:
            continue
        seen.add(url)
        links.append(url)
    return links


def detect_bitrate(label, url):
    label_text = clean_text(label).lower()
    url_text = clean_text(url).lower()
    if "/p320_cdn/" in url_text or "/d320_cdn/" in url_text or re.search(r"\b320\s*kbps\b", label_text):
        return 320
    if "/p128_cdn/" in url_text or "/d128_cdn/" in url_text or re.search(r"\b128\s*kbps\b", label_text):
        return 128
    return None


def strip_after_labels(value, labels):
    text = clean_text(value)
    if not text:
        return ""
    pattern = r"\s+(?:" + "|".join(re.escape(label) for label in labels) + r")\s*:.*$"
    return clean_text(re.sub(pattern, "", text, flags=re.IGNORECASE))


def extract_labeled_value(text, label, next_labels=None):
    blob = clean_text(text)
    if not blob:
        return ""

    boundaries = [re.escape(item) + ":" for item in (next_labels or [])]
    boundaries.extend(
        [
            r"Download\b",
            r"Track Name\b",
            r"window\.albumTracks\b",
            r"Latest from\b",
            r"Trending at\b",
            r"Browse by\b",
            r"Incoming Search Terms\b",
        ]
    )
    boundary_pattern = "|".join(boundaries)
    pattern = rf"{re.escape(label)}:\s*(.+?)(?=\s+(?:{boundary_pattern})|$)"
    match = re.search(pattern, blob, re.IGNORECASE)
    return clean_text(match.group(1)) if match else ""


def default_raw_catalog():
    return {
        "source": SITE_ORIGIN,
        "ingestedAt": None,
        "updatedAt": None,
        "albums": [],
        "summary": {"albumCount": 0, "trackCount": 0},
    }


def default_status():
    return {
        "albumCount": 0,
        "trackCount": 0,
        "updatedAt": None,
        "isEmpty": True,
    }


def is_noise_song_payload(title, movie):
    blob = f"{clean_text(title).lower()} {clean_text(movie).lower()}"
    return any(
        marker in blob
        for marker in (
            "verification successful",
            "verifying you are human",
            "waiting for",
            "www.masstamilan.dev",
            "masstamilan.dev",
            "masstelugu.com",
        )
    )


def build_raw_catalog_from_db():
    ensure_db()
    with get_db_connection() as connection:
        meta = dict(connection.execute("SELECT key, value FROM app_meta").fetchall())
        albums = []
        album_rows = connection.execute(
            """
            SELECT url, title, page_number, year, music_director, director,
                   starring, lyricists, zip_links_json
            FROM albums
            ORDER BY page_number, title COLLATE NOCASE
            """
        ).fetchall()
        for album_row in album_rows:
            album = dict(album_row)
            tracks = []
            for song_row in connection.execute(
                """
                SELECT id, title, artist, singers, composer, movie, year,
                       song_page_url, image_url, audio_url, audio_128_url, audio_320_url,
                       download_links_json, spotify_json
                FROM songs
                WHERE album_url = ?
                ORDER BY title COLLATE NOCASE, id
                """,
                (album["url"],),
            ).fetchall():
                song = dict(song_row)
                tracks.append(
                    {
                        "id": song["id"],
                        "title": clean_display_text(song["title"], "Untitled"),
                        "artist": clean_display_text(song["artist"], "Unknown artist"),
                        "singers": clean_display_text(song["singers"], "Unknown artist"),
                        "composer": clean_display_text(song["composer"], "Unknown composer"),
                        "movie": clean_display_text(song["movie"], album["title"] or "Unknown movie"),
                        "year": as_int(song["year"]),
                        "songPageUrl": song["song_page_url"],
                        "imageUrl": song["image_url"],
                        "audioUrl": song["audio_url"],
                        "audio128Url": song["audio_128_url"],
                        "audio320Url": song["audio_320_url"],
                        "downloadLinks": json.loads(song["download_links_json"] or "[]"),
                        "spotify": json.loads(song["spotify_json"] or "{}"),
                    }
                )
            albums.append(
                {
                    "title": clean_display_text(album["title"], "Untitled album"),
                    "url": album["url"],
                    "pageNumber": as_int(album["page_number"]),
                    "year": as_int(album["year"]),
                    "musicDirector": clean_display_text(album["music_director"], "Unknown composer"),
                    "director": clean_display_text(album["director"]),
                    "starring": clean_display_text(album["starring"]),
                    "lyricists": clean_display_text(album["lyricists"]),
                    "zipLinks": json.loads(album["zip_links_json"] or "[]"),
                    "tracks": tracks,
                }
            )
    return {
        "source": meta.get("source", SITE_ORIGIN),
        "ingestedAt": meta.get("ingestedAt") or utc_now(),
        "updatedAt": meta.get("updatedAt") or utc_now(),
        "albums": albums,
        "summary": summarize_catalog(albums),
    }


def load_raw_catalog():
    try:
        return read_json(RAW_CATALOG_PATH, default_raw_catalog())
    except json.JSONDecodeError:
        payload = build_raw_catalog_from_db()
        write_json(RAW_CATALOG_PATH, payload)
        return payload


def extract_album_blob(album):
    blob_parts = [
        album.get("blob"),
        album.get("musicDirector"),
        album.get("director"),
        album.get("starring"),
        album.get("lyricists"),
    ]
    blob_parts.extend(track.get("composer") for track in album.get("tracks", [])[:3])
    return " ".join(clean_text(part) for part in blob_parts if clean_text(part))


def extract_music_director(album, blob):
    direct = clean_display_text(album.get("musicDirector"))
    direct = strip_after_labels(direct, ["Director", "Lyricists", "Year", "Language", "Starring", "Track Name"])
    if direct and "window.albumTracks" not in direct and len(direct) < 180:
        return direct

    labeled = extract_labeled_value(
        blob,
        "Music",
        ["Director", "Lyricists", "Year", "Language", "Starring"],
    )
    if labeled:
        return short_text(
            strip_after_labels(
                clean_display_text(labeled),
                ["Director", "Lyricists", "Year", "Language", "Starring", "Track Name"],
            ),
            160,
        )

    match = re.search(
        r"music is composed by (.+?)\.\s+You can also download",
        blob,
        re.IGNORECASE,
    )
    if match:
        return short_text(
            strip_after_labels(
                clean_display_text(match.group(1)),
                ["Director", "Lyricists", "Year", "Language", "Starring", "Track Name"],
            ),
            160,
        )

    match = re.search(r"music is composed by (.+?)\.", blob, re.IGNORECASE)
    if match:
        return short_text(
            strip_after_labels(
                clean_display_text(match.group(1)),
                ["Director", "Lyricists", "Year", "Language", "Starring", "Track Name"],
            ),
            160,
        )

    return "Unknown composer"


def extract_year(album, blob):
    year = album.get("year")
    if isinstance(year, int) and year:
        return year

    match = re.search(r"Year:\s*(\d{4})", blob)
    if match:
        return int(match.group(1))

    return infer_year_from_sources(album.get("url"), album.get("title"), blob)


def extract_album_tracks(blob):
    match = re.search(r"window\.albumTracks\s*=\s*(\[.*?\]);", blob)
    if not match:
        return []

    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return []


def normalize_download_links(download_links, fallback_audio_url=None, base_origin=None):
    normalized = []
    seen = set()

    def push_link(label, url, bitrate):
        absolute = absolute_url(url, base_origin)
        if not absolute or absolute in seen:
            return
        seen.add(absolute)
        normalized.append(
            {
                "label": clean_text(label) or (f"{bitrate}kbps" if bitrate else "Download"),
                "url": absolute,
                "bitrate": bitrate,
            }
        )

    audio_128 = None
    audio_320 = None

    for item in download_links or []:
        url = absolute_url(item.get("url"), base_origin)
        bitrate = detect_bitrate(item.get("label"), url)
        push_link(item.get("label"), url, bitrate)
        if bitrate == 128 and not audio_128:
            audio_128 = url
        if bitrate == 320 and not audio_320:
            audio_320 = url

    fallback = absolute_url(fallback_audio_url, base_origin)
    if fallback:
        if "/p128_cdn/" in fallback and not audio_128:
            audio_128 = fallback
        if "/p320_cdn/" in fallback and not audio_320:
            audio_320 = fallback

    if audio_128 and not audio_320:
        audio_320 = infer_bitrate_url(audio_128, 320)
    if audio_320 and not audio_128:
        audio_128 = infer_bitrate_url(audio_320, 128)

    if audio_320:
        push_link("320kbps", audio_320, 320)
    if audio_128:
        push_link("128kbps", audio_128, 128)

    normalized.sort(key=lambda item: (0 if item.get("bitrate") == 320 else 1, item["label"]))
    return {
        "downloadLinks": normalized,
        "audio128Url": audio_128,
        "audio320Url": audio_320,
        "audioUrl": audio_320 or audio_128,
    }


def build_track_from_album_track(album, item, composer, year, index):
    album_origin = origin_from_url(album.get("url"))
    fallback_audio_url = absolute_url(item.get("dl_path"), album_origin)
    urls = normalize_download_links(item.get("downloadLinks"), fallback_audio_url, album_origin)
    image_name = clean_text(item.get("img_name"))

    return {
        "id": str(item.get("id") or f"{album.get('title', 'album')}-{index}"),
        "title": short_text(clean_display_text(item.get("name"), "Untitled"), 140),
        "artist": short_text(clean_display_text(item.get("artists"), "Unknown artist"), 180),
        "singers": short_text(clean_display_text(item.get("artists"), "Unknown artist"), 180),
        "composer": composer,
        "movie": short_text(clean_display_text(item.get("m_name") or album.get("title"), "Unknown movie"), 140),
        "year": year,
        "songPageUrl": absolute_url(item.get("songPageUrl"), album_origin) or album.get("url"),
        "imageUrl": absolute_url(f"/uploads/album/{image_name}.jpg", album_origin) if image_name else None,
        "spotify": {
            "album": None,
            "popularity": None,
            "previewAvailable": bool(urls["audioUrl"]),
        },
        **urls,
    }


def should_include_fallback_track(track):
    title = clean_text(track.get("title"))
    if not title:
        return False
    lowered = title.lower()
    if "zip" in lowered or "rar" in lowered or "kbps" in lowered:
        return False
    return True


def build_track_from_fallback_track(album, track, composer, year, index):
    fallback_audio_url = track.get("audioUrl") or track.get("previewUrl") or track.get("streamUrl")
    artist = strip_after_labels(track.get("artist") or track.get("singers"), ["Length", "Downloads"])
    album_origin = origin_from_url(album.get("url") or track.get("songPageUrl") or track.get("imageUrl"))
    urls = normalize_download_links(track.get("downloadLinks"), fallback_audio_url, album_origin)

    return {
        "id": str(track.get("id") or f"{album.get('title', 'album')}-{index}"),
        "title": short_text(clean_display_text(track.get("title"), "Untitled"), 140),
        "artist": short_text(clean_display_text(artist, "Unknown artist"), 180),
        "singers": short_text(clean_display_text(artist, "Unknown artist"), 180),
        "composer": composer,
        "movie": short_text(clean_display_text(track.get("movie") or album.get("title"), "Unknown movie"), 140),
        "year": year,
        "songPageUrl": absolute_url(track.get("songPageUrl"), album_origin) or album.get("url") or urls["audioUrl"],
        "imageUrl": absolute_url(track.get("imageUrl"), album_origin) or album.get("imageUrl"),
        "spotify": track.get("spotify")
        or {
            "album": None,
            "popularity": None,
            "previewAvailable": bool(urls["audioUrl"]),
        },
        **urls,
    }


def normalize_zip_links(zip_links, base_origin=None):
    normalized = []
    seen = set()
    for item in zip_links or []:
        url = absolute_url(item.get("url"), base_origin)
        if not url or url in seen:
            continue
        seen.add(url)
        normalized.append(
            {
                "label": clean_text(item.get("label")) or "ZIP download",
                "url": url,
                "bitrate": detect_bitrate(item.get("label"), url),
            }
        )
    normalized.sort(key=lambda item: (0 if item.get("bitrate") == 320 else 1, item["label"]))
    return normalized


def normalize_album(album):
    blob = extract_album_blob(album)
    composer = short_text(extract_music_director(album, blob), 160)
    year = extract_year(album, blob)
    director = clean_text(album.get("director"))
    starring = clean_text(album.get("starring"))
    lyricists = clean_text(album.get("lyricists"))

    if not director or "window.albumTracks" in director or len(director) > 180:
        director = extract_labeled_value(blob, "Director", ["Lyricists", "Year", "Language", "Track Name"])
    if not starring or "window.albumTracks" in starring or len(starring) > 180:
        starring = extract_labeled_value(blob, "Starring", ["Music", "Director", "Lyricists", "Year", "Language"])
    if not lyricists or "window.albumTracks" in lyricists or len(lyricists) > 180:
        lyricists = extract_labeled_value(blob, "Lyricists", ["Year", "Language", "Track Name"])

    album_tracks = album.get("albumTracks")
    if not isinstance(album_tracks, list) or not album_tracks:
        album_tracks = extract_album_tracks(blob)

    tracks = []
    if album_tracks:
        for idx, item in enumerate(album_tracks, start=1):
            tracks.append(build_track_from_album_track(album, item, composer, year, idx))
    else:
        for idx, track in enumerate(album.get("tracks", []), start=1):
            if should_include_fallback_track(track):
                tracks.append(build_track_from_fallback_track(album, track, composer, year, idx))

    return {
        "title": short_text(album.get("title") or "Untitled album", 180),
        "url": absolute_url(album.get("url")),
        "pageNumber": as_int(album.get("pageNumber")),
        "year": year,
        "musicDirector": composer,
        "director": short_text(director or "Unknown director", 180),
        "starring": short_text(starring or "", 220),
        "lyricists": short_text(lyricists or "", 220),
        "zipLinks": normalize_zip_links(album.get("zipLinks"), album.get("url")),
        "tracks": tracks,
    }


def summarize_catalog(albums):
    return {
        "albumCount": len(albums),
        "trackCount": sum(len(album.get("tracks", [])) for album in albums),
    }


def build_song_from_track(album, track):
    song_id = str(track.get("id"))
    local_320_url = media_url(song_id, 320)
    local_128_url = media_url(song_id, 128)
    remote_320_url = track.get("audio320Url")
    remote_128_url = track.get("audio128Url")
    audio_url = remote_320_url or remote_128_url or local_320_url or local_128_url
    source_url = track.get("songPageUrl") or album.get("url") or remote_320_url or remote_128_url
    artist = track.get("artist") or track.get("singers") or "Unknown artist"
    return {
        "id": song_id,
        "title": short_text(clean_display_text(track.get("title"), "Untitled"), 140),
        "artist": short_text(clean_display_text(artist, "Unknown artist"), 180),
        "composer": short_text(clean_display_text(track.get("composer") or album.get("musicDirector"), "Unknown composer"), 160),
        "movie": short_text(clean_display_text(track.get("movie") or album.get("title"), "Unknown movie"), 140),
        "year": as_int(track.get("year") or album.get("year")),
        "mood": "Imported",
        "audioUrl": audio_url,
        "audio128Url": remote_128_url,
        "audio320Url": remote_320_url,
        "remoteAudio128Url": remote_128_url,
        "remoteAudio320Url": remote_320_url,
        "localAudio128Url": local_128_url,
        "localAudio320Url": local_320_url,
        "sourceUrl": source_url,
        "imageUrl": track.get("imageUrl"),
        "downloadLinks": track.get("downloadLinks", []),
        "spotify": track.get("spotify")
        or {
            "album": None,
            "popularity": None,
            "previewAvailable": bool(remote_320_url or remote_128_url or local_320_url or local_128_url),
        },
    }


def song_identity_key(value):
    return re.sub(r"[^a-z0-9]+", " ", clean_text(value).lower()).strip()


def build_existing_album_song_maps(connection, album_url):
    rows = connection.execute(
        """
        SELECT id, title, song_page_url, source_url
        FROM songs
        WHERE album_url = ?
        """,
        (album_url,),
    ).fetchall()
    existing_by_page_url = {}
    existing_by_title_key = {}
    for row in rows:
        for candidate in (clean_text(row["song_page_url"]), clean_text(row["source_url"])):
            if not candidate or candidate == album_url:
                continue
            if candidate and candidate not in existing_by_page_url:
                existing_by_page_url[candidate] = row
        title_key = song_identity_key(row["title"])
        if not title_key:
            continue
        existing_by_title_key.setdefault(title_key, []).append(row)
    return rows, existing_by_page_url, existing_by_title_key


def resolve_existing_album_song(album_url, existing_by_page_url, existing_by_title_key, song_payload):
    for candidate in (clean_text(song_payload.get("sourceUrl")), clean_text(song_payload.get("songPageUrl"))):
        if not candidate or candidate == album_url:
            continue
        if candidate and candidate in existing_by_page_url:
            return existing_by_page_url[candidate]
    title_key = song_identity_key(song_payload.get("title"))
    if not title_key:
        return None
    matches = existing_by_title_key.get(title_key) or []
    if len(matches) == 1:
        return matches[0]
    return None


def build_index_payload(raw_catalog=None):
    raw_catalog = raw_catalog or load_raw_catalog()
    songs = []

    for album in raw_catalog.get("albums", []):
        normalized_album = normalize_album(album)
        for track in normalized_album.get("tracks", []):
            songs.append(build_song_from_track(normalized_album, track))

    decades = sorted({f"{(song['year'] // 10) * 10}s" for song in songs if song.get("year")})
    moods = sorted({clean_text(song.get("mood")) or "Imported" for song in songs})

    return {
        "source": raw_catalog.get("source", SITE_ORIGIN),
        "updatedAt": utc_now(),
        "summary": summarize_catalog(raw_catalog.get("albums", [])),
        "filters": {
            "decades": decades,
            "moods": moods,
        },
        "songs": songs,
    }


def sync_db_from_catalog(raw_catalog):
    ensure_db()
    normalized_catalog = normalize_catalog(raw_catalog)
    songs_payload = []
    song_album_map = {}
    for album in normalized_catalog.get("albums", []):
        for track in album.get("tracks", []):
            songs_payload.append(build_song_from_track(album, track))
            song_album_map[str(track.get("id"))] = album.get("url")

    updated_at = utc_now()
    with get_db_connection() as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        ensure_playlist_tables(connection)
        playlist_item_backup = connection.execute(
            """
            SELECT playlist_id, song_id, position, created_at
            FROM playlist_items
            ORDER BY playlist_id, position, song_id
            """
        ).fetchall()
        connection.execute("DELETE FROM download_links")
        connection.execute("DELETE FROM songs")
        connection.execute("DELETE FROM albums")

        connection.executemany(
            """
            INSERT INTO albums (
              url, title, page_number, year, music_director, director, starring,
              lyricists, zip_links_json, track_count, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    album.get("url"),
                    album.get("title") or "Untitled album",
                    as_int(album.get("pageNumber")),
                    as_int(album.get("year")),
                    clean_text(album.get("musicDirector")),
                    clean_text(album.get("director")),
                    clean_text(album.get("starring")),
                    clean_text(album.get("lyricists")),
                    json.dumps(album.get("zipLinks", []), ensure_ascii=False),
                    len(album.get("tracks", [])),
                    updated_at,
                )
                for album in normalized_catalog.get("albums", [])
                if album.get("url")
            ],
        )

        connection.executemany(
            """
            INSERT INTO songs (
              id, album_url, title, artist, singers, composer, movie, year, mood,
              song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
              remote_audio_128_url, remote_audio_320_url, local_audio_128_url, local_audio_320_url,
              download_links_json, spotify_json, last_refreshed_at, link_status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    song.get("id"),
                    song_album_map.get(str(song.get("id"))),
                    song.get("title") or "Untitled",
                    clean_text(song.get("artist")),
                    clean_text(song.get("artist")),
                    clean_text(song.get("composer")),
                    clean_text(song.get("movie")),
                    as_int(song.get("year")),
                    clean_text(song.get("mood")) or "Imported",
                    clean_text(song.get("sourceUrl")),
                    clean_text(song.get("sourceUrl")),
                    clean_text(song.get("imageUrl")),
                    clean_text(song.get("audioUrl")),
                    clean_text(song.get("audio128Url")),
                    clean_text(song.get("audio320Url")),
                    clean_text(song.get("remoteAudio128Url")),
                    clean_text(song.get("remoteAudio320Url")),
                    clean_text(song.get("localAudio128Url")),
                    clean_text(song.get("localAudio320Url")),
                    json.dumps(song.get("downloadLinks", []), ensure_ascii=False),
                    json.dumps(song.get("spotify", {}), ensure_ascii=False),
                    updated_at,
                    "fresh" if song.get("audioUrl") else "missing",
                    updated_at,
                )
                for song in songs_payload
            ],
        )

        link_rows = []
        for song in songs_payload:
            for link in song.get("downloadLinks", []) or []:
                if not clean_text(link.get("url")):
                    continue
                link_rows.append(
                    (
                        song.get("id"),
                        clean_text(link.get("url")),
                        clean_text(link.get("label")),
                        as_int(link.get("bitrate")),
                    )
                )
        if link_rows:
            connection.executemany(
                "INSERT INTO download_links (song_id, url, label, bitrate) VALUES (?, ?, ?, ?)",
                link_rows,
            )

        if playlist_item_backup:
            valid_song_ids = {clean_text(song.get("id")) for song in songs_payload if clean_text(song.get("id"))}
            valid_playlist_ids = {
                int(row["id"])
                for row in connection.execute("SELECT id FROM playlists").fetchall()
            }
            restore_rows = [
                (
                    int(row["playlist_id"]),
                    clean_text(row["song_id"]),
                    as_int(row["position"], 0) or 1,
                    clean_text(row["created_at"]) or updated_at,
                )
                for row in playlist_item_backup
                if int(row["playlist_id"]) in valid_playlist_ids and clean_text(row["song_id"]) in valid_song_ids
            ]
            if restore_rows:
                connection.executemany(
                    """
                    INSERT OR IGNORE INTO playlist_items (playlist_id, song_id, position, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    restore_rows,
                )

        summary = normalized_catalog.get("summary", {"albumCount": 0, "trackCount": 0})
        meta = {
            "source": normalized_catalog.get("source", SITE_ORIGIN),
            "ingestedAt": normalized_catalog.get("ingestedAt") or updated_at,
            "updatedAt": normalized_catalog.get("updatedAt") or updated_at,
            "albumCount": str(summary.get("albumCount", 0)),
            "trackCount": str(summary.get("trackCount", 0)),
        }
        connection.executemany(
            "INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)",
            list(meta.items()),
        )


def upsert_album_into_db(album_payload):
    ensure_db()
    album = normalize_album(album_payload)
    album_url = clean_text(album.get("url"))
    if not album_url:
        return False

    songs_payload = [build_song_from_track(album, track) for track in album.get("tracks", [])]
    updated_at = utc_now()

    with get_db_connection() as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        existing_rows, existing_by_page_url, existing_by_title_key = build_existing_album_song_maps(connection, album_url)
        existing_song_ids = {clean_text(row["id"]) for row in existing_rows if clean_text(row["id"])}
        refreshed_song_ids = []
        adjusted_songs_payload = []
        for song in songs_payload:
            payload = dict(song)
            payload["songPageUrl"] = clean_text(payload.get("songPageUrl") or payload.get("sourceUrl"))
            payload["sourceUrl"] = clean_text(payload.get("sourceUrl") or payload.get("songPageUrl") or album_url)
            existing_match = resolve_existing_album_song(album_url, existing_by_page_url, existing_by_title_key, payload)
            if existing_match is not None:
                payload["id"] = clean_text(existing_match["id"]) or payload.get("id")
            adjusted_songs_payload.append(payload)
            if clean_text(payload.get("id")):
                refreshed_song_ids.append(clean_text(payload.get("id")))

        stale_song_ids = sorted(existing_song_ids - set(refreshed_song_ids))
        connection.execute(
            "DELETE FROM download_links WHERE song_id IN (SELECT id FROM songs WHERE album_url = ?)",
            (album_url,),
        )
        connection.execute(
            """
            INSERT INTO albums (
              url, title, page_number, year, music_director, director, starring,
              lyricists, zip_links_json, track_count, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            """,
            (
                album_url,
                album.get("title") or "Untitled album",
                as_int(album.get("pageNumber")),
                as_int(album.get("year")),
                clean_text(album.get("musicDirector")),
                clean_text(album.get("director")),
                clean_text(album.get("starring")),
                clean_text(album.get("lyricists")),
                json.dumps(album.get("zipLinks", []), ensure_ascii=False),
                len(album.get("tracks", [])),
                updated_at,
            ),
        )
        if adjusted_songs_payload:
            connection.executemany(
                """
                INSERT INTO songs (
                  id, album_url, title, artist, singers, composer, movie, year, mood,
                  song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
                  remote_audio_128_url, remote_audio_320_url, local_audio_128_url, local_audio_320_url,
                  download_links_json, spotify_json, last_refreshed_at, link_status, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                """,
                [
                    (
                        song.get("id"),
                        album_url,
                        song.get("title") or "Untitled",
                        clean_text(song.get("artist")),
                        clean_text(song.get("artist")),
                        clean_text(song.get("composer")),
                        clean_text(song.get("movie")),
                        as_int(song.get("year")),
                        clean_text(song.get("mood")) or "Imported",
                        clean_text(song.get("sourceUrl")),
                        clean_text(song.get("sourceUrl")),
                        clean_text(song.get("imageUrl")),
                        clean_text(song.get("audioUrl")),
                        clean_text(song.get("audio128Url")),
                        clean_text(song.get("audio320Url")),
                        clean_text(song.get("remoteAudio128Url")),
                        clean_text(song.get("remoteAudio320Url")),
                        clean_text(song.get("localAudio128Url")),
                        clean_text(song.get("localAudio320Url")),
                        json.dumps(song.get("downloadLinks", []), ensure_ascii=False),
                        json.dumps(song.get("spotify", {}), ensure_ascii=False),
                        updated_at,
                        "fresh" if song.get("audioUrl") else "missing",
                        updated_at,
                    )
                    for song in adjusted_songs_payload
                ],
            )

            link_rows = []
            for song in adjusted_songs_payload:
                for link in song.get("downloadLinks", []) or []:
                    if not clean_text(link.get("url")):
                        continue
                    link_rows.append(
                        (
                            song.get("id"),
                            clean_text(link.get("url")),
                            clean_text(link.get("label")),
                            as_int(link.get("bitrate")),
                        )
                    )
            if link_rows:
                connection.executemany(
                    "INSERT INTO download_links (song_id, url, label, bitrate) VALUES (?, ?, ?, ?)",
                    link_rows,
                )
        if stale_song_ids:
            placeholders = ", ".join("?" for _ in stale_song_ids)
            connection.execute(
                f"DELETE FROM songs WHERE album_url = ? AND id IN ({placeholders})",
                (album_url, *stale_song_ids),
            )

        meta_rows = dict(connection.execute("SELECT key, value FROM app_meta").fetchall())
        album_count = connection.execute("SELECT COUNT(*) FROM albums").fetchone()[0]
        track_count = connection.execute("SELECT COUNT(*) FROM songs").fetchone()[0]
        stored_source = clean_text(meta_rows.get("source"))
        if album_count <= 1 or not stored_source or stored_source == SITE_ORIGIN:
            stored_source = origin_from_url(album_url)
        connection.executemany(
            "INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)",
            [
                ("source", stored_source or SITE_ORIGIN),
                ("ingestedAt", meta_rows.get("ingestedAt") or updated_at),
                ("updatedAt", updated_at),
                ("albumCount", str(album_count)),
                ("trackCount", str(track_count)),
            ],
        )

    SONG_RECORD_CACHE.clear()
    return True


def library_song_sort_key(song):
    return (
        -(as_int(song.get("year")) or 0),
        clean_text(song.get("movie")).lower(),
        clean_text(song.get("title")).lower(),
        clean_text(song.get("id")).lower(),
    )


def build_index_payload_from_connection(connection, source_fallback=SITE_ORIGIN, id_prefix="", use_local_media=True):
    meta_rows = dict(connection.execute("SELECT key, value FROM app_meta").fetchall())
    album_count = connection.execute("SELECT COUNT(*) FROM albums").fetchone()[0]
    songs = []
    for row in connection.execute(
        """
        SELECT id, album_url, title, artist, composer, movie, year, mood, audio_url, audio_128_url, audio_320_url,
               remote_audio_128_url, remote_audio_320_url, local_audio_128_url, local_audio_320_url,
               source_url, image_url, download_links_json, spotify_json, last_refreshed_at, link_status
        FROM songs
        ORDER BY year DESC, movie COLLATE NOCASE, title COLLATE NOCASE
        """
    ):
        song = dict(row)
        if is_noise_song_payload(song["title"], song["movie"]):
            continue
        stream_song_id = f"{id_prefix}{song['id']}" if id_prefix else str(song["id"])
        payload = build_song_payload_from_row(
            row,
            stream_song_id=stream_song_id,
            use_local_media=use_local_media,
        )
        if payload:
            songs.append(payload)

    songs.sort(key=library_song_sort_key)
    decades = sorted({f"{(song['year'] // 10) * 10}s" for song in songs if song.get("year")})
    moods = sorted({clean_text(song.get("mood")) or "Imported" for song in songs})
    return {
        "source": meta_rows.get("source", source_fallback),
        "updatedAt": meta_rows.get("updatedAt") or utc_now(),
        "summary": {
            "albumCount": as_int(album_count),
            "trackCount": len(songs),
        },
        "filters": {"decades": decades, "moods": moods},
        "songs": songs,
    }


def build_index_payload_from_db():
    ensure_db()
    with get_db_connection() as connection:
        return build_index_payload_from_connection(connection, source_fallback=SITE_ORIGIN)


def build_telugu_index_payload_from_db():
    if not telugu_catalog_enabled():
        return {
            "source": TELUGU_SITE_ORIGIN,
            "updatedAt": None,
            "summary": {"albumCount": 0, "trackCount": 0},
            "filters": {"decades": [], "moods": []},
            "songs": [],
        }
    with get_sqlite_connection(TELUGU_DB_PATH) as connection:
        return build_index_payload_from_connection(
            connection,
            source_fallback=TELUGU_SITE_ORIGIN,
            id_prefix=TELUGU_ID_PREFIX,
            use_local_media=False,
        )


def merge_index_payloads(local_payload, telugu_payload=None):
    telugu_payload = telugu_payload or {
        "summary": {"albumCount": 0, "trackCount": 0},
        "filters": {"decades": [], "moods": []},
        "songs": [],
        "updatedAt": None,
    }
    merged_songs = sorted(
        [*local_payload.get("songs", []), *telugu_payload.get("songs", [])],
        key=library_song_sort_key,
    )
    updated_at_candidates = [
        clean_text(local_payload.get("updatedAt")),
        clean_text(telugu_payload.get("updatedAt")),
    ]
    updated_at_candidates = [item for item in updated_at_candidates if item]
    return {
        "source": local_payload.get("source", SITE_ORIGIN),
        "updatedAt": max(updated_at_candidates) if updated_at_candidates else utc_now(),
        "summary": {
            "albumCount": as_int(local_payload.get("summary", {}).get("albumCount"))
            + as_int(telugu_payload.get("summary", {}).get("albumCount")),
            "trackCount": len(merged_songs),
        },
        "filters": {
            "decades": sorted(
                {
                    *local_payload.get("filters", {}).get("decades", []),
                    *telugu_payload.get("filters", {}).get("decades", []),
                }
            ),
            "moods": sorted(
                {
                    *local_payload.get("filters", {}).get("moods", []),
                    *telugu_payload.get("filters", {}).get("moods", []),
                }
            ),
        },
        "songs": merged_songs,
    }


def write_runtime_catalog_files_from_db():
    raw_payload = build_raw_catalog_from_db()
    write_json(RAW_CATALOG_PATH, raw_payload)
    index_payload = build_index_payload_from_db()
    write_json(INDEX_PATH, index_payload)
    write_json(
        STATUS_PATH,
        {
            "albumCount": index_payload.get("summary", {}).get("albumCount", 0),
            "trackCount": index_payload.get("summary", {}).get("trackCount", 0),
            "updatedAt": index_payload.get("updatedAt"),
            "isEmpty": not bool(index_payload.get("songs")),
        },
    )
    SONG_RECORD_CACHE.clear()
    return index_payload


def normalize_catalog(raw_catalog=None):
    payload = raw_catalog or load_raw_catalog()
    normalized_albums = [normalize_album(album) for album in payload.get("albums", [])]
    source = clean_text(payload.get("source")) or infer_catalog_source(normalized_albums, SITE_ORIGIN)
    return {
        "source": source,
        "ingestedAt": payload.get("ingestedAt") or utc_now(),
        "updatedAt": utc_now(),
        "albums": normalized_albums,
        "summary": summarize_catalog(normalized_albums),
    }


def save_catalog(raw_catalog):
    write_json(RAW_CATALOG_PATH, raw_catalog)
    sync_db_from_catalog(raw_catalog)
    write_json(INDEX_PATH, build_index_payload_from_db())
    SONG_RECORD_CACHE.clear()


def upsert_catalog_albums(albums, source=None):
    raw_catalog = normalize_catalog()
    by_url = {album.get("url"): album for album in raw_catalog.get("albums", []) if album.get("url")}

    for incoming in albums:
        normalized = normalize_album(incoming)
        if not normalized.get("url"):
            continue
        by_url[normalized["url"]] = normalized

    merged_albums = sorted(
        by_url.values(),
        key=lambda album: (album.get("pageNumber") or 10**9, clean_text(album.get("title"))),
    )
    payload = {
        "source": clean_text(source) or raw_catalog.get("source") or infer_catalog_source(merged_albums, SITE_ORIGIN),
        "ingestedAt": raw_catalog.get("ingestedAt") or utc_now(),
        "updatedAt": utc_now(),
        "albums": merged_albums,
        "summary": summarize_catalog(merged_albums),
    }
    save_catalog(payload)
    return payload


def reset_catalog():
    payload = default_raw_catalog()
    payload["ingestedAt"] = utc_now()
    payload["updatedAt"] = payload["ingestedAt"]
    save_catalog(payload)
    return payload


def load_processed_urls():
    ensure_db()
    with get_db_connection() as connection:
        rows = connection.execute("SELECT url FROM albums WHERE url IS NOT NULL ORDER BY page_number, title").fetchall()
    return [row["url"] for row in rows]


def load_bad_song_page_albums():
    ensure_db()
    with get_db_connection() as connection:
        rows = connection.execute(
            """
            SELECT album_url, COUNT(*) AS bad_track_count
            FROM songs
            WHERE album_url IS NOT NULL
              AND song_page_url = album_url
            GROUP BY album_url
            ORDER BY bad_track_count DESC, album_url COLLATE NOCASE
            """
        ).fetchall()
    albums = [{"url": row["album_url"], "badTrackCount": as_int(row["bad_track_count"])} for row in rows]
    return {
        "albums": albums,
        "albumCount": len(albums),
        "trackCount": sum(item["badTrackCount"] for item in albums),
        "updatedAt": utc_now(),
    }


def ensure_index():
    ensure_data_dir()
    ensure_db()
    with get_db_connection() as connection:
        db_has_catalog = bool(
            connection.execute("SELECT 1 FROM albums LIMIT 1").fetchone()
            or connection.execute("SELECT 1 FROM songs LIMIT 1").fetchone()
        )

    if db_has_catalog:
        local_payload = write_runtime_catalog_files_from_db()
    else:
        try:
            normalized_catalog = normalize_catalog()
            write_json(RAW_CATALOG_PATH, normalized_catalog)
            if normalized_catalog.get("albums"):
                try:
                    sync_db_from_catalog(normalized_catalog)
                except sqlite3.IntegrityError:
                    write_json(RAW_CATALOG_PATH, build_raw_catalog_from_db())
            local_payload = build_index_payload_from_db()
        except json.JSONDecodeError:
            local_payload = write_runtime_catalog_files_from_db()

    payload = merge_index_payloads(local_payload, build_telugu_index_payload_from_db())

    global SONG_INDEX, APP_STATE
    indexed = []
    for position, song in enumerate(payload.get("songs", [])):
        year = int(song.get("year") or 0)
        indexed.append(
            {
                **song,
                "year": year,
                "_decade": f"{(year // 10) * 10}s" if year else "Unknown",
                "_search": " ".join(
                    clean_text(song.get(field, ""))
                    for field in ("title", "artist", "composer", "movie", "mood")
                ).lower(),
                "_title_search": clean_text(song.get("title", "")).lower(),
                "_movie_search": clean_text(song.get("movie", "")).lower(),
                "_artist_search": clean_text(song.get("artist", "")).lower(),
                "_composer_search": clean_text(song.get("composer", "")).lower(),
                "_has_local": bool(song.get("localAudio320Url") or song.get("localAudio128Url")),
                "_order": position,
            }
        )

    SONG_INDEX = indexed
    APP_STATE = {
        "summary": payload.get("summary", {"albumCount": 0, "trackCount": 0}),
        "filters": payload.get("filters", {"decades": [], "moods": []}),
        "updatedAt": payload.get("updatedAt"),
        "refreshWorkerActive": is_refresh_worker_active(),
        "refreshWorkerSeenAt": APP_STATE.get("refreshWorkerSeenAt"),
    }
    write_json(
        STATUS_PATH,
        {
            "albumCount": APP_STATE["summary"]["albumCount"],
            "trackCount": APP_STATE["summary"]["trackCount"],
            "updatedAt": APP_STATE["updatedAt"],
            "isEmpty": not bool(SONG_INDEX),
        },
    )


def query_songs(query="", decade="all", mood="all", offset=0, limit=120, local_songs=False, movie=""):
    query = clean_text(query).lower()
    movie = clean_text(movie).lower()

    def include(song):
        if query and query not in song["_search"]:
            return False
        if movie and song["_movie_search"] != movie:
            return False
        if decade != "all" and song["_decade"] != decade:
            return False
        if mood != "all" and (clean_text(song.get("mood")) or "Imported") != mood:
            return False
        return True

    filtered = [song for song in SONG_INDEX if include(song)]
    if query or local_songs:
        def rank(song):
            if not query:
                match_rank = 10
            elif song["_title_search"] == query:
                match_rank = 0
            elif song["_title_search"].startswith(query):
                match_rank = 1
            elif song["_movie_search"] == query:
                match_rank = 2
            elif song["_movie_search"].startswith(query):
                match_rank = 3
            elif song["_artist_search"] == query or song["_artist_search"].startswith(query):
                match_rank = 4
            elif song["_composer_search"] == query or song["_composer_search"].startswith(query):
                match_rank = 5
            elif query in song["_title_search"]:
                match_rank = 6
            elif query in song["_movie_search"]:
                match_rank = 7
            elif query in song["_artist_search"]:
                match_rank = 8
            elif query in song["_composer_search"]:
                match_rank = 9
            else:
                match_rank = 10
            local_rank = 0 if (local_songs and song["_has_local"]) else 1
            return (match_rank, local_rank, -song["year"], song["_title_search"], song["_order"])

        filtered.sort(key=rank)
    page = filtered[offset : offset + limit]
    songs = [{key: value for key, value in song.items() if not key.startswith("_")} for song in page]
    return {
        "songs": songs,
        "total": len(filtered),
        "offset": offset,
        "limit": limit,
        "hasMore": offset + limit < len(filtered),
    }


def enqueue_refresh_request(song):
    song_id = str(song.get("id") or "")
    source_url = clean_text(song.get("sourceUrl"))
    if not song_id or not source_url:
        return None

    existing = REFRESH_RESULTS.get(song_id)
    if existing and existing.get("status") == "pending":
        return existing

    payload = {
        "id": song_id,
        "sourceUrl": source_url,
        "movie": clean_text(song.get("movie")),
        "title": clean_text(song.get("title")),
        "queuedAt": utc_now(),
        "status": "pending",
    }
    REFRESH_RESULTS[song_id] = payload
    if song_id not in REFRESH_SEEN:
        REFRESH_QUEUE.append(payload)
        REFRESH_SEEN.add(song_id)
    return payload


def claim_refresh_request():
    while REFRESH_QUEUE:
        item = REFRESH_QUEUE.pop(0)
        song_id = item.get("id")
        if song_id:
            REFRESH_SEEN.discard(song_id)
            current = REFRESH_RESULTS.get(song_id, {})
            current.update(item)
            current["status"] = "processing"
            current["claimedAt"] = utc_now()
            REFRESH_RESULTS[song_id] = current
            return current
    return None


def mark_refresh_result(song_id, ok, message=""):
    key = str(song_id or "")
    current = REFRESH_RESULTS.get(key, {"id": key})
    current["status"] = "done" if ok else "failed"
    current["finishedAt"] = utc_now()
    if message:
        current["message"] = clean_text(message)
    REFRESH_RESULTS[key] = current
    return current


def build_song_payload_from_row(row, stream_song_id=None, use_local_media=True):
    if row is None:
        return None

    song = dict(row)
    raw_song_id = clean_text(song["id"])
    stream_id = clean_text(stream_song_id) or raw_song_id
    local_128_url = media_url(raw_song_id, 128) if use_local_media else None
    local_320_url = media_url(raw_song_id, 320) if use_local_media else None
    download_links = json.loads(song.get("download_links_json") or "[]")
    spotify = json.loads(song.get("spotify_json") or "{}")
    return {
        "id": stream_id,
        "albumUrl": song["album_url"],
        "title": clean_display_text(song["title"], "Untitled"),
        "artist": clean_display_text(song["artist"], "Unknown artist"),
        "composer": clean_display_text(song["composer"], "Unknown composer"),
        "movie": clean_display_text(song["movie"], "Unknown movie"),
        "year": as_int(song["year"]) or infer_year_from_sources(song["album_url"], song["movie"], song["title"]),
        "mood": song["mood"] or "Imported",
        "audioUrl": public_stream_url(stream_id),
        "audio128Url": song["audio_128_url"],
        "audio320Url": song["audio_320_url"],
        "remoteAudio128Url": song["remote_audio_128_url"],
        "remoteAudio320Url": song["remote_audio_320_url"],
        "localAudio128Url": local_128_url,
        "localAudio320Url": local_320_url,
        "sourceUrl": song["source_url"],
        "imageUrl": song["image_url"],
        "downloadLinks": download_links,
        "spotify": spotify,
        "lastRefreshedAt": song["last_refreshed_at"],
        "linkStatus": song["link_status"],
    }


def load_song_db_row(song_id, db_path=None):
    storage = get_song_storage(song_id)
    target_path = db_path or storage["db_path"]
    target_song_id = clean_text(song_id if db_path else storage["song_id"])
    if not target_song_id:
        return None
    if target_path == DB_PATH:
        ensure_db()
    elif not Path(target_path).exists():
        return None
    with get_sqlite_connection(target_path) as connection:
        return connection.execute(
            """
            SELECT id, album_url, title, artist, singers, composer, movie, year, mood,
                   song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
                   remote_audio_128_url, remote_audio_320_url, local_audio_128_url, local_audio_320_url,
                   download_links_json, spotify_json, last_refreshed_at, link_status
            FROM songs
            WHERE id = ?
            """,
            (target_song_id,),
        ).fetchone()


def load_song_record(song_id):
    key = str(song_id)
    cached = SONG_RECORD_CACHE.get(key)
    if cached is not None:
        return cached
    storage = get_song_storage(song_id)
    if storage["db_path"] == TELUGU_DB_PATH and not telugu_catalog_enabled():
        payload = None
    else:
        payload = build_song_payload_from_row(
            load_song_db_row(song_id),
            stream_song_id=key,
            use_local_media=storage["use_local_media"],
        )
    SONG_RECORD_CACHE[key] = payload
    return payload


def load_song_records(song_ids):
    ordered_ids = [str(song_id) for song_id in song_ids if clean_text(song_id)]
    if not ordered_ids:
        return []
    records = []
    for song_id in ordered_ids:
        payload = load_song_record(song_id)
        if payload:
            records.append(payload)
    return records


def load_playlist_records(include_song_ids=False):
    ensure_db()
    with get_db_connection() as connection:
        return list_playlists(connection, include_song_ids=include_song_ids)


def load_playlist_record_by_slug(playlist_slug):
    ensure_db()
    with get_db_connection() as connection:
        return load_playlist(connection, playlist_slug)


def update_song_link_status(song_id, link_status, refreshed_at=None):
    storage = get_song_storage(song_id)
    if storage["db_path"] == TELUGU_DB_PATH and not telugu_catalog_enabled():
        return
    timestamp = refreshed_at or utc_now()
    with get_sqlite_connection(storage["db_path"]) as connection:
        connection.execute(
            """
            UPDATE songs
            SET link_status = ?, last_refreshed_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (clean_text(link_status) or "unknown", timestamp, timestamp, storage["song_id"]),
        )
    SONG_RECORD_CACHE.pop(str(song_id), None)


def fetch_page_html(url):
    target_url = absolute_url(url)
    target_origin = origin_from_url(target_url)
    request = Request(
        target_url,
        headers={
            "User-Agent": UPSTREAM_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": target_url or target_origin,
            "Origin": target_origin,
            "Connection": "keep-alive",
        },
    )
    with urlopen(request, timeout=UPSTREAM_PAGE_TIMEOUT_SECONDS) as response:
        body = response.read()
    html = body.decode("utf-8", errors="ignore")
    return html


def fetch_remote_text(url):
    request = Request(
        url,
        headers={
            "User-Agent": UPSTREAM_USER_AGENT,
            "Accept": "application/json,text/plain,*/*",
        },
    )
    with urlopen(request, timeout=UPSTREAM_PAGE_TIMEOUT_SECONDS) as response:
        return response.read().decode("utf-8", errors="ignore")


def try_refresh_song_link(song_id):
    if is_telugu_song_id(song_id):
        return None
    row = load_song_db_row(song_id)
    if row is None:
        return None

    song = dict(row)
    candidate_pages = []
    seen_pages = set()

    def push_candidate(url):
        absolute = absolute_url(url)
        if not absolute or absolute in seen_pages:
            return
        seen_pages.add(absolute)
        candidate_pages.append(absolute)

    push_candidate(song.get("album_url"))
    push_candidate(song.get("song_page_url"))
    push_candidate(song.get("source_url"))

    checked_pages = set()
    while candidate_pages:
        page_url = candidate_pages.pop(0)
        if page_url in checked_pages:
            continue
        checked_pages.add(page_url)

        try:
            html = fetch_page_html(page_url)
        except Exception:
            continue

        if not html:
            continue

        if "window.albumTracks" not in html:
            for discovered in extract_album_links_from_html(html):
                push_candidate(discovered)
            continue

        album_payload = {
            "title": parse_album_title_from_html(html) or clean_text(song.get("movie")) or clean_text(song.get("title")) or "Untitled album",
            "url": page_url,
            "blob": html,
            "pageNumber": 0,
            "tracks": [],
        }

        try:
            if not upsert_album_into_db(album_payload):
                continue
        except Exception:
            continue

        refreshed = load_song_record(song_id)
        if refreshed and (refreshed.get("audio320Url") or refreshed.get("audio128Url")):
            update_song_link_status(song_id, "fresh")
            return refreshed

    return None


def refresh_album_metadata(album_url):
    target_url = absolute_url(album_url)
    if not target_url:
        return False

    try:
        html = fetch_page_html(target_url)
    except Exception as error:
        with ALBUM_REFRESH_LOCK:
            ALBUM_REFRESH_STATUS[target_url] = {
                "status": "failed",
                "updatedAt": utc_now(),
                "message": clean_text(error),
            }
        return False

    if not html or "window.albumTracks" not in html:
        with ALBUM_REFRESH_LOCK:
            ALBUM_REFRESH_STATUS[target_url] = {
                "status": "failed",
                "updatedAt": utc_now(),
                "message": "Album page did not expose playable track metadata.",
            }
        return False

    album_payload = {
        "title": parse_album_title_from_html(html) or "Untitled album",
        "url": target_url,
        "blob": html,
        "pageNumber": 0,
        "tracks": [],
    }

    try:
        if not upsert_album_into_db(album_payload):
            raise ValueError("Album refresh did not produce a valid album payload.")
        with ALBUM_REFRESH_LOCK:
            ALBUM_REFRESH_STATUS[target_url] = {
                "status": "healthy",
                "updatedAt": utc_now(),
            }
        return True
    except Exception as error:
        with ALBUM_REFRESH_LOCK:
            ALBUM_REFRESH_STATUS[target_url] = {
                "status": "failed",
                "updatedAt": utc_now(),
                "message": clean_text(error),
            }
        return False


def queue_album_refresh(album_urls, song_prefetch_limit=0):
    urls = []
    with ALBUM_REFRESH_LOCK:
        for album_url in album_urls:
            target_url = absolute_url(album_url)
            if not target_url or target_url in ALBUM_REFRESH_IN_FLIGHT:
                continue
            state = ALBUM_REFRESH_STATUS.get(target_url)
            if state and state.get("status") == "healthy":
                seen_at = parse_iso_datetime(state.get("updatedAt"))
                if seen_at and (datetime.now(timezone.utc) - seen_at).total_seconds() < 12 * 3600:
                    continue
            ALBUM_REFRESH_IN_FLIGHT.add(target_url)
            ALBUM_REFRESH_STATUS[target_url] = {
                "status": "refreshing",
                "updatedAt": utc_now(),
            }
            urls.append(target_url)

    def runner(url):
        try:
            ok = refresh_album_metadata(url)
            if ok and song_prefetch_limit > 0:
                prefetch_song_ids(album_song_ids_for_album_url(url, song_prefetch_limit))
        finally:
            with ALBUM_REFRESH_LOCK:
                ALBUM_REFRESH_IN_FLIGHT.discard(url)

    for url in urls:
        threading.Thread(target=runner, args=(url,), daemon=True).start()
    return len(urls)


def cache_song_audio(song_id):
    key = str(song_id)
    ensure_cache_dir()
    target = cached_audio_path(key)
    if target.exists() and is_valid_audio_file(target):
        return target

    song = load_song_record(key)
    if not song:
        return None

    attempted_urls = []
    for phase in ("initial", "refresh"):
        if phase == "refresh":
            song = try_refresh_song_link(key)
            if not song:
                continue

        for candidate in (song.get("audio128Url"), song.get("audio320Url")):
            candidate_url = absolute_url(candidate)
            if not candidate_url or candidate_url in attempted_urls:
                continue
            attempted_urls.append(candidate_url)
            try:
                response, head = open_upstream_audio_range(
                    candidate_url,
                    None,
                    song.get("albumUrl") or song.get("sourceUrl"),
                )
            except (HTTPError, URLError, TimeoutError, ValueError):
                continue

            temp_path = target.with_suffix(".part")
            try:
                with temp_path.open("wb") as handle:
                    if head:
                        handle.write(head)
                    while True:
                        chunk = response.read(64 * 1024)
                        if not chunk:
                            break
                        handle.write(chunk)
                if is_valid_audio_file(temp_path):
                    os.replace(temp_path, target)
                    update_song_link_status(key, "fresh")
                    return target
            except OSError:
                pass
            finally:
                response.close()
                temp_path.unlink(missing_ok=True)

    update_song_link_status(key, "unavailable")
    return None


def prefetch_song_ids(song_ids):
    def runner(ids):
        try:
            for song_id in ids:
                cache_song_audio(song_id)
        finally:
            for song_id in ids:
                PREFETCH_IN_FLIGHT.discard(str(song_id))

    ids = []
    for song_id in song_ids:
        key = str(song_id)
        if not key or key in PREFETCH_IN_FLIGHT:
            continue
        if cached_audio_path(key).exists() and is_valid_audio_file(cached_audio_path(key)):
            continue
        PREFETCH_IN_FLIGHT.add(key)
        ids.append(key)
    if not ids:
        return 0
    threading.Thread(target=runner, args=(ids,), daemon=True).start()
    return len(ids)


def warmup_song_ids(limit=24):
    ensure_db()
    with get_db_connection() as connection:
        rows = connection.execute(
            """
            SELECT id
            FROM songs
            WHERE (audio_128_url IS NOT NULL AND audio_128_url != '')
               OR (audio_320_url IS NOT NULL AND audio_320_url != '')
            ORDER BY last_refreshed_at DESC, year DESC, movie COLLATE NOCASE, title COLLATE NOCASE
            LIMIT ?
            """,
            (max(1, as_int(limit, 24)),),
        ).fetchall()
    return [str(row["id"]) for row in rows]


def album_song_ids_for_song(song_id, limit=16):
    row = load_song_db_row(song_id)
    if row is None:
        return []
    album_url = clean_text(row["album_url"])
    if not album_url:
        return []
    ensure_db()
    with get_db_connection() as connection:
        rows = connection.execute(
            """
            SELECT id
            FROM songs
            WHERE album_url = ?
            ORDER BY year DESC, title COLLATE NOCASE, id
            LIMIT ?
            """,
            (album_url, max(1, as_int(limit, 16))),
        ).fetchall()
    return [str(item["id"]) for item in rows]


def album_song_ids_for_album_url(album_url, limit=16):
    if not clean_text(album_url):
        return []
    ensure_db()
    with get_db_connection() as connection:
        rows = connection.execute(
            """
            SELECT id
            FROM songs
            WHERE album_url = ?
            ORDER BY year DESC, title COLLATE NOCASE, id
            LIMIT ?
            """,
            (clean_text(album_url), max(1, as_int(limit, 16))),
        ).fetchall()
    return [str(item["id"]) for item in rows]


def recent_album_urls(limit=12):
    song_ids = warmup_song_ids(limit * 3)
    rows = []
    ensure_db()
    with get_db_connection() as connection:
        for song_id in song_ids:
            row = connection.execute("SELECT album_url FROM songs WHERE id = ?", (song_id,)).fetchone()
            if row and clean_text(row["album_url"]):
                rows.append(clean_text(row["album_url"]))
    seen = set()
    ordered = []
    for url in rows:
        if url in seen:
            continue
        seen.add(url)
        ordered.append(url)
        if len(ordered) >= max(1, as_int(limit, 12)):
            break
    return ordered


def open_upstream_audio(url):
    return open_upstream_audio_range(url)


def open_upstream_audio_range(url, range_header=None, referer_url=None):
    target_url = absolute_url(url, referer_url)
    referer = absolute_url(referer_url, target_url) or origin_from_url(target_url)
    origin = origin_from_url(referer or target_url)
    request = Request(
        target_url,
        headers={
            "User-Agent": UPSTREAM_USER_AGENT,
            "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
            "Referer": referer,
            "Origin": origin,
            "Connection": "keep-alive",
            **({"Range": range_header} if range_header else {}),
        },
    )
    response = urlopen(request, timeout=UPSTREAM_AUDIO_TIMEOUT_SECONDS)
    head = response.read(512)
    if not is_valid_audio_bytes(head):
        response.close()
        raise ValueError("Upstream response is not valid audio.")
    return response, head


def request_refresh_and_wait(song, timeout_seconds=STREAM_REFRESH_WAIT_SECONDS):
    if not song:
        return None
    payload = enqueue_refresh_request(song)
    if not payload or not is_refresh_worker_active():
        return None

    deadline = time.time() + timeout_seconds
    song_id = str(song.get("id") or "")
    while time.time() < deadline:
        status = REFRESH_RESULTS.get(song_id)
        if status and status.get("status") == "done":
            ensure_index()
            return load_song_record(song_id)
        if status and status.get("status") == "failed":
            return None
        time.sleep(STREAM_REFRESH_POLL_SECONDS)
    return None


class CatalogHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_HEAD(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/stream/"):
            song_id = parsed.path.rsplit("/", 1)[-1]
            song = load_song_record(song_id)
            if song is None:
                self.send_error(HTTPStatus.NOT_FOUND, "Song not found")
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            return
        return super().do_HEAD()

    def parse_byte_range(self, total_size):
        header = clean_text(self.headers.get("Range"))
        if not header or not header.startswith("bytes="):
            return None
        spec = header.split("=", 1)[1].split(",", 1)[0].strip()
        if "-" not in spec:
            return None
        start_text, end_text = spec.split("-", 1)
        try:
            if start_text == "":
                suffix = int(end_text)
                if suffix <= 0:
                    return None
                start = max(0, total_size - suffix)
                end = total_size - 1
            else:
                start = int(start_text)
                end = int(end_text) if end_text else total_size - 1
        except ValueError:
            return None
        if start < 0 or start >= total_size:
            return "invalid"
        end = min(end, total_size - 1)
        if end < start:
            return "invalid"
        return start, end

    def read_json_body(self):
        content_length = as_int(self.headers.get("Content-Length"), 0)
        if content_length <= 0:
            return {}

        raw_body = self.rfile.read(content_length)
        if not raw_body:
            return {}

        return json.loads(raw_body.decode("utf-8"))

    def read_raw_body(self):
        content_length = as_int(self.headers.get("Content-Length"), 0)
        if content_length <= 0:
            return b""
        return self.rfile.read(content_length)

    def stream_local_file(self, path):
        file_size = path.stat().st_size
        byte_range = self.parse_byte_range(file_size)
        if byte_range == "invalid":
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{file_size}")
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            return

        start = 0
        end = file_size - 1
        status = HTTPStatus.OK
        if byte_range:
            start, end = byte_range
            status = HTTPStatus.PARTIAL_CONTENT

        self.send_response(status)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = end - start + 1
            while True:
                if remaining <= 0:
                    break
                chunk = handle.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                self.wfile.write(chunk)

    def stream_upstream_audio(self, response, head, song_id, source_kind, cache_target=None):
        status = HTTPStatus.PARTIAL_CONTENT if getattr(response, "status", 200) == HTTPStatus.PARTIAL_CONTENT else HTTPStatus.OK
        self.send_response(status)
        self.send_header("Content-Type", "audio/mpeg")
        length = response.headers.get("Content-Length")
        if length:
            try:
                remaining = max(0, int(length) - len(head))
                self.send_header("Content-Length", str(len(head) + remaining))
            except ValueError:
                pass
        content_range = response.headers.get("Content-Range")
        if content_range:
            self.send_header("Content-Range", content_range)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("X-Sruthi-Source", source_kind)
        self.end_headers()
        cache_handle = None
        temp_path = None
        try:
            if cache_target is not None and status == HTTPStatus.OK:
                temp_path = cache_target.with_suffix(".part")
                temp_path.parent.mkdir(parents=True, exist_ok=True)
                cache_handle = temp_path.open("wb")

            if head:
                self.wfile.write(head)
                if cache_handle:
                    cache_handle.write(head)
            while True:
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
                if cache_handle:
                    cache_handle.write(chunk)
            if cache_handle:
                cache_handle.close()
                cache_handle = None
                if is_valid_audio_file(temp_path):
                    os.replace(temp_path, cache_target)
                else:
                    temp_path.unlink(missing_ok=True)
        except BrokenPipeError:
            if cache_handle:
                cache_handle.close()
                cache_handle = None
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
        try:
            update_song_link_status(song_id, "fresh")
        except Exception:
            pass
        finally:
            if cache_handle:
                cache_handle.close()
            if temp_path is not None and temp_path.exists():
                temp_path.unlink(missing_ok=True)
            response.close()

    def handle_stream_request(self, song_id):
        song = load_song_record(song_id)
        if not song:
            self.respond_json({"error": "Song not found."}, HTTPStatus.NOT_FOUND)
            return

        cache_path = cached_audio_path(song_id)
        if is_valid_audio_file(cache_path):
            self.stream_local_file(cache_path)
            return

        local_320_path = media_file_path(song_id, 320)
        local_128_path = media_file_path(song_id, 128)
        if is_valid_audio_file(local_320_path):
            self.stream_local_file(local_320_path)
            return
        if is_valid_audio_file(local_128_path):
            self.stream_local_file(local_128_path)
            return

        attempted_urls = []
        range_header = clean_text(self.headers.get("Range")) or None
        for candidate in (song.get("audio128Url"), song.get("audio320Url")):
            candidate_url = absolute_url(candidate)
            if not candidate_url or candidate_url in attempted_urls:
                continue
            attempted_urls.append(candidate_url)
            try:
                response, head = open_upstream_audio_range(
                    candidate_url,
                    range_header,
                    song.get("albumUrl") or song.get("sourceUrl"),
                )
                should_cache = range_header is None or range_header.startswith("bytes=0-")
                self.stream_upstream_audio(
                    response,
                    head,
                    song_id,
                    "remote",
                    cache_target=cache_path if should_cache else None,
                )
                return
            except (HTTPError, URLError, TimeoutError, ValueError):
                continue

        refreshed = try_refresh_song_link(song_id)
        if refreshed:
            for candidate in (refreshed.get("audio128Url"), refreshed.get("audio320Url")):
                candidate_url = absolute_url(candidate)
                if not candidate_url or candidate_url in attempted_urls:
                    continue
                attempted_urls.append(candidate_url)
                try:
                    response, head = open_upstream_audio_range(
                        candidate_url,
                        range_header,
                        refreshed.get("albumUrl") or refreshed.get("sourceUrl"),
                    )
                    should_cache = range_header is None or range_header.startswith("bytes=0-")
                    self.stream_upstream_audio(
                        response,
                        head,
                        song_id,
                        "refreshed",
                        cache_target=cache_path if should_cache else None,
                    )
                    return
                except (HTTPError, URLError, TimeoutError, ValueError):
                    continue

        try:
            update_song_link_status(song_id, "unavailable")
        except Exception:
            pass
        self.respond_json({"error": "Upstream stream unavailable."}, HTTPStatus.BAD_GATEWAY)

    def handle_artwork_request(self, song_id):
        song = load_song_record(song_id)
        attempted = set()
        candidates = []
        if song:
            candidates.append(absolute_url(song.get("imageUrl")))
        fallback_candidate = fetch_itunes_artwork_candidate(song or {})
        if fallback_candidate:
            candidates.append(fallback_candidate)

        for image_url in candidates:
            image_url = absolute_url(image_url)
            if not image_url or image_url in attempted:
                continue
            attempted.add(image_url)
            referer = absolute_url(song.get("albumUrl") or song.get("sourceUrl") or image_url) if song else image_url
            request = Request(
                image_url,
                headers={
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    "Referer": referer,
                    "Origin": origin_from_url(referer),
                    "User-Agent": UPSTREAM_USER_AGENT,
                },
            )
            try:
                with urlopen(request, timeout=UPSTREAM_PAGE_TIMEOUT_SECONDS) as response:
                    payload = response.read()
                    content_type = clean_text(response.headers.get("Content-Type")) or "image/jpeg"
                    if song and image_url != absolute_url(song.get("imageUrl")):
                        persist_song_artwork(song_id, image_url)
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(len(payload)))
                    self.send_header("Cache-Control", "public, max-age=86400")
                    self.end_headers()
                    self.wfile.write(payload)
                    return
            except (HTTPError, URLError, TimeoutError, ValueError):
                continue
        self.serve_default_artwork()

    def serve_default_artwork(self):
        fallback_path = ROOT / "Sruthi_kutty.jpg"
        if not fallback_path.exists():
            self.respond_json({"error": "Artwork unavailable."}, HTTPStatus.NOT_FOUND)
            return
        payload = fallback_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/status":
            self.respond_json(read_json(STATUS_PATH, default_status()))
            return

        if parsed.path == "/api/app-state":
            self.respond_json(APP_STATE)
            return

        if parsed.path == "/api/processed":
            self.respond_json(
                {
                    "processedUrls": load_processed_urls(),
                    "updatedAt": APP_STATE.get("updatedAt"),
                }
            )
            return

        if parsed.path == "/api/audit/song-page-url-mismatches":
            self.respond_json(load_bad_song_page_albums())
            return

        if parsed.path == "/api/media/status":
            self.respond_json(build_local_media_status())
            return

        if parsed.path == "/api/cache/status":
            ensure_cache_dir()
            cached_count = sum(1 for path in CACHE_AUDIO_DIR.glob("*.mp3") if is_valid_audio_file(path))
            with ALBUM_REFRESH_LOCK:
                refreshing_albums = sum(1 for item in ALBUM_REFRESH_STATUS.values() if item.get("status") == "refreshing")
            self.respond_json({"cachedCount": cached_count, "inFlight": len(PREFETCH_IN_FLIGHT), "refreshingAlbums": refreshing_albums})
            return

        if parsed.path.startswith("/api/stream/"):
            song_id = parsed.path.rsplit("/", 1)[-1]
            self.handle_stream_request(song_id)
            return

        if parsed.path == "/api/artwork":
            params = parse_qs(parsed.query)
            song_id = params.get("id", [""])[0]
            self.handle_artwork_request(song_id)
            return

        if parsed.path == "/api/library":
            params = parse_qs(parsed.query)
            query = params.get("query", [""])[0]
            movie = params.get("movie", [""])[0]
            decade = params.get("decade", ["all"])[0]
            mood = params.get("mood", ["all"])[0]
            offset = int(params.get("offset", ["0"])[0])
            limit = int(params.get("limit", ["120"])[0])
            local_songs = params.get("localSongs", ["false"])[0].lower() == "true"
            self.respond_json(query_songs(query, decade, mood, offset, limit, local_songs, movie))
            return

        if parsed.path == "/api/song":
            params = parse_qs(parsed.query)
            song_id = params.get("id", [""])[0]
            song = load_song_record(song_id) or next((item for item in SONG_INDEX if item["id"] == song_id), None)
            if song is None:
                self.respond_json({"error": "Song not found."}, HTTPStatus.NOT_FOUND)
                return
            self.respond_json({key: value for key, value in song.items() if not key.startswith("_")})
            return

        if parsed.path == "/api/playlists":
            self.respond_json({"playlists": load_playlist_records(include_song_ids=False)})
            return

        if parsed.path == "/api/playlist":
            playlist_id = parse_qs(parsed.query).get("id", [""])[0]
            if not playlist_id:
                self.respond_json({"error": "Playlist id is required."}, HTTPStatus.BAD_REQUEST)
                return
            payload = load_playlist_record_by_slug(playlist_id)
            if payload is None:
                self.respond_json({"error": "Playlist unavailable."}, HTTPStatus.NOT_FOUND)
                return
            payload["songs"] = load_song_records(payload.get("songIds") or [])
            status = HTTPStatus.OK
            self.respond_json(payload, status)
            return

        if parsed.path == "/api/refresh/next":
            APP_STATE["refreshWorkerActive"] = is_refresh_worker_active()
            item = claim_refresh_request()
            self.respond_json({"request": item, "workerActive": APP_STATE["refreshWorkerActive"]})
            return

        if parsed.path == "/api/refresh/status":
            params = parse_qs(parsed.query)
            song_id = params.get("id", [""])[0]
            status = REFRESH_RESULTS.get(song_id)
            self.respond_json(
                {
                    "status": status,
                    "workerActive": is_refresh_worker_active(),
                    "queueLength": len(REFRESH_QUEUE),
                }
            )
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/catalog/batch":
            try:
                payload = self.read_json_body()
            except json.JSONDecodeError:
                self.respond_json({"error": "Invalid JSON body."}, HTTPStatus.BAD_REQUEST)
                return

            albums = payload.get("albums", [])
            if not isinstance(albums, list):
                self.respond_json({"error": "albums must be an array."}, HTTPStatus.BAD_REQUEST)
                return

            merged = upsert_catalog_albums(albums, source=payload.get("source"))
            ensure_index()
            self.respond_json(
                {
                    "savedAlbums": merged["summary"]["albumCount"],
                    "savedTracks": merged["summary"]["trackCount"],
                    "updatedAt": merged["updatedAt"],
                }
            )
            return

        if parsed.path == "/api/catalog/reset":
            payload = reset_catalog()
            ensure_index()
            self.respond_json(
                {
                    "savedAlbums": payload["summary"]["albumCount"],
                    "savedTracks": payload["summary"]["trackCount"],
                    "updatedAt": payload["updatedAt"],
                }
            )
            return

        if parsed.path == "/api/media/upload":
            params = parse_qs(parsed.query)
            song_id = params.get("id", [""])[0]
            bitrate = params.get("bitrate", [""])[0]
            if not song_id:
                self.respond_json({"error": "Song id is required."}, HTTPStatus.BAD_REQUEST)
                return
            if bitrate not in {"128", "320"}:
                self.respond_json({"error": "bitrate must be 128 or 320."}, HTTPStatus.BAD_REQUEST)
                return

            try:
                audio_url = write_media_bytes(song_id, bitrate, self.read_raw_body())
            except ValueError as error:
                self.respond_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
                return
            self.respond_json({"ok": True, "id": song_id, "bitrate": bitrate, "audioUrl": audio_url})
            return

        if parsed.path == "/api/media/reindex":
            ensure_index()
            self.respond_json(
                {
                    "summary": APP_STATE["summary"],
                    "updatedAt": APP_STATE["updatedAt"],
                }
            )
            return

        if parsed.path == "/api/warmup":
            try:
                payload = self.read_json_body()
            except json.JSONDecodeError:
                self.respond_json({"error": "Invalid JSON body."}, HTTPStatus.BAD_REQUEST)
                return
            limit = as_int(payload.get("limit"), 8)
            song_ids = warmup_song_ids(min(limit, 8))
            queued_songs = prefetch_song_ids(song_ids)
            self.respond_json(
                {
                    "ok": True,
                    "limit": limit,
                    "queuedSongs": queued_songs,
                }
            )
            return

        if parsed.path == "/api/songs-batch":
            try:
                payload = self.read_json_body()
            except json.JSONDecodeError:
                self.respond_json({"error": "Invalid JSON body."}, HTTPStatus.BAD_REQUEST)
                return
            song_ids = payload.get("ids", [])
            if not isinstance(song_ids, list):
                self.respond_json({"error": "ids must be an array."}, HTTPStatus.BAD_REQUEST)
                return
            songs = load_song_records(song_ids)
            self.respond_json({"songs": songs})
            return

        if parsed.path == "/api/prefetch":
            try:
                payload = self.read_json_body()
            except json.JSONDecodeError:
                self.respond_json({"error": "Invalid JSON body."}, HTTPStatus.BAD_REQUEST)
                return
            song_ids = payload.get("ids", [])
            if not isinstance(song_ids, list):
                self.respond_json({"error": "ids must be an array."}, HTTPStatus.BAD_REQUEST)
                return
            queued = prefetch_song_ids(song_ids)
            self.respond_json({"ok": True, "queued": queued})
            return

        if parsed.path == "/api/prefetch/album":
            try:
                payload = self.read_json_body()
            except json.JSONDecodeError:
                self.respond_json({"error": "Invalid JSON body."}, HTTPStatus.BAD_REQUEST)
                return
            song_id = clean_text(payload.get("songId"))
            limit = as_int(payload.get("limit"), 16)
            if not song_id:
                self.respond_json({"error": "songId is required."}, HTTPStatus.BAD_REQUEST)
                return
            row = load_song_db_row(song_id)
            album_url = clean_text(row["album_url"]) if row else ""
            queued_albums = queue_album_refresh([album_url], song_prefetch_limit=limit)
            ids = album_song_ids_for_song(song_id, min(limit, 4))
            queued_songs = prefetch_song_ids(ids)
            self.respond_json({"ok": True, "queuedAlbums": queued_albums, "queuedSongs": queued_songs, "albumSongCount": len(ids)})
            return

        if parsed.path == "/api/refresh/request":
            try:
                payload = self.read_json_body()
            except json.JSONDecodeError:
                self.respond_json({"error": "Invalid JSON body."}, HTTPStatus.BAD_REQUEST)
                return

            song_id = clean_text(payload.get("id"))
            song = next((item for item in SONG_INDEX if item["id"] == song_id), None)
            if song is None:
                self.respond_json({"error": "Song not found."}, HTTPStatus.NOT_FOUND)
                return

            queued = enqueue_refresh_request(song)
            self.respond_json(
                {
                    "queued": queued,
                    "workerActive": is_refresh_worker_active(),
                    "queueLength": len(REFRESH_QUEUE),
                }
            )
            return

        if parsed.path == "/api/refresh/result":
            try:
                payload = self.read_json_body()
            except json.JSONDecodeError:
                self.respond_json({"error": "Invalid JSON body."}, HTTPStatus.BAD_REQUEST)
                return

            song_id = clean_text(payload.get("id"))
            ok = bool(payload.get("ok"))
            message = payload.get("message", "")
            album = payload.get("album")
            if ok and isinstance(album, dict):
                upsert_catalog_albums([album])
                ensure_index()
                song = next((item for item in SONG_INDEX if item["id"] == song_id), None)
                refreshed = mark_refresh_result(song_id, bool(song and song.get("audioUrl")), message or "Catalog refreshed.")
                self.respond_json({"ok": True, "status": refreshed})
                return

            status = mark_refresh_result(song_id, False, message or "Refresh worker could not fetch a fresh link.")
            self.respond_json({"ok": False, "status": status})
            return

        if parsed.path == "/api/refresh/heartbeat":
            APP_STATE["refreshWorkerSeenAt"] = utc_now()
            APP_STATE["refreshWorkerActive"] = True
            self.respond_json({"ok": True, "workerActive": True, "queueLength": len(REFRESH_QUEUE)})
            return

        self.respond_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)

    def respond_json(self, payload, status=HTTPStatus.OK):
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


if __name__ == "__main__":
    ensure_index()
    server = ThreadingHTTPServer(("127.0.0.1", 8000), CatalogHandler)
    print("Tamil Music Vault server running on http://127.0.0.1:8000")
    server.serve_forever()
