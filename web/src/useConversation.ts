/**
 * 对话修改：发一句话 → 模型给修改方案（回复 + ops + 可选项）→ 直接执行或等用户点选项 → 出新版本。
 * 规则：有选项时等用户选（执行 ops + 所选选项的 ops）；没有选项但有 ops 时直接执行；都没有时只是回复。
 * 输入框里的 @ 引用（TimeRef）也在这里，预览区点画面或暂停后「插入」都往这里加。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type EditOp, type Space } from './api';
import { composeMessage, type TimeRef } from './lib/shots';
import { mergeTurns, newId, sanitizeTurns, type AiTurn, type Turn } from './lib/turns';
import { errText } from './useWorkbench';

const MAX_REFS = 4;
const NONE: Turn[] = [];

/** 引用飞入输入框的起点（屏幕坐标） */
export interface Flying { ref: TimeRef; x: number; y: number; key: string }

/** 对话以服务端为准：打开项目时取服务端的对话记录，与内存里还在途的条目合并；连不上服务时只显示内存里的 */
function useTurns(spaceId?: string) {
  const [all, setAll] = useState<Record<string, Turn[]>>({});
  useEffect(() => {
    if (!spaceId) return undefined;
    let dead = false;
    api.chat(spaceId)
      .then((r) => { if (!dead) setAll((m) => ({ ...m, [spaceId]: mergeTurns(sanitizeTurns(r.turns), m[spaceId] ?? []) })); })
      .catch(() => undefined);
    return () => { dead = true; };
  }, [spaceId]);
  const turns = spaceId ? all[spaceId] ?? NONE : NONE;
  const update = useCallback((id: string, fn: (list: Turn[]) => Turn[]) => {
    setAll((m) => ({ ...m, [id]: fn(m[id] ?? []) }));
  }, []);
  return { turns, update };
}

function useRefs() {
  const [refs, setRefs] = useState<TimeRef[]>([]);
  const [flying, setFlying] = useState<Flying>();
  const put = useCallback((ref: TimeRef) =>
    setRefs((list) => (list.some((r) => r.sec === ref.sec && r.label === ref.label) ? list : [...list, ref].slice(-MAX_REFS))), []);
  /** 带起点时先飞一段再落进输入框 */
  const addRef = useCallback((ref: TimeRef, from?: { x: number; y: number }) => {
    if (from) setFlying({ ref, ...from, key: newId() });
    else put(ref);
  }, [put]);
  const land = useCallback(() => {
    if (flying) put(flying.ref);
    setFlying(undefined);
  }, [flying, put]);
  const removeRef = useCallback((i: number) => setRefs((list) => list.filter((_, k) => k !== i)), []);
  return { refs, setRefs, flying, addRef, land, removeRef };
}

type Update = (id: string, fn: (list: Turn[]) => Turn[]) => void;

/** 改一条 AI 回复；执行修改（apply）并把结果记回这条回复 */
function useApply(update: Update, refresh: (id: string) => Promise<void>) {
  const patchAi = useCallback((id: string, turnId: string, patch: Partial<AiTurn>) =>
    update(id, (list) => list.map((t) => (t.id === turnId && t.kind === 'ai' ? { ...t, ...patch } : t))), [update]);
  const runOps = useCallback(async (id: string, turnId: string, ops: EditOp[], parent: number, summary: string, picked: number) => {
    patchAi(id, turnId, { picked, applying: true, appliedOps: ops });
    try {
      const out = await api.apply(id, ops, parent, summary, { turn: turnId, picked });
      patchAi(id, turnId, { applying: false, applied: out.version, dropped: out.dropped });
      await refresh(id);
    } catch (err) {
      patchAi(id, turnId, { applying: false, picked: undefined, error: `没能执行：${errText(err)}` });
    }
  }, [patchAi, refresh]);
  return { patchAi, runOps };
}

interface Deps { space?: Space; base?: number; busy: boolean; notify: (m: string) => void; refresh: (id: string) => Promise<void> }

export function useConversation({ space, base, busy, notify, refresh }: Deps) {
  const { turns, update } = useTurns(space?.id);
  const r = useRefs();
  const [draft, setDraft] = useState('');
  const { setRefs } = r;
  useEffect(() => { setRefs([]); setDraft(''); }, [space?.id, setRefs]);

  const { patchAi, runOps } = useApply(update, refresh);

  const sending = useRef(false);
  const send = useCallback(async () => {
    if (!space || !base || sending.current) return;
    const text = draft.trim();
    if (!text && !r.refs.length) { notify('先说一句要改什么'); return; }
    const message = composeMessage(r.refs, text);
    const id = space.id;
    const aiId = newId();
    const userId = newId();
    const now = Date.now();
    update(id, (list) => [...list, { id: userId, kind: 'user', at: now, message, base }, { id: aiId, kind: 'ai', at: now + 1, base, pending: true }]);
    setDraft(''); r.setRefs([]);
    sending.current = true;
    try {
      const plan = await api.messages(id, message, base, { user: userId, ai: aiId });
      patchAi(id, aiId, { pending: false, reply: plan.reply, ops: plan.ops, options: plan.options ?? [] });
      if (!plan.options?.length && plan.ops.length) await runOps(id, aiId, plan.ops, plan.version, text.slice(0, 40) || '对话修改', -1);
    } catch (err) {
      patchAi(id, aiId, { pending: false, error: errText(err) });
    } finally {
      sending.current = false;
    }
  }, [space, base, draft, r, update, patchAi, runOps, notify]);

  const pick = useCallback((turn: AiTurn, index: number) => {
    if (!space || busy || turn.applied !== undefined || turn.applying || turn.unsure) return;
    const option = turn.options?.[index];
    if (!option) return;
    void runOps(space.id, turn.id, [...(turn.ops ?? []), ...option.ops], turn.base, option.label.slice(0, 40), index);
  }, [space, busy, runOps]);

  return { turns, draft, setDraft, send, pick, ...r };
}

export type Conversation = ReturnType<typeof useConversation>;
