/**
 * 对话记录：服务端不存对话（只存版本），这里按项目存在本机浏览器里，刷新后还能看到。
 * 读出来的每一条都过结构校验（旧格式、手改、别的扩展写入的坏数据直接丢掉，不让页面白屏）；
 * 读写都包 try/catch：隐私模式或存储被禁时退化为只在内存里。
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

const KEY = (spaceId: string) => `mingzhi.turns.${spaceId}`;
const MAX_TURNS = 200;

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

export function loadTurns(spaceId: string): Turn[] {
  try {
    const raw = window.localStorage.getItem(KEY(spaceId));
    return raw ? sanitizeTurns(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveTurns(spaceId: string, turns: readonly Turn[]): void {
  try {
    window.localStorage.setItem(KEY(spaceId), JSON.stringify(turns.slice(-MAX_TURNS)));
  } catch {
    /* 存不下就只留在内存里 */
  }
}

export const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
