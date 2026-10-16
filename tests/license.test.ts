import { describe, expect, it } from 'vitest';
import { classifyLicense } from '../src/broll/sources/license.js';

describe('classifyLicense（白名单）', () => {
  it.each([
    ['CC0', false], ['cc0', false], ['CC0 1.0', false], ['Public domain', false], ['PUBLIC DOMAIN', false], ['  public domain ', false],
    ['PD-old', false], ['PD-US', false], ['pd old 100', false], ['PD-USGov', false],
    ['CC BY 4.0', true], ['cc by 4.0', true], ['CC-BY-4.0', true], ['CC_BY_3.0', true], ['CC BY 2.5', true], ['CC BY 3.0 de', true],
    ['Pexels License', false], ['Pixabay Content License', false],
  ])('放行 %s（署名=%s）', (name, attribution) => {
    expect(classifyLicense(name)).toEqual({ attributionRequired: attribution });
  });

  it.each([
    '', '   ', 'GFDL', 'Attribution', 'Copyrighted free use', 'GODL-India', 'OGL', 'Fair use', 'Public domain (non commercial)', 'PD-Italy',
    'CC BY', 'CC BY-SA 4.0', 'CC-BY-SA-4.0', 'cc by sa 3.0', 'CC BY-NC 2.0', 'CC BY-ND 2.0', 'cc-by-nc-nd-2.0', 'CC BY-NC-SA 4.0',
    'CC BY 3.0 or GFDL', 'CC BY-SA 3.0 or GFDL', 'CC BY 4.0 / CC BY-SA 4.0', 'CC BY 4.0, CC BY-SA 4.0', 'CC0 or CC BY-NC', 'Creative Commons',
  ])('排除 %j', (name) => {
    expect(classifyLicense(name)).toBeUndefined();
  });

  it('缺失许可名（undefined）排除', () => {
    expect(classifyLicense(undefined)).toBeUndefined();
  });
});
