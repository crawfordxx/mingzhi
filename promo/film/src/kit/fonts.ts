// 字体：全部本地文件（Fusion Pixel / Press Start 2P 为 OFL，IBM Plex 来自 @fontsource），加载完才出帧
import { cancelRender, continueRender, delayRender, staticFile } from 'remotion';
import { loadFont } from '@remotion/fonts';

const FONTS = [
  { family: 'FusionPixel', file: 'fusion-pixel-12px-proportional-zh_hans.otf.woff2' },
  { family: 'PressStart2P', file: 'PressStart2P-Regular.ttf' },
  { family: 'PlexSerif', file: 'ibm-plex-serif-latin-200-italic.woff2', weight: '200', style: 'italic' },
  { family: 'PlexSerif', file: 'ibm-plex-serif-latin-300-italic.woff2', weight: '300', style: 'italic' },
  { family: 'PlexMono', file: 'ibm-plex-mono-latin-400-normal.woff2', weight: '400' },
  { family: 'PlexMono', file: 'ibm-plex-mono-latin-500-normal.woff2', weight: '500' },
];

const handle = delayRender('加载字体');
Promise.all(FONTS.map((x) => loadFont({ family: x.family, url: staticFile(`fonts/${x.file}`), weight: x.weight, style: x.style })))
  .then(() => continueRender(handle), (e: unknown) => cancelRender(e));
