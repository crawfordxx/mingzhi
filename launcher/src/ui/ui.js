/* 启动器进度页脚本：每秒轮询 /api/state；命令 POST /api/retry|restart|settings（带 X-Mingzhi 头） */
'use strict';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const POLL_MS = 1000;
/* 启动阶段与检查阶段轮询更勤，二次启动时尽快跳转 */
const POLL_FAST_MS = 200;
const GROUPS = [['runtime', '运行环境'], ['model', '本地模型'], ['asset', '配乐与字体']];

let S = null, lost = 0, leaving = false, shownPct = 0, pctAnim = null, panel = null;
let hadWork = false, firstState = true;
const rows = new Map();           // id → { root, refs, phase }
const logLines = [];              // 终端已打印的行
const loggedStages = new Set();

/* ---------- 格式化 ---------- */
const MB = 1024 * 1024;
function size(b) { if (b >= 1024 * MB) return (b / 1024 / MB).toFixed(2) + ' GB'; if (b >= 100 * MB) return Math.round(b / MB) + ' MB'; if (b >= MB) return (b / MB).toFixed(1) + ' MB'; return Math.max(1, Math.round(b / 1024)) + ' KB'; }
function speed(bps) { return bps >= MB ? (bps / MB).toFixed(1) + ' MB/s' : Math.round(bps / 1024) + ' KB/s'; }
function eta(sec) {
  if (sec == null || !isFinite(sec)) return '';
  if (sec < 5) return '马上好';
  if (sec < 60) return '约 ' + Math.ceil(sec / 5) * 5 + ' 秒';
  if (sec < 600) { const m = Math.floor(sec / 60), s = Math.round((sec % 60) / 10) * 10; return '约 ' + m + ' 分' + (s ? ' ' + s + ' 秒' : '钟'); }
  return '约 ' + Math.round(sec / 60) + ' 分钟';
}
function duration(ms) { const sec = Math.max(1, Math.round(ms / 1000)); return sec < 60 ? sec + ' 秒' : Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒'; }
function shortEta(sec) { if (sec == null || !isFinite(sec)) return ''; if (sec < 60) return Math.max(1, Math.ceil(sec)) + ' 秒'; return Math.ceil(sec / 60) + ' 分'; }

/* ---------- 请求 ---------- */
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'X-Mingzhi': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : '' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}
async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    S = await r.json(); lost = 0; render(S);
  } catch (e) {
    if (++lost >= 3) renderLost();
  } finally {
    const fast = S && (S.stage === 'starting' || (S.stage === 'preparing' && !S.items.some((i) => i.needed)));
    if (!leaving) setTimeout(poll, fast || !S ? POLL_FAST_MS : POLL_MS);
  }
}

/* ---------- 文案切换（淡出淡入） ---------- */
let headKey = '';
function setHead(key, title, accent, sub) {
  if (key === headKey) { $('#sub').textContent = sub; return; }
  const box = $('#headline'); const first = !headKey; headKey = key;
  const apply = () => {
    const h = $('#h1'); h.textContent = title;
    if (accent) { h.append(' '); h.append(el('span', 'it', accent)); }
    $('#sub').textContent = sub; box.classList.remove('out');
  };
  if (first) return apply();
  box.classList.add('out'); setTimeout(apply, 220);
}

