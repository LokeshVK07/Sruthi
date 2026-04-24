#!/usr/bin/env python3

import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PLAYLIST_SEED_PATH = ROOT / "tools" / "playlist_seeds.json"
CURRENT_YEAR = datetime.now(timezone.utc).year

PLAYLIST_TABLE_SQL = """
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
);

CREATE TABLE IF NOT EXISTS playlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  song_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(playlist_id, song_id),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist_id ON playlist_items(playlist_id);
CREATE INDEX IF NOT EXISTS idx_playlist_items_song_id ON playlist_items(song_id);
"""

COMPOSER_ALIAS_MAP = {
    "a r rahman": {"a r rahman", "ar rahman", "a r r rahman", "arr rahman", "rahman"},
    "anirudh ravichander": {"anirudh ravichander", "anirudh"},
    "harris jayaraj": {"harris jayaraj", "harris"},
    "ilaiyaraaja": {"ilaiyaraaja", "ilaiyaraja", "raaja"},
    "yuvan shankar raja": {"yuvan shankar raja", "yuvan"},
}

NOISE_TOKENS = {
    "en",
    "in",
    "the",
    "a",
    "an",
    "of",
    "and",
    "bit",
    "theme",
    "song",
    "hits",
    "tamil",
}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def clean_text(value):
    return " ".join(str(value or "").split()).strip()


def slugify(value):
    slug = re.sub(r"[^a-z0-9]+", "-", clean_text(value).lower()).strip("-")
    return slug or "playlist"


def collapse_repeated_vowels(value):
    return re.sub(r"([aeiou])\1+", r"\1", value)


def canonicalize_token(token):
    token = clean_text(token).lower()
    token = re.sub(r"[^a-z0-9]", "", token)
    token = collapse_repeated_vowels(token)
    return token


def normalize_song_title(value):
    tokens = title_tokens(value, include_noise=True)
    return " ".join(tokens)


def compact_normalized_title(value):
    return normalize_song_title(value).replace(" ", "")


