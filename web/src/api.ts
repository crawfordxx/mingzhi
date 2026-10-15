/**
 * 工作台 HTTP 客户端（契约见 Task 6：src/server/routes.ts）。
 * 地址栏带 ?mock=1 或构建时 VITE_MOCK=1 时改用 ./mock.ts 的内存假数据，后端未就绪也能完整演示。
 */
import { createMockApi } from './mock';

export type BackgroundSpec = { kind: 'preset'; id: string } | { kind: 'file'; path: string } | { kind: 'prompt'; prompt: string };

export interface SpaceSettings {
  background?: BackgroundSpec;
  captionStyle: string;
  /** 封面风格 id（src/cover/styles.ts）；后端缺省时按 bauhaus */
  coverStyle?: string;
  budgetYuan: number;
  broll: boolean;
  maxVideos: number;
}

export interface VersionMeta {
  n: number;
  createdAt: string;
  parent?: number;
  summary: string;
  changedShots: number[];
  costYuan: number;
  qaScore?: number;
  status: 'running' | 'done' | 'failed';
}

export interface Space {
  id: string;
  title: string;
  createdAt: string;
  inputs: string[];
  versions: VersionMeta[];
  settings: SpaceSettings;
}

export interface Status {
  version: string;
  keyConfigured: boolean;
  /** 本机识别模型与预设素材是否已下载 */
  modelsReady: boolean;
  assetsReady: boolean;
}

export interface KeyInfo { configured: boolean; source?: 'env' | 'keychain' | 'file'; masked?: string }

export interface EstimateItem { label: string; yuan: number; low: number }
export interface Estimate { low: number; high: number; items: EstimateItem[] }

export interface BackgroundOption { id: string; name: string; thumb: string }
export interface CaptionOption { id: string; name: string; preview: string }
export interface CoverOption { id: string; name: string; example: string }
export interface Options { backgrounds: BackgroundOption[]; captionStyles: CaptionOption[]; coverStyles: CoverOption[] }

export type SpacePatch = { title?: string; settings?: Partial<SpaceSettings> };
export type Progress = (ratio: number) => void;

export interface Api {
  status(): Promise<Status>;
  options(): Promise<Options>;
  getKey(): Promise<KeyInfo>;
  /** 校验通过才保存；不通过时抛出带中文原因的 ApiError */
  saveKey(key: string): Promise<KeyInfo>;
  deleteKey(): Promise<void>;
  listSpaces(): Promise<Space[]>;
  createSpace(title?: string): Promise<Space>;
  getSpace(id: string): Promise<Space>;
  patchSpace(id: string, patch: SpacePatch): Promise<Space>;
  /** 一次传一段口播（流式，x-filename 头）；多段就多次调用 */
  uploadInput(id: string, file: File, onProgress?: Progress): Promise<Space>;
  /** 上传自定义背景图（契约待 Task 6 确认：POST /api/spaces/:id/background） */
  uploadBackground(id: string, file: File, onProgress?: Progress): Promise<Space>;
  estimate(id: string): Promise<Estimate>;
  start(id: string): Promise<{ version: number }>;
}

/** 后端错误统一为 { error: string }；这里转成带状态码的异常，界面直接展示 message */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function readError(res: Response): Promise<ApiError> {
  let message = `请求失败（${res.status}）`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) message = body.error;
  } catch {
    /* 非 JSON 响应：保留状态码提示 */
  }
  return new ApiError(message, res.status);
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  } catch {
    throw new ApiError('连不上本机服务，请确认 mingzhi serve 正在运行', 0);
  }
  if (!res.ok) throw await readError(res);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** fetch 拿不到上传进度，用 XHR 流式发送文件本体 */
function sendFile<T>(path: string, file: File, onProgress?: Progress): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onerror = () => reject(new ApiError('上传中断，请检查本机服务', 0));
    xhr.onload = () => {
      let body: { error?: string } & Record<string, unknown> = {};
      try { body = JSON.parse(xhr.responseText) as typeof body; } catch { /* 空响应 */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(new ApiError(body.error ?? `上传失败（${xhr.status}）`, xhr.status));
    };
    xhr.send(file);
  });
}

const enc = encodeURIComponent;

export function createHttpApi(): Api {
  return {
    status: () => json('/api/status'),
    options: () => json('/api/options'),
    getKey: () => json('/api/key'),
    saveKey: (key) => json('/api/key', { method: 'POST', body: JSON.stringify({ key }) }),
    deleteKey: () => json('/api/key', { method: 'DELETE' }),
    listSpaces: () => json('/api/spaces'),
    createSpace: (title) => json('/api/spaces', { method: 'POST', body: JSON.stringify(title ? { title } : {}) }),
    getSpace: (id) => json(`/api/spaces/${enc(id)}`),
    patchSpace: (id, patch) => json(`/api/spaces/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    uploadInput: (id, file, onProgress) => sendFile(`/api/spaces/${enc(id)}/inputs`, file, onProgress),
    uploadBackground: (id, file, onProgress) => sendFile(`/api/spaces/${enc(id)}/background`, file, onProgress),
    estimate: (id) => json(`/api/spaces/${enc(id)}/estimate`),
    start: (id) => json(`/api/spaces/${enc(id)}/start`, { method: 'POST' }),
  };
}

function mockEnabled(): boolean {
  if (import.meta.env.VITE_MOCK === '1') return true;
  return new URLSearchParams(window.location.search).get('mock') === '1';
}

export const api: Api = mockEnabled() ? createMockApi(new URLSearchParams(window.location.search)) : createHttpApi();
export const isMock = mockEnabled();

/** 项目已花费：各版本花费之和 */
export const spentOf = (space: Space | undefined): number => (space ? space.versions.reduce((sum, v) => sum + v.costYuan, 0) : 0);
