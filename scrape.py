#!/usr/bin/env python3
"""
玉山銀行「海外債券參考報價」爬蟲

整張報價表（目前約 557 筆）是伺服器端算好直接寫在 HTML 裡的，
頁面上的「確定」按鈕與分頁都只是前端 JS 在控制顯示，
因此不需要 Selenium / Playwright，純 requests + BeautifulSoup 即可。

產出：
  data/bonds_latest.csv   最新完整快照（每次覆寫）
  data/price_history.csv  逐日累積的精簡報價歷史（同一天同一檔只會有一筆）
"""

from __future__ import annotations

import csv
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

import analytics

URL = "https://wealth.esunbank.com/zh-tw/offshore-bond/price"
ORIGIN = "https://wealth.esunbank.com"
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
LATEST_CSV = DATA_DIR / "bonds_latest.csv"
HISTORY_CSV = DATA_DIR / "price_history.csv"
SITE_JSON = ROOT / "docs" / "data" / "bonds.json"

# 低於這個筆數就視為抓取失敗（網站改版 / 被擋 / 回傳空表），直接讓 Action 紅燈
MIN_ROWS = int(os.getenv("MIN_ROWS", "300"))

EXPECTED_HEADERS = [
    "是否開放申購",
    "產品名稱",
    "產品代碼",
    "ISIN CODE",
    "票面利率(%)",
    "到期日",
    "計價幣別",
    "申購參考報價",
    "贖回參考報價",
    "配息頻率",
    "風險報酬等級",
    "申購資格",
    "產品說明書",
]

OUTPUT_FIELDS = [
    "抓取時間",
    "是否開放申購",
    "產品名稱",
    "產品代碼",
    "ISIN_CODE",
    "票面利率",
    "到期日",
    "計價幣別",
    "申購參考報價",
    "申購報價日",
    "贖回參考報價",
    "贖回報價日",
    "配息頻率",
    "風險報酬等級",
    "申購資格",
    "走勢圖連結",
    "產品說明書連結",
]

HISTORY_FIELDS = [
    "抓取日期",
    "產品代碼",
    "ISIN_CODE",
    "計價幣別",
    "申購參考報價",
    "申購報價日",
    "贖回參考報價",
    "贖回報價日",
]

PRICE_RE = re.compile(r"(-?[\d,]+\.?\d*)\s*\(?\s*(\d{4}/\d{2}/\d{2})?\s*\)?")
CODE_RE = re.compile(r"^[A-Za-z]\d{3}$")


def fetch(url: str = URL, retries: int = 4) -> str:
    """抓頁面，失敗時指數退避重試。"""
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=45)
            resp.raise_for_status()
            resp.encoding = resp.apparent_encoding or "utf-8"
            return resp.text
        except Exception as err:  # noqa: BLE001
            last_err = err
            wait = 2**attempt
            print(f"[warn] 第 {attempt} 次抓取失敗：{err}；{wait}s 後重試", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"連續 {retries} 次抓取失敗") from last_err


def clean(text: str) -> str:
    """把換行、不斷行空白、連續空白壓成單一半形空白。"""
    return re.sub(r"\s+", " ", (text or "").replace("\xa0", " ")).strip()


def split_price(cell: str) -> tuple[str, str]:
    """把 '90.46 (2026/09/24)' 拆成 ('90.46', '2026/09/24')。"""
    cell = clean(cell)
    if not cell or cell == "-":
        return "", ""
    m = PRICE_RE.search(cell)
    if not m:
        return cell, ""
    return m.group(1).replace(",", ""), (m.group(2) or "")


def absolutize(href: str | None) -> str:
    if not href:
        return ""
    if href.startswith("http"):
        return href
    return ORIGIN + ("" if href.startswith("/") else "/") + href


def find_table(soup: BeautifulSoup):
    for table in soup.find_all("table"):
        head = table.get_text(" ", strip=True)[:400]
        if "ISIN" in head.upper() and "產品代碼" in head:
            return table
    raise RuntimeError("找不到報價表格，網站結構可能已改版")


def header_row_cells(table) -> list[str]:
    """
    只有表頭那一列整列都是 <th>；資料列的「是否開放申購」與「產品代碼」
    也是用 <th> 包的，所以不能直接 table.find_all("th") 當表頭。
    """
    for tr in table.find_all("tr"):
        tags = tr.find_all(["th", "td"], recursive=False)
        if tags and all(tag.name == "th" for tag in tags):
            return [clean(tag.get_text(" ", strip=True)) for tag in tags]
    return []


def align(cells: list[str], width: int) -> list[str] | None:
    """
    偶爾某些列會多出空白 <td>（例如標題列殘留），
    先從頭尾砍掉空白格試著對齊；對不齊就回 None 交給呼叫端記錄。
    """
    cells = list(cells)
    while len(cells) > width and cells and cells[0] == "":
        cells.pop(0)
    while len(cells) > width and cells and cells[-1] == "":
        cells.pop()
    if len(cells) < width:
        cells += [""] * (width - len(cells))
    return cells if len(cells) == width else None


