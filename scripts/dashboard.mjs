/**
 * 生成自托管的「GitHub 数据看板」卡片 SVG（深浅两套）。
 * 布局参考 lowlighter/metrics 的 classic 卡片：左侧指标列表 + 右侧多序列曲线 + 底部语言占比条，
 * 但**不依赖任何第三方 Action、不需要 PAT**，数据全部取自 GitHub 公开接口：
 *
 *   - /users/<user>                      → 关注者、公开仓库、昵称
 *   - /users/<user>/repos（3 页）        → 总 Star、复刻数（排除 fork）
 *   - /users/<user>/starred?per_page=1   → 自己 Star 过的仓库数（读 Link 头 last 页）
 *   - /search/issues  (author / reviewed-by) → 提交的 PR、Issue、Code Review 数
 *   - /search/commits (author)           → 提交数
 *   - /users/<user>/events/public（3 页）→ 右侧「近 13 周各类活动」的多序列曲线
 *   - /repos/<user>/<repo>/languages     → 底部语言占比条（按字节，取 Star 最高的若干净库）
 *   - assets/contrib-data.json           → 近一年贡献（由 contrib-heatmap.mjs 生成）
 *
 * 任一接口失败只让对应那一行显示 “—”，不会让整张卡片失败。
 *
 * 用法：GH_TOKEN=xxx node scripts/dashboard.mjs        # token 可选，有则限流更宽松
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

const LOGIN = process.env.GH_LOGIN || '777nx';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const OUT_DIR = 'assets';
const DATA_FILE = OUT_DIR + '/contrib-data.json';
const EVENT_WEEKS = 13;
const LANG_REPOS = 8;
// 生成的产物站（public/ 目录被提交过）会以 HTML 淹没语言占比，默认忽略；
// 想统计它就把下面这行改成 [] 或加上自己的仓库名。
const IGNORED_REPOS = ['777nx.github.io'];

const THEMES = {
  dark: {
    suffix: '',
    canvas: '#0d1117',
    border: '#30363d',
    text: '#8b949e',
    strong: '#c9d1d9',
    grid: '#21262d',
    icon: '#8b949e',
    series: ['#39d353', '#58a6ff', '#d29922', '#a371f7', '#f778ba', '#6e7681'],
  },
  light: {
    suffix: '-light',
    canvas: '#ffffff',
    border: '#d0d7de',
    text: '#57606a',
    strong: '#24292f',
    grid: '#eaeef2',
    icon: '#57606a',
    series: ['#2da44e', '#0969da', '#bf8700', '#8250df', '#bf3989', '#8c959f'],
  },
};

const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', HTML: '#e34c26', CSS: '#563d7c', SCSS: '#c6538c',
  Stylus: '#ff6347', Pug: '#a86454', Vue: '#41b883', Python: '#3572a5', Java: '#b07219',
  'C#': '#178600', 'C++': '#f34b7d', C: '#555555', Rust: '#dea584', Go: '#00add8',
  Shell: '#89e051', Ruby: '#701516', PHP: '#4f5d95', MATLAB: '#e16737', Kotlin: '#a97bff',
  Swift: '#f05138', Lua: '#000080', Dockerfile: '#384d54', EJS: '#a91e50', Less: '#1d365d',
};
const FALLBACK_LANG = '#8c959f';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const iso = (d) => d.toISOString().slice(0, 10);
const r1 = (n) => Math.round(n * 10) / 10;
// 粗略估算文本宽度（ASCII≈6.8px，中文≈11px）：只用于图例排布，宁可估大
const estWidth = (s, cjk = 11) => [...String(s)].reduce((w, c) => w + (c.charCodeAt(0) < 128 ? 6.8 : cjk), 0);

const num = (n) => (n === null || n === undefined ? '—' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','));

const HEADERS = { 'user-agent': 'dashboard-card', accept: 'application/vnd.github+json' };
if (TOKEN) HEADERS.authorization = 'bearer ' + TOKEN;

async function api(url, asText) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    return asText ? { text: await res.text(), headers: res.headers } : await res.json();
  } catch {
    return null;
  }
}
const countLast = (link) => { const m = /[?&]page=(\d+)>; rel="last"/.exec(link || ''); return m ? Number(m[1]) : null; };

// ---------- 采集 ----------
const user = await api('https://api.github.com/users/' + LOGIN);
if (!user) {
  // 限流 / 断网时保留旧卡片，避免定时任务把线上看板清空
  console.error('⚠ 无法读取 GitHub 用户数据（可能触发限流），保留原有看板不做修改');
  process.exit(0);
}
const reposRaw = [];
for (let page = 1; page <= 3; page++) {
  const chunk = await api('https://api.github.com/users/' + LOGIN + '/repos?per_page=100&page=' + page + '&sort=pushed');
  if (!Array.isArray(chunk) || !chunk.length) break;
  reposRaw.push(...chunk);
}
const owned = reposRaw.filter((r) => !r.fork);
const stars = owned.reduce((s, r) => s + r.stargazers_count, 0);
const forks = owned.reduce((s, r) => s + r.forks_count, 0);

const starredRes = await api('https://api.github.com/users/' + LOGIN + '/starred?per_page=1', true);
const starredCount = starredRes ? countLast(starredRes.headers.get('link')) : null;

const searchCount = async (q) => {
  const j = await api('https://api.github.com/search/' + (q.commits ? 'commits' : 'issues') + '?q=' + encodeURIComponent(q.q) + '&per_page=1');
  return j && typeof j.total_count === 'number' ? j.total_count : null;
};
const [prCount, issueCount, reviewCount, commitCount] = await Promise.all([
  searchCount({ q: 'author:' + LOGIN + ' type:pr' }),
  searchCount({ q: 'author:' + LOGIN + ' type:issue' }),
  searchCount({ q: 'reviewed-by:' + LOGIN }),
  searchCount({ q: 'author:' + LOGIN, commits: true }),
]);

let contribTotal = null;
if (existsSync(DATA_FILE)) {
  try { contribTotal = JSON.parse(readFileSync(DATA_FILE, 'utf8')).total; } catch { /* ignore */ }
}

