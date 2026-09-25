#!/usr/bin/env python3
"""
玉山銀行「外幣匯率」牌告爬蟲。

牌告表和債券報價表一樣是伺服器端直接寫在 HTML 裡，requests + BeautifulSoup 就夠。
每個幣別一列 <tr class="USD currency">，四個報價各有自己的 class：

    BBoardRate     / SBoardRate       即期買入 / 即期賣出
    CashBBoardRate / CashSBoardRate   現金買入 / 現金賣出

（「網銀/App 優惠」欄是加減碼、不是匯率，所以不收。）

產出：
  docs/data/fx.json   前端換匯匯率的預設值
  data/fx_latest.csv  當日牌告快照（CI 會 commit，等於留下每日歷史）

可以單獨執行：python fx.py
"""

from __future__ import annotations

import csv
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

URL = "https://www.esunbank.com/zh-tw/personal/deposit/rate/forex/foreign-exchange-rates"
TZ = ZoneInfo("Asia/Taipei")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
    ),
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
}

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
LATEST_CSV = DATA_DIR / "fx_latest.csv"
SITE_JSON = ROOT / "docs" / "data" / "fx.json"

# 牌告幣別目前 15 種，少於這個數就當網站改版
MIN_CCY = 10

# 前端預設值的取法：四個報價裡最低的那個
DEFAULT_BASIS = "min"

RATE_FIELDS = {
    "spot_buy": "BBoardRate",
    "spot_sell": "SBoardRate",
    "cash_buy": "CashBBoardRate",
    "cash_sell": "CashSBoardRate",
}

CSV_FIELDS = [
    "抓取時間",
    "牌告時間",
    "幣別",
    "即期買入",
    "即期賣出",
    "現金買入",
    "現金賣出",
    "預設匯率",
]

CCY_RE = re.compile(r"^[A-Z]{3}$")
TIME_RE = re.compile(r"(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2}):(\d{2})(?::(\d{2}))?")


def fetch(url: str = URL, retries: int = 4) -> str:
    """抓頁面，失敗時指數退避重試。"""
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=45)
            resp.raise_for_status()
            return resp.content.decode("utf-8", "replace")
        except Exception as err:  # noqa: BLE001
            last_err = err
            wait = 2**attempt
            print(f"[warn] 第 {attempt} 次抓牌告匯率失敗：{err}；{wait}s 後重試", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"連續 {retries} 次抓牌告匯率失敗") from last_err


def to_float(text: str | None) -> float | None:
    text = (text or "").replace(",", "").strip()
    if not text or text == "-":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def quoted_at(soup: BeautifulSoup) -> str:
    """把 '2026年09月25日 12:08:00' 轉成 ISO 字串；抓不到就回空字串。"""
    node = soup.find(id="dataTime")
    if not node:
        return ""
    m = TIME_RE.search(node.get_text(" ", strip=True))
    if not m:
        return ""
    y, mo, d, hh, mm, ss = m.groups()
    stamp = datetime(int(y), int(mo), int(d), int(hh), int(mm), int(ss or 0), tzinfo=TZ)
    return stamp.isoformat(timespec="seconds")


def parse(html: str) -> tuple[dict[str, dict], str]:
    soup = BeautifulSoup(html, "html.parser")
    rates: dict[str, dict] = {}

    for tr in soup.find_all("tr"):
        classes = tr.get("class") or []
        if "currency" not in classes:
            continue
        ccy = next((c for c in classes if CCY_RE.match(c)), "")
        if not ccy:
            continue

        row: dict[str, float | None] = {}
        for key, cls in RATE_FIELDS.items():
            node = tr.find(class_=cls)
            row[key] = to_float(node.get_text(" ", strip=True) if node else None)

        quotes = [v for v in row.values() if v is not None and v > 0]
        if not quotes:
            continue
        row["min"] = min(quotes)
        rates[ccy] = row

    if len(rates) < MIN_CCY:
        raise RuntimeError(f"只解析到 {len(rates)} 種幣別牌告，網站可能已改版")
    return rates, quoted_at(soup)


def write_files(rates: dict[str, dict], quoted: str) -> None:
    now = datetime.now(TZ)

    SITE_JSON.parent.mkdir(parents=True, exist_ok=True)
    SITE_JSON.write_text(
        json.dumps(
            {
                "generated_at": now.isoformat(timespec="seconds"),
                "quoted_at": quoted,
                "source": URL,
                "basis": DEFAULT_BASIS,
                "count": len(rates),
                "rates": dict(sorted(rates.items())),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with LATEST_CSV.open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for ccy, r in sorted(rates.items()):
            writer.writerow(
                {
                    "抓取時間": now.strftime("%Y-%m-%d %H:%M:%S"),
                    "牌告時間": quoted,
                    "幣別": ccy,
                    "即期買入": r["spot_buy"] if r["spot_buy"] is not None else "",
                    "即期賣出": r["spot_sell"] if r["spot_sell"] is not None else "",
                    "現金買入": r["cash_buy"] if r["cash_buy"] is not None else "",
                    "現金賣出": r["cash_sell"] if r["cash_sell"] is not None else "",
                    "預設匯率": r["min"],
                }
            )

    print(f"[ok] 寫入 {SITE_JSON.relative_to(ROOT)} 與 {LATEST_CSV.relative_to(ROOT)}：{len(rates)} 種幣別")
    print(f"      牌告時間 {quoted or '（頁面沒給）'}，預設值取四個報價中最低者")


def run() -> dict[str, dict]:
    rates, quoted = parse(fetch())
    write_files(rates, quoted)
    return rates


def main() -> int:
    try:
        run()
    except Exception as err:  # noqa: BLE001
        print(f"[error] 牌告匯率抓取失敗：{err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
