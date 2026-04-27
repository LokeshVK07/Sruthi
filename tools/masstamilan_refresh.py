#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import random
import re
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Dict, List
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

import cloudscraper
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server


SCRAPE_SITE_ORIGIN = server.SITE_ORIGIN
LISTING_PATH = "/tamil-songs?page={page}"
MOVIE_INDEX_PATH = "/movie-index"
CHALLENGE_MARKERS = (
    "just a moment",
    "cf-browser-verification",
    "checking your browser",
    "enable javascript and cookies to continue",
)

# Global rate-limit gate shared across all threads
REQUEST_GATE_LOCK = threading.Lock()
REQUEST_GATE_NEXT_ALLOWED_AT = 0.0
CONSECUTIVE_RATE_LIMITS = 0
TOTAL_429_COUNT = 0  # monotonic; never reset; used for per-fetch 429 detection


class AdaptiveSemaphore:
    """Semaphore whose concurrency limit can be raised or lowered at runtime."""

    def __init__(self, initial):
        self._max = initial
        self._limit = initial
        self._used = 0
        self._cond = threading.Condition(threading.Lock())

    def acquire(self):
        with self._cond:
            while self._used >= self._limit:
                self._cond.wait()
            self._used += 1

    def release(self):
        with self._cond:
            self._used = max(0, self._used - 1)
            self._cond.notify_all()

    def reduce(self, floor=1):
        with self._cond:
            self._limit = max(floor, self._limit - 1)
            return self._limit

    def recover(self):
        with self._cond:
            if self._limit < self._max:
                self._limit += 1
                self._cond.notify_all()
            return self._limit

    @property
    def limit(self):
        return self._limit

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *_):
        self.release()


def default_listing_path(origin):
    host = urlparse(clean_text(origin)).netloc.lower()
    if "masstelugu.com" in host:
        return "/telugu-songs?page={page}"
    return "/tamil-songs?page={page}"


def parse_args():
    parser = argparse.ArgumentParser(description="Refresh Sruthi from a Mass* source without browser automation.")
    default_workers = max(4, min(16, os.cpu_count() or 4))
    parser.add_argument("--origin", default=server.SITE_ORIGIN)
    parser.add_argument("--listing-path", default=None)
    parser.add_argument("--movie-index-path", default=MOVIE_INDEX_PATH)
    parser.add_argument("--start-page", type=int, default=1)
    parser.add_argument("--max-pages", type=int, default=800)
    parser.add_argument("--workers", type=int, default=default_workers)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--page-delay", type=float, default=0.2)
    parser.add_argument("--album-delay", type=float, default=0.15)
    parser.add_argument("--retry-count", type=int, default=3)
    parser.add_argument("--retry-base-delay", type=float, default=1.0)
    parser.add_argument("--stop-after-known-pages", type=int, default=2)
    parser.add_argument("--skip-movie-index", action="store_true")
    parser.add_argument("--include-tag-index", action="store_true")
    parser.add_argument("--movie-index-stop-after-known-pages", type=int, default=120)
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--print-summary-only", action="store_true")
    parser.add_argument("--known-urls-file", default="", help="Optional newline-delimited album URL file for incremental early-stop hinting")
    parser.add_argument("--failure-threshold", type=float, default=0.5, help="Max fraction of albums allowed to fail before aborting (0–1)")
    parser.add_argument("--batch-commit-size", type=int, default=32, help="Albums per DB transaction in the write phase")
    return parser.parse_args()


def clean_text(value):
    return " ".join(str(value or "").split()).strip()


def sleep_with_jitter(base_seconds, jitter_seconds=0.25):
    if base_seconds <= 0:
        return
    time.sleep(base_seconds + random.random() * max(jitter_seconds, 0))


def wait_for_request_window():
    while True:
        with REQUEST_GATE_LOCK:
            delay_seconds = REQUEST_GATE_NEXT_ALLOWED_AT - time.time()
        if delay_seconds <= 0:
            return
        time.sleep(min(delay_seconds, 5.0))


def note_successful_request():
    global CONSECUTIVE_RATE_LIMITS
    with REQUEST_GATE_LOCK:
        CONSECUTIVE_RATE_LIMITS = 0


def note_rate_limit(base_delay_seconds):
    global REQUEST_GATE_NEXT_ALLOWED_AT, CONSECUTIVE_RATE_LIMITS, TOTAL_429_COUNT
    with REQUEST_GATE_LOCK:
        CONSECUTIVE_RATE_LIMITS += 1
        TOTAL_429_COUNT += 1
        adaptive_delay = base_delay_seconds * max(1, min(CONSECUTIVE_RATE_LIMITS, 8))
        cooldown_until = time.time() + adaptive_delay + random.uniform(0.5, 2.0)
        REQUEST_GATE_NEXT_ALLOWED_AT = max(REQUEST_GATE_NEXT_ALLOWED_AT, cooldown_until)
        return CONSECUTIVE_RATE_LIMITS, max(0.0, REQUEST_GATE_NEXT_ALLOWED_AT - time.time())


def is_challenge_page(html):
    lowered = clean_text(html).lower()
    return any(marker in lowered for marker in CHALLENGE_MARKERS)


def to_absolute(url):
    text = clean_text(url)
    if not text:
        return None
    return urljoin(SCRAPE_SITE_ORIGIN, text)


def escape_regex(value):
    return re.escape(value)


