// 片尾设置：项目设置接口可改文字、可关闭；新项目缺省带 outro（开启）；没有该字段的旧项目见 outro-legacy.test.ts
import { describe, expect, it } from 'vitest';
import { OUTRO_DEFAULT_TEXT, OUTRO_TEXT_MAX } from '../src/compose/ending.js';
import { DEFAULT_SETTINGS, mergeSettings, parseSettingsPatch } from '../src/server/spaces.js';

describe('片尾设置', () => {
  it('缺省设置带 outro（开启、默认文字）；设置接口可关闭或改文字', () => {
    expect(DEFAULT_SETTINGS.outro).toEqual({ enabled: true, text: OUTRO_DEFAULT_TEXT });
    expect(parseSettingsPatch({ outro: { enabled: false, text: '' } })).toEqual({ outro: { enabled: false, text: '' } });
    expect(mergeSettings(DEFAULT_SETTINGS, parseSettingsPatch({ outro: { enabled: true, text: ' 某某出品 ' } })).outro).toEqual({ enabled: true, text: '某某出品' });
  });
  it('文字过长、字段不全、多余字段、类型不对都拒绝', () => {
    expect(() => parseSettingsPatch({ outro: { enabled: true, text: '一'.repeat(OUTRO_TEXT_MAX + 1) } })).toThrow('设置不合法');
    expect(() => parseSettingsPatch({ outro: { enabled: true } })).toThrow('设置不合法');
    expect(() => parseSettingsPatch({ outro: { enabled: true, text: 'x', logo: 'y' } })).toThrow('设置不合法');
    expect(() => parseSettingsPatch({ outro: 'off' })).toThrow('设置不合法');
  });
});
