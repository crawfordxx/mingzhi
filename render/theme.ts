/** 视觉常量（来自参考片实测，见计划 Global Constraints） */
export const THEME = {
  stage: '#EFEBE5',
  card: '#FFFFFF',
  ink: '#1C1B19',
  sub: '#6B675F',
  faint: '#A39E94',
  radius: 28,
  shadow: '0 18px 48px rgba(40, 30, 20, 0.12)',
  /** 白字胶囊底色，与白字对比度均 ≥ 4.5（成本/收益比参考片的鲜亮色略深） */
  badge: { 成本: '#9D6C14', 收益: '#28864B', 证据: '#2F6FE0', 来源: '#7B4FD6' } as Record<string, string>,
  /** 色块/柱条等填充用的原色；做文字用 *Text（深一档，对比度 ≥ 4.5） */
  red: '#E04848',
  gold: '#C8891A',
  green: '#2F9E58',
  redText: '#CB2222',
  goldText: '#9D6C14',
  greenText: '#247B44',
  /** 浅色底：对勾/叉号胶囊、高亮格子 */
  tint: { yes: '#E3F3E8', no: '#FBE5E4', hot: '#F2FAF4' },
  /** CTA 胶囊：点击后翻成的彩底（鲜亮保持参考片原色，字色由 readableOn 按底色自动选）；未点时是半透明白底灰字 */
  cta: { actions: { 关注: '#F2334B', 点赞: '#FF7A2F', 收藏: '#F5A623' } as Record<string, string>, fallback: ['#2F6FE0', '#7B4FD6', '#2F9E58'] as readonly string[],
    idle: { fg: '#55524D', bg: '#FAF9F7', alpha: 0.94 } },
  /** 对比图的灰色瓶身（warn 档），瓶上标签字色由 readableOn 选 */
  neutral: '#8D97A2',
  /** 「不确定」胶囊：浅灰底 + 加深一档的灰字 */
  maybe: { bg: '#EEEDEA', fg: '#6E6962' },
  /** 浏览器卡「正在加载…」提示字 */
  hint: '#737573',
  /** 浏览器地址栏胶囊 */
  url: { bg: '#EEF1F0', fg: '#2E3330' },
  /** 终端卡文字（底色 THEME.terminal） */
  termInk: { title: '#D97757', head: '#FFFFFF', body: '#D6D6D6', prompt: '#9C9C9C' },
  /** 图片卡标签：白色半透明玻璃底；副标题在最不利的暗图上也要 ≥ 4.5，所以比 sub 再深一点 */
  glass: { bg: '#FFFFFF', alpha: 0.86 },
  subOnGlass: '#625E57',
  crumbDot: '#F06A2A',
  hookLime: '#D4F23C',
  hookBg: '#0E0F0C',
  terminal: '#1E1E1E',
  font: '"PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif',
  mono: '"SF Mono", Menlo, "JetBrains Mono", monospace',
} as const;
