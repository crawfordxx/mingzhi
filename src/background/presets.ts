import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 内置 10 张预设背景（1:1、1k，GPT Image 生成），id 用于命令行与工程文件 */
export const PRESETS = [
  { id: 'study', name: '书房', file: '01-study.jpg' },
  { id: 'studio', name: '极简工作室', file: '02-studio.jpg' },
  { id: 'cafe', name: '咖啡馆', file: '03-cafe.jpg' },
  { id: 'night-window', name: '夜景落地窗', file: '04-night-window.jpg' },
  { id: 'tech-dark', name: '科技暗色', file: '05-tech-dark.jpg' },
  { id: 'japanese', name: '日式和室', file: '06-japanese.jpg' },
  { id: 'balcony', name: '绿植阳台', file: '07-balcony.jpg' },
  { id: 'library', name: '图书馆', file: '08-library.jpg' },
  { id: 'rooftop', name: '黄昏天台', file: '09-rooftop.jpg' },
  { id: 'concrete', name: '水泥灰墙', file: '10-concrete.jpg' },
] as const;

const PRESET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'backgrounds');

export function isPresetId(id: string): boolean {
  return PRESETS.some((p) => p.id === id);
}

export function presetPath(id: string): string {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`没有这个预设背景：${id}。可选：${PRESETS.map((p) => p.id).join('、')}`);
  const path = join(PRESET_DIR, preset.file);
  if (!existsSync(path)) throw new Error(`预设背景文件缺失：${path}`);
  return path;
}
