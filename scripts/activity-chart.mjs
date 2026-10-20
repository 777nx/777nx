/**
 * 生成自托管的「活动曲线」卡片 SVG（深浅两套）。
 * 零第三方依赖、不需要 PAT：数据全部来自公开接口。
 *
 *   1) assets/contrib-data.json —— contrib-heatmap.mjs 产出的近一年每日贡献量
 *      → 主图：近 12 个月的圆角柱状图（带渐变、数值标注、月标签、网格线）
 *   2) GitHub 公开事件 API（近 90 天，最多 3 页 × 100 条）
 *      → 底部：活动构成分段条 + 图例（Push / PR / Issue / 评论 / Review / 其他）
 *
 * 事件接口取不到时底部构成栏自动省略，卡片高度同步收缩，不报错。
 *
 * 用法：GH_TOKEN=xxx node scripts/activity-chart.mjs
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

const LOGIN = process.env.GH_LOGIN || '777nx';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const OUT_DIR = 'assets';
const DATA_FILE = OUT_DIR + '/contrib-data.json';
const EVENT_DAYS = 90;
const MONTHS = 12;

const THEMES = {
  dark: {
    suffix: '',
    canvas: '#0d1117',
    border: '#30363d',
    text: '#8b949e',
    strong: '#c9d1d9',
    grid: '#21262d',
    barTop: '#39d353',
    barBottom: '#26a641',
    dash: '#58a6ff',
    barZero: '#21262d',
    track: '#161b22',
    seg: ['#39d353', '#58a6ff', '#d29922', '#a371f7', '#f778ba', '#6e7681'],
  },
  light: {
    suffix: '-light',
    canvas: '#ffffff',
    border: '#d0d7de',
    text: '#57606a',
    strong: '#24292f',
    grid: '#eaeef2',
    barTop: '#2da44e',
    barBottom: '#1a7f37',
    dash: '#0969da',
    barZero: '#eaeef2',
    track: '#f6f8fa',
    seg: ['#2da44e', '#0969da', '#bf8700', '#8250df', '#bf3989', '#8c959f'],
  },
};

const iso = (d) => d.toISOString().slice(0, 10);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r1 = (n) => Math.round(n * 10) / 10;
const estWidth = (s, cjk = 11) => [...String(s)].reduce((w, c) => w + (c.charCodeAt(0) < 128 ? 6.8 : cjk), 0);

// ---------- 每日贡献 ----------
const daily = new Map();
if (existsSync(DATA_FILE)) {
  try {
    const json = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    for (const d of json.days || []) daily.set(d.date, d.count);
  } catch { /* ignore */ }
}

// ---------- 事件构成 ----------
const EVENT_TYPES = [
  { key: 'push', label: 'Push', match: (t) => t === 'PushEvent' },
  { key: 'pr', label: 'Pull Request', match: (t) => t === 'PullRequestEvent' },
  { key: 'issue', label: 'Issue', match: (t) => t === 'IssuesEvent' },
  { key: 'comment', label: '评论', match: (t) => t === 'IssueCommentEvent' },
  { key: 'review', label: 'Review', match: (t) => t === 'PullRequestReviewEvent' },
  { key: 'other', label: '其他', match: () => true },
];

async function fetchEvents() {
  const headers = { 'user-agent': 'activity-chart', accept: 'application/vnd.github+json' };
  if (TOKEN) headers.authorization = 'bearer ' + TOKEN;
  const events = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const res = await fetch('https://api.github.com/users/' + LOGIN + '/events/public?per_page=100&page=' + page, { headers });
      if (!res.ok) break;
      const chunk = await res.json();
      if (!Array.isArray(chunk) || !chunk.length) break;
      events.push(...chunk);
    } catch {
      break;
    }
  }
  return events;
}

const events = await fetchEvents();
const since = new Date();
since.setUTCDate(since.getUTCDate() - EVENT_DAYS);
const evCounts = new Map(EVENT_TYPES.map((t) => [t.key, 0]));
let eventTotal = 0;
for (const e of events) {
  if (new Date(e.created_at) < since) continue;
  const bucket = EVENT_TYPES.find((t) => t.match(e.type));
  if (!bucket) continue;
  evCounts.set(bucket.key, evCounts.get(bucket.key) + 1);
  eventTotal++;
}
const hasEvents = eventTotal > 0;
const segments = EVENT_TYPES
  .map((t, i) => ({ label: t.label, value: evCounts.get(t.key), color: t.key }))
  .filter((s) => s.value > 0);

