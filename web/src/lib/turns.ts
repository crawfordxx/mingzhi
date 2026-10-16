/**
 * 对话记录：服务端按项目存（<space>/chat.jsonl，GET /api/spaces/:id/chat），换浏览器、清缓存后照样在；
 * 本机只在内存里放还在等回复、正在执行的条目，与服务端的合并（mergeTurns）。
 * 服务端返回的每一条都过结构校验（坏数据直接丢掉，不让页面白屏）。
 */
import type { EditOp, EditOption } from '../api';

export interface UserTurn { id: string; kind: 'user'; at: number; message: string; base: number }
export interface AiTurn {
  id: string; kind: 'ai'; at: number; base: number;
  /** 等模型回复中 */
  pending?: boolean;
  reply?: string; ops?: EditOp[]; options?: EditOption[]; error?: string;
  /** 用户点了第几个选项（-1 = 直接执行 ops） */
  picked?: number;
  /** 执行后得到的新版本号；applying 为执行请求在途 */
  applied?: number; applying?: boolean; dropped?: string[];
  /** 实际提交执行的操作（出片中卡据此标出要重渲的镜头） */
  appliedOps?: EditOp[];
  /** 刷新前执行请求还在途：不知道是否已提交，选项锁住，请到版本卡确认 */
  unsure?: boolean;
}
export type Turn = UserTurn | AiTurn;


type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isOp = (v: unknown): v is EditOp => isObj(v) && typeof v.type === 'string';
const isOps = (v: unknown): v is EditOp[] => Array.isArray(v) && v.every(isOp);
const isOption = (v: unknown): v is EditOption => isObj(v) && typeof v.label === 'string' && isOps(v.ops);
const optional = (v: unknown, ok: (x: unknown) => boolean): boolean => v === undefined || ok(v);

function validUser(t: Raw): t is Raw & UserTurn {
  return t.kind === 'user' && typeof t.message === 'string';
}

function validAi(t: Raw): t is Raw & AiTurn {
  return t.kind === 'ai'
    && optional(t.reply, (v) => typeof v === 'string') && optional(t.error, (v) => typeof v === 'string')
    && optional(t.ops, isOps) && optional(t.appliedOps, isOps)
    && optional(t.options, (v) => Array.isArray(v) && v.every(isOption))
    && optional(t.picked, isNum) && optional(t.applied, isNum)
    && optional(t.dropped, (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'));
}

/** 结构不对的条目丢弃；上次没等完的回复、在途的执行请求按「不确定」处理 */
export function sanitizeTurns(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).filter((t) => typeof t.id === 'string' && isNum(t.at) && isNum(t.base) && (validUser(t) || validAi(t)))
    .map((t) => settle(t as unknown as Turn));
}

function settle(t: Turn): Turn {
  if (t.kind !== 'ai') return t;
  if (t.applying) return { ...t, applying: false, unsure: true, error: '刷新前这次修改正在提交，不确定是否已经出片，请看下面的版本卡' };
  if (t.pending) return { ...t, pending: false, error: t.reply ? t.error : '页面刷新了，这一轮没有等到回复' };
  return t;
}

/** 还在等回复或正在执行（服务端还没有结果） */
const inFlight = (t: Turn): boolean => t.kind === 'ai' && (!!t.pending || !!t.applying);

/** 合并：以服务端为准；本机在途的条目保留本机的样子；服务端还没有的本机条目按时间接上 */
export function mergeTurns(server: readonly Turn[], local: readonly Turn[]): Turn[] {
  const mine = new Map(local.map((t) => [t.id, t]));
  const known = new Set(server.map((t) => t.id));
  const merged = server.map((t) => { const l = mine.get(t.id); return l && inFlight(l) ? l : t; });
  return [...merged, ...local.filter((t) => !known.has(t.id))].sort((a, b) => a.at - b.at);
}

/** 版本卡上「触发它的那句话」：执行出第 n 版的回复前面那句用户的话 */
export function saidFor(turns: readonly Turn[], n: number): string | undefined {
  const at = turns.findIndex((t) => t.kind === 'ai' && t.applied === n);
  const user = turns.slice(0, Math.max(0, at)).reverse().find((t): t is UserTurn => t.kind === 'user');
  return at >= 0 ? user?.message : undefined;
}

export const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