// 近一年贡献（没有快照时退回 null）
const events = [];
for (let page = 1; page <= 3; page++) {
  const chunk = await api('https://api.github.com/users/' + LOGIN + '/events/public?per_page=100&page=' + page);
  if (!Array.isArray(chunk) || !chunk.length) break;
  events.push(...chunk);
}

const SERIES = [
  { key: 'push', label: 'Push', match: (t) => t === 'PushEvent' },
  { key: 'pr', label: 'Pull Request', match: (t) => t === 'PullRequestEvent' },
  { key: 'issue', label: 'Issue', match: (t) => t === 'IssuesEvent' },
  { key: 'comment', label: '评论', match: (t) => t === 'IssueCommentEvent' },
  { key: 'review', label: 'Review', match: (t) => t === 'PullRequestReviewEvent' },
  { key: 'other', label: '其他', match: () => true },
];
const today = new Date();
const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
const buckets = [];
for (let i = EVENT_WEEKS - 1; i >= 0; i--) {
  const bucketEnd = new Date(end);
  bucketEnd.setUTCDate(bucketEnd.getUTCDate() - i * 7);
  const bucketStart = new Date(bucketEnd);
  bucketStart.setUTCDate(bucketStart.getUTCDate() - 6);
  buckets.push({ start: bucketStart, end: bucketEnd, counts: SERIES.map(() => 0) });
}
for (const e of events) {
  const d = new Date(e.created_at);
  const idx = buckets.findIndex((b) => d >= b.start && d <= b.end);
  if (idx < 0) continue;
  const t = SERIES.findIndex((s) => s.match(e.type));
  if (t < 0) continue;
  buckets[idx].counts[t]++;
}
const seriesTotals = SERIES.map((_, t) => buckets.reduce((s, b) => s + b.counts[t], 0));
const activeSeries = SERIES.map((s, i) => ({ ...s, i, total: seriesTotals[i] })).filter((s) => s.total > 0);
const maxSeries = Math.max(1, ...buckets.flatMap((b) => b.counts));