def extract_bounded_value(text, label, next_labels=None):
    next_labels = next_labels or []
    boundaries = [f"{escape_regex(item)}:" for item in next_labels]
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
    pattern = re.compile(
        rf"{escape_regex(label)}:\s*(.+?)(?=\s+(?:{'|'.join(boundaries)})|$)",
        re.IGNORECASE,
    )
    match = pattern.search(clean_text(text))
    return clean_text(match.group(1)) if match else None


def normalize_key(value):
    return re.sub(r"[^a-z0-9]+", "-", clean_text(value).lower()).strip("-")


def detect_bitrate(label, url):
    label_text = clean_text(label).lower()
    url_text = clean_text(url).lower()
    if "/p320_cdn/" in url_text or "/d320_cdn/" in url_text or re.search(r"\b320\s*kbps\b", label_text):
        return 320
    if "/p128_cdn/" in url_text or "/d128_cdn/" in url_text or re.search(r"\b128\s*kbps\b", label_text):
        return 128
    return None


def infer_bitrate_url(url, bitrate):
    text = clean_text(url)
    if not text:
        return None
    return re.sub(r"/p(?:128|320)_cdn/", f"/p{bitrate}_cdn/", text, flags=re.IGNORECASE)


def unique_by(items, key_fn):
    seen = set()
    results = []
    for item in items:
        key = key_fn(item)
        if key in seen:
            continue
        seen.add(key)
        results.append(item)
    return results


def normalize_download_links(download_links, fallback_url=None):
    normalized = []
    seen = set()
    audio_128 = None
    audio_320 = None

    def push_link(label, url, bitrate):
        nonlocal normalized
        absolute = to_absolute(url)
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

    for item in download_links:
        url = to_absolute(item.get("url"))
        bitrate = detect_bitrate(item.get("label"), url)
        push_link(item.get("label"), url, bitrate)
        if bitrate == 128 and not audio_128:
            audio_128 = url
        if bitrate == 320 and not audio_320:
            audio_320 = url

    if fallback_url:
        absolute = to_absolute(fallback_url)
        if absolute and "/p128_cdn/" in absolute and not audio_128:
            audio_128 = absolute
        if absolute and "/p320_cdn/" in absolute and not audio_320:
            audio_320 = absolute

    if audio_128 and not audio_320:
        audio_320 = infer_bitrate_url(audio_128, 320)
    if audio_320 and not audio_128:
        audio_128 = infer_bitrate_url(audio_320, 128)

    if audio_320:
        push_link("320kbps", audio_320, 320)
    if audio_128:
        push_link("128kbps", audio_128, 128)

    normalized.sort(key=lambda item: item.get("bitrate") or 0, reverse=True)
    return {
        "downloadLinks": normalized,
        "audio128Url": audio_128,
        "audio320Url": audio_320,
        "audioUrl": audio_320 or audio_128 or None,
    }


def make_session():
    session = cloudscraper.create_scraper(
        browser={
            "browser": "chrome",
            "platform": "windows",
            "desktop": True,
        }
    )
    session.headers.update(
        {
            "User-Agent": server.UPSTREAM_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Upgrade-Insecure-Requests": "1",
        }
    )
    return session


def fetch_html(session, url, retry_count=3, retry_base_delay=1.0):
    last_error = None
    absolute = to_absolute(url)
    for attempt in range(1, retry_count + 1):
        try:
            wait_for_request_window()
            response = session.get(absolute, timeout=server.UPSTREAM_PAGE_TIMEOUT_SECONDS)
            response.raise_for_status()
            html = response.text
            if is_challenge_page(html):
                request = Request(
                    absolute,
                    headers={
                        "User-Agent": server.UPSTREAM_USER_AGENT,
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                        "Accept-Language": "en-US,en;q=0.9",
                        "Cache-Control": "no-cache",
                        "Pragma": "no-cache",
                        "Upgrade-Insecure-Requests": "1",
                    },
                )
                with urlopen(request, timeout=server.UPSTREAM_PAGE_TIMEOUT_SECONDS) as fallback_response:
                    html = fallback_response.read().decode("utf-8", errors="ignore")
                if is_challenge_page(html):
                    raise RuntimeError(f"Challenge page detected for {absolute}")
            note_successful_request()
            return html
        except Exception as error:  # noqa: BLE001
            last_error = error
            status_code = getattr(getattr(error, "response", None), "status_code", None)
            retry_after_header = ""
            if getattr(error, "response", None) is not None:
                retry_after_header = clean_text(error.response.headers.get("Retry-After"))
            if attempt == retry_count:
                break
            delay_seconds = retry_base_delay * attempt
            if status_code == 429:
                retry_after_seconds = 0
                if retry_after_header.isdigit():
                    retry_after_seconds = int(retry_after_header)
                delay_seconds = max(delay_seconds, retry_after_seconds or (retry_base_delay * (attempt + 2) * 4))
                consecutive_rate_limits, gate_delay = note_rate_limit(delay_seconds)
                print(
                    f"Rate limited on {absolute}; retrying in {delay_seconds:.1f}s "
                    f"(attempt {attempt}/{retry_count}, consecutive 429s: {consecutive_rate_limits}, "
                    f"shared cooldown: {gate_delay:.1f}s)",
                    file=sys.stderr,
                )
            elif isinstance(error, requests.HTTPError):
                print(
                    f"HTTP {status_code} for {absolute}; retrying in {delay_seconds:.1f}s "
                    f"(attempt {attempt}/{retry_count})",
                    file=sys.stderr,
                )
            sleep_with_jitter(delay_seconds, min(5.0, max(0.5, delay_seconds * 0.25)))
    raise RuntimeError(f"Failed to fetch {absolute}: {last_error}") from last_error


