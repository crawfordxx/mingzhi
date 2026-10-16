import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate } from './sources/types.js';

/** 每个用到的素材一条授权记录，随项目存成 credits.json */
export interface CreditEntry {
  file: string;
  source: Candidate['source'];
  page: string;
  author?: string;
  license: string;
  licenseUrl?: string;
  attributionRequired: boolean;
  aiGenerated: boolean;
  /** 做过的加工，如 crop、lut、speed0.5 */
  modified: string[];
  query: string;
  fetchedAt: string;
}

const SOURCE_NAME: Partial<Record<Candidate['source'], string>> = { pexels: 'Pexels', pixabay: 'Pixabay', wikimedia: 'Wikimedia Commons' };

export function writeCredits(dir: string, entries: readonly CreditEntry[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'credits.json');
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`);
  return path;
}

function hostOf(page: string): string {
  try {
    return new URL(page).hostname.replace(/^www\./, '');
  } catch {
    return page;
  }
}

/** 同一来源（Wikimedia 还按许可区分）合并作者，保持首次出现的顺序 */
function sourceItems(entries: readonly CreditEntry[]): string[] {
  const groups = new Map<string, { label: string; authors: string[] }>();
  for (const e of entries) {
    const name = SOURCE_NAME[e.source];
    if (!name) continue;
    const label = e.source === 'wikimedia' ? `${name}（${e.license}）` : name;
    const group = groups.get(label) ?? { label, authors: [] };
    if (e.author && !group.authors.includes(e.author)) group.authors.push(e.author);
    groups.set(label, group);
  }
  return [...groups.values()].map((g) => (g.authors.length > 0 ? `${g.label}${g.label.endsWith('）') ? '' : ' '}${g.authors.map((a) => `@${a}`).join('、')}` : g.label));
}

/** 发布正文末尾的中文署名段落 */
export function attributionText(entries: readonly CreditEntry[]): string {
  const items = sourceItems(entries);
  const hosts = [...new Set(entries.filter((e) => e.source === 'screenshot').map((e) => hostOf(e.page)))];
  const ai = entries.some((e) => e.aiGenerated || e.source === 'generated');
  return [
    items.length > 0 ? `素材：${items.join('、')}` : '',
    hosts.length > 0 ? `部分画面截自 ${hosts.join('、')}` : '',
    ai ? '部分画面为 AI 生成' : '',
  ].filter(Boolean).join('；');
}
