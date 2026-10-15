/**
 * 对话记录：服务端不存对话（只存版本），这里按项目存在本机浏览器里，刷新后还能看到。
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
}
export type Turn = UserTurn | AiTurn;

const KEY = (spaceId: string) => `mingzhi.turns.${spaceId}`;
const MAX_TURNS = 200;

export function loadTurns(spaceId: string): Turn[] {
  try {
    const raw = window.localStorage.getItem(KEY(spaceId));
    const list = raw ? (JSON.parse(raw) as Turn[]) : [];
    // 上次关页面时还在等的回复，不会再回来了
    return Array.isArray(list) ? list.map((t) => (t.kind === 'ai' && (t.pending || t.applying) ? { ...t, pending: false, applying: false, error: t.reply ? t.error : '页面刷新了，这一轮没有等到回复' } : t)) : [];
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