def parse_total_pages(soup):
    pages = {1}
    for link in soup.select('a[href*="page="]'):
        href = link.get("href") or ""
        match = re.search(r"[?&]page=(\d+)", href)
        if match:
            pages.add(int(match.group(1)))
    return max(pages)


def parse_listing_page(html, page_number):
    soup = BeautifulSoup(html, "html.parser")
    candidates = []
    for link in soup.select('a[href*="/"]'):
        href = link.get("href")
        text = clean_text(link.get_text(" ", strip=True))
        if not href or not text:
            continue
        if "/tamil-songs" in href:
            continue
        if re.search(r"Search|Latest Updates|Movie Index|Telegram|Privacy Policy|Terms of use|Disclaimer|Contact", text, re.I):
            continue
        if not re.search(r"(Starring:|Music:|Director:)", text, re.I):
            continue
        title = clean_text(text.split("Starring:")[0])
        candidates.append({"title": title, "url": to_absolute(href), "pageNumber": page_number})
    return unique_by(candidates, lambda item: item["url"])


def make_seed(title, href, page_number=0):
    absolute = to_absolute(href)
    if not absolute:
        return None
    return {
        "title": clean_text(title),
        "url": absolute,
        "pageNumber": page_number,
    }


def parse_movie_index_entry_paths(html, include_tag_index=False):
    soup = BeautifulSoup(html, "html.parser")
    paths = []
    for link in soup.select("a[href]"):
        href = clean_text(link.get("href"))
        if not href:
            continue
        if "/browse-by-year/" in href:
            paths.append(to_absolute(href))
            continue
        if include_tag_index and href.startswith("/tag/"):
            paths.append(to_absolute(href))
    return unique_by([path for path in paths if path], lambda item: item)


def parse_directory_album_seeds(html, page_number=0):
    soup = BeautifulSoup(html, "html.parser")
    candidates = []
    for link in soup.select("a[href]"):
        href = clean_text(link.get("href"))
        text = clean_text(link.get_text(" ", strip=True))
        if not href or not text:
            continue
        if href.startswith("#") or "/movie-index" in href or "/browse-by-year/" in href or href.startswith("/tag/"):
            continue
        if re.search(r"Search|Latest Updates|Movie Index|Telegram|Privacy Policy|Terms of use|Disclaimer|Contact|Tamil Songs|Hindi Songs|Telugu Songs|Malayalam Songs", text, re.I):
            continue
        if not re.search(r"(Starring:|Music:|Director:)", text, re.I):
            continue
        title = clean_text(text.split("Starring:")[0])
        seed = make_seed(title, href, page_number=page_number)
        if seed:
            candidates.append(seed)
    return unique_by(candidates, lambda item: item["url"])


def parse_directory_pagination_paths(html, current_url):
    soup = BeautifulSoup(html, "html.parser")
    current = urlparse(current_url)
    current_base = f"{current.scheme}://{current.netloc}{current.path}"
    pagination = []

    for link in soup.select("a[href]"):
        href = clean_text(link.get("href"))
        text = clean_text(link.get_text(" ", strip=True))
        if not href or not text:
            continue
        if not re.fullmatch(r"[<>]|\d+", text):
            continue
        absolute = to_absolute(href)
        if not absolute or absolute == current_url:
            continue
        parsed = urlparse(absolute)
        absolute_base = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
        if absolute_base != current_base:
            continue
        pagination.append(absolute)

    return unique_by(pagination, lambda item: item)


def extract_album_tracks_from_html(html):
    match = re.search(r"window\.albumTracks\s*=\s*(\[.*?\]);", html, re.S)
    if not match:
        return []
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return []


def collect_track_sections(soup, album_title):
    sections = {}
    headings = []
    for heading in soup.find_all("h2"):
        text = clean_text(heading.get_text(" ", strip=True))
        if not text or text == album_title:
            continue
        if re.search(r"Download .* songs in RAR/ZIP format|Songs Download MassTamilan|Other .* Songs Download", text, re.I):
            continue
        headings.append(heading)

    for index, heading in enumerate(headings, start=1):
        title = clean_text(heading.get_text(" ", strip=True))
        key = normalize_key(title)
        details = []
        download_links = []
        song_link = heading.find("a", href=True)
        for sibling in heading.next_siblings:
            if getattr(sibling, "name", None) == "h2":
                break
            if not getattr(sibling, "get_text", None):
                continue
            text = clean_text(sibling.get_text(" ", strip=True))
            if not text:
                continue
            if re.search(r"^Latest from|^Trending at|^Browse by", text, re.I):
                break
            details.append(text)
            for link in sibling.select("a[href]"):
                href = link.get("href") or ""
                if re.search(r"\.mp3|128kbps|320kbps", clean_text(link.get_text(" ", strip=True)), re.I) or ".mp3" in href.lower():
                    download_links.append({"label": clean_text(link.get_text(" ", strip=True)), "url": href})
            if re.search(r"Downloads:", text, re.I):
                break

        joined = " ".join(details)
        existing = sections.get(key, {})
        sections[key] = {
            **existing,
            "id": existing.get("id") or f"{album_title}-{index}-{key}",
            "title": title,
            "songPageUrl": to_absolute(song_link.get("href")) if song_link else existing.get("songPageUrl"),
            "singers": extract_bounded_value(joined, "Singers", ["Length", "Downloads"]) or existing.get("singers"),
            "length": extract_bounded_value(joined, "Length", ["Downloads"]) or existing.get("length"),
            "downloads": extract_bounded_value(joined, "Downloads") or existing.get("downloads"),
            "downloadLinks": unique_by(existing.get("downloadLinks", []) + download_links, lambda item: to_absolute(item["url"])),
        }
    return sections


