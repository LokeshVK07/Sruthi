#!/usr/bin/env python3

import argparse
import json
import os
import random
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
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
    parser.add_argument("--known-urls-file", default="", help="Optional newline-delimited album URL file used for incremental stopping")
    return parser.parse_args()


def clean_text(value):
    return " ".join(str(value or "").split()).strip()


def sleep_with_jitter(base_seconds, jitter_seconds=0.25):
    if base_seconds <= 0:
        return
    time.sleep(base_seconds + random.random() * max(jitter_seconds, 0))


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
                print(
                    f"Rate limited while fetching {absolute}; retrying in {delay_seconds:.1f}s "
                    f"(attempt {attempt}/{retry_count})",
                    file=sys.stderr,
                )
            elif isinstance(error, requests.HTTPError):
                print(
                    f"Fetch failed for {absolute} with HTTP {status_code}; retrying in {delay_seconds:.1f}s "
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


def load_processed_urls(known_urls_file=""):
    processed = set()
    known_file = Path(clean_text(known_urls_file)) if clean_text(known_urls_file) else None
    if known_file and known_file.exists():
        processed.update(
            to_absolute(line)
            for line in known_file.read_text(encoding="utf-8", errors="ignore").splitlines()
            if clean_text(line)
        )
        processed = {item for item in processed if item}

    server.ensure_db()
    processed.update(server.load_processed_urls())
    return processed


def build_album_seeds(session, args, processed_urls):
    page = max(1, args.start_page)
    discovered = []
    seen = set()
    total_pages = None
    consecutive_known_pages = 0

    while page <= args.max_pages:
        html = fetch_html(session, LISTING_PATH.format(page=page), args.retry_count, args.retry_base_delay)
        seeds = parse_listing_page(html, page)
        soup = BeautifulSoup(html, "html.parser")
        page_total = parse_total_pages(soup)
        total_pages = max(total_pages or 1, page_total)

        new_on_page = 0
        for seed in seeds:
            if seed["url"] in seen:
                continue
            seen.add(seed["url"])
            discovered.append(seed)
            if seed["url"] not in processed_urls:
                new_on_page += 1

        print(f"Listing page {page}: {len(seeds)} albums, {new_on_page} new")

        if not args.full:
            if new_on_page == 0:
                consecutive_known_pages += 1
            else:
                consecutive_known_pages = 0
            if consecutive_known_pages >= max(1, args.stop_after_known_pages):
                break

        if total_pages and page >= total_pages:
            break

        page += 1
        sleep_with_jitter(args.page_delay, 0.15)

    return unique_by(discovered, lambda item: item["url"]), total_pages or page


def build_movie_index_album_seeds(session, args, processed_urls):
    if args.skip_movie_index:
        return []

    root_html = fetch_html(session, MOVIE_INDEX_PATH, args.retry_count, args.retry_base_delay)
    entry_paths = parse_movie_index_entry_paths(root_html, include_tag_index=args.include_tag_index)
    discovered = []
    seen_album_urls = set()
    seen_page_urls = set()
    queue = list(entry_paths)
    page_number = 0
    consecutive_known_pages = 0

    while queue:
        page_url = queue.pop(0)
        if page_url in seen_page_urls:
            continue
        seen_page_urls.add(page_url)
        page_number += 1

        html = fetch_html(session, page_url, args.retry_count, args.retry_base_delay)
        seeds = parse_directory_album_seeds(html, page_number=page_number)
        new_on_page = 0
        for seed in seeds:
            if seed["url"] in seen_album_urls:
                continue
            seen_album_urls.add(seed["url"])
            discovered.append(seed)
            if seed["url"] not in processed_urls:
                new_on_page += 1

        print(f"Movie index page {page_number}: {len(seeds)} albums, {new_on_page} new")

        if new_on_page == 0:
            consecutive_known_pages += 1
        else:
            consecutive_known_pages = 0

        if not args.full and consecutive_known_pages >= max(1, args.movie_index_stop_after_known_pages):
            print(
                f"Movie index crawl stopped after {consecutive_known_pages} consecutive pages with no new albums."
            )
            break

        for next_page in parse_directory_pagination_paths(html, page_url):
            if next_page not in seen_page_urls:
                queue.append(next_page)

        sleep_with_jitter(args.page_delay, 0.1)

    return unique_by(discovered, lambda item: item["url"])


def refresh_albums(session, albums, args):
    updated = 0
    failed = []

    def worker(album):
        sleep_with_jitter(args.album_delay, 0.2)
        html = fetch_html(session, album["url"], args.retry_count, args.retry_base_delay)
        parsed = parse_album_page(html, album)
        if not parsed.get("tracks"):
            raise RuntimeError(f"No tracks parsed for {album['url']}")
        server.upsert_album_into_db(parsed)
        return parsed["title"], len(parsed["tracks"])

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {executor.submit(worker, album): album for album in albums}
        for future in as_completed(futures):
            album = futures[future]
            try:
                title, count = future.result()
                updated += 1
                print(f"Updated album: {title} ({count} tracks)")
            except Exception as error:  # noqa: BLE001
                failed.append({"url": album["url"], "title": album["title"], "error": str(error)})
                print(f"Failed album: {album['title']} -> {error}", file=sys.stderr)

    return updated, failed


def configure_server_paths():
    server.ensure_data_dir()
    server.ensure_db()


def main():
    global SCRAPE_SITE_ORIGIN
    global LISTING_PATH
    global MOVIE_INDEX_PATH

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

    session = make_session()
    processed_urls = load_processed_urls(args.known_urls_file)
    listing_album_seeds, total_pages = build_album_seeds(session, args, processed_urls)
    movie_index_album_seeds = build_movie_index_album_seeds(session, args, processed_urls)
    album_seeds = unique_by(listing_album_seeds + movie_index_album_seeds, lambda item: item["url"])
    remaining = album_seeds

    print(
        json.dumps(
            {
                "origin": SCRAPE_SITE_ORIGIN,
                "listingPath": LISTING_PATH,
                "listingPagesSeen": total_pages,
                "listingDiscoveredAlbums": len(listing_album_seeds),
                "movieIndexDiscoveredAlbums": len(movie_index_album_seeds),
                "discoveredAlbums": len(album_seeds),
                "knownAlbums": len(processed_urls),
                "albumsToRefresh": len(remaining),
                "fullRefresh": bool(args.full),
            },
            indent=2,
        )
    )

    if not remaining:
        server.write_runtime_catalog_files_from_db()
        return 0

    updated, failed = refresh_albums(session, remaining, args)
    payload = server.write_runtime_catalog_files_from_db()
    summary = {
        "updatedAlbums": updated,
        "failedAlbums": len(failed),
        "albumCount": payload.get("summary", {}).get("albumCount", 0),
        "trackCount": payload.get("summary", {}).get("trackCount", 0),
    }
    print(json.dumps(summary, indent=2))

    if failed and updated == 0:
        raise SystemExit("All album refreshes failed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
