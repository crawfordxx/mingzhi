/**
 * 开始出片之后的对话流：v1 剪辑直播 → 版本卡 → 你说的话 → 明知的回复（可带内联选项）→ 出片中卡 → 新版本卡……
 * 版本（服务端时间）与对话（本机记录）按时间先后排在一起。
 */
import { useEffect, type RefObject } from 'react';
import type { Options, Space, VersionMeta, VersionState } from '../api';
import type { ShotInfo } from '../lib/liveModel';
import { cliLine } from '../lib/cli';
import { splitMessage } from '../lib/shots';
import type { AiTurn, Turn } from '../lib/turns';
import type { Replay } from '../live';
import type { Conversation } from '../useConversation';
import type { Runs } from '../useRuns';
import { backgroundLabel } from './SetupCard';
import { InlineOptions } from './InlineOptions';
import { LiveCard } from './LiveCard';
import { Msg, Who } from './Msg';
import { RunCard } from './RunCard';
import { TimeRefChip } from './TimeRefChip';
import { thumbSecOf, VersionCard } from './VersionCard';

type Item = { at: number; key: string } & ({ kind: 'turn'; turn: Turn } | { kind: 'version'; meta: VersionMeta });

function itemsOf(space: Space, turns: Turn[]): Item[] {
  const versions: Item[] = space.versions.filter((v) => v.n > 1 || v.status === 'done').map((v) => ({ kind: 'version', meta: v, at: Date.parse(v.createdAt) + (v.n === 1 ? 1 : 0), key: `v${v.n}` }));
  const said: Item[] = turns.map((t) => ({ kind: 'turn', turn: t, at: t.at, key: t.id }));
  return [...versions, ...said].sort((a, b) => a.at - b.at);
}

const shotsOf = (state?: VersionState): ShotInfo[] | undefined =>
  state?.storyboard.shots.map((s, index) => ({ index, start: s.start, end: s.end, layout: s.layout, template: s.card?.template }));

/** 这一轮执行的操作里点名了哪些镜头 */
function hotOf(turns: Turn[], n: number): ReadonlySet<number> | undefined {
  const turn = turns.find((t): t is AiTurn => t.kind === 'ai' && t.applied === n);
  const idx = (turn?.appliedOps ?? []).map((op) => op.shotIndex).filter((i): i is number => typeof i === 'number');
  return idx.length ? new Set(idx) : undefined;
}

function UserBubble({ message }: { message: string }) {
  const { refs, text } = splitMessage(message);
  return <div className="bubble">{refs.map((r) => <TimeRefChip key={`${r.sec}${r.label}`} r={r} />)}{text}</div>;
}

function AiReply({ turn, busy, onPick }: { turn: AiTurn; busy: boolean; onPick: (i: number) => void }) {
  return (
    <>
      <Who>明知</Who>
      {turn.pending ? <p className="say typing" aria-label="明知正在想"><i /><i /><i /></p>
        : turn.reply ? <p className="say">{turn.reply}</p> : null}
      {turn.error && <p className="say err">{turn.error}</p>}
      {!!turn.options?.length && <InlineOptions options={turn.options} picked={turn.picked} applying={turn.applying} applied={turn.applied} disabled={busy} onPick={onPick} />}
      {!turn.options?.length && (turn.applying || turn.applied !== undefined) && <p className="picked">{turn.applying ? '正在排队出新版本…' : <>已执行 · 出 <span className="it l">v{turn.applied}</span></>}</p>}
      {!!turn.dropped?.length && <p className="picked warn">有 {turn.dropped.length} 处没法执行，已忽略：{turn.dropped.join('；')}</p>}
    </>
  );
}

interface Props {
  space: Space; options: Options; runs: Runs; convo: Conversation; replay: Replay;
  stream: RefObject<HTMLDivElement>; onSeek: (n: number, sec: number) => void;
}

export function Thread({ space, options, runs, convo, replay, stream, onSeek }: Props) {
  const v1 = space.versions.find((v) => v.n === 1);
  const items = itemsOf(space, convo.turns);
  const done = space.versions.filter((v) => v.status === 'done');
  const latest = done.at(-1)?.n;
  const busy = runs.active !== undefined;
  const backdrop = backgroundLabel(space, options).thumb;
  const tail = `${items.length}:${convo.turns.at(-1)?.kind === 'ai' ? String((convo.turns.at(-1) as AiTurn).pending) : ''}:${runs.active ?? ''}`;
  useEffect(() => {
    const el = stream.current;
    if (el) window.setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }), 60);
  }, [tail, stream]);

  const versionItem = (meta: VersionMeta) => (meta.status === 'done'
    ? <VersionCard spaceId={space.id} thumbSec={thumbSecOf(meta, runs.stateOf(meta.n)?.storyboard.shots)} meta={meta} parent={done.find((v) => v.n === (meta.parent ?? meta.n - 1))} totalShots={runs.stateOf(meta.n)?.storyboard.shots.length}
        events={runs.eventsOf(meta.n)} viewing={runs.view === meta.n} latest={meta.n === latest} exporting={runs.exporting === meta.n} busy={busy}
        onView={() => runs.setView(meta.n)} onExport={() => void runs.exportVersion(meta.n)} onRevert={() => void runs.revert(meta.n)} />
    : <RunCard meta={meta} events={runs.eventsOf(meta.n)} onCancel={runs.active === meta.n ? () => void runs.cancel() : undefined} backdrop={backdrop}
        shots={shotsOf(runs.stateOf(meta.parent ?? meta.n - 1))} hot={hotOf(convo.turns, meta.n)} />);

  return (
    <>
      {v1 && (
        <Msg root={stream} id="live">
          <Who>明知 · 剪辑直播</Who>
          <LiveCard events={runs.eventsOf(1)} title={space.inputs[0] ?? space.title} command={cliLine(space)} backdrop={backdrop}
            live={runs.active === 1} replay={replay} onSeek={(sec) => onSeek(1, sec)} onCancel={() => void runs.cancel()} />
        </Msg>
      )}
      {items.map((it) => (
        <Msg key={it.key} root={stream} user={it.kind === 'turn' && it.turn.kind === 'user'}>
          {it.kind === 'version' ? versionItem(it.meta)
            : it.turn.kind === 'user' ? <UserBubble message={it.turn.message} />
              : <AiReply turn={it.turn} busy={busy} onPick={(i) => convo.pick(it.turn as AiTurn, i)} />}
        </Msg>
      ))}
    </>
  );
}
