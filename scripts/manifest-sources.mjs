// 下载清单的来源定义：版本、url 与目录。--update-lock 时据此下载并算出 sha256/size，写入 launcher/manifest.lock.json。
// url 顺序即下载优先级：国内镜像在前，官方源其次，GitHub 直链最后（启动器会为 github.com / raw.githubusercontent.com 的 url 额外插入用户配置的代理前缀）。
// 模型与素材的来源、目录、sha256 取自 assets/music.json、assets/fonts.json 与 scripts/fetch-models.mjs，保持 data/models、data/assets 布局不变。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const readAssets = (name) => JSON.parse(readFileSync(join(ASSETS_DIR, name), 'utf8'));

/** Node 运行时：22 LTS（Jod）。原生模块走 N-API，22.x 内 ABI 稳定 */
export const NODE_VERSION = '22.23.3';
/** Remotion 4.0.531 所用的 Chrome Headless Shell 版本（node_modules/@remotion/renderer 的 TESTED_VERSION） */
export const CHROME_VERSION = '149.0.7790.0';
/** ffmpeg-static 的发布标签：三平台静态 GPL 构建，均带 libass（烧录字幕必需） */
export const FFMPEG_STATIC_TAG = 'b6.1.1';
/** HuggingFace 仓库固定到提交，避免 main 分支内容漂移 */
const HF_SENSEVOICE = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const HF_SENSEVOICE_REV = '2365baeacb507f821a0c8120fcee3d484dba7a07';

