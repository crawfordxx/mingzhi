import React from 'react';
import type { CardSpec, TemplateId } from '../../src/storyboard/schema.js';
import type { TemplateProps } from './parts.js';
import { BigNumber } from './BigNumber.js';
import { Browser } from './Browser.js';
import { Chips } from './Chips.js';
import { CompareBars } from './CompareBars.js';
import { Cta } from './Cta.js';
import { EvidenceList } from './EvidenceList.js';
import { Hook, HookBackdrop } from './Hook.js';
import { Photo, PhotoBackdrop } from './Photo.js';
import { StrikeList } from './StrikeList.js';
import { Terminal } from './Terminal.js';
import { Title } from './Title.js';
import { Toggles } from './Toggles.js';

/** 每个模板 id 对应接收该模板 props 的组件（编译期保证 12 个都登记） */
type Registry = { [K in TemplateId]: React.FC<TemplateProps<K>> };
/** 任意模板的组件（运行时按 card.template 取出后使用） */
type AnyTemplate = React.FC<TemplateProps<TemplateId>>;

/** 模板注册表 */
export const TEMPLATES: Registry = {
  hook: Hook,
  title: Title,
  bigNumber: BigNumber,
  chips: Chips,
  compareBars: CompareBars,
  evidenceList: EvidenceList,
  terminal: Terminal,
  toggles: Toggles,
  strikeList: StrikeList,
  browser: Browser,
  photo: Photo,
  cta: Cta,
};

/** 铺满卡片区、不随卡片进出场移动的底（例如钩子卡的黑底与配图），避免相邻镜头之间底色闪烁 */
const BACKDROPS: Partial<Registry> = { hook: HookBackdrop, photo: PhotoBackdrop };

/** 按模板 id 渲染卡片内容；local 为镜头内秒数，dur 为镜头时长；未登记的模板（未经校验的数据）直接抛错 */
export function renderCard(card: CardSpec, local: number, dur: number): React.ReactNode {
  const Component = TEMPLATES[card.template] as AnyTemplate | undefined;
  if (!Component) throw new Error('未登记的模板：' + card.template);
  return React.createElement(Component, { props: card.props, local, dur });
}

/** 模板的固定底；没有则返回 null（用卡片区米色底） */
export function renderBackdrop(card: CardSpec, local: number, dur: number): React.ReactNode {
  const Component = BACKDROPS[card.template] as AnyTemplate | undefined;
  return Component ? React.createElement(Component, { props: card.props, local, dur }) : null;
}