// 语言占比（按字节）
const langRepos = owned.filter((r) => !IGNORED_REPOS.includes(r.name)).sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, LANG_REPOS);
const langBytes = {};
for (const r of langRepos) {
  const m = await api('https://api.github.com/repos/' + LOGIN + '/' + r.name + '/languages');
  if (!m) continue;
  for (const [k, v] of Object.entries(m)) langBytes[k] = (langBytes[k] || 0) + v;
}
const langSum = Object.values(langBytes).reduce((a, b) => a + b, 0);
const langs = Object.entries(langBytes).sort((a, b) => b[1] - a[1]).slice(0, 5)
  .map(([name, bytes]) => ({ name, pct: langSum ? r1((bytes / langSum) * 100) : 0 }));

// ---------- 版式 ----------
const W = 811;
const PAD = 26;
const ROW_H = 24;
const ROWS = [
  { icon: 'star', label: 'Stars Earned（收获的 Star）', value: stars },
  { icon: 'starline', label: 'Starred Repos（我 Star 的）', value: starredCount },
  { icon: 'repo', label: 'Public Repos（公开仓库）', value: user ? user.public_repos : null },
  { icon: 'users', label: 'Followers（关注者）', value: user ? user.followers : null },
  { icon: 'commit', label: 'Commits（提交）', value: commitCount },
  { icon: 'issue', label: 'Issues（议题）', value: issueCount && issueCount > 0 ? issueCount : null },
  { icon: 'pr', label: 'Pull Requests', value: prCount && prCount > 0 ? prCount : null },
  { icon: 'flame', label: '近一年贡献', value: contribTotal },
].filter((r) => r.value !== null && r.value !== undefined);

const LEFT_W = 300;
const CHART_X0 = PAD + LEFT_W + 30;
const CHART_X1 = W - PAD;
const GW = CHART_X1 - CHART_X0;
const CHART_TOP = 104;
const CHART_BOTTOM = 230;
const GH = CHART_BOTTOM - CHART_TOP;
const LANG_TOP = CHART_BOTTOM + 46;
const H = LANG_TOP + (langs.length ? 62 : 24);

const icon = (kind, x, y, C) => {
  const s = 'stroke="' + C.icon + '" stroke-width="1.3" fill="none"';
  switch (kind) {
    case 'star':
      return '<path transform="translate(' + x + ',' + y + ')" d="M6 0.8 7.6 4.2 11.3 4.7 8.6 7.3 9.3 11 6 9.2 2.7 11 3.4 7.3 0.7 4.7 4.4 4.2 Z" fill="' + C.icon + '" fill-opacity="0.85" stroke="none"/>';
    case 'starline':
      return '<path transform="translate(' + x + ',' + y + ')" d="M6 0.8 7.6 4.2 11.3 4.7 8.6 7.3 9.3 11 6 9.2 2.7 11 3.4 7.3 0.7 4.7 4.4 4.2 Z" ' + s + '/>';
    case 'repo':
      return '<g transform="translate(' + x + ',' + y + ')"><path d="M1.2 1.2h7.2v9.6H1.2z" ' + s + '/><path d="M3.4 1.2v9.6" ' + s + '/></g>';
    case 'users':
      return '<g transform="translate(' + x + ',' + y + ')"><circle cx="6" cy="4" r="2.4" ' + s + '/><path d="M1.4 11c0-2.4 2-3.8 4.6-3.8S10.6 8.6 10.6 11" ' + s + '/></g>';
    case 'commit':
      return '<g transform="translate(' + x + ',' + y + ')"><circle cx="6" cy="6" r="3.6" ' + s + '/><path d="M0 6h2.4M9.6 6H12" ' + s + '/></g>';
    case 'issue':
      return '<g transform="translate(' + x + ',' + y + ')"><circle cx="6" cy="6" r="4.6" ' + s + '/><circle cx="6" cy="6" r="1.4" fill="' + C.icon + '"/></g>';
    case 'pr':
      return '<g transform="translate(' + x + ',' + y + ')"><circle cx="2.6" cy="2.6" r="1.8" ' + s + '/><circle cx="2.6" cy="9.4" r="1.8" ' + s + '/><circle cx="9.4" cy="9.4" r="1.8" ' + s + '/><path d="M2.6 4.4v3.2M9.4 7.6V4.4c0-1.2-1-1.8-2.6-1.8H5.4" ' + s + '/></g>';
    case 'flame':
      return '<path transform="translate(' + x + ',' + y + ')" d="M6 0.6c2.4 2.6 4 4.4 4 6.8A4 4 0 0 1 2 7.4C2 5 3.6 3.2 6 0.6Z" fill="' + C.icon + '" fill-opacity="0.85" stroke="none"/>';
    default:
      return '';
  }
};

