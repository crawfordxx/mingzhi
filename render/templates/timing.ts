/**
 * 模板里与音效对齐的动画关键时间点（秒，相对镜头开始）。纯数据、不依赖 React：
 * 模板（.tsx）用它们驱动动画，音效规划（src/audio/sfx-plan.ts）直接引用，改动画节奏时音效自动跟着走。
 */

/** 钩子标题高亮刷开：第 0 行从 MARK_START 开始，每行晚 MARK_STAGGER，刷开用 MARK_SEC（Hook.tsx） */
export const HOOK_MARK_START = 0.2;
export const HOOK_MARK_STAGGER = 0.12;
export const HOOK_MARK_SEC = 0.5;
/** 钩子的 hit：第一行高亮刷开完成的时刻 */
export const HOOK_HIT_SEC = HOOK_MARK_START + HOOK_MARK_SEC;