/* ---------- 行 ---------- */
function icon() {
  const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('class', 'ico'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<circle class="trk" cx="10" cy="10" r="8"/><circle class="arc" cx="10" cy="10" r="8"/><circle class="dot" cx="10" cy="10" r="9"/>' +
    '<path class="ok" d="M6.2 10.2l2.6 2.6 5-5.2"/><rect class="bang" x="9.1" y="5" width="1.8" height="6.4" rx=".9"/><circle class="bang" cx="10" cy="14.2" r="1.05"/>' +
    '<path class="clock" d="M10 6.2V10l2.4 1.6"/>';
  return svg;
}
function makeRow(it) {
  const root = el('div', 'row'); root.dataset.id = it.id;
  const ico = icon();
  const name = el('div', 'nm'); name.append(el('span', '', it.name)); const sz = el('span', 'sz', size(it.size)); name.append(sz);
  const st = el('div', 'st'); const line = el('i', 'line'); const bar = el('b'); line.append(bar);
  root.append(ico, name, st, line);
  return { root, ico, st, bar, phase: null };
}
const PHASE_CLASS = { checking: 'is-check', waiting: 'is-wait', downloading: 'is-dl', installing: 'is-inst', ready: 'is-ready', done: 'is-ok', failed: 'is-fail', deferred: 'is-defer' };
function rowText(it) {
  switch (it.phase) {
    case 'checking': return it.optional ? '稍后' : '检查中';
    case 'waiting': return '排队中';
    case 'downloading': {
      const p = it.size ? Math.floor((it.downloaded / it.size) * 100) : 0;
      if (!it.bytesPerSec) return p + '% · 连接中';
      return p + '% · ' + speed(it.bytesPerSec) + ' · 剩 ' + shortEta((it.size - it.downloaded) / it.bytesPerSec);
    }
    case 'installing': return '校验解包';
    case 'ready': return '已就绪';
    case 'done': return '已完成';
    case 'failed': return it.problem ? it.problem.title : '失败';
    case 'deferred': return '稍后补齐';
  }
  return '';
}
function updateRow(r, it) {
  const cls = PHASE_CLASS[it.phase] || '';
  if (r.phase !== it.phase) {
    r.root.className = 'row ' + cls;
    if (it.phase === 'done' && r.phase && r.phase !== 'done') { r.root.classList.add('flash'); }
    r.phase = it.phase;
  }
  const frac = it.phase === 'done' || it.phase === 'ready' || it.phase === 'installing' ? 1 : it.size ? Math.min(1, it.downloaded / it.size) : 0;
  r.bar.style.width = (frac * 100).toFixed(2) + '%';
  r.ico.querySelector('.arc').style.strokeDashoffset = (50.27 * (1 - (it.phase === 'downloading' ? frac : 0))).toFixed(2);
  r.st.textContent = rowText(it);
  r.root.title = it.phase === 'failed' && it.problem ? it.problem.hint : '';
}
function renderList(items, stage) {
  const list = $('#list');
  if (!list.dataset.built) {
    list.dataset.built = '1';
    for (const [g, label] of GROUPS) {
      const its = items.filter((i) => i.group === g); if (!its.length) continue;
      const head = el('div', 'grp'); head.append(el('span', '', label));
      if (g === 'asset') { const n = el('span', 'note', '稍后补齐，不影响使用'); n.id = 'asset-note'; head.append(n); }
      const cnt = el('span', 'cnt'); cnt.dataset.group = g; head.append(cnt);
      const box = el('div', g === 'asset' ? 'chips' : 'rows');
      for (const it of its) { const r = makeRow(it); rows.set(it.id, r); box.append(r.root); }
      list.append(head, box);
    }
  }
  for (const it of items) { const r = rows.get(it.id); if (r) updateRow(r, it); }
  const an = $('#asset-note');
  if (an) {
    const opt = items.filter((i) => i.optional);
    const busy = opt.some((i) => i.phase === 'downloading' || i.phase === 'waiting' || i.phase === 'installing');
    an.textContent = opt.every((i) => i.phase === 'ready' || i.phase === 'done') ? '全部就绪' : busy && stage === 'running' ? '正在后台下载，不影响使用' : '稍后补齐，不影响使用';
  }
  for (const [g] of GROUPS) {
    const c = list.querySelector('.cnt[data-group="' + g + '"]'); if (!c) continue;
    const its = items.filter((i) => i.group === g);
    c.textContent = its.filter((i) => i.phase === 'ready' || i.phase === 'done').length + ' / ' + its.length;
  }
}

/* ---------- 总进度 ---------- */
function tweenPct(target) {
  if (pctAnim) cancelAnimationFrame(pctAnim);
  const from = shownPct, t0 = performance.now(), dur = 900;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    shownPct = from + (target - from) * e; $('#num').textContent = Math.floor(shownPct);
    if (k < 1) pctAnim = requestAnimationFrame(step);
  };
  pctAnim = requestAnimationFrame(step);
}
function renderMeter(s, req, needed) {
  const t = s.total;
  const settled = s.stage === 'starting' || s.stage === 'running';
  let pct = t.size ? (t.downloaded / t.size) * 100 : (req.every((i) => i.phase === 'ready' || i.phase === 'done') && req.length ? 100 : 0);
  if (settled) pct = 100;
  pct = Math.max(0, Math.min(100, pct));
  if (Math.floor(pct) !== Math.floor(shownPct) || pct === 100) tweenPct(pct);
  $('#fill').style.width = pct.toFixed(2) + '%';
  $('#track').setAttribute('aria-valuenow', String(Math.floor(pct)));
  const dl = req.some((i) => i.phase === 'downloading');
  $('#meter').classList.toggle('busy', dl);
  const stats = $('#stats'); stats.textContent = '';
  const line = (strong, rest) => { const d = el('div'); if (strong) d.append(el('b', '', strong)); if (rest) d.append(rest); stats.append(d); };
  if (needed.length && t.size) {
    line(size(t.downloaded), ' / ' + size(t.size));
    if (dl && t.bytesPerSec > 0) line(speed(t.bytesPerSec), t.etaSecs != null ? ' · ' + eta(t.etaSecs) : '');
    else if (s.stage === 'failed') line('', '已暂停');
    else line('', settled ? '全部就绪 · 用时 ' + duration(s.elapsedMs) : '校验解包中');
  } else {
    line(req.length ? req.filter((i) => i.phase === 'ready' || i.phase === 'done').length + ' / ' + req.length : '—', ' 项已就绪');
    line('', settled ? '已校验，无需下载' : '检查中');
  }
}

