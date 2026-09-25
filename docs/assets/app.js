/* ==========================================================================
   海外債利差試算
   資料來自 data/bonds.json（由 GitHub Action 每個交易日更新）。
   殖利率與存續期間在 Python 端算好，這裡負責把使用者的貸款條件套上去。
   ========================================================================== */

'use strict';

const $ = (id) => document.getElementById(id);

const CCY_COLOR = {
  USD: '#14212E', EUR: '#1D5FA8', ZAR: '#97302F', AUD: '#9C6A0C',
  CNY: '#0E6E5E', NZD: '#6B4E9B', SEK: '#2A7A8C', MXN: '#B0532A',
  JPY: '#4A5B6B', GBP: '#7A2F5E', CAD: '#3F6B2F',
};
const ccyColor = (c) => CCY_COLOR[c] || '#8D9AA7';

/* 各幣別對台幣的備援匯率。正常情況會被 data/fx.json（玉山牌告）蓋掉，
   只有牌告抓不到時才會用到。使用者一定要自己改成實際換到的價格。 */
const FX_DEFAULT = {
  USD: 32, EUR: 35, AUD: 21, CNY: 4.5, ZAR: 1.8, NZD: 19,
  SEK: 3.2, MXN: 1.7, JPY: 0.21, GBP: 41, CAD: 23,
};

/* 牌告匯率：回傳該幣別要帶進輸入框的預設值（fx.json 已取四個報價中最低者）。 */
function fxQuote(ccy) {
  return (state.fx && state.fx.rates && state.fx.rates[ccy]) || null;
}

function fxDefault(ccy) {
  const q = fxQuote(ccy);
  return (q && q.min) || FX_DEFAULT[ccy] || null;
}

/* 說明這個預設值是哪來的，順便提醒實際買外幣是用「即期賣出」那一邊。 */
function renderFxHint(ccy) {
  const el = $('fxSource');
  if (!el) return;
  const q = fxQuote(ccy);
  if (!q) { el.textContent = ''; return; }

  const pair = [];
  if (q.spot_buy != null) pair.push(`即期 ${q.spot_buy} / ${q.spot_sell}`);
  if (q.cash_buy != null) pair.push(`現金 ${q.cash_buy} / ${q.cash_sell}`);

  const when = state.fx.quoted_at ? state.fx.quoted_at.slice(0, 16).replace('T', ' ') : '';
  el.textContent = `玉山牌告 ${ccy}${when ? `（${when}）` : ''}　${pair.join('、')}（買入/賣出）。`
    + `已帶入最低的 ${q.min}；真的要買外幣時銀行是用即期賣出 ${q.spot_sell}。`;
}

const state = {
  data: null,
  fx: null,
  bonds: [],
  view: [],
  selected: null,
  ccyOff: new Set(),
};

/* ---------------------------------------------------------------- 格式 */

const nf0 = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
const money = (v) => (v < 0 ? '−' : '') + nf0.format(Math.abs(Math.round(v)));
const pct = (v, d = 2) => (v == null || !isFinite(v) ? '—' : v.toFixed(d) + '%');
const signed = (v, d = 2) => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + '%');

/* ---------------------------------------------------------------- 輸入 */

function inputs() {
  const repay = document.querySelector('input[name="repay"]:checked').value;
  return {
    amount: Math.max(0, +$('loanAmount').value || 0),
    rate: Math.max(0, +$('loanRate').value || 0) / 100,
    years: Math.max(1, +$('loanYears').value || 1),
    fee: Math.max(0, +$('loanFee').value || 0),
    repay,
    fxRate: Math.max(0.0001, +$('fxRate').value || 1),
    fxCost: Math.max(0, +$('fxCost').value || 0) / 100,
    fxChange: (+$('fxChange').value || 0) / 100,
    tax: Math.max(0, +$('taxRate').value || 0) / 100,
    shock: (+$('rateShock').value || 0) / 10000,
  };
}

/* ------------------------------------------------------------ 貸款數學 */

function monthlyPayment(principal, annualRate, years) {
  const i = annualRate / 12, n = years * 12;
  if (i === 0) return principal / n;
  return (principal * i) / (1 - Math.pow(1 + i, -n));
}

function balanceAfter(principal, annualRate, years, k) {
  const i = annualRate / 12, n = years * 12;
  if (k >= n) return 0;
  if (i === 0) return principal * (1 - k / n);
  return principal * (Math.pow(1 + i, n) - Math.pow(1 + i, k)) / (Math.pow(1 + i, n) - 1);
}

