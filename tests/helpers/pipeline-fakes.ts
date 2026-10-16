/** pipeline 测试共用的假分镜与假自检 */
import type { QaDeps } from '../../src/pipeline/qa-step.js';
import type { CardQaEntry } from '../../src/qa/visual.js';

export const FAKE_STORYBOARD = { shots: [{ start: 0, end: 2, layout: 'split', card: { template: 'title', props: { title: '测试' } } }], bgm: 'tech', coverTitle: { title: '高性价比', subtitle: '测试封面' } };

/** 假卡片自检：不跑 Remotion 打包，原样返回分镜与一份报告；记录收到的参数。整片自检给达标的假度量 */
export const fakeQa = (report: CardQaEntry[] = []): { deps: QaDeps; seen: { meter?: unknown; storyboard?: unknown }[] } => {
  const seen: { meter?: unknown; storyboard?: unknown }[] = [];
  // 整片自检默认给达标的假度量（流程顺序确定，不触发局部重做）；要真实度量的用例自己去掉 film
  const film: QaDeps['film'] = async () => ({ ok: true, durationSec: 0, metrics: [], templates: [], skipped: [] });
  return { seen, deps: { qaCards: async (o) => { seen.push({ meter: o.meter, storyboard: o.storyboard }); return { storyboard: o.storyboard, report }; }, film } };
};
