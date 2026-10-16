import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate } from './sources/types.js';

/** 每个用到的素材一条授权记录，随项目存成 credits.json */
export interface CreditEntry {
  file: string;
  source: Candidate['source'];
  page: string;
  author?: string;
  /** 作者主页，有则随署名附上 */
  authorUrl?: string;
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

interface SourceGroup { label: string; authors: Map<string, string[]> }

function groupLabel(e: CreditEntry): string | undefined {
  const name = SOURCE_NAME[e.source];
  if (!name) return undefined;
  // CC BY 要求给出许可链接
  return e.source === 'wikimedia' ? `${name}（${[e.license, e.licenseUrl].filter(Boolean).join(' ')}）` : name;
}

/** 作者后的链接：作者主页；Wikimedia 要署名的再附来源页（CC BY 要求在合理范围内给出出处） */
function linksOf(e: CreditEntry): string[] {
  return [e.authorUrl, e.source === 'wikimedia' && e.attributionRequired ? e.page : undefined].filter((u): u is string => !!u);
}

function authorMention(name: string, urls: readonly string[]): string {
  return urls.length > 0 ? `@${name}（${urls.join(' ')}）` : `@${name}`;
}

function renderGroup(g: SourceGroup): string {
  const authors = [...g.authors].map(([name, urls]) => authorMention(name, urls));
  if (authors.length === 0) return g.label;
  // 括号收尾的标签后不加空格，作者之间用空格分隔，避免和来源间的顿号混淆
  return `${g.label}${g.label.endsWith('）') ? '' : ' '}${authors.join(' ')}`;
}

/** 同一来源（Wikimedia 还按许可区分）合并作者，保持首次出现的顺序 */
function sourceItems(entries: readonly CreditEntry[]): string[] {
  const groups = new Map<string, SourceGroup>();
  for (const e of entries) {
    const label = groupLabel(e);
    if (!label) continue;
    const group = groups.get(label) ?? { label, authors: new Map() };
    if (e.author) group.authors.set(e.author, [...new Set([...(group.authors.get(e.author) ?? []), ...linksOf(e)])]);
    groups.set(label, group);
  }
  return [...groups.values()].map(renderGroup);
}

const PROCESSED = /crop|lut|grade|color/;

/** 发布正文末尾的中文署名段落 */
export function attributionText(entries: readonly CreditEntry[]): string {
  const items = sourceItems(entries);
  const hosts = [...new Set(entries.filter((e) => e.source === 'screenshot').map((e) => hostOf(e.page)))];
  const processed = entries.some((e) => e.source !== 'generated' && e.modified.some((m) => PROCESSED.test(m)));
  const ai = entries.some((e) => e.aiGenerated || e.source === 'generated');
  return [
    items.length > 0 ? `素材：${items.join('、')}` : '',
    processed ? '部分素材已裁切调色' : '',
    hosts.length > 0 ? `部分画面截自 ${hosts.join('、')}` : '',
    ai ? '部分画面为 AI 生成' : '',
  ].filter(Boolean).join('；');
}
