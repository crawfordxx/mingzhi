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
  crumbDot: '#F06A2A',
  hookLime: '#D4F23C',
  hookBg: '#0E0F0C',
  terminal: '#1E1E1E',
  font: '"PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif',
  mono: '"SF Mono", Menlo, "JetBrains Mono", monospace',
} as const;
