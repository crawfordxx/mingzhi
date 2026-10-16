/**
 * 对话记录：每个项目一份 <space>/chat.jsonl，逐行追加（用户的话、AI 回复、执行了哪个选项），读取时归并成对话条目。
 * 条目形状与前端 web/src/lib/turns.ts 的 Turn 一致；换浏览器、清缓存后对话照样在。
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CHAT_FILE = 'chat.jsonl';
/** 条目 id：前端生成的（时间戳 + 随机，base36）或服务端补的 */
const ID_RE = /^[a-z0-9]{6,32}$/;

type Ops = unknown[];
interface Option { label: string; ops: Ops }
export type ChatEntry =
  | { type: 'user'; id: string; at: number; base: number; message: string }
  | { type: 'ai'; id: string; at: number; base: number; reply?: string; ops?: Ops; options?: Option[]; error?: string }
  | { type: 'apply'; id: string; at: number; picked: number; version: number; ops: Ops; dropped: string[] };

export interface UserTurn { id: string; kind: 'user'; at: number; base: number; message: string }
export interface AiTurn {
  id: string; kind: 'ai'; at: number; base: number; reply?: string; ops?: Ops; options?: Option[]; error?: string;
  picked?: number; applied?: number; appliedOps?: Ops; dropped?: string[];
}
export type ChatTurn = UserTurn | AiTurn;

/** 合规的 id 原样用，否则生成一个 */
export const turnId = (raw: unknown): string => (typeof raw === 'string' && ID_RE.test(raw) ? raw : randomUUID().replace(/-/g, '').slice(0, 16));
export const isTurnId = (raw: unknown): raw is string => typeof raw === 'string' && ID_RE.test(raw);

export function appendChat(spaceDir: string, entry: ChatEntry): void {
  appendFileSync(join(spaceDir, CHAT_FILE), `${JSON.stringify(entry)}\n`);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 一行解析成记录；坏行、字段不全的返回 null */
function parseLine(line: string): ChatEntry | null {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return null; }
  if (!isObj(v) || !isTurnId(v.id) || !num(v.at)) return null;
  if (v.type === 'user') return num(v.base) && typeof v.message === 'string' ? (v as ChatEntry) : null;
  if (v.type === 'ai') return num(v.base) ? (v as ChatEntry) : null;
  if (v.type === 'apply') return num(v.picked) && num(v.version) && Array.isArray(v.ops) ? (v as ChatEntry) : null;
  return null;
}

/** 一条记录并入对话条目：用户的话、AI 回复各成一条；执行记录并到对应的 AI 回复上 */
function fold(turns: ChatTurn[], e: ChatEntry): ChatTurn[] {
  if (e.type === 'user') return [...turns, { id: e.id, kind: 'user', at: e.at, base: e.base, message: e.message }];
  if (e.type === 'ai') {
    const { type: _t, ...rest } = e;
    return [...turns, { ...rest, kind: 'ai' }];
  }
  return turns.map((t) => (t.id === e.id && t.kind === 'ai' ? { ...t, picked: e.picked, applied: e.version, appliedOps: e.ops, dropped: e.dropped ?? [] } : t));
}

export function readChat(spaceDir: string): ChatTurn[] {
  const file = join(spaceDir, CHAT_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map(parseLine)
    .filter((e): e is ChatEntry => e !== null).reduce(fold, []);
}
