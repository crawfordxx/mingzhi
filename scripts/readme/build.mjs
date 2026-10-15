#!/usr/bin/env node
// 生成 README 的全部图片到 docs/readme/（WebP）。
// 用法：node scripts/readme/build.mjs <media 目录> <截图目录> <对比视频目录>
//   media 目录：scripts/readme/media.sh 的产出，外加 art-night.jpg（gen-art.ts studio-night 生成）
//   截图目录：工作台真实截图（1440×900@2x）：setup.png live.png v1.png chat.png compare.png
//   对比视频目录：compare.sh 的产出 landscape.* 与 portrait.*
// 文案里的数字都来自 README 实测的两条样片，改数字前先重新实测。
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [media, shots, cmp] = process.argv.slice(2).map((p) => p && resolve(p));
if (!media || !shots || !cmp) {
  console.error('用法：node scripts/readme/build.mjs <media 目录> <截图目录> <对比视频目录>');
  process.exit(1);
}
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const out = resolve(root, 'docs/readme');
const tmp = resolve(out, '.tmp');
mkdirSync(tmp, { recursive: true });

const render = (tpl, query, w, h, png) =>
  execFileSync('node', [resolve(here, 'render.mjs'), tpl, query, String(w), String(h), png, '--scale', '2'], { stdio: 'inherit' });
const webp = (png, name, q = 86, width) => {
  const dest = resolve(out, name);
  execFileSync('cwebp', ['-quiet', '-q', String(q), '-m', '6', ...(width ? ['-resize', String(width), '0'] : []), png, '-o', dest]);
  console.log(`${name} ${(statSync(dest).size / 1024).toFixed(0)} KB`);
};
const enc = (o) => encodeURIComponent(JSON.stringify(o));

// 横幅：横屏样片在对话里改背景的那一轮（真实回复、真实日志）
const HERO = {
  zh: {
    h1: '把一条口播，<br>变成 <span class="it">finished cut.</span>',
    lede: '拖进口播，选好背景、字幕和封面。剪口误、换背景、做分镜卡片和封面交给它，哪里不满意，<span class="hl">说一句就改</span>。',
    facts: [['0:15 → 0:11', '实测样片，剪掉 4 处'], ['¥2.05', '首版成片的全部花费'], ['7 / 7', '成片检查全部通过']],
    ask: '背景换成夜景落地窗', reply: '已执行 · 出 <b>v2</b> 19 秒 · ¥0.00',
    win: 'v2 — 怎么用 AI 剪口播', tc: '00:02 / 00:11',
    log: ['<s>#</s> v2 · 背景换成夜景落地窗', '<em>✓</em> 修改  应用 1 项 · 重跑换背景、成片', '<em>✓</em> 背景  夜景落地窗', '<em>✓</em> 抠像  复用整条抠像 · 合成 0.8 秒', '<em>✓</em> 成片  分段渲染 5 段', '<em>✓</em> 检查  7/7 全部通过', '<em>✓</em> 完成  19 秒 · ¥0.00'],
  },
  en: {
    h1: 'Turn one raw take<br>into a <span class="it">finished cut.</span>',
    lede: 'Drop in a talking-head video, pick a background, captions and a cover. Slips, storyboard cards and covers are handled for you. Something off? <span class="hl">Just say it.</span>',
    facts: [['0:15 → 0:11', 'sample take, 4 cuts'], ['¥2.05', 'all-in cost of v1'], ['7 / 7', 'final checks passed']],
    ask: 'Switch to the night window', reply: 'Done · <b>v2</b> in 19 s · ¥0.00',
    win: 'v2 — How to cut with AI', tc: '00:02 / 00:11',
    log: ['<s>#</s> v2 · switch to the night window', '<em>✓</em> edit     1 op · rerun bg + video', '<em>✓</em> bg       night window', '<em>✓</em> matte    reused · composite 0.8 s', '<em>✓</em> render   5 segments', '<em>✓</em> checks   7/7 passed', '<em>✓</em> done     19 s · ¥0.00'],
  },
};
const art = { light: resolve(root, 'web/public/art/01-studio.webp'), dark: resolve(media, 'art-night.jpg') };
for (const lang of ['zh', 'en']) {
  for (const theme of ['light', 'dark']) {
    const sfx = `${lang === 'en' ? '-en' : ''}${theme === 'dark' ? '-dark' : ''}`;
    const png = resolve(tmp, `hero${sfx}.png`);
    render('hero', `theme=${theme}&lang=${lang}&art=${art[theme]}&frame=${resolve(media, 'hero-frame.jpg')}&copy=${enc(HERO[lang])}`, 1200, 600, png);
    webp(png, `hero${sfx}.webp`, 88);
    const fpng = resolve(tmp, `flow${sfx}.png`);
    render('flow', `theme=${theme}&lang=${lang}`, 1000, 250, fpng);
    webp(fpng, `flow${sfx}.webp`, 90);
    for (const id of ['cut', 'bg', 'board', 'chat', 'compare', 'qa']) {
      const t = resolve(tmp, `f-${id}${sfx}.png`);
      render('feature', `id=${id}&theme=${theme}&lang=${lang}&m=${media}`, 800, 520, t);
      webp(t, `feature-${id}${sfx}.webp`, 86);
    }
  }
}

// 产品截图：2880×1800 原图压成 WebP
for (const name of ['setup', 'live', 'v1', 'chat', 'compare']) webp(resolve(shots, `${name}.png`), `shot-${name}.webp`, 82);

// 剪辑前后：动图 webp 为主，GIF 兜底，MP4 带声音
for (const kind of ['landscape', 'portrait']) {
  for (const ext of ['webp', 'gif', 'mp4']) copyFileSync(resolve(cmp, `${kind}.${ext}`), resolve(out, `before-after-${kind}.${ext}`));
}
rmSync(tmp, { recursive: true, force: true });