// ---------- 近 12 个月聚合 ----------
const today = new Date();
const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
const months = [];
for (let i = MONTHS - 1; i >= 0; i--) {
  const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
  months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth(), total: 0, days: 0 });
}
for (const [date, count] of daily) {
  const [y, m] = date.split('-').map(Number);
  const hit = months.find((x) => x.year === y && x.month === m - 1);
  if (!hit) continue;
  hit.total += count;
  if (count > 0) hit.days++;
}
const totals = months.map((m) => m.total);
const grandTotal = totals.reduce((a, b) => a + b, 0);
const maxMonth = Math.max(1, ...totals);
const peakIdx = totals.indexOf(Math.max(...totals));
const peakMonth = months[peakIdx];
const activeMonths = totals.filter((v) => v > 0).length;
const monthLabel = (m) => (m.month + 1) + '月';

// ---------- 版式 ----------
const W = 811;
const PAD = 26;
const TITLE_Y = 30;
const STAT_Y = 52;
const FOOT = hasEvents ? 92 : 40;              // 底部构成栏占用的高度
const baseline = 196;                           // 柱状图基线
const chartTop = 78;
const GH = baseline - chartTop;
const X0 = PAD + 30;                            // 左侧留出 y 轴数字
const X1 = W - PAD;
const GW = X1 - X0;
const barGap = 12;
const barW = (GW - barGap * (MONTHS - 1)) / MONTHS;
const H = baseline + FOOT;

const statLine = '近 12 个月 ' + grandTotal + ' 次贡献 · 活跃 ' + activeMonths + '/' + MONTHS + ' 个月 · 单月最高 '
  + peakMonth.total + ' 次（' + peakMonth.year + ' 年 ' + monthLabel(peakMonth) + '）';

