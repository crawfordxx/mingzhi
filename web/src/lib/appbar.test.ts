import { describe, expect, it } from 'vitest';
import type { Space, Status } from '../api';
import { exitWarning, updateToShow } from './appbar';

const base: Status = { version: '0.1.0', keyConfigured: true, modelsReady: true, assetsReady: true, ffmpegReady: true };
const UPDATE = { version: '0.2.0', url: 'https://github.com/crawfordxx/mingzhi/releases/tag/v0.2.0', notes: '修复' };

describe('新版本胶囊的显示条件', () => {
  it('服务端给了新版本、开关开着：显示', () => {
    expect(updateToShow({ ...base, update: UPDATE }, true)).toEqual(UPDATE);
  });

  it('开关状态还没读到（undefined）时按服务端为准：服务端关掉检查时本来就不给 update', () => {
    expect(updateToShow({ ...base, update: UPDATE }, undefined)).toEqual(UPDATE);
  });

  it('没有 status、没有 update：不显示', () => {
    expect(updateToShow(undefined, true)).toBeNull();
    expect(updateToShow(base, true)).toBeNull();
  });

  it('用户刚在设置里关掉检查更新：立即不显示', () => {
    expect(updateToShow({ ...base, update: UPDATE }, false)).toBeNull();
  });

  it('与当前版本相同（服务端缓存未刷新）：不显示', () => {
    expect(updateToShow({ ...base, version: '0.2.0', update: UPDATE }, true)).toBeNull();
  });

  it.each([
    ['不是本仓库的 Release 页', { ...UPDATE, url: 'https://evil.example/releases/tag/v0.2.0' }],
    ['http 地址', { ...UPDATE, url: 'http://github.com/crawfordxx/mingzhi/releases/tag/v0.2.0' }],
    ['javascript: 地址', { ...UPDATE, url: 'javascript:alert(1)' }],
    ['版本号为空', { ...UPDATE, version: '' }],
  ])('数据不可信（%s）：不显示', (_name, update) => {
    expect(updateToShow({ ...base, update }, true)).toBeNull();
  });
});

const space = (id: string, title: string, job: Space['job']): Space =>
  ({ id, title, createdAt: '', inputs: [], versions: [], job, totalCostYuan: 0, settings: { captionStyle: 'blade', budgetYuan: 10, broll: true, maxVideos: 1 } });

describe('退出确认里的任务提示', () => {
  it('没有任务：没有提示', () => {
    expect(exitWarning([space('a', '第1期', null)])).toBeNull();
  });

  it('一个任务在出片：点名哪一期哪一版', () => {
    expect(exitWarning([space('a', '第3期', { state: 'running', version: 2 }), space('b', '第1期', null)]))
      .toBe('「第3期」v2 正在出片，退出会中断它（已经花掉的费用不退）。');
  });

  it('多个任务（含排队）：说总数', () => {
    expect(exitWarning([space('a', '第3期', { state: 'running', version: 2 }), space('b', '第4期', { state: 'queued', version: 1 })]))
      .toBe('有 2 个任务正在出片或排队，退出会中断它们（已经花掉的费用不退）。');
  });
});
