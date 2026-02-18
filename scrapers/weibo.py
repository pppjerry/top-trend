import time
import logging
from urllib.parse import quote

import requests

from .base import BaseScraper

logger = logging.getLogger(__name__)

WEIBO_HOT_SEARCH_URL = "https://weibo.com/ajax/side/hotSearch"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://weibo.com/",
}

MAX_RETRIES = 3
RETRY_DELAY = 5  # seconds


class WeiboScraper(BaseScraper):
    """微博热搜抓取器"""

    @property
    def name(self) -> str:
        return "weibo"

    @property
    def display_name(self) -> str:
        return "微博热搜"

    def fetch(self) -> list[dict]:
        """抓取微博热搜榜单数据，失败自动重试。"""
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                return self._do_fetch()
            except Exception as e:
                logger.warning(
                    "Weibo fetch attempt %d/%d failed: %s",
                    attempt, MAX_RETRIES, e,
                )
                if attempt < MAX_RETRIES:
                    time.sleep(RETRY_DELAY)

        logger.error("Weibo fetch failed after %d attempts", MAX_RETRIES)
        return []

    def _do_fetch(self) -> list[dict]:
        resp = requests.get(
            WEIBO_HOT_SEARCH_URL,
            headers=HEADERS,
            timeout=15,
        )
        resp.raise_for_status()

        data = resp.json()
        realtime = data.get("data", {}).get("realtime", [])

        items = []
        for idx, entry in enumerate(realtime):
            title = (entry.get("word") or entry.get("note") or "").strip()
            encoded_title = quote(title)
            item = {
                "rank": idx + 1,
                "title": title,
                "hotValue": entry.get("num", 0),
                "url": f"https://s.weibo.com/weibo?q=%23{encoded_title}%23" if title else "",
            }
            label_name = entry.get("label_name")
            if label_name:
                item["category"] = label_name

            items.append(item)

        logger.info("Weibo: fetched %d items", len(items))
        return items