const render = (C) => {
  const p = [];
  p.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(LOGIN) + ' 的活动曲线">');
  p.push('<defs><linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0%" stop-color="' + C.barTop + '"/><stop offset="100%" stop-color="' + C.barBottom + '" stop-opacity="0.55"/>'
    + '</linearGradient></defs>');
  p.push('<style>'
    + '.t{font:12px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:' + C.text + '}'
    + '.t2{font:600 15px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:' + C.strong + '}'
    + '.t3{font:11px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:' + C.text + '}'
    + '.v{font:600 11px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:' + C.barTop + '}'
    + '.m{font:11px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:' + C.strong + '}'
    + '</style>');
  p.push('<rect x="0.5" y="0.5" width="' + (W - 1) + '" height="' + (H - 1) + '" rx="12" fill="' + C.canvas + '" stroke="' + C.border + '"/>');
  p.push('<text x="' + PAD + '" y="' + TITLE_Y + '" class="t2">活动曲线</text>');
  p.push('<text x="' + (W - PAD) + '" y="' + TITLE_Y + '" class="t3" text-anchor="end">柱＝每月贡献 · 线＝累计贡献</text>');
  p.push('<text x="' + PAD + '" y="' + STAT_Y + '" class="t">' + esc(statLine) + '</text>');

  // y 轴网格（只留 3 档，数字放左边）
  const ticks = [0, 0.5, 1];
  for (const f of ticks) {
    const y = r1(baseline - f * GH);
    p.push('<line x1="' + X0 + '" y1="' + y + '" x2="' + X1 + '" y2="' + y + '" stroke="' + C.grid + '" stroke-width="1"' + (f === 0 ? '' : ' stroke-dasharray="3 4"') + '/>');
    p.push('<text x="' + (X0 - 8) + '" y="' + (y + 4) + '" class="t3" text-anchor="end">' + Math.round(maxMonth * f) + '</text>');
  }

  // 柱子
  months.forEach((m, i) => {
    const x = r1(X0 + i * (barW + barGap));
    const v = m.total;
    const h = v === 0 ? 3 : Math.max(6, Math.round((v / maxMonth) * GH));
    const y = r1(baseline - h);
    p.push('<rect x="' + x + '" y="' + y + '" width="' + r1(barW) + '" height="' + h + '" rx="' + Math.min(6, r1(barW / 2)) + '" fill="'
      + (v === 0 ? C.barZero : 'url(#bar)') + '"' + (v === 0 ? ' fill-opacity="0.9"' : '') + '/>');
    if (v > 0) p.push('<text x="' + r1(x + barW / 2) + '" y="' + (y - 7) + '" class="v" text-anchor="middle">' + v + '</text>');
    p.push('<text x="' + r1(x + barW / 2) + '" y="' + (baseline + 18) + '" class="' + (v > 0 ? 'm' : 't3') + '" text-anchor="middle">' + monthLabel(m) + '</text>');
  });
  // 累计贡献曲线（柱状图之上的折线，填满纵向空间并给出趋势）
  const cum = [];
  let run = 0;
  for (const v of totals) { run += v; cum.push(run); }
  const cumMax = Math.max(1, grandTotal);
  const cpx = (i) => r1(X0 + i * (barW + barGap) + barW / 2);
  const cpy = (v) => r1(baseline - (v / cumMax) * GH);
  const cumPath = cum.map((v, i) => (i ? 'L' : 'M') + cpx(i) + ',' + cpy(v)).join(' ');
  const cumArea = cumPath + ' L' + cpx(cum.length - 1) + ',' + baseline + ' L' + cpx(0) + ',' + baseline + ' Z';
  p.push('<path d="' + cumArea + '" fill="' + C.dash + '" fill-opacity="0.07" stroke="none"/>');
  p.push('<path d="' + cumPath + '" fill="none" stroke="' + C.dash + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
  cum.forEach((v, i) => {
    p.push('<circle cx="' + cpx(i) + '" cy="' + cpy(v) + '" r="2.6" fill="' + C.canvas + '" stroke="' + C.dash + '" stroke-width="1.6"/>');
  });

  p.push('<line x1="' + X0 + '" y1="' + baseline + '" x2="' + X1 + '" y2="' + baseline + '" stroke="' + C.border + '"/>');

  // 底部活动构成
  if (hasEvents) {
    const y0 = baseline + 44;
    p.push('<text x="' + PAD + '" y="' + y0 + '" class="t3">近 ' + EVENT_DAYS + ' 天活动构成 · 共 ' + eventTotal + ' 条</text>');
    const barY = y0 + 10;
    const totalW = X1 - PAD;
    let cx = PAD;
    segments.forEach((s, i) => {
      const w = Math.max(3, r1((s.value / eventTotal) * (totalW - segments.length * 3)));
      p.push('<rect x="' + r1(cx) + '" y="' + barY + '" width="' + w + '" height="8" rx="4" fill="' + C.seg[EVENT_TYPES.findIndex((t) => t.key === s.color)] + '"/>');
      cx += w + 3;
    });
    // 图例
    const legendY = barY + 30;
    let lx = PAD;
    segments.forEach((s) => {
      const color = C.seg[EVENT_TYPES.findIndex((t) => t.key === s.color)];
      const text = s.label + ' ' + s.value;
      p.push('<circle cx="' + r1(lx + 4) + '" cy="' + (legendY - 4) + '" r="4" fill="' + color + '"/>');
      p.push('<text x="' + r1(lx + 14) + '" y="' + legendY + '" class="t3">' + esc(text) + '</text>');
      lx += 14 + estWidth(text) + 22;
    });
  }

  p.push('<text x="' + (W - PAD) + '" y="' + (H - 16) + '" class="t3" text-anchor="end">由 GitHub Actions 自动生成 · ' + iso(end) + '</text>');
  p.push('</svg>');
  return p.join('');
};

mkdirSync(OUT_DIR, { recursive: true });
for (const [, C] of Object.entries(THEMES)) {
  writeFileSync(OUT_DIR + '/activity' + C.suffix + '.svg', render(C));
}
console.log('✔ ' + OUT_DIR + '/activity.svg + activity-light.svg  ' + W + 'x' + H
  + '  近 12 个月 ' + grandTotal + ' 次 · 活跃 ' + activeMonths + ' 个月 · 单月最高 ' + peakMonth.total
  + ' · 近 ' + EVENT_DAYS + ' 天事件 ' + eventTotal + (hasEvents ? '' : '（构成栏省略）'));