def extract_track_id_from_url(url):
    match = re.search(r"/(?:p128|p320)_cdn/(\d+)(?:$|[/?#])", clean_text(url), re.I)
    return match.group(1) if match else None


def collect_global_track_links(soup):
    by_track_id: Dict[str, List[dict]] = {}
    for link in soup.select("a[href]"):
        href = link.get("href") or ""
        bitrate = detect_bitrate(link.get_text(" ", strip=True), href)
        track_id = extract_track_id_from_url(href)
        if not track_id or not bitrate:
            continue
        by_track_id.setdefault(track_id, []).append(
            {
                "label": clean_text(link.get_text(" ", strip=True)) or f"{bitrate}kbps",
                "url": href,
                "bitrate": bitrate,
            }
        )
    return by_track_id


def parse_album_page(html, album_seed):
    soup = BeautifulSoup(html, "html.parser")
    full_text = clean_text(soup.get_text(" ", strip=True))
    info_text = clean_text(full_text.split("Track Name")[0] or full_text)
    year = extract_bounded_value(info_text, "Year")
    composer = extract_bounded_value(info_text, "Music", ["Director", "Lyricists", "Year", "Language"])
    director = extract_bounded_value(info_text, "Director", ["Lyricists", "Year", "Language"])
    starring = extract_bounded_value(info_text, "Starring", ["Music", "Director", "Lyricists", "Year", "Language"])
    lyricists = extract_bounded_value(info_text, "Lyricists", ["Year", "Language"])

    zip_links = [
        {"label": clean_text(link.get_text(" ", strip=True)), "url": to_absolute(link.get("href"))}
        for link in soup.select('a[href$=".zip"], a[href*=".zip?"]')
    ]

    section_map = collect_track_sections(soup, album_seed["title"])
    global_track_links = collect_global_track_links(soup)
    script_tracks = extract_album_tracks_from_html(html)
    tracks = []

    if script_tracks:
        for index, item in enumerate(script_tracks, start=1):
            section = section_map.get(normalize_key(item.get("name"))) or {}
            merged_download_links = (section.get("downloadLinks") or []) + global_track_links.get(str(item.get("id")), [])
            links = normalize_download_links(merged_download_links, item.get("dl_path"))
            image_name = clean_text(item.get("img_name"))
            tracks.append(
                {
                    "id": str(item.get("id") or f"{album_seed['pageNumber']}-{index}-{normalize_key(item.get('name'))}"),
                    "title": clean_text(item.get("name")),
                    "songPageUrl": section.get("songPageUrl") or album_seed["url"],
                    "singers": section.get("singers") or clean_text(item.get("artists")),
                    "length": section.get("length"),
                    "downloads": section.get("downloads"),
                    "artist": section.get("singers") or clean_text(item.get("artists")),
                    "composer": composer,
                    "movie": clean_text(item.get("m_name") or album_seed["title"]),
                    "year": int(year) if year and year.isdigit() else None,
                    "imageUrl": to_absolute(f"/uploads/album/{image_name}.jpg") if image_name else None,
                    "downloadLinks": links["downloadLinks"],
                    "audio128Url": links["audio128Url"],
                    "audio320Url": links["audio320Url"],
                    "audioUrl": links["audioUrl"],
                    "spotify": {
                        "album": None,
                        "popularity": None,
                        "previewAvailable": bool(links["audioUrl"]),
                    },
                }
            )
    else:
        for key, section in section_map.items():
            links = normalize_download_links(section.get("downloadLinks") or [], None)
            tracks.append(
                {
                    "id": section.get("id") or f"{album_seed['pageNumber']}-{key}",
                    "title": section.get("title"),
                    "songPageUrl": section.get("songPageUrl") or album_seed["url"],
                    "singers": section.get("singers"),
                    "length": section.get("length"),
                    "downloads": section.get("downloads"),
                    "artist": section.get("singers"),
                    "composer": composer,
                    "movie": album_seed["title"],
                    "year": int(year) if year and year.isdigit() else None,
                    "imageUrl": None,
                    "downloadLinks": links["downloadLinks"],
                    "audio128Url": links["audio128Url"],
                    "audio320Url": links["audio320Url"],
                    "audioUrl": links["audioUrl"],
                    "spotify": {
                        "album": None,
                        "popularity": None,
                        "previewAvailable": bool(links["audioUrl"]),
                    },
                }
            )

    return {
        "title": album_seed["title"],
        "url": album_seed["url"],
        "pageNumber": album_seed["pageNumber"],
        "year": int(year) if year and year.isdigit() else None,
        "musicDirector": composer,
        "director": director,
        "starring": starring,
        "lyricists": lyricists,
        "zipLinks": zip_links,
        "tracks": unique_by(tracks, lambda item: f"{item['id']}::{item.get('songPageUrl') or ''}"),
    }