def parse(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    table = find_table(soup)

    headers = header_row_cells(table) or EXPECTED_HEADERS
    if len(headers) != len(EXPECTED_HEADERS):
        print(
            f"[warn] 表頭欄數為 {len(headers)}（預期 {len(EXPECTED_HEADERS)}）："
            f"{headers}",
            file=sys.stderr,
        )
    width = len(headers)

    body = table.find("tbody") or table
    now = datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S")
    rows: list[dict] = []
    skipped = 0

    for tr in body.find_all("tr"):
        # 資料列 th / td 混用，必須照原始順序一起取，否則欄位會整排錯位
        tags = tr.find_all(["th", "td"], recursive=False)
        if not any(tag.name == "td" for tag in tags):
            continue  # 表頭列或空列
        cells = align([clean(tag.get_text(" ", strip=True)) for tag in tags], width)
        if cells is None:
            skipped += 1
            continue

        raw = dict(zip(headers, cells))

        chart_link = ""
        pdf_link = ""
        for a in tr.find_all("a", href=True):
            href = a["href"]
            if "bondid=" in href:
                chart_link = absolutize(href)
            elif href.lower().endswith(".pdf"):
                pdf_link = absolutize(href)

        code = raw.get("產品代碼", "").strip()
        if not CODE_RE.match(code):
            # 欄位可能錯位，用走勢圖連結的 bondid 補救
            m = re.search(r"bondid=([A-Za-z]\d{3})", chart_link)
            if m:
                code = m.group(1).upper()
            else:
                skipped += 1
                continue

        buy_price, buy_date = split_price(raw.get("申購參考報價", ""))
        sell_price, sell_date = split_price(raw.get("贖回參考報價", ""))

        rows.append(
            {
                "抓取時間": now,
                "是否開放申購": raw.get("是否開放申購", ""),
                "產品名稱": raw.get("產品名稱", ""),
                "產品代碼": code,
                "ISIN_CODE": raw.get("ISIN CODE", ""),
                "票面利率": raw.get("票面利率(%)", "").replace("%", ""),
                "到期日": raw.get("到期日", ""),
                "計價幣別": raw.get("計價幣別", ""),
                "申購參考報價": buy_price,
                "申購報價日": buy_date,
                "贖回參考報價": sell_price,
                "贖回報價日": sell_date,
                "配息頻率": raw.get("配息頻率", ""),
                "風險報酬等級": raw.get("風險報酬等級", ""),
                "申購資格": raw.get("申購資格", ""),
                "走勢圖連結": chart_link,
                "產品說明書連結": pdf_link,
            }
        )

    if skipped:
        print(f"[warn] 有 {skipped} 列無法對齊欄位，已略過", file=sys.stderr)
    return rows


def write_latest(rows: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    rows = sorted(rows, key=lambda r: r["產品代碼"])
    with LATEST_CSV.open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=OUTPUT_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"[ok] 寫入 {LATEST_CSV.relative_to(ROOT)}：{len(rows)} 筆")


def append_history(rows: list[dict]) -> None:
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    existing: list[dict] = []
    seen: set[tuple[str, str]] = set()

    if HISTORY_CSV.exists():
        with HISTORY_CSV.open(encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                existing.append(row)
                seen.add((row["抓取日期"], row["產品代碼"]))

    added = 0
    for r in rows:
        key = (today, r["產品代碼"])
        if key in seen:
            continue
        seen.add(key)
        existing.append(
            {
                "抓取日期": today,
                "產品代碼": r["產品代碼"],
                "ISIN_CODE": r["ISIN_CODE"],
                "計價幣別": r["計價幣別"],
                "申購參考報價": r["申購參考報價"],
                "申購報價日": r["申購報價日"],
                "贖回參考報價": r["贖回參考報價"],
                "贖回報價日": r["贖回報價日"],
            }
        )
        added += 1

    existing.sort(key=lambda r: (r["抓取日期"], r["產品代碼"]))
    with HISTORY_CSV.open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=HISTORY_FIELDS)
        writer.writeheader()
        writer.writerows(existing)
    print(f"[ok] 歷史檔新增 {added} 筆，累計 {len(existing)} 筆")


def write_site_json(rows: list[dict]) -> None:
    """產生 GitHub Pages 用的 JSON，含自行計算的殖利率與存續期間。"""
    today = datetime.now(TZ).date()
    bonds = [analytics.analyse(r, today) for r in rows]
    bonds.sort(key=lambda b: b["code"])

    priced = [b for b in bonds if b["ytm"] is not None]
    payload = {
        "generated_at": datetime.now(TZ).isoformat(timespec="seconds"),
        "source": URL,
        "count": len(bonds),
        "priced_count": len(priced),
        "bonds": bonds,
    }
    SITE_JSON.parent.mkdir(parents=True, exist_ok=True)
    SITE_JSON.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size_kb = SITE_JSON.stat().st_size / 1024
    print(f"[ok] 寫入 {SITE_JSON.relative_to(ROOT)}：{len(bonds)} 筆 / {size_kb:.0f} KB")
    print(f"      其中 {len(priced)} 筆可計算到期殖利率（其餘為永續債或缺報價）")


def main() -> int:
    html = fetch()
    rows = parse(html)

    if len(rows) < MIN_ROWS:
        print(
            f"[error] 只解析到 {len(rows)} 筆，低於門檻 {MIN_ROWS}，"
            "可能被擋或網站改版，本次不寫檔",
            file=sys.stderr,
        )
        return 1

    write_latest(rows)
    append_history(rows)
    write_site_json(rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
