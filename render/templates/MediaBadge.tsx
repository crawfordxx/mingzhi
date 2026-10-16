import React from 'react';
import type { Broll } from '../../src/storyboard/schema.js';
import { THEME } from '../theme.js';

/**
 * 画面角标（截图「来源：站点」、AI 生成「AI 生成」）：右上、小号、半透明玻璃底，不随 Ken Burns 移动。
 * 位置按容器比例：全屏在 y≈9%（避开平台顶栏与右上角搜索图标），远离下部字幕与右侧点赞栏。
 * 镜头 B-roll（BrollLayer）与卡片自带的图（钩子、图片卡的底）共用
 */
export const MediaBadge: React.FC<{ label: NonNullable<Broll['label']> }> = ({ label }) => (
  <div style={{ position: 'absolute', top: '9%', right: '4%', padding: '6px 14px', borderRadius: 999, fontFamily: THEME.font, fontSize: 22, lineHeight: 1.2, fontWeight: 500, letterSpacing: 0.5,
    color: 'rgba(255, 255, 255, 0.9)', background: 'rgba(18, 18, 16, 0.38)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
    border: '1px solid rgba(255, 255, 255, 0.18)', whiteSpace: 'nowrap' }}>
    {label.text}
  </div>
);