/* ---------- 终端 ---------- */
function say(cls, text) { logLines.push([cls, text]); while (logLines.length > 40) logLines.shift(); }
function prompt(cmd) { say('p', '$ ' + cmd); }
function renderTerm(s, items) {
  const scr = $('#screen'); const keep = 7;
  const live = items.filter((i) => i.phase === 'downloading' || i.phase === 'installing').slice(0, 2);
  const lines = logLines.slice(-keep + live.length);
  scr.textContent = '';
  for (const [cls, text] of lines) {
    const d = el('div', cls);
    if (cls === 'p') { d.append(el('b', '', '$'), text.slice(1)); } else d.textContent = text;
    scr.append(d);
  }
  for (const it of live) {
    const d = el('div', 'live bl');
    if (it.phase === 'installing') d.textContent = '⠿ 校验解包 ' + it.name;
    else {
      const frac = it.size ? it.downloaded / it.size : 0, w = 16, full = Math.round(frac * w);
      d.append('↓ ' + it.name + '  ', el('span', 'bar-on', '━'.repeat(full)), el('span', 'bar-off', '━'.repeat(w - full)), ' ' + Math.floor(frac * 100) + '%');
    }
    scr.append(d);
  }
  if (!live.length && s.stage !== 'running') { const d = el('div', 'live'); d.append(el('span', 'caret')); scr.append(d); }
  // 保持最多 8 行，旧行在上方淡出
  while (scr.children.length > 8) scr.removeChild(scr.firstChild);
}
function logTransitions(s, items) {
  if (firstState) {
    prompt('mingzhi start' + (s.settings.mirror === 'global' ? ' --mirror global' : ''));
    const ready = items.filter((i) => i.phase === 'ready');
    if (ready.length) say('g', '✓ ' + ready.length + ' 个组件已就绪（哈希一致，跳过校验）');
  }
  for (const it of items) {
    const r = rows.get(it.id); const prev = r ? r.logged : undefined;
    if (prev === it.phase) continue;
    if (r) r.logged = it.phase;
    if (firstState && it.phase === 'ready') continue;
    if (it.phase === 'ready' && prev === 'checking' && !it.optional) say('g', '✓ ' + it.name + ' 已就绪');
    if (it.phase === 'done') say('g', '✓ ' + it.name + '  ' + size(it.size) + '  sha256 ✓');
    if (it.phase === 'failed') say('r', '✗ ' + it.name + ' — ' + (it.problem ? it.problem.title : '失败'));
    if (it.phase === 'deferred') say('y', '… ' + it.name + ' 稍后补齐');
  }
  if (!loggedStages.has(s.stage)) {
    loggedStages.add(s.stage);
    if (s.stage === 'starting') { prompt('node --import tsx src/server/index.ts'); say('d', '启动本机工作台服务…'); }
    if (s.stage === 'running' && s.url) say('ok', '明知AI剪辑 已启动：' + s.url);
    if (s.stage === 'crashed' && s.error) say('r', '✗ ' + s.error.title);
    if (s.stage === 'failed') say('r', '✗ 有组件没装好，等待重试');
  }
  if (s.stage === 'preparing') { loggedStages.delete('failed'); loggedStages.delete('crashed'); loggedStages.delete('starting'); loggedStages.delete('running'); }
  firstState = false;
}

