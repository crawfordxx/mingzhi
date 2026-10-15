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

/** 入库的 Kenney CC0 音效（assets/sfx/） */
export const SFX = {
  enter: 'maximize_006.wav',
  exit: 'minimize_003.wav',
  click: 'click_002.wav',
  toggle: 'toggle_002.wav',
  tick: 'tick_002.wav',
  load: 'scroll_002.wav',
  confirm: 'confirmation_002.wav',
  sparkle: 'glass_001.wav',
} as const;

export type SfxId = keyof typeof SFX;

const REPO_ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');

const TrackSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  zip: z.string().min(1),
  entry: z.string().min(1),
  mood: z.enum(['chill', 'tech', 'upbeat']),
  energy: z.number().int().min(1).max(3),
  durationSec: z.number().positive(),
});

const MusicSchema = z.object({
  license: z.string(),
  zips: z.record(z.object({ url: z.string().url(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
  tracks: z.array(TrackSchema),
});

const FontSchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  url: z.string().url(),
  file: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  zipEntry: z.string().optional(),
});

const FontsSchema = z.object({ license: z.string(), fonts: z.array(FontSchema) });

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ASSETS, name), 'utf8'));
}

export function loadTracks(): Track[] {
  return MusicSchema.parse(readJson('music.json')).tracks;
}

export function loadFonts(): FontAsset[] {
  return FontsSchema.parse(readJson('fonts.json')).fonts;
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

function nonEmpty(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

export function musicReady(cfg: AppConfig): boolean {
  return loadTracks().every((t) => nonEmpty(trackPath(cfg, t)));
}

export function fontsReady(cfg: AppConfig): boolean {
  return loadFonts().every((f) => nonEmpty(fontPath(cfg, f)));
}
