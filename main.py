import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from collections import defaultdict

from scrapers import ALL_SCRAPERS

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
logger = logging.getLogger("toptrend")

UTC8 = timezone(timedelta(hours=8))
DATA_DIR = Path("data")
RAW_DIR = DATA_DIR / "raw"
INDEX_FILE = DATA_DIR / "index.json"
STATUS_FILE = DATA_DIR / "status.json"
DERIVED_DIR = DATA_DIR / "derived"


def now_iso() -> str:
    return datetime.now(UTC8).isoformat(timespec="seconds")


def today_str() -> str:
    return datetime.now(UTC8).strftime("%Y-%m-%d")


def ensure_json(path: Path, default: dict) -> dict:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        logger.warning("Invalid JSON found in %s, fallback to default", path)
        return default


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def append_snapshot(scraper_name: str, snapshot: dict) -> None:
    day = today_str()
    day_file = RAW_DIR / scraper_name / f"{day}.json"
    payload = ensure_json(
        day_file,
        {
            "source": scraper_name,
            "date": day,
            "snapshots": [],
        },
    )
    payload.setdefault("snapshots", []).append(snapshot)
    write_json(day_file, payload)


def update_index(source: str) -> None:
    data = ensure_json(
        INDEX_FILE,
        {
            "sources": [],
            "dates": {},
            "lastUpdated": "",
        },
    )
    if source not in data["sources"]:
        data["sources"].append(source)
        data["sources"].sort()

    source_dir = RAW_DIR / source
    source_dir.mkdir(parents=True, exist_ok=True)
    dates = sorted(
        [p.stem for p in source_dir.glob("*.json")],
        reverse=True,
    )
    data["dates"][source] = dates
    data["lastUpdated"] = now_iso()
    write_json(INDEX_FILE, data)


def update_status(
    ok: bool,
    message: str,
    source_results: list[dict],
    last_success_at: str = "",
) -> None:
    existing = ensure_json(
        STATUS_FILE,
        {
            "ok": False,
            "lastRunAt": "",
            "lastSuccessAt": "",
            "message": "",
            "sourceResults": [],
        },
    )
    payload = {
        "ok": ok,
        "lastRunAt": now_iso(),
        "lastSuccessAt": last_success_at or existing.get("lastSuccessAt", ""),
        "message": message,
        "sourceResults": source_results,
    }
    write_json(STATUS_FILE, payload)


def _parse_iso(iso_text: str | None) -> datetime | None:
    if not iso_text:
        return None
    try:
        return datetime.fromisoformat(iso_text)
    except ValueError:
        return None


def _load_snapshots_for_source(source: str) -> list[dict]:
    source_dir = RAW_DIR / source
    if not source_dir.exists():
        return []

    day_files = sorted(source_dir.glob("*.json"))
    snapshots: list[dict] = []
    for day_file in day_files:
        payload = ensure_json(day_file, {"snapshots": []})
        for snapshot in payload.get("snapshots", []):
            if snapshot.get("timestamp"):
                snapshots.append(snapshot)

    snapshots.sort(
        key=lambda s: _parse_iso(s.get("timestamp")) or datetime.min.replace(tzinfo=UTC8)
    )
    return snapshots