def compute_album_hash(parsed):
    """Stable SHA-256 fingerprint of an album's scrape-visible content.

    Includes fields that meaningfully change when a site editor updates the page:
    title, year, composer, tracks (id + title + artist + all audio URLs + image).
    Stable sort ensures the hash is independent of parse ordering.
    """
    tracks = sorted(parsed.get("tracks", []), key=lambda t: str(t.get("id", "")))
    canonical = {
        "title": clean_text(parsed.get("title")),
        "year": parsed.get("year"),
        "musicDirector": clean_text(parsed.get("musicDirector")),
        "tracks": [
            {
                "id": str(t.get("id", "")),
                "title": clean_text(t.get("title")),
                "artist": clean_text(t.get("artist")),
                "audioUrl": clean_text(t.get("audioUrl")),
                "audio128Url": clean_text(t.get("audio128Url")),
                "audio320Url": clean_text(t.get("audio320Url")),
                "imageUrl": clean_text(t.get("imageUrl")),
            }
            for t in tracks
        ],
    }
    return hashlib.sha256(
        json.dumps(canonical, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def load_known_urls(known_urls_file=""):
    """Load album URLs that are already in the DB, used only for incremental early-stopping."""
    known = set()
    known_file = Path(clean_text(known_urls_file)) if clean_text(known_urls_file) else None
    if known_file and known_file.exists():
        known.update(
            to_absolute(line)
            for line in known_file.read_text(encoding="utf-8", errors="ignore").splitlines()
            if clean_text(line)
        )
        known = {item for item in known if item}

    server.ensure_db()
    known.update(url for url in server.load_processed_urls() if url)
    return known


def build_album_seeds(session, args, known_urls):
    """Scrape listing pages and return discovered album seeds.

    In incremental mode, stops after --stop-after-known-pages consecutive pages
    where every album is already in the DB. In full mode, scans all pages.
    All discovered albums are returned regardless of DB presence.
    """
    page = max(1, args.start_page)
    discovered = []
    seen = set()
    total_pages = None
    consecutive_known_pages = 0
    listing_pages_scanned = 0

    print(f"=== Listing pages scan ({'full' if args.full else 'incremental'}) ===")

    while page <= args.max_pages:
        html = fetch_html(session, LISTING_PATH.format(page=page), args.retry_count, args.retry_base_delay)
        seeds = parse_listing_page(html, page)
        soup = BeautifulSoup(html, "html.parser")
        page_total = parse_total_pages(soup)
        total_pages = max(total_pages or 1, page_total)
        listing_pages_scanned += 1

        new_on_page = 0
        for seed in seeds:
            if seed["url"] in seen:
                continue
            seen.add(seed["url"])
            discovered.append(seed)
            if seed["url"] not in known_urls:
                new_on_page += 1

        known_on_page = len(seeds) - new_on_page
        print(f"  Listing page {page}/{total_pages}: {len(seeds)} albums scanned ({new_on_page} new to DB, {known_on_page} already in DB)")

        if not args.full:
            if new_on_page == 0:
                consecutive_known_pages += 1
            else:
                consecutive_known_pages = 0
            if consecutive_known_pages >= max(1, args.stop_after_known_pages):
                print(f"  Incremental stop: {consecutive_known_pages} consecutive pages with no new albums.")
                break

        if total_pages and page >= total_pages:
            break

        page += 1
        sleep_with_jitter(args.page_delay, 0.15)

    print(f"Listing scan done: {listing_pages_scanned} pages, {len(discovered)} albums discovered")
    return unique_by(discovered, lambda item: item["url"]), total_pages or page


def build_movie_index_album_seeds(session, args, known_urls):
    """Scrape movie index and year-wise pages and return discovered album seeds.

    Fetches /movie-index to find year/tag index pages, supplements with explicit
    year URLs from 1952 to the current year to guarantee full coverage.
    All discovered albums are returned regardless of DB presence.
    """
    if args.skip_movie_index:
        return []

    root_html = fetch_html(session, MOVIE_INDEX_PATH, args.retry_count, args.retry_base_delay)
    entry_paths = parse_movie_index_entry_paths(root_html, include_tag_index=args.include_tag_index)

    # Supplement with explicit year URLs so we never miss a year not linked from index page
    found_year_paths = {p for p in entry_paths if p and "/browse-by-year/" in p}
    found_years = set()
    for p in found_year_paths:
        m = re.search(r"/browse-by-year/(\d+)", p)
        if m:
            found_years.add(int(m.group(1)))

    current_year = datetime.now().year
    supplemented_years = []
    for year in range(current_year, 1951, -1):
        if year not in found_years:
            year_url = to_absolute(f"/browse-by-year/{year}")
            entry_paths.append(year_url)
            supplemented_years.append(year)

    print(f"\n=== Movie index scan ({'full' if args.full else 'incremental'}) ===")
    print(f"  Index pages found: {len(entry_paths) - len(supplemented_years)} from site, {len(supplemented_years)} year-URLs added ({current_year}→1952)")

    discovered = []
    seen_album_urls = set()
    seen_page_urls = set()
    queue = list(entry_paths)
    page_number = 0
    consecutive_known_pages = 0
    movie_index_pages_scanned = 0

    while queue:
        page_url = queue.pop(0)
        if page_url in seen_page_urls:
            continue
        seen_page_urls.add(page_url)
        page_number += 1

        try:
            html = fetch_html(session, page_url, args.retry_count, args.retry_base_delay)
        except Exception as err:
            print(f"  Skipping {page_url}: {err}", file=sys.stderr)
            continue

        movie_index_pages_scanned += 1
        seeds = parse_directory_album_seeds(html, page_number=page_number)
        new_on_page = 0
        for seed in seeds:
            if seed["url"] in seen_album_urls:
                continue
            seen_album_urls.add(seed["url"])
            discovered.append(seed)
            if seed["url"] not in known_urls:
                new_on_page += 1

        year_match = re.search(r"/browse-by-year/(\d+)", page_url)
        page_label = f"Year {year_match.group(1)}" if year_match else f"Index page {page_number}"
        known_on_page = len(seeds) - new_on_page
        if seeds or year_match:
            print(f"  {page_label}: {len(seeds)} albums ({new_on_page} new, {known_on_page} known)")

        if new_on_page == 0:
            consecutive_known_pages += 1
        else:
            consecutive_known_pages = 0

        if not args.full and consecutive_known_pages >= max(1, args.movie_index_stop_after_known_pages):
            print(f"  Movie index incremental stop: {consecutive_known_pages} consecutive pages with no new albums.")
            break

        for next_page in parse_directory_pagination_paths(html, page_url):
            if next_page not in seen_page_urls:
                queue.append(next_page)

        sleep_with_jitter(args.page_delay, 0.1)

    print(f"Movie index scan done: {movie_index_pages_scanned} pages, {len(discovered)} albums discovered")
    return unique_by(discovered, lambda item: item["url"])


def refresh_albums(session, albums, args):
    """Fetch, parse, and write every discovered album.

    Phase 1 (parallel): Fetch album HTML + parse + compute content hash.
             Uses AdaptiveSemaphore to reduce concurrency on 429s and recover on clean streaks.
    Phase 2 (batched): Write all parsed results to SQLite in transactions of --batch-commit-size
             albums each. Albums whose content_hash matches the stored value are skipped
             (only last_checked_at is updated); changed or new albums are fully upserted.

    Returns (fetched_count, failed_list, stats_dict).
    """
    total = len(albums)
    failed = []
    worker_count = max(1, min(args.workers, 16))
    start_time = time.time()

    # ── Phase 1: parallel fetch + parse ────────────────────────────────────────
    print(f"\n=== Phase 1: Fetching {total} album pages ({worker_count} workers) ===")

    concurrency = AdaptiveSemaphore(worker_count)
    recovery_streak = [0]
    rl_lock = threading.Lock()
    parsed_entries: list = []   # (seed, parsed, content_hash) for successes
    fetch_done = [0]
    abort_flag = [False]

    def fetch_one(album):
        if abort_flag[0]:
            return None
        rl_before = TOTAL_429_COUNT
        with concurrency:
            if abort_flag[0]:
                return None
            sleep_with_jitter(args.album_delay, 0.2)
            html = fetch_html(session, album["url"], args.retry_count, args.retry_base_delay)
        had_429 = TOTAL_429_COUNT > rl_before
        with rl_lock:
            if had_429:
                recovery_streak[0] = 0
                new_limit = concurrency.reduce()
                print(f"  [adaptive] 429 on {album['title']!r}, concurrency → {new_limit}", file=sys.stderr)
            else:
                recovery_streak[0] += 1
                if recovery_streak[0] >= 10 and concurrency.limit < worker_count:
                    new_limit = concurrency.recover()
                    recovery_streak[0] = 0
                    print(f"  [adaptive] Stable, concurrency → {new_limit}", file=sys.stderr)
        parsed = parse_album_page(html, album)
        if not parsed.get("tracks"):
            raise RuntimeError(f"No tracks parsed for {album['url']}")
        return album, parsed, compute_album_hash(parsed)

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = {executor.submit(fetch_one, album): album for album in albums}
        for future in as_completed(futures):
            album = futures[future]
            fetch_done[0] += 1
            n = fetch_done[0]
            try:
                result = future.result()
                if result is None:
                    continue
                parsed_entries.append(result)
                if n % 25 == 0 or n == total:
                    elapsed = time.time() - start_time
                    print(f"  [{n}/{total}] fetched  ({elapsed:.0f}s elapsed, {len(failed)} failed)")
            except Exception as error:  # noqa: BLE001
                failed.append({"url": album["url"], "title": album["title"], "error": str(error)})
                print(f"  [{n}/{total}] FAILED fetch: {album['title']} → {error}", file=sys.stderr)
                if total >= 10 and n >= 20:
                    fail_rate = len(failed) / n
                    if fail_rate > args.failure_threshold:
                        print(
                            f"Failure rate {fail_rate:.0%} exceeds threshold {args.failure_threshold:.0%} "
                            f"after {n} albums — stopping fetch phase.",
                            file=sys.stderr,
                        )
                        abort_flag[0] = True
                        executor.shutdown(wait=False, cancel_futures=True)
                        break

    fetch_elapsed = time.time() - start_time
    print(
        f"Fetch phase done: {len(parsed_entries)} fetched, {len(failed)} failed  "
        f"({fetch_elapsed:.1f}s, {TOTAL_429_COUNT} total 429s)"
    )

    if not parsed_entries:
        return 0, failed, {"unchanged": 0, "albumsInserted": 0, "albumsUpdated": 0,
                           "tracksInserted": 0, "tracksUpdated": 0, "tracksRemoved": 0}

    # ── Phase 2: batched DB writes ──────────────────────────────────────────────
    batch_size = max(1, args.batch_commit_size)
    print(f"\n=== Phase 2: Writing {len(parsed_entries)} albums (batch={batch_size}) ===")
    write_start = time.time()

    write_stats = server.batch_upsert_albums_into_db(parsed_entries, batch_size=batch_size)

    write_elapsed = time.time() - write_start
    print(
        f"Write phase done: {write_stats.get('unchanged', 0)} unchanged, "
        f"{write_stats.get('albumsInserted', 0)} inserted, "
        f"{write_stats.get('albumsUpdated', 0)} updated  ({write_elapsed:.1f}s)"
    )

    return len(parsed_entries), failed, write_stats


def validate_db_after_refresh():
    """Run basic integrity checks on the DB and print results."""
    import sqlite3
    db_path = server.DB_PATH
    if not Path(db_path).exists():
        print("DB validation skipped: file not found", file=sys.stderr)
        return False

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        album_count = conn.execute("SELECT COUNT(*) FROM albums").fetchone()[0]
        song_count = conn.execute("SELECT COUNT(*) FROM songs").fetchone()[0]
        dup_albums = conn.execute(
            "SELECT url FROM albums GROUP BY url HAVING COUNT(*) > 1"
        ).fetchall()
        empty_albums = conn.execute(
            "SELECT COUNT(*) FROM albums WHERE track_count = 0"
        ).fetchone()[0]
        no_audio = conn.execute(
            "SELECT COUNT(*) FROM songs WHERE (audio_url IS NULL OR audio_url = '') "
            "AND (audio_128_url IS NULL OR audio_128_url = '') "
            "AND (audio_320_url IS NULL OR audio_320_url = '')"
        ).fetchone()[0]
    finally:
        conn.close()

    issues = []
    if album_count < 100:
        issues.append(f"Unexpectedly low album count: {album_count}")
    if song_count < 500:
        issues.append(f"Unexpectedly low song count: {song_count}")
    if dup_albums:
        issues.append(f"Duplicate album URLs found: {len(dup_albums)}")

    validation = {
        "albumCount": album_count,
        "songCount": song_count,
        "emptyAlbums": empty_albums,
        "songsWithNoAudio": no_audio,
        "duplicateAlbumUrls": len(dup_albums),
        "issues": issues,
    }
    print("\n=== DB validation ===")
    print(json.dumps(validation, indent=2))

    for issue in issues:
        print(f"WARNING: {issue}", file=sys.stderr)

    return not issues


def configure_server_paths():
    server.ensure_data_dir()
    server.ensure_db()


def main():
    global SCRAPE_SITE_ORIGIN
    global LISTING_PATH
    global MOVIE_INDEX_PATH

    run_start = time.time()

    args = parse_args()
    SCRAPE_SITE_ORIGIN = clean_text(args.origin).rstrip("/") or server.SITE_ORIGIN
    LISTING_PATH = clean_text(args.listing_path) or default_listing_path(SCRAPE_SITE_ORIGIN)
    MOVIE_INDEX_PATH = clean_text(args.movie_index_path) or "/movie-index"
    configure_server_paths()
    if args.workers <= 0:
        raise SystemExit("--workers must be greater than 0")
    if args.batch_size <= 0:
        raise SystemExit("--batch-size must be greater than 0")
    if args.start_page <= 0 or args.max_pages <= 0:
        raise SystemExit("--start-page and --max-pages must be greater than 0")

    if args.print_summary_only:
        payload = server.build_index_payload_from_db()
        print(json.dumps(payload.get("summary", {}), indent=2))
        return 0

    mode = "full" if args.full else "incremental"
    print(json.dumps({
        "mode": mode,
        "origin": SCRAPE_SITE_ORIGIN,
        "workers": args.workers,
        "batchCommitSize": args.batch_commit_size,
        "pageDelay": args.page_delay,
        "albumDelay": args.album_delay,
    }, indent=2))

    session = make_session()

    # Load known URLs from DB for incremental early-stopping during discovery.
    # These are NOT used to filter which albums get refreshed — all discovered
    # albums are always refreshed regardless of whether they exist in the DB.
    known_urls = load_known_urls(args.known_urls_file)

    listing_album_seeds, total_pages = build_album_seeds(session, args, known_urls)
    movie_index_album_seeds = build_movie_index_album_seeds(session, args, known_urls)

    # Merge and deduplicate — never fetch the same detail page twice in one run
    listing_only = len(listing_album_seeds)
    movie_index_only = len(movie_index_album_seeds)
    all_seeds = unique_by(listing_album_seeds + movie_index_album_seeds, lambda item: item["url"])
    deduped_total = len(all_seeds)
    duplicates_removed = (listing_only + movie_index_only) - deduped_total

    # All discovered albums are refreshed — no filtering by DB presence.
    # Hash check inside batch_upsert_albums_into_db() determines whether a full
    # rewrite is needed; presence in DB alone never causes a skip.
    remaining = all_seeds

    print(json.dumps(
        {
            "origin": SCRAPE_SITE_ORIGIN,
            "mode": mode,
            "listingPagesSeen": total_pages,
            "listingDiscoveredAlbums": listing_only,
            "movieIndexDiscoveredAlbums": movie_index_only,
            "duplicatesRemoved": duplicates_removed,
            "totalAlbumsToRefresh": deduped_total,
            "knownUrlsInDb": len(known_urls),
        },
        indent=2,
    ))

    if not remaining:
        server.write_runtime_catalog_files_from_db()
        return 0

    fetched, failed, stats = refresh_albums(session, remaining, args)

    # Save failure report
    if failed:
        report_path = Path("data/failed_albums.json")
        report_path.write_text(json.dumps(failed, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\nFailed albums report: {report_path} ({len(failed)} entries)", file=sys.stderr)

    payload = server.write_runtime_catalog_files_from_db()
    validate_db_after_refresh()

    total_runtime_s = time.time() - run_start
    runtime_str = f"{int(total_runtime_s // 60)}m {int(total_runtime_s % 60)}s"

    # Active/inactive song counts from DB
    import sqlite3 as _sqlite3
    try:
        _conn = _sqlite3.connect(str(server.DB_PATH))
        active_songs = _conn.execute("SELECT COUNT(*) FROM songs WHERE link_status != 'inactive'").fetchone()[0]
        inactive_songs = _conn.execute("SELECT COUNT(*) FROM songs WHERE link_status = 'inactive'").fetchone()[0]
        _conn.close()
    except Exception:
        active_songs = inactive_songs = "?"

    summary = {
        "mode": mode,
        # Discovery
        "discoveredAlbumURLs": listing_only + movie_index_only,
        "deduplicatedURLs": deduped_total,
        "duplicatesRemoved": duplicates_removed,
        # Fetch phase
        "detailPagesFetched": fetched,
        "failedURLs": len(failed),
        "total429s": TOTAL_429_COUNT,
        # Write phase (hash-based)
        "unchangedAlbums": stats.get("unchanged", 0),
        "insertedAlbums": stats.get("albumsInserted", 0),
        "updatedAlbums": stats.get("albumsUpdated", 0),
        # Tracks
        "activeSongs": active_songs,
        "inactiveSongs": inactive_songs,
        "tracksInserted": stats.get("tracksInserted", 0),
        "tracksUpdated": stats.get("tracksUpdated", 0),
        "tracksMarkedInactive": stats.get("tracksRemoved", 0),
        # Catalog totals
        "totalAlbumCount": payload.get("summary", {}).get("albumCount", 0),
        "totalTrackCount": payload.get("summary", {}).get("trackCount", 0),
        # Runtime
        "totalRuntime": runtime_str,
        "totalRuntimeSeconds": round(total_runtime_s, 1),
    }
    print("\n=== Final summary ===")
    print(json.dumps(summary, indent=2))

    print("\n=== How runtime is reduced ===")
    print(
        "  • Hash skip: albums whose scrape-visible content (title, year, composer, track titles/URLs/artwork)\n"
        "    is unchanged are detected via SHA-256 in a single bulk DB read; only last_checked_at is updated —\n"
        f"    {stats.get('unchanged', 0)} albums skipped full rewrite this run.\n"
        "  • Transaction batching: all writes inside one SQLite transaction per batch of "
        f"{args.batch_commit_size} albums —\n"
        "    ~{} commits instead of one per album.\n".format(
            max(1, (fetched + len(failed)) // args.batch_commit_size)
        ) +
        "  • Incremental discovery (non-full mode): listing pages stop after consecutive known-only pages;\n"
        "    movie index does the same — far fewer detail pages to fetch than a full catalog scan.\n"
        "  • Adaptive concurrency: 429 responses reduce the semaphore limit; 10+ clean fetches recover it —\n"
        f"    {TOTAL_429_COUNT} 429s triggered adaptive throttle this run."
    )

    print("\n=== How correctness is preserved ===")
    print(
        "  • Every discovered album URL is always fetched — hash check is only used to skip DB writes,\n"
        "    never to skip the HTTP fetch. Changed content is always detected.\n"
        "  • COALESCE(NULLIF(new,''), old) on all audio/image URL columns prevents overwriting a working\n"
        "    URL with an empty string when the scrape doesn't find one.\n"
        "  • Stale tracks are marked link_status='inactive' (not deleted) — existing favourites/queues\n"
        "    remain playable; inactive songs are hidden from catalog listings only.\n"
        "  • Blue/green D1: this script writes only to local SQLite; the live Cloudflare D1 is never\n"
        "    touched during refresh. D1 validation gates block deployment of broken catalogs."
    )

    print("\n=== Commands ===")
    base = "python tools/masstamilan_refresh.py"
    fast_cmd = (
        f"{base} "
        "--workers 4 --batch-commit-size 32 "
        "--page-delay 1.0 --album-delay 0.8 "
        "--retry-count 5 --retry-base-delay 3 "
        "--stop-after-known-pages 2 --movie-index-stop-after-known-pages 120 "
        "--failure-threshold 0.5"
    )
    full_cmd = (
        f"{base} --full "
        "--workers 4 --batch-commit-size 32 "
        "--page-delay 1.0 --album-delay 0.8 "
        "--retry-count 5 --retry-base-delay 3 "
        "--failure-threshold 0.5"
    )
    print(f"  Fast scheduled refresh:\n    {fast_cmd}")
    print(f"  Complete full refresh:\n    {full_cmd}")

    if failed and fetched == 0:
        raise SystemExit("All album refreshes failed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
