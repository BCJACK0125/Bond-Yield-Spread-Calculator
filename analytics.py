"""
債券分析引擎。

玉山的報價頁只給「價格」，沒給到期殖利率，所以 YTM 必須自己解。
所有計算以「面額 100」為基準，日計基礎用 ACT/365。

重要假設（前端也會顯示）：
  - 以「申購參考報價的報價日」為結算日，不是今天。報價可能很舊。
  - 報價視為除息價（clean price），買進成本另加應計利息。
  - 永續債沒有到期日，只算當期殖利率，不算 YTM。
"""

from __future__ import annotations

import calendar
import re
from datetime import date, datetime

FREQ_MAP = {
    "年": 1,
    "半年": 2,
    "季": 4,
    "月": 12,
    "雙月": 6,
    "-": 0,
    "": 0,
    "無配息": 0,
}

DAY_COUNT = 365.0


# --------------------------------------------------------------------------
# 欄位解析
# --------------------------------------------------------------------------


def parse_date(text: str) -> date | None:
    text = (text or "").strip()
    m = re.search(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", text)
    if not m:
        return None
    return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))


def parse_number(text: str) -> float | None:
    text = (text or "").replace(",", "").replace("%", "").strip()
    try:
        return float(text)
    except ValueError:
        return None


def parse_coupon(text: str) -> float:
    """'8.130%' -> 8.13；'無配息' -> 0.0"""
    val = parse_number(text)
    return 0.0 if val is None else val


def parse_freq(text: str, coupon: float) -> int:
    if coupon == 0:
        return 0
    return FREQ_MAP.get((text or "").strip(), 2)


# --------------------------------------------------------------------------
# 現金流
# --------------------------------------------------------------------------


def add_months(d: date, months: int) -> date:
    total = d.month - 1 + months
    year = d.year + total // 12
    month = total % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def coupon_schedule(settle: date, maturity: date, freq: int) -> tuple[list[date], date | None]:
    """
    從到期日往回推配息日。
    回傳 (結算日之後的配息日, 結算日之前最近一次配息日)。
    """
    if freq <= 0:
        return [], None

    step = 12 // freq
    dates: list[date] = []
    cursor = maturity
    # 最多往回推 100 年，避免資料異常時無限迴圈
    for _ in range(freq * 100):
        dates.append(cursor)
        cursor = add_months(cursor, -step)
        if cursor <= settle:
            break

    dates.sort()
    future = [d for d in dates if d > settle]
    previous = cursor if cursor <= settle else None
    return future, previous


def accrued_interest(settle: date, maturity: date, coupon: float, freq: int) -> float:
    """應計利息（每 100 面額）。"""
    if freq <= 0 or coupon == 0:
        return 0.0
    future, previous = coupon_schedule(settle, maturity, freq)
    if not future or previous is None:
        return 0.0
    period = (future[0] - previous).days
    if period <= 0:
        return 0.0
    elapsed = (settle - previous).days
    return coupon / freq * (elapsed / period)


def cashflows(settle: date, maturity: date, coupon: float, freq: int) -> list[tuple[float, float]]:
    """回傳 [(距今年數, 金額)]，含到期還本 100。"""
    flows: list[tuple[float, float]] = []
    if freq > 0 and coupon > 0:
        future, _ = coupon_schedule(settle, maturity, freq)
        for d in future:
            flows.append(((d - settle).days / DAY_COUNT, coupon / freq))
    years = (maturity - settle).days / DAY_COUNT
    if years <= 0:
        return []
    flows.append((years, 100.0))
    # 到期日當天的配息和還本併成一筆
    merged: dict[float, float] = {}
    for t, amt in flows:
        merged[round(t, 6)] = merged.get(round(t, 6), 0.0) + amt
    return sorted(merged.items())


def present_value(flows: list[tuple[float, float]], ytm: float, freq: int) -> float:
    """以年化殖利率 ytm 折現。freq=0（零息）用年複利。"""
    m = max(freq, 1)
    if 1 + ytm / m <= 0:
        return float("inf")
    return sum(amt / (1 + ytm / m) ** (m * t) for t, amt in flows)