def build_item_library(source: str) -> None:
    snapshots = _load_snapshots_for_source(source)
    out_file = DERIVED_DIR / source / "items.json"

    if not snapshots:
        write_json(
            out_file,
            {
                "source": source,
                "generatedAt": now_iso(),
                "totalItems": 0,
                "items": [],
            },
        )
        return

    info_by_title: dict[str, dict] = {}
    active_start: dict[str, datetime] = {}
    duration_seconds: dict[str, float] = defaultdict(float)

    prev_seen: set[str] = set()
    prev_ts: datetime | None = None

    for snapshot in snapshots:
        ts = _parse_iso(snapshot.get("timestamp"))
        if ts is None:
            continue

        items = snapshot.get("items", [])
        current_seen = {item.get("title", "").strip() for item in items if item.get("title")}
        current_seen.discard("")

        current_map = {item.get("title", "").strip(): item for item in items if item.get("title")}

        for title in current_seen:
            row = info_by_title.get(title)
            if row is None:
                row = {
                    "title": title,
                    "firstSeenAt": snapshot["timestamp"],
                    "lastSeenAt": snapshot["timestamp"],
                    "peakRank": current_map[title].get("rank"),
                    "appearanceCount": 0,
                    "comebackCount": 0,
                }
                info_by_title[title] = row
            elif title not in prev_seen:
                row["comebackCount"] += 1

            row["lastSeenAt"] = snapshot["timestamp"]
            row["appearanceCount"] += 1

            rank = current_map[title].get("rank")
            if isinstance(rank, int):
                if row["peakRank"] is None:
                    row["peakRank"] = rank
                else:
                    row["peakRank"] = min(row["peakRank"], rank)

            if title not in prev_seen:
                active_start[title] = ts

        for title in (prev_seen - current_seen):
            start = active_start.pop(title, None)
            if start is not None and prev_ts is not None:
                duration_seconds[title] += max(0, (prev_ts - start).total_seconds())

        prev_seen = current_seen
        prev_ts = ts

    if prev_ts is not None:
        for title, start in active_start.items():
            duration_seconds[title] += max(0, (prev_ts - start).total_seconds())

    latest_items = snapshots[-1].get("items", [])
    latest_map = {item.get("title", "").strip(): item for item in latest_items if item.get("title")}
    latest_seen = set(latest_map.keys())

    result_items = []
    for title, row in info_by_title.items():
        latest_item = latest_map.get(title, {})
        result_items.append(
            {
                "title": title,
                "status": "on_list" if title in latest_seen else "off_list",
                "firstSeenAt": row["firstSeenAt"],
                "lastSeenAt": row["lastSeenAt"],
                "peakRank": row["peakRank"],
                "appearanceCount": row["appearanceCount"],
                "comebackCount": row["comebackCount"],
                "onListDurationMinutes": int(round(duration_seconds.get(title, 0) / 60)),
                "currentRank": latest_item.get("rank") if title in latest_seen else None,
                "currentHotValue": latest_item.get("hotValue") if title in latest_seen else None,
            }
        )

    result_items.sort(
        key=lambda x: _parse_iso(x.get("lastSeenAt")) or datetime.min.replace(tzinfo=UTC8),
        reverse=True,
    )

    write_json(
        out_file,
        {
            "source": source,
            "generatedAt": now_iso(),
            "totalItems": len(result_items),
            "items": result_items,
        },
    )


def run() -> None:
    total = 0
    success_sources = 0
    source_results: list[dict] = []
    for scraper in ALL_SCRAPERS:
        logger.info("Start scraping %s", scraper.name)
        try:
            items = scraper.fetch()
        except Exception:
            logger.exception("Unhandled error in scraper %s", scraper.name)
            source_results.append(
                {
                    "source": scraper.name,
                    "ok": False,
                    "count": 0,
                    "error": "Unhandled exception in scraper.fetch()",
                }
            )
            continue

        if not items:
            logger.warning("No items fetched for %s", scraper.name)
            source_results.append(
                {
                    "source": scraper.name,
                    "ok": False,
                    "count": 0,
                    "error": "No items fetched",
                }
            )
            continue

        snapshot = {
            "timestamp": now_iso(),
            "items": items,
        }
        append_snapshot(scraper.name, snapshot)
        update_index(scraper.name)
        build_item_library(scraper.name)
        total += len(items)
        success_sources += 1
        source_results.append(
            {
                "source": scraper.name,
                "ok": True,
                "count": len(items),
                "error": "",
            }
        )
        logger.info("Saved %d items for %s", len(items), scraper.name)

    # Always refresh derived files for known sources so the library tab
    # can still work even when a particular scrape run has partial failures.
    index_data = ensure_json(INDEX_FILE, {"sources": []})
    for source in index_data.get("sources", []):
        try:
            build_item_library(source)
        except Exception:
            logger.exception("Failed to build item library for source %s", source)

    all_ok = success_sources == len(ALL_SCRAPERS) and len(ALL_SCRAPERS) > 0
    if all_ok:
        update_status(
            ok=True,
            message=f"All sources succeeded. Total items: {total}",
            source_results=source_results,
            last_success_at=now_iso(),
        )
    else:
        update_status(
            ok=False,
            message=f"Some sources failed. Total items: {total}",
            source_results=source_results,
        )

    logger.info("Done. Total items saved: %d", total)


if __name__ == "__main__":
    run()
