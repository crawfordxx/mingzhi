import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AppConfig } from '../config.js';

export type Mood = 'chill' | 'tech' | 'upbeat';

export interface Track {
  id: string;
  title: string;
  /** 压缩包简称，对应 music.json 的 zips */
  zip: string;
  /** 压缩包内路径 */
  entry: string;
  mood: Mood;
  energy: number;
  durationSec: number;
}

export interface FontAsset {
  id: string;
  family: string;
  url: string;
  /** 落盘文件名 */
  file: string;
  /** 下载物的 sha256（有 zipEntry 时校验的是压缩包本身） */
  sha256: string;
  /** 下载物是压缩包时，其中要取出的文件 */
  zipEntry?: string;
}

/**
 * 入库的音效（assets/sfx/）：前 8 个是 Kenney CC0 包里挑出的；其余由 scripts/make-sfx.mjs 用代码合成（无第三方采样），
 * 带数字后缀的是同类变体（音高、质感略不同），同一音效全片重复过多时轮换用
 */
export const SFX = {
  enter: 'maximize_006.wav',
  exit: 'minimize_003.wav',
  click: 'click_002.wav',
  toggle: 'toggle_002.wav',
  tick: 'tick_002.wav',
  load: 'scroll_002.wav',
  confirm: 'confirmation_002.wav',
  sparkle: 'glass_001.wav',
  whoosh: 'whoosh.wav',
  whoosh2: 'whoosh_2.wav',
  whoosh3: 'whoosh_3.wav',
  hit: 'hit.wav',
  hit2: 'hit_2.wav',
  hit3: 'hit_3.wav',
  riser: 'riser.wav',
  riserShort: 'riser_short.wav',
  pop: 'pop.wav',
  pop2: 'pop_2.wav',
  pop3: 'pop_3.wav',
  pop4: 'pop_4.wav',
  tick2: 'tick_2.wav',
  tick3: 'tick_3.wav',
  click2: 'click_2.wav',
  toggle2: 'toggle_2.wav',
  confirm2: 'confirm_2.wav',
  confirm3: 'confirm_3.wav',
  logo: 'logo.wav',
} as const;

export type SfxId = keyof typeof SFX;

const REPO_ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');

/** 清单里的 id 与文件名会拼进磁盘路径：只允许字母数字、下划线、点、横线；没有斜杠，再排除 . 和 ..，就不会路径穿越 */
const SafeName = z.string().regex(/^[\w.-]+$/, '只能包含字母、数字、下划线、点和横线').refine((v) => v !== '.' && v !== '..', '不能是 . 或 ..');

const TrackSchema = z.object({
  id: SafeName,
  title: z.string().min(1),
  zip: z.string().min(1),
  entry: z.string().min(1),
  mood: z.enum(['chill', 'tech', 'upbeat']),
  energy: z.number().int().min(1).max(3),
  durationSec: z.number().positive(),
});

const MusicSchema = z.object({
  license: z.string(),
  zips: z.record(SafeName, z.object({ url: z.string().url(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
  tracks: z.array(TrackSchema),
}).superRefine((music, ctx) => {
  const seen = new Set<string>();
  music.tracks.forEach((t, i) => {
    if (seen.has(t.id)) ctx.addIssue({ code: 'custom', path: ['tracks', i, 'id'], message: `曲目 id 重复：${t.id}` });
    seen.add(t.id);
    if (!Object.hasOwn(music.zips, t.zip)) ctx.addIssue({ code: 'custom', path: ['tracks', i, 'zip'], message: `曲目 ${t.id} 的压缩包「${t.zip}」不在 zips 里` });
  });
});

const FontSchema = z.object({
  id: SafeName,
  family: z.string().min(1),
  url: z.string().url(),
  file: SafeName,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  zipEntry: z.string().optional(),
});

const FontsSchema = z.object({ license: z.string(), fonts: z.array(FontSchema) }).superRefine((data, ctx) => {
  const seen = new Set<string>();
  data.fonts.forEach((f, i) => {
    if (seen.has(f.id)) ctx.addIssue({ code: 'custom', path: ['fonts', i, 'id'], message: `字体 id 重复：${f.id}` });
    seen.add(f.id);
  });
});

/** 解析并校验清单（导出供测试） */
export const parseMusicManifest = (raw: unknown) => MusicSchema.parse(raw);
export const parseFontsManifest = (raw: unknown) => FontsSchema.parse(raw);

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ASSETS, name), 'utf8'));
}

export function loadTracks(): Track[] {
  return parseMusicManifest(readJson('music.json')).tracks;
}

export function loadFonts(): FontAsset[] {
  return parseFontsManifest(readJson('fonts.json')).fonts;
}

export function assetsDir(cfg: AppConfig): string {
  return join(cfg.dataDir, 'assets');
}

export function trackPath(cfg: AppConfig, t: Track): string {
  return join(assetsDir(cfg), 'music', `${t.id}.mp3`);
}

export function fontPath(cfg: AppConfig, f: FontAsset): string {
  return join(assetsDir(cfg), 'fonts', f.file);
}

export function sfxPath(id: SfxId): string {
  return join(REPO_ASSETS, 'sfx', SFX[id]);
}

/** 片尾用的品牌 logo（PNG） */
export function brandLogoPath(): string {
  return join(REPO_ASSETS, 'brand', 'logo-512.png');
}

function nonEmpty(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

/** 已下载（存在且非空）的曲目 */
export function downloadedTracks(cfg: AppConfig): Track[] {
  return loadTracks().filter((t) => nonEmpty(trackPath(cfg, t)));
}

/**
 * 配乐素材是否够用：不带 want 时要求全部曲目都已下载；
 * want 为曲目 id 时只要该曲目已下载；want 为 'auto' 时至少有一首已下载（选曲优先同情绪，没有就退到任意已下载曲目）。
 */
export function musicReady(cfg: AppConfig, want?: string): boolean {
  if (want === undefined) return loadTracks().every((t) => nonEmpty(trackPath(cfg, t)));
  if (want === 'auto') return downloadedTracks(cfg).length > 0;
  return downloadedTracks(cfg).some((t) => t.id === want);
}

export function fontsReady(cfg: AppConfig): boolean {
  return loadFonts().every((f) => nonEmpty(fontPath(cfg, f)));
}