/* ---------- 总渲染 ---------- */
function render(s) {
  $('#ver').textContent = 'v' + s.version; $('#ab-ver').textContent = '(v' + s.version + ')';
  const items = s.items; const req = items.filter((i) => !i.optional);
  const needed = req.filter((i) => i.needed);
  if (needed.length) hadWork = true;
  logTransitions(s, items);
  renderList(items, s.stage);
  renderMeter(s, req, needed);
  renderTerm(s, items);
  renderNote(s);
  renderLicenses(s);
  syncSettings(s.settings);

  const main = $('#main');
  const failedReq = req.filter((i) => i.phase === 'failed');
  main.classList.toggle('show-alert', s.stage === 'failed' || s.stage === 'crashed');
  main.classList.toggle('done', s.stage === 'running');
  main.classList.toggle('paused', s.stage === 'failed' || s.stage === 'crashed');
  if (s.stage === 'preparing') delete main.dataset.scrolled;
  if (s.stage === 'failed' || s.stage === 'crashed') {
    const e = s.error || (failedReq[0] && failedReq[0].problem) || { title: '出了点意外', hint: '点「重试」再试一次。', detail: '' };
    const who = s.stage === 'failed' && failedReq.length === 1 ? failedReq[0].name + '：' : '';
    $('#a-title').textContent = who + e.title;
    if (failedReq[0] && main.dataset.scrolled !== failedReq[0].id) {
      main.dataset.scrolled = failedReq[0].id;
      setTimeout(() => rows.get(failedReq[0].id).root.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 400);
    } $('#a-hint').textContent = e.hint; $('#a-detail').textContent = e.detail || '（无）';
    const btn = $('#a-main'); btn.textContent = s.stage === 'crashed' ? '重新启动' : '重试'; btn.dataset.cmd = s.stage === 'crashed' ? 'restart' : 'retry';
    // 点过之后要等阶段真的变了（epoch 变化）才能再点，避免连点把陈旧命令塞进队列
    btn.disabled = btn.dataset.epoch === String(s.epoch);
  }

  const total = needed.reduce((a, i) => a + i.size, 0);
  switch (s.stage) {
    case 'preparing':
      if (needed.length) setHead('dl', '正在准备剪辑台', '(只需这一次)', '首次要下载 ' + needed.length + ' 个组件（约 ' + size(total) + '），完成后自动打开工作台。');
      else setHead('check', '正在打开明知AI剪辑', '(一下就好)', '检查已安装的组件…');
      $('#tt').textContent = '明知AI剪辑 — 准备工作台'; break;
    case 'failed':
      setHead('fail', failedReq.length ? '还差 ' + failedReq.length + ' 个组件' : '没能准备好工作台', failedReq.length ? '(其余都好了)' : '', '已下好的部分都会保留，重试时接着下。'); break;
    case 'starting':
      setHead('start', '组件就绪，正在启动工作台', '', hadWork ? '第一次启动要多等几秒。' : '马上就好。'); break;
    case 'running':
      setHead('run', '准备好了', '(ready)', '正在打开工作台…'); $('#tt').textContent = '明知AI剪辑 — 已就绪';
      if (s.url) leave(s.url); break;
    case 'crashed':
      setHead('crash', '工作台停止运行了', '', '已下载的组件都还在，点「重新启动」即可。'); break;
  }
  document.title = s.stage === 'preparing' && needed.length && s.total.size ? Math.floor((s.total.downloaded / s.total.size) * 100) + '% · 明知AI剪辑' : '明知AI剪辑';
}
function renderNote(s) {
  const n = $('#note'); if (n.dataset.v === (s.lowSpec || '')) return; n.dataset.v = s.lowSpec || '';
  n.textContent = ''; n.classList.toggle('low', !!s.lowSpec);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = s.lowSpec ? '<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.6v4.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.2" r=".95" fill="currentColor"/>'
    : '<path d="M8 1.6l5.4 2.1v4.1c0 3.2-2.3 5.6-5.4 6.6-3.1-1-5.4-3.4-5.4-6.6V3.7z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M5.6 8.1l1.7 1.7 3.2-3.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>';
  n.append(svg, el('span', '', s.lowSpec || '全部在本机运行 · 默认不收集任何数据'));
}
function renderLicenses(s) {
  const box = $('#lic'); if (box.dataset.built) return; box.dataset.built = '1';
  for (const l of s.licenses) {
    const m = l.license.match(/^([^（(]+)[（(](.*)[）)]$/);
    const short = (m ? m[1] : l.license).trim(), extra = m ? m[2] : '';
    const li = el('div', 'li'), meta = el('div', 'meta');
    meta.append(el('span', 'l' + (/GPL/.test(short) ? ' gpl-tag' : ''), short));
    if (extra) meta.append(el('span', 'x', extra));
    li.append(el('span', 'n', l.name), meta);
    box.append(li);
  }
}
function renderLost() {
  if (leaving) return;
  setHead('lost', '启动器已经关闭', '', '重新双击「明知AI剪辑」即可继续，已下载的部分不会丢。');
  $('#meter').classList.remove('busy');
}

/* ---------- 跳转 ---------- */
function leave(url) {
  if (leaving) return; leaving = true;
  // 刚下载完：留一拍「准备好了」；二次启动：尽快进工作台
  const wait = hadWork ? 1500 : 200, fade = hadWork ? 380 : 220;
  setTimeout(() => { document.body.classList.add('leaving'); setTimeout(() => location.replace(url), fade); }, wait);
}

/* ---------- 浮窗 ---------- */
function openPanel(id) {
  if (panel === id) return closePanel();
  closePanel(true);
  const p = $('#' + id); p.hidden = false; panel = id;
  requestAnimationFrame(() => { p.classList.add('in'); requestAnimationFrame(() => p.classList.add('open')); });
  if (id === 'settings') { loadSettingsForm(); setTimeout(() => $('#prefix').focus({ preventScroll: true }), 260); }
}
function closePanel(instant) {
  if (!panel) return; const p = $('#' + panel); panel = null;
  p.classList.remove('open');
  setTimeout(() => { if (!p.classList.contains('open')) { p.classList.remove('in'); p.hidden = true; } }, instant ? 0 : 500);
}
let formMirror = 'cn';
function loadSettingsForm() { if (!S) return; formMirror = S.settings.mirror; $('#prefix').value = S.settings.githubPrefix || ''; $('#prefix-err').textContent = ''; $('#prefix').classList.remove('bad'); paintSeg(); }
function syncSettings(st) { if (panel !== 'settings' && st) { formMirror = st.mirror; paintSeg(); } }
function paintSeg() { document.querySelectorAll('[data-mirror]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mirror === formMirror))); }

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button'); if (!t) return;
  if (t.dataset.open) return openPanel(t.dataset.open);
  if (t.hasAttribute('data-close')) return closePanel();
  if (t.dataset.mirror) { formMirror = t.dataset.mirror; return paintSeg(); }
  if (t.id === 'a-more') { const open = t.getAttribute('aria-expanded') !== 'true'; t.setAttribute('aria-expanded', String(open)); $('#a-detail').hidden = !open; return; }
  if (t.id === 'a-main') {
    t.disabled = true; t.dataset.epoch = String(S.epoch); say('p', '$ mingzhi ' + (t.dataset.cmd === 'restart' ? 'restart' : 'retry'));
    try { await post('/api/' + t.dataset.cmd); } catch (e) { delete t.dataset.epoch; t.disabled = false; }
    return;
  }
  if (t.id === 'save') {
    t.disabled = true; $('#prefix-err').textContent = ''; $('#prefix').classList.remove('bad');
    try {
      const r = await post('/api/settings', { mirror: formMirror, githubPrefix: $('#prefix').value });
      $('#prefix').value = r.settings.githubPrefix; S.settings = r.settings;
      say('d', '设置已保存：' + (r.settings.mirror === 'cn' ? '国内镜像优先' : '官方源优先') + (r.settings.githubPrefix ? '，GitHub 走代理前缀' : ''));
      const ok = $('#saved'); ok.classList.add('on'); setTimeout(() => { ok.classList.remove('on'); closePanel(); }, 1100);
    } catch (e) { $('#prefix-err').textContent = e.message; $('#prefix').classList.add('bad'); }
    t.disabled = false;
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); if (e.key === 'Enter' && panel === 'settings' && e.target.id === 'prefix') $('#save').click(); });

/* ---------- 开场 ---------- */
const art = new Image(); art.src = '/assets/art.webp';
const begin = () => { document.getElementById('stage').classList.add('ready'); ['#main', '#term'].forEach((s) => $(s).classList.add('in')); };
art.decode ? art.decode().then(begin, begin) : (art.onload = begin);
setTimeout(begin, 900);
poll();
