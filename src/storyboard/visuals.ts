import type { Storyboard, Visual } from './schema.js';

export interface VisualNeed { shotIndex: number; template: 'hook' | 'photo' | 'browser'; visual: Visual }

/** 列出分镜里全部素材需求（hook / photo / browser 卡片上的 visual）及其镜头下标 */
export function visualsOf(storyboard: Storyboard): VisualNeed[] {
  return storyboard.shots.flatMap((shot, shotIndex): VisualNeed[] => {
    const card = shot.card;
    if (card?.template !== 'hook' && card?.template !== 'photo' && card?.template !== 'browser') return [];
    return card.props.visual ? [{ shotIndex, template: card.template, visual: card.props.visual }] : [];
  });
}