def title_tokens(value, include_noise=False):
    text = clean_text(value).lower()
    text = text.replace("&", " and ")
    text = re.sub(r"[’'`]", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    raw_tokens = [canonicalize_token(token) for token in text.split()]
    tokens = [token for token in raw_tokens if token]
    if include_noise:
        return tokens
    return [token for token in tokens if token not in NOISE_TOKENS]


def normalize_name_tokens(value):
    tokens = title_tokens(value)
    compact = "".join(tokens)
    values = set(tokens)
    if compact:
        values.add(compact)
    return values


def timestamp_or_default(value):
    text = clean_text(value)
    return text or utc_now()


def ensure_playlist_tables(connection):
    connection.executescript(PLAYLIST_TABLE_SQL)


def load_playlist_seeds():
    return json.loads(PLAYLIST_SEED_PATH.read_text(encoding="utf-8"))


def parse_year_window(playlist_name):
    text = clean_text(playlist_name)
    present_match = re.search(r"(19|20)\d{2}\s*-\s*present", text, re.IGNORECASE)
    if present_match:
        start = int(present_match.group(0)[:4])
        return (start, CURRENT_YEAR)
    range_match = re.search(r"((?:19|20)\d{2})\s*-\s*((?:19|20)\d{2})", text)
    if not range_match:
        return None
    start = int(range_match.group(1))
    end = int(range_match.group(2))
    return (min(start, end), max(start, end))


def playlist_primary_identity(seed):
    title = clean_text(seed.get("name"))
    if seed.get("category") == "actor":
        return re.sub(r"\s+hits$", "", title, flags=re.IGNORECASE)
    if seed.get("category") == "music_director":
        return re.sub(r"\s+hits$", "", title, flags=re.IGNORECASE)
    if seed.get("category") == "mood":
        return re.sub(r"^Tamil\s+", "", re.sub(r"\s+Songs?$", "", title, flags=re.IGNORECASE), flags=re.IGNORECASE)
    return ""


def composer_aliases_for_seed(seed):
    if clean_text(seed.get("category")) != "music_director":
        return set()
    identity = normalize_song_title(playlist_primary_identity(seed))
    aliases = set(COMPOSER_ALIAS_MAP.get(identity, set()))
    raw_identity = clean_text(playlist_primary_identity(seed))
    if raw_identity:
        aliases.add(raw_identity)
        aliases.add(raw_identity.replace(".", " "))
        aliases.add(raw_identity.replace(".", ""))
    normalized_aliases = set()
    for alias in aliases:
        alias_norm = normalize_song_title(alias)
        alias_compact = compact_normalized_title(alias)
        if alias_norm:
            normalized_aliases.add(alias_norm)
        if alias_compact:
            normalized_aliases.add(alias_compact)
    return {alias for alias in normalized_aliases if alias}


def playlist_tags(seed, year_window):
    tags = {
        "seed-category": clean_text(seed.get("category")),
    }
    identity = clean_text(playlist_primary_identity(seed))
    if identity:
        tags["seed-identity"] = identity
    if year_window:
        tags["year-range"] = f"{year_window[0]}-{year_window[1]}"
    composer_aliases = sorted(composer_aliases_for_seed(seed))
    if composer_aliases:
        tags["composer-aliases"] = composer_aliases
    return json.dumps(tags, ensure_ascii=False, sort_keys=True)


def fetch_song_catalog(connection):
    rows = connection.execute(
        """
        SELECT
          s.id,
          s.title,
          s.movie,
          s.artist,
          s.singers,
          s.composer,
          s.year,
          s.mood,
          s.image_url,
          s.updated_at,
          s.album_url,
          COALESCE(a.starring, '') AS starring,
          COALESCE(a.music_director, '') AS album_music_director
        FROM songs s
        LEFT JOIN albums a ON a.url = s.album_url
        ORDER BY s.year DESC, lower(s.movie) ASC, lower(s.title) ASC, s.id ASC
        """
    ).fetchall()
    songs = []
    for row in rows:
        song = dict(row)
        song["title_norm"] = normalize_song_title(song.get("title"))
        song["title_compact"] = compact_normalized_title(song.get("title"))
        song["title_tokens"] = tuple(title_tokens(song.get("title")))
        song["movie_norm"] = normalize_song_title(song.get("movie"))
        song["movie_compact"] = compact_normalized_title(song.get("movie"))
        song["composer_source"] = clean_text(song.get("composer") or song.get("album_music_director"))
        song["composer_norm"] = normalize_song_title(song.get("composer_source"))
        song["composer_compact"] = compact_normalized_title(song.get("composer_source"))
        song["artist_norm"] = normalize_song_title(song.get("artist") or song.get("singers"))
        song["starring_norm"] = normalize_song_title(song.get("starring"))
        song["mood_norm"] = normalize_song_title(song.get("mood"))
        songs.append(song)
    return songs


def build_song_indexes(all_songs):
    exact_title_index = defaultdict(list)
    token_index = defaultdict(list)
    for song in all_songs:
        title_compact = clean_text(song.get("title_compact"))
        if title_compact:
            exact_title_index[title_compact].append(song)
        for token in set(song.get("title_tokens") or ()):
            token_index[token].append(song)
    return {
        "exact_title_index": exact_title_index,
        "token_index": token_index,
    }


def playlist_seed_context(seed):
    return {
        "category": clean_text(seed.get("category")),
        "year_window": parse_year_window(seed.get("name")),
        "actor_tokens": normalize_name_tokens(playlist_primary_identity(seed)) if clean_text(seed.get("category")) == "actor" else set(),
        "composer_aliases": composer_aliases_for_seed(seed),
        "prefer_newer": clean_text(seed.get("category")) == "era",
    }


def safe_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def composer_match_state(song, composer_aliases):
    if not composer_aliases:
        return "not_applicable"
    composer_norm = clean_text(song.get("composer_norm"))
    composer_compact = clean_text(song.get("composer_compact"))
    if not composer_norm and not composer_compact:
        return "missing"
    for alias in composer_aliases:
        alias_text = clean_text(alias)
        alias_compact = alias_text.replace(" ", "")
        if alias_text and (alias_text in composer_norm or composer_norm in alias_text):
            return "match"
        if alias_compact and (alias_compact in composer_compact or composer_compact in alias_compact):
            return "match"
    return "mismatch"


def title_match_details(seed_title, song):
    seed_norm = normalize_song_title(seed_title)
    seed_compact = compact_normalized_title(seed_title)
    seed_tokens = tuple(title_tokens(seed_title))
    song_norm = clean_text(song.get("title_norm"))
    song_compact = clean_text(song.get("title_compact"))
    song_tokens = tuple(song.get("title_tokens") or ())
    if not seed_compact or not song_compact:
        return None

    if seed_compact == song_compact:
        return {"tier": 1, "score": 1.0}

    if seed_norm and song_norm and f" {seed_norm} " in f" {song_norm} ":
        return {"tier": 2, "score": len(seed_compact) / max(len(song_compact), 1)}

    if seed_compact and song_compact.startswith(seed_compact):
        return {"tier": 2, "score": len(seed_compact) / max(len(song_compact), 1)}

    if seed_norm and song_norm and f" {song_norm} " in f" {seed_norm} " and len(song_tokens) >= 2:
        return {"tier": 3, "score": len(song_compact) / max(len(seed_compact), 1)}

    if seed_compact and song_compact and seed_compact.startswith(song_compact) and len(song_tokens) >= 2:
        return {"tier": 3, "score": len(song_compact) / max(len(seed_compact), 1)}

    seed_token_set = set(seed_tokens)
    song_token_set = set(song_tokens)
    common_tokens = seed_token_set & song_token_set
    if len(seed_token_set) >= 2 and len(common_tokens) >= 2:
        token_score = len(common_tokens) / max(len(seed_token_set), len(song_token_set), 1)
        ratio = SequenceMatcher(None, seed_compact, song_compact).ratio()
        if token_score >= 0.66 and ratio >= 0.72:
            return {"tier": 4, "score": max(token_score, ratio)}

    if len(seed_token_set) >= 2:
        ratio = SequenceMatcher(None, seed_compact, song_compact).ratio()
        if ratio >= 0.9 and len(seed_compact) >= 10:
            return {"tier": 5, "score": ratio}

    return None


def movie_matches(seed_movie, song):
    seed_norm = normalize_song_title(seed_movie)
    seed_compact = compact_normalized_title(seed_movie)
    if not seed_compact:
        return True
    movie_norm = clean_text(song.get("movie_norm"))
    movie_compact = clean_text(song.get("movie_compact"))
    if seed_compact == movie_compact:
        return True
    if seed_norm and movie_norm and (seed_norm in movie_norm or movie_norm in seed_norm):
        return True
    return False


def candidate_rank(song, match, context, composer_state):
    year = safe_int(song.get("year"))
    year_window = context.get("year_window")
    actor_tokens = context.get("actor_tokens") or set()
    rank = [
        -int(match["tier"] == 1),
        -int(match["tier"] == 2),
        -int(match["tier"] == 3),
        -int(match["tier"] == 4),
        -int(match["tier"] == 5),
        -int(composer_state == "match"),
        -int(composer_state == "missing"),
        -int(bool(year_window) and year_window[0] <= year <= year_window[1]),
        -int(bool(actor_tokens) and any(token and token in clean_text(song.get("starring_norm")) for token in actor_tokens)),
        -int(round(match["score"] * 1000)),
    ]
    if context.get("prefer_newer"):
        rank.append(-year)
    return tuple(rank + [clean_text(song.get("title")).lower(), clean_text(song.get("movie")).lower(), clean_text(song.get("id"))])


def candidate_songs_for_seed(seed_title, song_indexes):
    seed_compact = compact_normalized_title(seed_title)
    seed_tokens = tuple(title_tokens(seed_title))
    candidate_map = {}
    token_songs = {}

    for song in song_indexes["exact_title_index"].get(seed_compact, []):
        candidate_map[clean_text(song.get("id"))] = song

    token_counts = Counter()
    for token in seed_tokens:
        for song in song_indexes["token_index"].get(token, []):
            song_id = clean_text(song.get("id"))
            token_counts[song_id] += 1
            token_songs[song_id] = song

    min_shared_tokens = 2 if len(seed_tokens) >= 2 else 1
    for song_id, shared in token_counts.items():
        song = candidate_map.get(song_id) or token_songs.get(song_id)
        if song is None:
            continue
        if shared >= min_shared_tokens or seed_compact in clean_text(song.get("title_compact")) or clean_text(song.get("title_compact")).startswith(seed_compact):
            candidate_map[song_id] = song

    return list(candidate_map.values())


def resolve_seed_song(seed, seed_title, seed_movie, all_songs, song_indexes, log_warning=None):
    context = playlist_seed_context(seed)
    matching_candidates = []
    composer_mismatch_count = 0
    best_mismatch = None

    for song in candidate_songs_for_seed(seed_title, song_indexes):
        match = title_match_details(seed_title, song)
        if not match:
            continue
        if not movie_matches(seed_movie, song):
            continue
        composer_state = composer_match_state(song, context["composer_aliases"])
        if composer_state == "mismatch":
            composer_mismatch_count += 1
            mismatch_rank = candidate_rank(song, match, context, composer_state)
            if best_mismatch is None or mismatch_rank < best_mismatch[0]:
                best_mismatch = (mismatch_rank, song)
            continue
        matching_candidates.append((candidate_rank(song, match, context, composer_state), song, composer_state))

    if not matching_candidates:
        if composer_mismatch_count:
            if best_mismatch and log_warning:
                log_warning(
                    f'console.warn("[Playlist Seed] Composer mismatch:", "{clean_text(seed.get("name"))}", "{clean_text(seed_title)}", "{clean_text(best_mismatch[1].get("title"))}", "{clean_text(best_mismatch[1].get("composer_source"))}")'
                )
            return None, "composer_mismatch", composer_mismatch_count
        return None, "missing", 0

    matching_candidates.sort()
    best_rank, best_song, composer_state = matching_candidates[0]
    equally_ranked = [item for item in matching_candidates if item[0] == best_rank]
    if len(equally_ranked) > 1:
        return None, "ambiguous", composer_mismatch_count

    if composer_state == "missing" and context["composer_aliases"] and log_warning:
        log_warning(
            f'console.warn("[Playlist Seed] Composer missing, matched by title only:", "{clean_text(seed.get("name"))}", "{clean_text(seed_title)}", "{clean_text(best_song.get("title"))}")'
        )
    return best_song, "matched", composer_mismatch_count


def collect_profile(seed, matched_songs):
    year_window = parse_year_window(seed.get("name"))
    actor_tokens = set()
    composer_tokens = set()
    mood_tokens = set()

    identity = playlist_primary_identity(seed)
    if seed.get("category") == "actor":
        actor_tokens |= normalize_name_tokens(identity)
    elif seed.get("category") == "music_director":
        composer_tokens |= composer_aliases_for_seed(seed)
    elif seed.get("category") == "mood":
        mood_tokens |= normalize_name_tokens(identity)

    composer_counts = Counter()
    starring_counts = Counter()
    year_counts = Counter()
    mood_counts = Counter()
    for song in matched_songs:
        if clean_text(song.get("composer_source")):
            composer_counts[song["composer_norm"]] += 1
        if clean_text(song.get("starring")):
            starring_counts[song["starring_norm"]] += 1
        if clean_text(song.get("mood")) and clean_text(song.get("mood")).lower() != "imported":
            mood_counts[song["mood_norm"]] += 1
        if safe_int(song.get("year")):
            year_counts[safe_int(song["year"])] += 1

    for token, count in composer_counts.most_common(4):
        if token and count > 0:
            composer_tokens.add(token)
    for token, count in starring_counts.most_common(4):
        if token and count > 0:
            actor_tokens.add(token)
    for token, count in mood_counts.most_common(3):
        if token and count > 0:
            mood_tokens.add(token)

    if not year_window and year_counts:
        years = sorted(year_counts)
        year_window = (years[0], years[-1])

    return {
        "year_window": year_window,
        "actor_tokens": actor_tokens,
        "composer_tokens": composer_tokens,
        "mood_tokens": mood_tokens,
    }


def score_candidate(song, profile):
    score = 0

    if profile["year_window"]:
        start, end = profile["year_window"]
        song_year = safe_int(song.get("year"))
        if start <= song_year <= end:
            score += 40

    if profile["actor_tokens"] and song.get("starring_norm"):
        if any(token and token in song["starring_norm"] for token in profile["actor_tokens"]):
            score += 60

    if profile["composer_tokens"]:
        composer_fields = {clean_text(song.get("composer_norm")), normalize_song_title(song.get("album_music_director"))}
        if any(token and any(token in field for field in composer_fields if field) for token in profile["composer_tokens"]):
            score += 55

    if profile["mood_tokens"] and song.get("mood_norm"):
        if any(token and token in song["mood_norm"] for token in profile["mood_tokens"]):
            score += 20

    return score


def autofill_songs(seed, matched_songs, all_songs, existing_ids):
    profile = collect_profile(seed, matched_songs)
    ranked = []
    for song in all_songs:
        song_id = clean_text(song.get("id"))
        if not song_id or song_id in existing_ids:
            continue
        score = score_candidate(song, profile)
        if score <= 0:
            continue
        ranked.append((score, -safe_int(song.get("year")), clean_text(song.get("title")).lower(), song_id, song))

    ranked.sort()
    ranked.reverse()

    additions = []
    for _, _, _, song_id, song in ranked:
        if song_id in existing_ids:
            continue
        additions.append(song)
        existing_ids.add(song_id)
        if len(existing_ids) >= 100:
            break
    return additions


def playlist_db_row(connection, playlist_id):
    return connection.execute(
        """
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
        WHERE p.id = ?
        GROUP BY
          p.id, p.name, p.slug, p.description, p.category, p.cover_url,
          p.tags, p.is_featured, p.created_at, p.updated_at
        """,
        (playlist_id,),
    ).fetchone()


def upsert_playlist(connection, seed, song_ids, cover_url, tags_json):
    slug = slugify(seed.get("name"))
    now = utc_now()
    existing = connection.execute(
        "SELECT id FROM playlists WHERE slug = ?",
        (slug,),
    ).fetchone()
    if existing:
        playlist_id = int(existing["id"])
        connection.execute(
            """
            UPDATE playlists
            SET name = ?, description = ?, category = ?, cover_url = ?, tags = ?, is_featured = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                clean_text(seed.get("name")),
                clean_text(seed.get("description")),
                clean_text(seed.get("category")),
                clean_text(cover_url),
                tags_json,
                1,
                now,
                playlist_id,
            ),
        )
        created = False
    else:
        cursor = connection.execute(
            """
            INSERT INTO playlists (
              name, slug, description, category, cover_url, tags, is_featured, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                clean_text(seed.get("name")),
                slug,
                clean_text(seed.get("description")),
                clean_text(seed.get("category")),
                clean_text(cover_url),
                tags_json,
                1,
                now,
                now,
            ),
        )
        playlist_id = int(cursor.lastrowid)
        created = True

    previous_count = safe_int(
        connection.execute("SELECT COUNT(*) FROM playlist_items WHERE playlist_id = ?", (playlist_id,)).fetchone()[0]
    )
    existing_song_ids = {
        clean_text(row["song_id"])
        for row in connection.execute("SELECT song_id FROM playlist_items WHERE playlist_id = ?", (playlist_id,)).fetchall()
        if clean_text(row["song_id"])
    }
    inserted_count = 0
    remaining_new_slots = max(0, 100 - previous_count)
    for position, song_id in enumerate(song_ids, start=1):
        if song_id not in existing_song_ids and remaining_new_slots <= 0:
            continue
        if song_id not in existing_song_ids:
            inserted_count += 1
            remaining_new_slots -= 1
        connection.execute(
            """
            INSERT INTO playlist_items (playlist_id, song_id, position, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(playlist_id, song_id) DO UPDATE SET
              position = excluded.position
            """,
            (playlist_id, song_id, position, now),
        )

    final_count = safe_int(
        connection.execute("SELECT COUNT(*) FROM playlist_items WHERE playlist_id = ?", (playlist_id,)).fetchone()[0]
    )
    return {
        "playlist_id": playlist_id,
        "slug": slug,
        "created": created,
        "previous_count": previous_count,
        "final_count": final_count,
        "inserted_items": inserted_count,
    }


def build_seed_summary():
    return {
        "created": 0,
        "updated": 0,
        "playlistCount": 0,
        "playlistItemsInserted": 0,
        "missingSongCount": 0,
        "ambiguousSongCount": 0,
        "composerMismatchCount": 0,
        "removedWrongMappings": 0,
        "playlists": [],
        "missingSongs": {},
    }


def seed_playlists(connection, log_warning=None):
    ensure_playlist_tables(connection)
    all_songs = fetch_song_catalog(connection)
    song_indexes = build_song_indexes(all_songs)
    seeds = load_playlist_seeds()

    summary = build_seed_summary()

    for seed in seeds:
        playlist_name = clean_text(seed.get("name"))
        matched_songs = []
        matched_ids = set()
        missing_titles = []
        ambiguous_titles = []
        composer_mismatch_count = 0

        for item in seed.get("songs", []):
            if isinstance(item, dict):
                seed_title = clean_text(item.get("title"))
                seed_movie = clean_text(item.get("movie"))
            else:
                seed_title = clean_text(item)
                seed_movie = ""
            if not seed_title:
                continue

            song, status, mismatch_count = resolve_seed_song(
                seed,
                seed_title,
                seed_movie,
                all_songs,
                song_indexes,
                log_warning=log_warning,
            )
            composer_mismatch_count += mismatch_count
            if song is None:
                if status == "ambiguous":
                    ambiguous_titles.append(seed_title)
                    if log_warning:
                        log_warning(f'console.warn("[Playlist Seed] Missing or ambiguous song:", "{playlist_name}", "{seed_title}")')
                elif status == "composer_mismatch":
                    if log_warning:
                        log_warning(f'console.warn("[Playlist Seed] Missing song:", "{playlist_name}", "{seed_title}")')
                    missing_titles.append(seed_title)
                else:
                    missing_titles.append(seed_title)
                    if log_warning:
                        log_warning(f'console.warn("[Playlist Seed] Missing song:", "{playlist_name}", "{seed_title}")')
                continue

            song_id = clean_text(song.get("id"))
            if not song_id or song_id in matched_ids:
                continue
            matched_songs.append(song)
            matched_ids.add(song_id)

        if len(matched_songs) < 70:
            for song in autofill_songs(seed, matched_songs, all_songs, matched_ids):
                matched_songs.append(song)
                if len(matched_songs) >= 100:
                    break

        matched_songs = matched_songs[:100]
        song_ids = [clean_text(song.get("id")) for song in matched_songs if clean_text(song.get("id"))]
        year_window = parse_year_window(seed.get("name"))
        tags_json = playlist_tags(seed, year_window)
        cover_url = clean_text(matched_songs[0].get("image_url")) if matched_songs else ""

        result = upsert_playlist(connection, seed, song_ids, cover_url, tags_json)
        summary["created"] += 1 if result["created"] else 0
        summary["updated"] += 0 if result["created"] else 1
        summary["playlistCount"] += 1
        summary["playlistItemsInserted"] += result["inserted_items"]
        summary["missingSongCount"] += len(missing_titles)
        summary["ambiguousSongCount"] += len(ambiguous_titles)
        summary["composerMismatchCount"] += composer_mismatch_count
        summary["missingSongs"][playlist_name] = missing_titles
        summary["playlists"].append(
            {
                "id": result["slug"],
                "name": playlist_name,
                "previousSongCount": result["previous_count"],
                "finalSongCount": result["final_count"],
                "newlyInsertedCount": result["inserted_items"],
                "skippedMissingCount": len(missing_titles),
                "skippedAmbiguousCount": len(ambiguous_titles),
                "composerMismatchCount": composer_mismatch_count,
                "removedWrongMappingsCount": 0,
                "missingTitles": missing_titles,
                "ambiguousTitles": ambiguous_titles,
            }
        )

    connection.commit()
    return summary


def repair_music_director_playlist_mappings(connection, log_warning=None):
    ensure_playlist_tables(connection)
    rows = connection.execute(
        """
        SELECT
          p.id AS playlist_id,
          p.name AS playlist_name,
          p.slug AS playlist_slug,
          p.category AS playlist_category,
          pi.song_id AS song_id,
          s.title AS song_title,
          COALESCE(s.composer, '') AS song_composer,
          COALESCE(a.music_director, '') AS album_music_director
        FROM playlists p
        JOIN playlist_items pi ON pi.playlist_id = p.id
        JOIN songs s ON s.id = pi.song_id
        LEFT JOIN albums a ON a.url = s.album_url
        WHERE lower(p.category) = 'music_director'
        ORDER BY lower(p.name), pi.position, s.title
        """
    ).fetchall()

    grouped = {}
    for row in rows:
        grouped.setdefault(int(row["playlist_id"]), []).append(dict(row))

    summary = build_seed_summary()
    summary["playlistCount"] = len(grouped)

    for playlist_id, items in grouped.items():
        playlist_name = clean_text(items[0].get("playlist_name"))
        playlist_slug = clean_text(items[0].get("playlist_slug"))
        seed_stub = {"name": playlist_name, "category": "music_director"}
        aliases = composer_aliases_for_seed(seed_stub)
        previous_count = len(items)
        removed = 0

        for item in items:
            composer_source = clean_text(item.get("song_composer") or item.get("album_music_director"))
            if not composer_source:
                continue
            composer_norm = normalize_song_title(composer_source)
            composer_compact = composer_norm.replace(" ", "")
            matched = False
            for alias in aliases:
                alias_norm = clean_text(alias)
                alias_compact = alias_norm.replace(" ", "")
                if alias_norm and (alias_norm in composer_norm or composer_norm in alias_norm):
                    matched = True
                    break
                if alias_compact and (alias_compact in composer_compact or composer_compact in alias_compact):
                    matched = True
                    break
            if matched:
                continue
            connection.execute(
                "DELETE FROM playlist_items WHERE playlist_id = ? AND song_id = ?",
                (playlist_id, clean_text(item.get("song_id"))),
            )
            removed += 1
            if log_warning:
                log_warning(
                    f'console.warn("[Playlist Seed] Composer mismatch:", "{playlist_name}", "{clean_text(item.get("song_title"))}", "{clean_text(item.get("song_title"))}", "{composer_source}")'
                )

        final_count = safe_int(
            connection.execute("SELECT COUNT(*) FROM playlist_items WHERE playlist_id = ?", (playlist_id,)).fetchone()[0]
        )
        summary["removedWrongMappings"] += removed
        summary["playlists"].append(
            {
                "id": playlist_slug,
                "name": playlist_name,
                "previousSongCount": previous_count,
                "finalSongCount": final_count,
                "newlyInsertedCount": 0,
                "skippedMissingCount": 0,
                "skippedAmbiguousCount": 0,
                "composerMismatchCount": removed,
                "removedWrongMappingsCount": removed,
                "missingTitles": [],
                "ambiguousTitles": [],
            }
        )

    connection.commit()
    return summary


def list_playlists(connection, include_song_ids=False):
    rows = connection.execute(
        """
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
        ORDER BY lower(p.category) ASC, lower(p.name) ASC
        """
    ).fetchall()
    playlists = []
    for row in rows:
        payload = {
            "dbId": int(row["id"]),
            "id": clean_text(row["slug"]),
            "name": clean_text(row["name"]),
            "description": clean_text(row["description"]),
            "category": clean_text(row["category"]),
            "coverUrl": clean_text(row["cover_url"]),
            "tags": clean_text(row["tags"]),
            "isFeatured": int(row["is_featured"] or 0),
            "createdAt": clean_text(row["created_at"]),
            "updatedAt": clean_text(row["updated_at"]),
            "songCount": int(row["song_count"] or 0),
        }
        if include_song_ids:
            payload["songIds"] = playlist_song_ids(connection, payload["id"])
        playlists.append(payload)
    return playlists


def playlist_song_ids(connection, playlist_slug):
    rows = connection.execute(
        """
        SELECT pi.song_id
        FROM playlist_items pi
        JOIN playlists p ON p.id = pi.playlist_id
        WHERE p.slug = ?
        ORDER BY pi.position ASC, pi.song_id ASC
        """,
        (clean_text(playlist_slug),),
    ).fetchall()
    return [clean_text(row["song_id"]) for row in rows if clean_text(row["song_id"])]


def load_playlist(connection, playlist_slug):
    row = connection.execute(
        """
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
        """,
        (clean_text(playlist_slug),),
    ).fetchone()
    if not row:
        return None
    song_ids = playlist_song_ids(connection, playlist_slug)
    return {
        "dbId": int(row["id"]),
        "id": clean_text(row["slug"]),
        "name": clean_text(row["name"]),
        "description": clean_text(row["description"]),
        "category": clean_text(row["category"]),
        "coverUrl": clean_text(row["cover_url"]),
        "tags": clean_text(row["tags"]),
        "isFeatured": int(row["is_featured"] or 0),
        "createdAt": clean_text(row["created_at"]),
        "updatedAt": clean_text(row["updated_at"]),
        "songIds": song_ids,
        "songCount": len(song_ids),
    }