/** 把開辦費攤進去之後的實質年化資金成本。 */
function fundingCost(inp) {
  const { amount, rate, years, fee, repay } = inp;
  if (amount <= 0) return rate;
  const n = years * 12;
  const flows = [amount - fee];
  if (repay === 'amortizing') {
    const m = monthlyPayment(amount, rate, years);
    for (let k = 1; k <= n; k++) flows.push(-m);
  } else {
    const interest = amount * rate / 12;
    for (let k = 1; k <= n; k++) flows.push(k === n ? -(interest + amount) : -interest);
  }
  const i = irr(flows);
  return i == null ? rate : Math.pow(1 + i, 12) - 1;
}

/**
 * 解月報酬率。flows[0] 為期初。
 * 配息月是正的、其他月是負的，現金流正負交錯，NPV 會有多個零點，
 * 所以不能只取區間兩端；由低往高掃描，取第一個變號區間才是有意義的那個解。
 */
function irr(flows) {
  const npv = (r) => {
    let s = 0;
    for (let k = 0; k < flows.length; k++) s += flows[k] / Math.pow(1 + r, k);
    return s;
  };
  const LO = -0.9, HI = 1.0, N = 200;
  let prevR = LO, prevV = npv(LO);
  if (!isFinite(prevV)) return null;

  for (let i = 1; i <= N; i++) {
    const r = LO + (HI - LO) * i / N;
    const v = npv(r);
    if (isFinite(v) && prevV * v <= 0) {
      let lo = prevR, hi = r, flo = prevV;
      for (let k = 0; k < 80; k++) {
        const mid = (lo + hi) / 2, fm = npv(mid);
        if (flo * fm <= 0) { hi = mid; } else { lo = mid; flo = fm; }
      }
      return (lo + hi) / 2;
    }
    prevR = r; prevV = v;
  }
  return null;
}

/* ------------------------------------------------------------ 債券數學 */

/** 從到期日往回推配息日，回傳距結算日的年數陣列（與 Python 端規則一致）。 */
function couponTimes(bond) {
  if (bond._times) return bond._times;
  bond._times = computeCouponTimes(bond);
  return bond._times;
}