def solve_ytm(dirty_price: float, flows: list[tuple[float, float]], freq: int) -> float | None:
    """二分法解殖利率。穩定、不會像牛頓法發散。"""
    if dirty_price <= 0 or not flows:
        return None
    lo, hi = -0.90, 3.0
    f_lo = present_value(flows, lo, freq) - dirty_price
    f_hi = present_value(flows, hi, freq) - dirty_price
    if f_lo * f_hi > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        f_mid = present_value(flows, mid, freq) - dirty_price
        if f_lo * f_mid <= 0:
            hi = mid
        else:
            lo, f_lo = mid, f_mid
        if hi - lo < 1e-12:
            break
    return (lo + hi) / 2


def durations(flows, ytm: float, freq: int, dirty_price: float) -> tuple[float | None, float | None]:
    """(Macaulay, Modified) 存續期間，單位為年。"""
    if not flows or dirty_price <= 0 or ytm is None:
        return None, None
    m = max(freq, 1)
    weighted = 0.0
    for t, amt in flows:
        pv = amt / (1 + ytm / m) ** (m * t)
        weighted += t * pv
    mac = weighted / dirty_price
    return mac, mac / (1 + ytm / m)


# --------------------------------------------------------------------------
# 單一債券分析
# --------------------------------------------------------------------------


def analyse(row: dict, today: date) -> dict:
    """吃一筆 scrape.py 產出的 row，回傳含分析欄位的 dict。"""
    coupon = parse_coupon(row.get("票面利率", ""))
    freq = parse_freq(row.get("配息頻率", ""), coupon)
    maturity = parse_date(row.get("到期日", ""))
    perpetual = maturity is None

    buy = parse_number(row.get("申購參考報價", ""))
    sell = parse_number(row.get("贖回參考報價", ""))
    buy_date = parse_date(row.get("申購報價日", ""))
    sell_date = parse_date(row.get("贖回報價日", ""))

    settle = buy_date or today
    out: dict = {
        "code": row.get("產品代碼", ""),
        "name": row.get("產品名稱", ""),
        "isin": row.get("ISIN_CODE", ""),
        "ccy": row.get("計價幣別", ""),
        "coupon": coupon,
        "freq": freq,
        "maturity": maturity.isoformat() if maturity else None,
        "perpetual": perpetual,
        "zero": coupon == 0,
        "open": row.get("是否開放申購", "").strip() == "是",
        "eligibility": row.get("申購資格", "").strip(),
        "rr": row.get("風險報酬等級", "").strip(),
        "buy": buy,
        "sell": sell,
        "buy_date": buy_date.isoformat() if buy_date else None,
        "sell_date": sell_date.isoformat() if sell_date else None,
        "settle": settle.isoformat(),
        "stale_days": (today - buy_date).days if buy_date else None,
        "chart": row.get("走勢圖連結", ""),
        "doc": row.get("產品說明書連結", ""),
    }

    # 買賣價差（提前贖回的隱含成本）
    if buy and sell and buy > 0:
        out["spread_pct"] = round((buy - sell) / buy * 100, 3)
    else:
        out["spread_pct"] = None

    # 當期殖利率
    out["current_yield"] = round(coupon / buy * 100, 4) if (buy and buy > 0) else None

    if perpetual or not buy or not maturity:
        out.update(
            {"ytm": None, "years": None, "accrued": None, "mod_duration": None, "mac_duration": None}
        )
        return out

    years = (maturity - settle).days / DAY_COUNT
    if years <= 0:
        out.update({"ytm": None, "years": 0.0, "accrued": None, "mod_duration": None})
        return out

    acc = accrued_interest(settle, maturity, coupon, freq)
    dirty = buy + acc
    flows = cashflows(settle, maturity, coupon, freq)
    y = solve_ytm(dirty, flows, freq)
    mac, mod = durations(flows, y, freq, dirty) if y is not None else (None, None)

    out.update(
        {
            "years": round(years, 3),
            "accrued": round(acc, 4),
            "ytm": round(y * 100, 4) if y is not None else None,
            "mac_duration": round(mac, 3) if mac else None,
            "mod_duration": round(mod, 3) if mod else None,
        }
    )
    return out
