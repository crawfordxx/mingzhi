import React from 'react';
import type { CardSpec, TemplateId } from '../../src/storyboard/schema.js';
import { BigNumber } from './BigNumber.js';
import { Chips } from './Chips.js';
import { CompareBars } from './CompareBars.js';
import { EvidenceList } from './EvidenceList.js';
import { Hook, HookBackdrop } from './Hook.js';
import { Title } from './Title.js';

/** 模板组件：props 为该模板的数据，local 为镜头内的秒数（从 0 开始） */
export type TemplateComponent = React.FC<{ props: any; local: number }>;

/** 模板注册表 */
export const TEMPLATES: Partial<Record<TemplateId, TemplateComponent>> = {
  hook: Hook,
  title: Title,
  bigNumber: BigNumber,
  chips: Chips,
  compareBars: CompareBars,
  evidenceList: EvidenceList,
};

/** 铺满卡片区、不随卡片进出场移动的底（例如钩子卡的黑底与配图），避免相邻镜头之间底色闪烁 */
const BACKDROPS: Partial<Record<TemplateId, TemplateComponent>> = { hook: HookBackdrop };

/** 按模板 id 渲染卡片内容；未登记的模板直接抛错 */
export function renderCard(card: CardSpec, local: number): React.ReactNode {
  const Component = TEMPLATES[card.template];
  if (!Component) throw new Error('未登记的模板：' + card.template);
  return React.createElement(Component, { props: card.props, local });
}

/** 模板的固定底；没有则返回 null（用卡片区米色底） */
export function renderBackdrop(card: CardSpec, local: number): React.ReactNode {
  const Component = BACKDROPS[card.template];
  return Component ? React.createElement(Component, { props: card.props, local }) : null;
}