function computeCouponTimes(bond) {
  if (!bond.maturity || !bond.freq || !bond.coupon) return [];
  const mat = new Date(bond.maturity + 'T00:00:00');
  const settle = new Date(bond.settle + 'T00:00:00');
  const step = 12 / bond.freq;
  const out = [];
  let d = new Date(mat);
  for (let k = 0; k < bond.freq * 100; k++) {
    if (d <= settle) break;
    out.push((d - settle) / 86400000 / 365);
    const day = d.getDate();
    d = new Date(d.getFullYear(), d.getMonth() - step, 1);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  return out.reverse();
}

/** 在 atYears 時點賣出，每 100 面額可拿回多少（已扣買賣價差）。 */
function exitProceeds(bond, atYears, shock, times) {
  const m = Math.max(bond.freq, 1);
  const y = (bond.ytm / 100) + shock;
  const cpn = bond.coupon / (bond.freq || 1);
  let dirty = 0;
  for (const t of times) {
    if (t > atYears) dirty += cpn / Math.pow(1 + y / m, m * (t - atYears));
  }
  dirty += 100 / Math.pow(1 + y / m, m * (bond.years - atYears));

  // 應計利息
  let acc = 0;
  if (bond.freq > 0 && bond.coupon > 0) {
    const nextIdx = times.findIndex((t) => t > atYears);
    if (nextIdx > 0) {
      const prev = times[nextIdx - 1], next = times[nextIdx];
      acc = cpn * ((atYears - prev) / (next - prev));
    } else if (nextIdx === 0) {
      acc = cpn * Math.max(0, (atYears - (times[0] - 1 / m)) / (1 / m));
    }
  }
  const clean = Math.max(0, dirty - acc);
  const haircut = Math.min(20, Math.max(0, bond.spread_pct || 0)) / 100;
  return clean * (1 - haircut) + acc;
}

/* ------------------------------------------------------------ 模擬引擎 */

function simulate(bond, inp, fxChangeOverride, wantIrr) {
  if (!bond || bond.ytm == null || !bond.buy) return null;

  const fxChange = fxChangeOverride === undefined ? inp.fxChange : fxChangeOverride;
  const times = couponTimes(bond);
  const horizon = Math.min(inp.years, bond.years);
  const M = Math.max(1, Math.round(horizon * 12));
  const heldToMaturity = bond.years <= inp.years + 1e-9;

  // 換匯買進
  const twdIn = Math.max(0, inp.amount - inp.fee);
  const foreign = twdIn / (inp.fxRate * (1 + inp.fxCost / 2));
  const dirtyBuy = bond.buy + (bond.accrued || 0);
  const face = foreign / (dirtyBuy / 100);          // 買到的面額
  const costForeign = foreign;

  const toTwd = (f) => f * inp.fxRate * (1 + fxChange) * (1 - inp.fxCost / 2);

  const net = new Array(M + 1).fill(0);
  const coupons = new Array(M + 1).fill(0);
  const payments = new Array(M + 1).fill(0);

  // 貸款還款
  const pay = inp.repay === 'amortizing'
    ? monthlyPayment(inp.amount, inp.rate, inp.years)
    : inp.amount * inp.rate / 12;
  for (let k = 1; k <= M; k++) payments[k] = pay;

  // 債息
  const cpnAmt = face * bond.coupon / 100 / (bond.freq || 1);
  for (const t of times) {
    if (t > horizon + 1e-9) continue;
    const k = Math.min(M, Math.max(1, Math.round(t * 12)));
    coupons[k] += toTwd(cpnAmt) * (1 - inp.tax);
  }

  // 期末：到期還本或賣出，然後清償貸款餘額
  let exitForeign;
  if (heldToMaturity) {
    exitForeign = face;                               // 面額 100 → 還本
  } else {
    exitForeign = face * exitProceeds(bond, horizon, inp.shock, times) / 100;
  }
  const gain = Math.max(0, exitForeign - costForeign);
  const exitTwd = toTwd(exitForeign - gain * inp.tax);

  const remaining = inp.repay === 'amortizing'
    ? balanceAfter(inp.amount, inp.rate, inp.years, M)
    : (M >= inp.years * 12 ? 0 : inp.amount);

  for (let k = 0; k <= M; k++) net[k] = coupons[k] - payments[k];
  net[M] += exitTwd - remaining;

  const cum = [];
  let run = 0;
  for (let k = 0; k <= M; k++) { run += net[k]; cum.push(run); }

  const total = cum[M];
  const trough = Math.min(0, ...cum);
  const gapMonth = cum.indexOf(trough);
  const mIrr = wantIrr ? irr(net) : null;

  return {
    bond, horizon, M, heldToMaturity, face, net, cum, coupons, payments,
    total, maxGap: -trough, gapMonth, exitTwd, remaining,
    totalCoupon: coupons.reduce((a, b) => a + b, 0),
    totalPayment: payments.reduce((a, b) => a + b, 0),
    annualised: mIrr == null ? null : (Math.pow(1 + mIrr, 12) - 1) * 100,
  };
}

/** 外幣要貶多少，整筆操作才會由賺轉賠。 */
function breakevenFx(bond, inp) {
  const f = (chg) => { const s = simulate(bond, inp, chg); return s ? s.total : NaN; };
  let lo = -0.95, hi = 2.0;
  let flo = f(lo), fhi = f(hi);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if (flo * fm <= 0) { hi = mid; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2 * 100;
}

/* ------------------------------------------------------------ 指標計算 */

function annotate(bond, inp, cost) {
  const horizon = Math.min(inp.years, bond.years || inp.years);
  const fxDrag = horizon > 0 ? (inp.fxCost * 100) / horizon : 0;
  const taxDrag = (bond.ytm || 0) * inp.tax;
  bond._fxDrag = fxDrag;
  bond._taxDrag = taxDrag;
  bond._net = bond.ytm == null ? null : bond.ytm - cost * 100 - fxDrag - taxDrag;
  return bond;
}

function flags(bond, inp) {
  const out = [];
  if (!bond.open) out.push(['未開放申購', 1]);
  if (bond.eligibility) out.push([bond.eligibility, 1]);
  if (bond.perpetual) out.push(['永續債', 1]);
  if (bond.stale_days > 30) out.push([`報價 ${bond.stale_days} 天前`, bond.stale_days > 180 ? 1 : 0]);
  if (bond.rr === 'RR5') out.push(['RR5', 1]);
  if (bond.spread_pct > 3) out.push([`價差 ${bond.spread_pct.toFixed(1)}%`, 0]);
  if (bond.years && bond.years > inp.years) out.push([`${Math.ceil(bond.years)} 年後到期`, 0]);
  return out;
}

/* ---------------------------------------------------------------- 篩選 */

function applyFilters() {
  const inp = inputs();
  const cost = fundingCost(inp);
  const onlyOpen = $('fOpen').checked;
  const onlyRetail = $('fRetail').checked;
  const onlyFresh = $('fFresh').checked;
  const onlyFit = $('fFit').checked;

  let list = state.bonds.filter((b) => b.ytm != null && b.buy);
  if (onlyOpen) list = list.filter((b) => b.open);
  if (onlyRetail) list = list.filter((b) => !b.eligibility);
  if (onlyFresh) list = list.filter((b) => b.stale_days != null && b.stale_days <= 30);
  if (onlyFit) list = list.filter((b) => b.years <= inp.years);
  list = list.filter((b) => !state.ccyOff.has(b.ccy));

  list.forEach((b) => annotate(b, inp, cost));

  const key = $('sortBy').value;
  const cmp = {
    net: (a, b) => (b._net ?? -99) - (a._net ?? -99),
    ytm: (a, b) => b.ytm - a.ytm,
    years: (a, b) => a.years - b.years,
    duration: (a, b) => (a.mod_duration ?? 99) - (b.mod_duration ?? 99),
    spread: (a, b) => (a.spread_pct ?? 99) - (b.spread_pct ?? 99),
  }[key];
  list.sort(cmp);

  state.view = list;
  return { inp, cost };
}

/* ---------------------------------------------------------------- SVG */

function svg(w, h) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', `0 0 ${w} ${h}`);
  s.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  s.setAttribute('role', 'img');
  return s;
}
function el(tag, attrs, text) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  return n;
}
function niceTicks(min, max, count) {
  const span = (max - min) || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

/* ---- 圖一：殖利率 vs 剩餘年期，畫上資金成本線 ---- */

function drawScatter(list, costPct) {
  const host = $('scatter');
  host.textContent = '';
  if (!list.length) return;

  const W = 780, H = 300, L = 48, R = 18, T = 16, B = 36;
  const s = svg(W, H);
  s.setAttribute('aria-label', '各債券到期殖利率與剩餘年期的分布');

  const xs = list.map((b) => b.years), ys = list.map((b) => b.ytm);
  const xMax = Math.max(...xs, 1) * 1.06;
  const yLo = Math.min(...ys, costPct) - 0.4;
  const yHi = Math.max(...ys, costPct) + 0.4;
  const X = (v) => L + (v / xMax) * (W - L - R);
  const Y = (v) => H - B - ((v - yLo) / (yHi - yLo)) * (H - T - B);

  for (const t of niceTicks(yLo, yHi, 5)) {
    s.appendChild(el('line', { class: 'grid-line', x1: L, x2: W - R, y1: Y(t), y2: Y(t) }));
    s.appendChild(el('text', { class: 'axis-label', x: L - 8, y: Y(t) + 3.5, 'text-anchor': 'end' }, t.toFixed(1)));
  }
  for (const t of niceTicks(0, xMax, 6)) {
    if (t < 0) continue;
    s.appendChild(el('text', { class: 'axis-label', x: X(t), y: H - B + 15, 'text-anchor': 'middle' }, t));
  }
  s.appendChild(el('line', { class: 'axis-line', x1: L, x2: W - R, y1: H - B, y2: H - B }));
  s.appendChild(el('text', { class: 'axis-title', x: W - R, y: H - 4, 'text-anchor': 'end' }, '剩餘年期'));
  s.appendChild(el('text', { class: 'axis-title', x: L - 34, y: T + 2, 'text-anchor': 'start' }, '殖利率 %'));

  // 資金成本線
  const hy = Y(costPct);
  s.appendChild(el('line', { class: 'hurdle', x1: L, x2: W - R, y1: hy, y2: hy }));
  s.appendChild(el('text', { class: 'hurdle-label', x: L + 4, y: hy - 6 }, `你的資金成本 ${costPct.toFixed(2)}%`));

  for (const b of list) {
    const above = b.ytm > costPct;
    const c = el('circle', {
      class: 'dot', cx: X(b.years), cy: Y(b.ytm), r: above ? 5 : 3.5,
      fill: above ? ccyColor(b.ccy) : '#FFFFFF',
      stroke: ccyColor(b.ccy), 'stroke-width': above ? 0 : 1.4,
      'fill-opacity': above ? 0.85 : 1,
      'data-code': b.code, 'data-on': state.selected === b.code ? '1' : '0',
    });
    c.appendChild(el('title', {}, `${b.name}\n${b.ccy} ${b.ytm.toFixed(2)}% / ${b.years.toFixed(1)} 年`));
    c.addEventListener('click', () => select(b.code));
    s.appendChild(c);
  }
  host.appendChild(s);

  const used = [...new Set(list.map((b) => b.ccy))].sort();
  $('scatterLegend').innerHTML =
    used.map((c) => `<i><b style="background:${ccyColor(c)}"></b>${c}</i>`).join('') +
    '<i>實心＝殖利率高於你的資金成本，空心＝低於</i>';
}

/* ---- 圖二：累計淨現金部位 ---- */

function drawCashflow(sim) {
  const host = $('cashflow');
  host.textContent = '';
  if (!sim) return;

  const W = 780, H = 260, L = 64, R = 18, T = 18, B = 34;
  const s = svg(W, H);
  s.setAttribute('aria-label', '累計淨現金部位隨時間變化');

  const cum = sim.cum;
  const lo = Math.min(0, ...cum), hi = Math.max(0, ...cum);
  const pad = (hi - lo) * 0.08 || 1;
  const X = (m) => L + (m / sim.M) * (W - L - R);
  const Y = (v) => H - B - ((v - lo + pad) / (hi - lo + pad * 2)) * (H - T - B);

  for (const t of niceTicks(lo - pad, hi + pad, 5)) {
    s.appendChild(el('line', { class: 'grid-line', x1: L, x2: W - R, y1: Y(t), y2: Y(t) }));
    s.appendChild(el('text', { class: 'axis-label', x: L - 8, y: Y(t) + 3.5, 'text-anchor': 'end' },
      Math.abs(t) >= 10000 ? (t / 10000).toFixed(0) + '萬' : money(t)));
  }
  const years = Math.ceil(sim.M / 12);
  for (let y = 0; y <= years; y++) {
    const m = Math.min(sim.M, y * 12);
    s.appendChild(el('text', { class: 'axis-label', x: X(m), y: H - B + 15, 'text-anchor': 'middle' }, y === 0 ? '起' : y + '年'));
  }

  // 面積
  let d = `M ${X(0)} ${Y(0)}`;
  cum.forEach((v, m) => { d += ` L ${X(m)} ${Y(v)}`; });
  d += ` L ${X(sim.M)} ${Y(0)} Z`;
  s.appendChild(el('path', { d, fill: sim.total >= 0 ? 'var(--income-w)' : 'var(--cost-w)', 'fill-opacity': 0.75 }));

  s.appendChild(el('line', { class: 'axis-line', x1: L, x2: W - R, y1: Y(0), y2: Y(0), 'stroke-width': 1.5 }));

  let line = '';
  cum.forEach((v, m) => { line += (m === 0 ? 'M ' : ' L ') + X(m) + ' ' + Y(v); });
  s.appendChild(el('path', { d: line, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.8 }));

  // 最大缺口
  if (sim.maxGap > 0) {
    const gx = X(sim.gapMonth), gy = Y(-sim.maxGap);
    s.appendChild(el('circle', { cx: gx, cy: gy, r: 3.5, fill: 'var(--cost)' }));
    s.appendChild(el('text', {
      class: 'hurdle-label', x: Math.min(gx + 7, W - R - 120), y: gy + 14,
    }, `最大缺口 ${money(-sim.maxGap)}`));
  }
  // 期末
  const ey = Y(sim.total);
  s.appendChild(el('circle', { cx: X(sim.M), cy: ey, r: 4, fill: sim.total >= 0 ? 'var(--income)' : 'var(--cost)' }));
  s.appendChild(el('text', {
    class: 'hurdle-label', x: W - R, y: ey - 9, 'text-anchor': 'end',
    fill: sim.total >= 0 ? 'var(--income)' : 'var(--cost)',
  }, `${sim.total >= 0 ? '+' : '−'}${money(Math.abs(sim.total))}`));

  host.appendChild(s);
  $('cashLegend').textContent =
    `期初不用自備款（貸款直接買債）。線往下代表你正在自掏腰包補貸款月付，`
    + `往上代表債息與還本已經把洞補回來。`;
}

/* ---- 圖三：匯率敏感度 ---- */

function drawFxCurve(bond, inp, be) {
  const host = $('fxcurve');
  host.textContent = '';

  const W = 780, H = 230, L = 64, R = 18, T = 16, B = 34;
  const s = svg(W, H);
  s.setAttribute('aria-label', '總損益隨匯率變動的曲線');

  const pts = [];
  for (let c = -30; c <= 30; c += 1) {
    const sim = simulate(bond, inp, c / 100);
    if (sim) pts.push([c, sim.total]);
  }
  if (!pts.length) return;

  const vals = pts.map((p) => p[1]);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const pad = (hi - lo) * 0.1 || 1;
  const X = (c) => L + ((c + 30) / 60) * (W - L - R);
  const Y = (v) => H - B - ((v - lo + pad) / (hi - lo + pad * 2)) * (H - T - B);

  for (const t of niceTicks(lo - pad, hi + pad, 4)) {
    s.appendChild(el('line', { class: 'grid-line', x1: L, x2: W - R, y1: Y(t), y2: Y(t) }));
    s.appendChild(el('text', { class: 'axis-label', x: L - 8, y: Y(t) + 3.5, 'text-anchor': 'end' },
      Math.abs(t) >= 10000 ? (t / 10000).toFixed(0) + '萬' : money(t)));
  }
  for (let c = -30; c <= 30; c += 10) {
    s.appendChild(el('text', { class: 'axis-label', x: X(c), y: H - B + 15, 'text-anchor': 'middle' },
      (c > 0 ? '+' : '') + c + '%'));
  }
  s.appendChild(el('line', { class: 'axis-line', x1: L, x2: W - R, y1: Y(0), y2: Y(0), 'stroke-width': 1.5 }));

  let d = '';
  pts.forEach(([c, v], i) => { d += (i === 0 ? 'M ' : ' L ') + X(c) + ' ' + Y(v); });
  s.appendChild(el('path', { d, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 2 }));

  if (be != null && be >= -30 && be <= 30) {
    s.appendChild(el('line', { class: 'hurdle', x1: X(be), x2: X(be), y1: T, y2: H - B }));
    s.appendChild(el('text', {
      class: 'hurdle-label', x: X(be) + (be > 10 ? -6 : 6), y: T + 12,
      'text-anchor': be > 10 ? 'end' : 'start',
    }, `損益兩平 ${signed(be, 1)}`));
  }

  const now = simulate(bond, inp);
  if (now) {
    s.appendChild(el('circle', {
      cx: X(inp.fxChange * 100), cy: Y(now.total), r: 4.5,
      fill: now.total >= 0 ? 'var(--income)' : 'var(--cost)',
    }));
  }
  s.appendChild(el('text', { class: 'axis-title', x: W - R, y: H - 4, 'text-anchor': 'end' }, '外幣對台幣變動'));
  host.appendChild(s);

  $('fxLegend').textContent = be == null
    ? '在 ±30% 的範圍內都沒有損益兩平點。'
    : be < -30
      ? '外幣就算貶值 30%，這筆操作仍有獲利。'
      : `外幣對台幣${be < 0 ? '貶值' : '升值'}超過 ${Math.abs(be).toFixed(1)}%，這筆操作就由賺轉賠。`;
}

/* ---- 圖四：利差瀑布 ---- */

function drawWaterfall(bond, cost) {
  const host = $('waterfall');
  host.textContent = '';

  const steps = [
    ['到期殖利率', bond.ytm, 'start'],
    ['資金成本', -cost * 100, 'down'],
    ['換匯成本', -bond._fxDrag, 'down'],
    ['所得稅', -bond._taxDrag, 'down'],
    ['淨利差', bond._net, 'end'],
  ].filter((s, i) => i === 0 || i === 4 || Math.abs(s[1]) > 0.001);

  const W = 780, H = 150, T = 26, B = 42, L = 8, R = 8;
  const s = svg(W, H);
  s.setAttribute('aria-label', '殖利率扣除各項成本後的淨利差');

  const all = [bond.ytm, 0, bond._net];
  let acc = 0;
  const spans = steps.map((st) => {
    if (st[2] === 'start') { acc = st[1]; return [0, st[1]]; }
    if (st[2] === 'end') return [0, st[1]];
    const from = acc; acc += st[1]; all.push(acc);
    return [acc, from];
  });
  const hi = Math.max(...all, 0.5), lo = Math.min(...all, 0);
  const Y = (v) => H - B - ((v - lo) / (hi - lo || 1)) * (H - T - B);

  const bw = (W - L - R) / steps.length;
  s.appendChild(el('line', { class: 'axis-line', x1: L, x2: W - R, y1: Y(0), y2: Y(0) }));

  steps.forEach((st, i) => {
    const [a, b] = spans[i];
    const x = L + i * bw + bw * 0.16, w = bw * 0.68;
    const y1 = Y(Math.max(a, b)), y2 = Y(Math.min(a, b));
    const fill = st[2] === 'down' ? 'var(--cost)'
      : st[2] === 'end' ? (st[1] >= 0 ? 'var(--income)' : 'var(--cost)')
        : 'var(--ink)';
    s.appendChild(el('rect', { x, y: y1, width: w, height: Math.max(1.5, y2 - y1), fill, rx: 1 }));
    s.appendChild(el('text', {
      x: x + w / 2, y: y1 - 7, 'text-anchor': 'middle',
      fill: 'var(--ink)', 'font-size': 13, 'font-weight': 700,
    }, (st[2] === 'down' ? '−' : '') + Math.abs(st[1]).toFixed(2) + '%'));
    s.appendChild(el('text', {
      x: x + w / 2, y: H - B + 17, 'text-anchor': 'middle',
      fill: 'var(--ink-2)', 'font-size': 11.5,
    }, st[0]));
    if (i > 0 && i < steps.length - 1) {
      s.appendChild(el('line', {
        x1: x + w, x2: L + (i + 1) * bw + bw * 0.16, y1: Y(spans[i][0]), y2: Y(spans[i][0]),
        stroke: 'var(--rule)', 'stroke-width': 1, 'stroke-dasharray': '2 2',
      }));
    }
  });
  host.appendChild(s);
}

/* ---------------------------------------------------------------- 渲染 */

function renderTable(inp) {
  const body = $('resultBody');
  body.textContent = '';
  const note = $('emptyNote');

  if (!state.view.length) {
    note.hidden = false;
    note.textContent = '目前的篩選條件沒有符合的債券。試著放寬「只看到期日在貸款年限內」或「只看一般投資人可買」。';
    return;
  }
  note.hidden = true;

  const frag = document.createDocumentFragment();
  for (const b of state.view.slice(0, 120)) {
    const tr = document.createElement('tr');
    tr.dataset.code = b.code;
    if (state.selected === b.code) tr.setAttribute('aria-selected', 'true');
    const tags = flags(b, inp).map(([t, hard]) =>
      `<span class="tag${hard ? ' tag--hard' : ''}">${t}</span>`).join('');
    tr.innerHTML = `
      <td><span class="bondname">${b.name}</span><span class="bondcode">${b.code}</span></td>
      <td class="num">${b.zero ? '零息' : b.coupon.toFixed(2)}</td>
      <td>${b.maturity || '永續'}</td>
      <td class="num">${b.years.toFixed(1)}</td>
      <td class="num">${b.buy.toFixed(2)} <span class="bondcode">${b.ccy}</span></td>
      <td class="num">${b.ytm.toFixed(2)}</td>
      <td class="num ${b._net >= 0 ? 'pos' : 'neg'}">${signed(b._net)}</td>
      <td class="num">${b.mod_duration != null ? b.mod_duration.toFixed(1) : '—'}</td>
      <td class="num">${b.spread_pct != null ? b.spread_pct.toFixed(1) : '—'}</td>
      <td>${tags || '<span class="bondcode">—</span>'}</td>`;
    tr.addEventListener('click', () => select(b.code));
    frag.appendChild(tr);
  }
  body.appendChild(frag);
}

function renderDetail(inp, cost) {
  const panel = $('detail');
  const bond = state.bonds.find((b) => b.code === state.selected);
  if (!bond || bond.ytm == null) { panel.hidden = true; return; }
  panel.hidden = false;

  annotate(bond, inp, cost);
  const sim = simulate(bond, inp, undefined, true);
  const be = breakevenFx(bond, inp);

  $('detailName').textContent = `${bond.name}　${bond.code}`;
  const doc = $('detailDoc');
  if (bond.doc) { doc.href = bond.doc; doc.hidden = false; } else { doc.hidden = true; }

  drawWaterfall(bond, cost);

  const items = [
    ['淨利差', signed(bond._net), '每年，扣成本後'],
    ['總損益', (sim.total >= 0 ? '+' : '−') + money(Math.abs(sim.total)), `持有 ${sim.horizon.toFixed(1)} 年`],
    ['你要墊的現金', money(sim.maxGap), '中途最大缺口'],
    ['年化報酬', sim.annualised == null ? '—' : signed(sim.annualised), '對投入的自備現金'],
    ['匯率容忍度', be == null ? '—' : signed(be, 1), '超過就轉賠'],
    ['期末處分', sim.heldToMaturity ? '抱到到期' : '提前賣出', sim.heldToMaturity ? '拿回面額' : `承受價差 ${(bond.spread_pct || 0).toFixed(1)}%`],
  ];
  $('stats').innerHTML = items.map(([t, v, s]) =>
    `<div><dt>${t}</dt><dd>${v}<small>${s}</small></dd></div>`).join('');

  drawCashflow(sim);
  drawFxCurve(bond, inp, be);

  // 逐年
  const rows = [];
  const years = Math.ceil(sim.M / 12);
  let run = 0;
  for (let y = 1; y <= years; y++) {
    let c = 0, p = 0;
    for (let m = (y - 1) * 12 + 1; m <= Math.min(y * 12, sim.M); m++) { c += sim.coupons[m]; p += sim.payments[m]; }
    let n = c - p;
    if (y === years) n += sim.exitTwd - sim.remaining;
    run += n;
    rows.push(`<tr><td>第 ${y} 年</td><td class="num">${money(c)}</td><td class="num">${money(-p)}</td>
      <td class="num ${n >= 0 ? 'pos' : 'neg'}">${money(n)}</td>
      <td class="num ${run >= 0 ? 'pos' : 'neg'}">${money(run)}</td></tr>`);
  }
  $('yearBody').innerHTML = rows.join('');
}

function select(code) {
  if (state.selected === code) {
    // 取消選取後單位會回到 TWD/USD，匯率也要跟著回去，免得數字和單位對不上
    state.selected = null;
    const usd = fxDefault('USD');
    if (usd) $('fxRate').value = usd;
    render();
    return;
  }

  // 換到不同幣別時，把該幣別的牌告匯率帶進輸入框
  const next = state.bonds.find((b) => b.code === code);
  const cur = state.bonds.find((b) => b.code === state.selected);
  if (next && (!cur || cur.ccy !== next.ccy)) {
    const v = fxDefault(next.ccy);
    if (v) $('fxRate').value = v;
  }

  state.selected = code;
  render();
  $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function render() {
  const { inp, cost } = applyFilters();

  // 貸款摘要
  const pay = inp.repay === 'amortizing'
    ? monthlyPayment(inp.amount, inp.rate, inp.years)
    : inp.amount * inp.rate / 12;
  $('loanReadout').innerHTML =
    `月付 <b>${money(pay)}</b> 元　實質年化資金成本 <b>${pct(cost * 100)}</b>`
    + (inp.repay === 'interest' ? `　到期另需還本 ${money(inp.amount)} 元` : '');

  // 匯率單位與牌告說明隨選取債券調整
  const sel = state.bonds.find((b) => b.code === state.selected);
  $('fxUnit').textContent = 'TWD/' + (sel ? sel.ccy : 'USD');
  renderFxHint(sel ? sel.ccy : 'USD');

  const over = state.view.filter((b) => b.ytm > cost * 100).length;
  $('heroSummary').textContent = state.view.length
    ? `篩出 ${state.view.length} 檔，其中 ${over} 檔的到期殖利率高於你 ${pct(cost * 100)} 的資金成本。點任一個點看細節。`
    : '目前條件下沒有符合的債券。';

  drawScatter(state.view, cost * 100);
  renderTable(inp);
  renderDetail(inp, cost);
}

/* ---------------------------------------------------------------- 啟動 */

function buildCcyFilter() {
  const host = $('ccyFilter');
  const list = [...new Set(state.bonds.filter((b) => b.ytm != null).map((b) => b.ccy))].sort();
  host.innerHTML = '';
  for (const c of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = c;
    btn.setAttribute('aria-pressed', 'true');
    btn.addEventListener('click', () => {
      const on = btn.getAttribute('aria-pressed') === 'true';
      btn.setAttribute('aria-pressed', on ? 'false' : 'true');
      if (on) state.ccyOff.add(c); else state.ccyOff.delete(c);
      render();
    });
    host.appendChild(btn);
  }
}

function wire() {
  const ids = ['loanAmount', 'loanRate', 'loanYears', 'loanFee', 'fxRate', 'fxCost', 'taxRate',
    'fOpen', 'fRetail', 'fFresh', 'fFit', 'sortBy'];
  ids.forEach((id) => $(id).addEventListener('input', render));
  document.querySelectorAll('input[name="repay"]').forEach((r) => r.addEventListener('change', render));

  $('fxChange').addEventListener('input', (e) => {
    $('fxChangeOut').textContent = (e.target.value > 0 ? '+' : '') + e.target.value + '%';
    render();
  });
  $('rateShock').addEventListener('input', (e) => {
    $('rateShockOut').textContent = (e.target.value > 0 ? '+' : '') + e.target.value + ' bp';
    render();
  });

  const tog = $('consoleToggle');
  tog.addEventListener('click', () => {
    const open = tog.getAttribute('aria-expanded') === 'true';
    tog.setAttribute('aria-expanded', open ? 'false' : 'true');
    $('consoleBody').dataset.open = open ? '0' : '1';
  });

  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(render, 150); });
}