const NODE_PLATFORMS = {
  'darwin-arm64': { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, unpack: 'tar.gz' },
  'darwin-x64': { file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, unpack: 'tar.gz' },
  'win32-x64': { file: `node-v${NODE_VERSION}-win-x64.zip`, unpack: 'zip' },
};
// Chrome for Testing 的平台名与 Remotion 的目录名一致
const CHROME_PLATFORMS = { 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64', 'win32-x64': 'win64' };
const FFMPEG_LICENSES = {
  'darwin-arm64': 'GPL-3.0-or-later（静态构建，含 x264/x265/libass；来源 osxexperts.net，经 eugeneware/ffmpeg-static 打包）',
  'darwin-x64': 'GPL-3.0-or-later（静态构建，含 x264/x265/libass；来源 evermeet.cx，经 eugeneware/ffmpeg-static 打包）',
  'win32-x64': 'GPL-3.0-or-later（gyan.dev essentials 静态构建，含 x264/x265/libass，经 eugeneware/ffmpeg-static 打包）',
};

function nodeItems() {
  return Object.entries(NODE_PLATFORMS).map(([platform, { file, unpack }]) => ({
    id: `node-${platform}`,
    kind: 'node',
    platform,
    dest: 'runtime/node',
    unpack,
    strip: 1,
    exec: `runtime/node/${platform === 'win32-x64' ? 'node.exe' : 'bin/node'}`,
    urls: [`https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${file}`, `https://nodejs.org/dist/v${NODE_VERSION}/${file}`],
    license: 'MIT（Node.js）',
  }));
}

function ffmpegItems() {
  const items = [];
  for (const tool of ['ffmpeg', 'ffprobe']) {
    for (const platform of Object.keys(NODE_PLATFORMS)) {
      const file = `${tool}-${platform}.gz`;
      items.push({
        id: `${tool}-${platform}`,
        kind: 'ffmpeg',
        platform,
        dest: `data/bin/${tool}${platform === 'win32-x64' ? '.exe' : ''}`,
        unpack: 'gz',
        executable: true,
        urls: [
          `https://cdn.npmmirror.com/binaries/ffmpeg-static/${FFMPEG_STATIC_TAG}/${file}`,
          `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_TAG}/${file}`,
        ],
        license: FFMPEG_LICENSES[platform],
      });
    }
  }
  return items;
}

function chromeItems() {
  return Object.entries(CHROME_PLATFORMS).map(([platform, cft]) => {
    const dest = `runtime/chrome-headless-shell/${CHROME_VERSION}/${cft}`;
    return {
      id: `chrome-${platform}`,
      kind: 'chrome',
      platform,
      // zip 内顶层目录是 chrome-headless-shell-<cft>/，strip 1 后可执行文件的路径固定（exec）；
      // 装在 runtime/ 下、不随应用版本重下，启动器据 exec 设置 MINGZHI_CHROME
      dest,
      unpack: 'zip',
      strip: 1,
      exec: `${dest}/chrome-headless-shell${platform === 'win32-x64' ? '.exe' : ''}`,
      urls: [
        `https://cdn.npmmirror.com/binaries/chrome-for-testing/${CHROME_VERSION}/${cft}/chrome-headless-shell-${cft}.zip`,
        `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${cft}/chrome-headless-shell-${cft}.zip`,
      ],
      license: 'BSD-3-Clause（Chromium；内含第三方组件各自许可，见包内 LICENSE.headless_shell）',
    };
  });
}

const hf = (host, repo, rev, file) => `https://${host}/${repo}/resolve/${rev}/${file}`;
const hfBoth = (repo, rev, file) => [hf('hf-mirror.com', repo, rev, file), hf('huggingface.co', repo, rev, file)];

function modelItems() {
  const SV_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
  return [
    {
      id: 'model-silero-vad',
      kind: 'model',
      platform: 'any',
      // 与 scripts/fetch-models.mjs 下载的同一个文件。HuggingFace 的 csukuangfj/vad 里同名文件是另一个版本（sha 不同），不能当镜像用
      sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
      dest: 'data/models/silero_vad.onnx',
      urls: ['https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'],
      license: 'MIT（Silero VAD）',
    },
    {
      id: 'model-sensevoice-int8',
      kind: 'model',
      platform: 'any',
      dest: `data/models/${SV_DIR}/model.int8.onnx`,
      urls: hfBoth(HF_SENSEVOICE, HF_SENSEVOICE_REV, 'model.int8.onnx'),
      license: 'FunASR Model Open Source License（SenseVoice）',
    },
    {
      id: 'model-sensevoice-tokens',
      kind: 'model',
      platform: 'any',
      dest: `data/models/${SV_DIR}/tokens.txt`,
      urls: hfBoth(HF_SENSEVOICE, HF_SENSEVOICE_REV, 'tokens.txt'),
      license: 'FunASR Model Open Source License（SenseVoice）',
    },
    {
      id: 'model-rvm',
      kind: 'model',
      platform: 'any',
      // sha256 来自 scripts/fetch-models.mjs 的 RVM_SHA256
      sha256: '88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828',
      dest: 'data/models/rvm_mobilenetv3_fp32.onnx',
      urls: ['https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx'],
      license: 'GPL-3.0（RobustVideoMatting 权重）',
    },
  ];
}

/** google/fonts 的 raw 链接在 jsDelivr 上有同路径镜像（国内可直连）；其余字体只有 GitHub 源 */
// 两处都固定到提交，不引用分支名：上游挪文件或改内容后，已发布的清单依然下得到
const GOOGLE_FONTS_COMMIT = '1d0e46c7933245c8180fe83e47917961c913bbdb';
const GOOGLE_FONTS_RAW = 'https://raw.githubusercontent.com/google/fonts/main/';
function fontUrls(url) {
  if (!url.startsWith(GOOGLE_FONTS_RAW)) return [url];
  const path = url.slice(GOOGLE_FONTS_RAW.length);
  return [`https://cdn.jsdelivr.net/gh/google/fonts@${GOOGLE_FONTS_COMMIT}/${path}`, `https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/${path}`];
}

function assetItems() {
  const music = readAssets('music.json');
  const fonts = readAssets('fonts.json');
  const musicItems = Object.entries(music.zips).map(([key, zip]) => ({
    id: `music-${key}`,
    kind: 'asset',
    platform: 'any',
    optional: true, // 没有配乐也能出片（降级为不配乐），下载失败不阻塞启动
    sha256: zip.sha256,
    dest: 'data/assets/music',
    unpack: 'zip',
    // 取出清单里的 mp3 并转码为 128k 立体声 44.1kHz（与 scripts/fetch-assets.mjs 一致），压缩包不落在 data 里
    entries: music.tracks.filter((t) => t.zip === key).map((t) => ({ entry: t.entry, dest: `data/assets/music/${t.id}.mp3`, transcode: 'mp3' })),
    urls: [zip.url],
    license: music.license,
  }));
  const fontItems = fonts.fonts.map((f) => ({
    id: `font-${f.id}`,
    kind: 'asset',
    platform: 'any',
    optional: true, // 没有这些字体时降级为系统字体，下载失败不阻塞启动
    sha256: f.sha256,
    dest: f.zipEntry ? 'data/assets/fonts' : `data/assets/fonts/${f.file}`,
    ...(f.zipEntry ? { unpack: 'zip', entries: [{ entry: f.zipEntry, dest: `data/assets/fonts/${f.file}` }] } : {}),
    urls: fontUrls(f.url),
    license: fonts.license,
  }));
  return [...musicItems, ...fontItems];
}

/** 全部来源条目（尚无 size；sha256 仅在已有清单提供时预填） */
export function sourceItems() {
  return [...nodeItems(), ...ffmpegItems(), ...chromeItems(), ...modelItems(), ...assetItems()];
}
