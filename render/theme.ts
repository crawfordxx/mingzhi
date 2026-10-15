/** 视觉常量（来自参考片实测，见计划 Global Constraints） */
export const THEME = {
  stage: '#EFEBE5',
  card: '#FFFFFF',
  ink: '#1C1B19',
  sub: '#6B675F',
  faint: '#A39E94',
  radius: 28,
  shadow: '0 18px 48px rgba(40, 30, 20, 0.12)',
  badge: { 成本: '#C8891A', 收益: '#2F9E58', 证据: '#2F6FE0', 来源: '#7B4FD6' } as Record<string, string>,
  red: '#E04848',
  gold: '#C8891A',
  crumbDot: '#F06A2A',
  hookLime: '#D4F23C',
  hookBg: '#0E0F0C',
  terminal: '#1E1E1E',
  font: '"PingFang SC", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif',
  mono: '"SF Mono", Menlo, "JetBrains Mono", monospace',
} as const;