async function boot() {
  try {
    const res = await fetch('data/bonds.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    state.data = await res.json();
  } catch (err) {
    $('heroSummary').textContent = '讀不到報價資料。請確認 GitHub Action 已經跑過一次並產生 docs/data/bonds.json。';
    return;
  }

  // 牌告匯率是加分項，抓不到就沿用 FX_DEFAULT，不影響其他功能
  try {
    const fxRes = await fetch('data/fx.json', { cache: 'no-cache' });
    if (fxRes.ok) state.fx = await fxRes.json();
  } catch (err) {
    state.fx = null;
  }

  state.bonds = state.data.bonds;
  const usd = fxDefault('USD');
  if (usd) $('fxRate').value = usd;

  const d = new Date(state.data.generated_at);
  $('metaTime').textContent = isNaN(d) ? state.data.generated_at
    : `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  $('metaCount').textContent = `${state.data.count} 檔，${state.data.priced_count} 檔可算殖利率`;

  buildCcyFilter();
  wire();
  render();

  // 預設選第一檔，讓分析面板一載入就有東西看
  if (state.view.length) select(state.view[0].code);
}

if (typeof document !== 'undefined') boot();

/* 讓計算邏輯可以在 Node 下被測試，瀏覽器環境不受影響 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    monthlyPayment, balanceAfter, irr, fundingCost,
    computeCouponTimes, exitProceeds, simulate, breakevenFx,
  };
}