const render = (C) => {
  const p = [];
  p.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(LOGIN) + ' 的 GitHub 数据看板">');
  p.push('<style>'
    + '.t{font:12px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:' + C.text + '}'
    + '.t2{font:600 15px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:' + C.strong + '}'
    + '.t3{font:11px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:' + C.text + '}'
    + '.k{font:12px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:' + C.text + '}'
    + '.v{font:600 14px -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:' + C.strong + '}'
    + '</style>');
  p.push('<rect x="0.5" y="0.5" width="' + (W - 1) + '" height="' + (H - 1) + '" rx="12" fill="' + C.canvas + '" stroke="' + C.border + '"/>');
  p.push('<text x="' + PAD + '" y="30" class="t2">' + esc((user && user.name) || LOGIN) + ' 的 GitHub 数据看板</text>');
  p.push('<text x="' + (W - PAD) + '" y="30" class="t3" text-anchor="end">数据源 GitHub 公开 API</text>');
  p.push('<line x1="' + PAD + '" y1="44" x2="' + (W - PAD) + '" y2="44" stroke="' + C.border + '"/>');

  // 左侧指标
  ROWS.forEach((row, i) => {
    const y = 70 + i * ROW_H;
    p.push(icon(row.icon, PAD + 2, y - 10, C));
    p.push('<text x="' + (PAD + 24) + '" y="' + (y + 1) + '" class="k">' + esc(row.label) + '</text>');
    p.push('<text x="' + (PAD + LEFT_W) + '" y="' + (y + 2) + '" class="v" text-anchor="end">' + num(row.value) + '</text>');
  });

  // 右侧图例：先算总宽，能一行放下就一行（在图表宽度内均匀居中），
  // 放不下才折成多行，且每行也按实际宽度均分，避免出现「第二行只有一个」的丑布局
  const legendItems = activeSeries.map((s) => ({ label: s.label, color: C.series[s.i], w: 14 + estWidth(s.label, 11) }));
  const gapX = 20;
  const totalW = legendItems.reduce((sum, it) => sum + it.w, 0) + gapX * (legendItems.length - 1);
  const rows = totalW <= GW ? [legendItems] : (() => {
    const half = Math.ceil(legendItems.length / 2);
    return [legendItems.slice(0, half), legendItems.slice(half)];
  })();
  rows.forEach((row, ri) => {
    const rowW = row.reduce((sum, it) => sum + it.w, 0) + gapX * (row.length - 1);
    let lx = r1(CHART_X0 + Math.max(0, (GW - rowW) / 2));
    const ly = 60 + ri * 17;
    row.forEach((it) => {
      p.push('<circle cx="' + r1(lx + 4) + '" cy="' + (ly - 4) + '" r="4" fill="' + it.color + '"/>');
      p.push('<text x="' + r1(lx + 14) + '" y="' + ly + '" class="t3">' + esc(it.label) + '</text>');
      lx += it.w + gapX;
    });
  });

  // 图表网格
  for (const f of [0, 0.5, 1]) {
    const y = r1(CHART_BOTTOM - f * GH);
    p.push('<line x1="' + CHART_X0 + '" y1="' + y + '" x2="' + CHART_X1 + '" y2="' + y + '" stroke="' + C.grid + '" stroke-width="1"' + (f === 0 ? '' : ' stroke-dasharray="3 4"') + '/>');
    p.push('<text x="' + (CHART_X0 - 8) + '" y="' + (y + 4) + '" class="t3" text-anchor="end">' + Math.round(maxSeries * f) + '</text>');
  }

  // 多序列曲线
  const px = (i) => r1(CHART_X0 + (i / (EVENT_WEEKS - 1)) * GW);
  const py = (v) => r1(CHART_BOTTOM - (v / maxSeries) * GH);
  for (const s of activeSeries) {
    const d = buckets.map((b, i) => (i ? 'L' : 'M') + px(i) + ',' + py(b.counts[s.i])).join(' ');
    p.push('<path d="' + d + '" fill="none" stroke="' + C.series[s.i] + '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>');
    buckets.forEach((b, i) => {
      if (b.counts[s.i] > 0) p.push('<circle cx="' + px(i) + '" cy="' + py(b.counts[s.i]) + '" r="2.4" fill="' + C.canvas + '" stroke="' + C.series[s.i] + '" stroke-width="1.5"/>');
    });
  }
  p.push('<line x1="' + CHART_X0 + '" y1="' + CHART_BOTTOM + '" x2="' + CHART_X1 + '" y2="' + CHART_BOTTOM + '" stroke="' + C.border + '"/>');
  buckets.forEach((b, i) => {
    if (i % 2 !== 0) return;
    const d = b.end;
    p.push('<text x="' + px(i) + '" y="' + (CHART_BOTTOM + 16) + '" class="t3" text-anchor="middle">' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '</text>');
  });
  p.push('<text x="' + CHART_X0 + '" y="' + (CHART_TOP - 12) + '" class="t3">近 ' + EVENT_WEEKS + ' 周各类活动（按周）</text>');

  // 底部语言占比
  if (langs.length) {
    p.push('<line x1="' + PAD + '" y1="' + (LANG_TOP - 22) + '" x2="' + (W - PAD) + '" y2="' + (LANG_TOP - 22) + '" stroke="' + C.border + '"/>');
    p.push('<text x="' + PAD + '" y="' + LANG_TOP + '" class="t3">常用语言（按字节 · 统计 Star 最高的 ' + langRepos.length + ' 个原创仓库）</text>');
    const barY = LANG_TOP + 10;
    const totalW = W - PAD * 2;
    let cx = PAD;
    langs.forEach((l, i) => {
      const w = Math.max(3, r1((l.pct / 100) * (totalW - (langs.length - 1) * 3)));
      p.push('<rect x="' + r1(cx) + '" y="' + barY + '" width="' + w + '" height="8" rx="4" fill="' + (LANG_COLORS[l.name] || FALLBACK_LANG) + '"/>');
      cx += w + 3;
    });
    let lx = PAD;
    langs.forEach((l) => {
      const text = l.name + ' ' + l.pct + '%';
      p.push('<circle cx="' + r1(lx + 4) + '" cy="' + (barY + 26) + '" r="4" fill="' + (LANG_COLORS[l.name] || FALLBACK_LANG) + '"/>');
      p.push('<text x="' + r1(lx + 14) + '" y="' + (barY + 30) + '" class="t3">' + esc(text) + '</text>');
      lx += 14 + [...text].reduce((w, ch) => w + (ch.charCodeAt(0) < 128 ? 6.8 : 11), 0) + 22;
    });
  }

  p.push('<text x="' + (W - PAD) + '" y="' + (H - 14) + '" class="t3" text-anchor="end">由 GitHub Actions 自动生成 · ' + iso(end) + '</text>');
  p.push('</svg>');
  return p.join('');
};

mkdirSync(OUT_DIR, { recursive: true });
for (const [, C] of Object.entries(THEMES)) {
  writeFileSync(OUT_DIR + '/dashboard' + C.suffix + '.svg', render(C));
}
console.log('✔ ' + OUT_DIR + '/dashboard.svg + dashboard-light.svg  ' + W + 'x' + H
  + '  指标 ' + ROWS.length + ' 行 · 曲线 ' + activeSeries.length + ' 条 · 语言 ' + langs.length + ' 项'
  + '  [Star ' + stars + ' · 关注者 ' + (user ? user.followers : '—') + ' · 提交 ' + num(commitCount) + ']');
