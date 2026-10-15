import type { TemplateId } from './schema.js';

export interface CatalogEntry { id: TemplateId; use: string; props: string }

/** 模板目录：给模型看的用途与字段说明；字段长度上限须与 schema.ts 保持一致 */
export const CATALOG: readonly CatalogEntry[] = [
  {
    id: 'hook',
    use: '开头钩子大字卡，一张对应一句最抓人的话',
    props: 'index（第几张，从 1 起）、total（共几张，1-3）、headline（主标题 ≤60 字）、highlight（高亮词数组，最多 3 个，每个 ≤12 字，必须是 headline 的子串）、kicker（可选，小标题 ≤60 字）、stat（可选，{value ≤24 字, label ≤24 字}）、image（可选，可用图片文件名）',
  },
  {
    id: 'title',
    use: '讲一个观点或结论时的标题卡',
    props: 'title（≤60 字）、subtitle（可选，≤60 字）、crumb（可选，面包屑 ≤24 字）',
  },
  {
    id: 'bigNumber',
    use: '强调一个关键数字（价格、增长率、人数等）',
    props: 'value（数字本身 ≤10 字，如 "3.5"）、unit（可选，单位 ≤24 字）、label（说明 ≤60 字）、chips（可选，标签数组，最多 18 个，每个 ≤12 字）、highlight（可选，高亮标签数组，最多 6 个，每个 ≤12 字）',
  },
  {
    id: 'chips',
    use: '分组罗列可选项或适用/不适用的对象，带对勾叉号标记',
    props: 'groups（1-2 组）：每组 {label ≤12 字, items（1-5 个）：{text ≤12 字, mark 取 "yes"|"no"|"maybe"}}',
  },
  {
    id: 'compareBars',
    use: '对比 2-3 个方案、产品或做法的优劣，用横条表示程度',
    props: 'crumb（可选，≤24 字）、items（1-3 项）：{name ≤12 字, note 可选 ≤24 字, value 0 到 1 的小数, annotation 可选 ≤12 字, tone 取 "bad"|"warn"|"good"}、verdict（可选结论，≤12 字）',
  },
  {
    id: 'evidenceList',
    use: '列出成本、收益、证据、来源等多条依据',
    props: 'crumb（可选，≤24 字）、title（≤60 字）、rows（1-5 行）：{badge 取 "成本"|"收益"|"证据"|"来源", text ≤60 字}、highlight（可选，要高亮的行号数组，从 0 起，最多 5 个）、tags（可选，最多 3 个，每个 ≤12 字）',
  },
  {
    id: 'terminal',
    use: '命令行、代码或配置片段的展示，适合技术操作类内容',
    props: 'title（可选，≤24 字）、lines（1-6 行，每行 ≤40 字）',
  },
  {
    id: 'toggles',
    use: '一组开关设置，演示打开或关闭哪些选项',
    props: 'title（可选，≤24 字）、rows（1-4 行）：{label ≤12 字, on 为 true 或 false}、footnote（可选，≤60 字）',
  },
  {
    id: 'strikeList',
    use: '划掉一组过时、错误或不该做的事项',
    props: 'title（可选，≤24 字）、items（1-5 项，每项 ≤12 字）',
  },
  {
    id: 'browser',
    use: '展示一个网站或网页，浏览器窗口样式',
    props: 'url（网址 ≤80 字）、title（可选，≤60 字）、image（可选，网页截图，只能用可用图片文件名）',
  },
  {
    id: 'photo',
    use: '展示一张配图（实物、截图、场景）；可用图片为无时禁止使用',
    props: 'image（必填，只能用可用图片文件名）、label（可选，≤24 字）、sublabel（可选，≤60 字）',
  },
  {
    id: 'cta',
    use: '结尾号召（关注、点赞、收藏），只用于最后一个镜头，layout 用 full',
    props: 'actions 固定写 ["关注","点赞","收藏"]，不要改动',
  },
];
