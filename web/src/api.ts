/**
 * 工作台 HTTP 客户端，对齐 Task 6 实现（src/server/，路由表见 task-6-report.md）。
 * 地址栏带 ?mock=1 或构建时 VITE_MOCK=1 时改用 ./mock.ts（按需动态加载）的内存假数据。
 */
export type BackgroundSpec = { kind: 'preset'; id: string } | { kind: 'file'; path: string } | { kind: 'prompt'; prompt: string };

export interface SpaceSettings {
  background?: BackgroundSpec;
  captionStyle: string;
  /** 封面风格 id（src/cover/styles.ts）；缺省 = bauhaus */
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
  /** 文件名（服务端清洗过），不含本机路径 */
  inputs: string[];
  versions: VersionMeta[];
  settings: SpaceSettings;
  job: null | { state: 'queued' | 'running'; version: number };
  totalCostYuan: number;
}

export interface Status { version: string; keyConfigured: boolean; modelsReady: boolean; assetsReady: boolean; ffmpegReady: boolean }
export type KeySource = 'env' | 'keychain' | 'file';
export interface KeyInfo { configured: boolean; source?: KeySource; masked?: string }

export interface EstimateItem { label: string; yuan: number; low: number }
export interface Estimate { low: number; high: number; items: EstimateItem[]; durationSec?: number; budgetYuan?: number; text?: string }

export interface BackgroundOption { id: string; name: string; thumb: string }
export interface CaptionOption { id: string; name: string; preview: string }
export interface CoverOption { id: string; name: string; example: string }
export interface Options { backgrounds: BackgroundOption[]; captionStyles: CaptionOption[]; coverStyles: CoverOption[]; defaults?: Partial<SpaceSettings> }

/** background 传 null 表示清除（不换背景）；undefined 的键会被 JSON 丢掉，等于不改 */
export type SettingsPatch = Partial<Omit<SpaceSettings, 'background'>> & { background?: BackgroundSpec | null };
export type SpacePatch = { title?: string; settings?: SettingsPatch };
export interface UploadedInput { name: string; bytes: number; durationSec: number; width: number; height: number }
export type Progress = (ratio: number) => void;
export interface UploadOpts { onProgress?: Progress; signal?: AbortSignal }

export interface Api {
  status(): Promise<Status>;
  options(): Promise<Options>;
  getKey(): Promise<KeyInfo>;
  /** 校验通过才保存；无效 400、暂时无法校验 503，都抛带中文原因的 ApiError */
  saveKey(key: string): Promise<KeyInfo>;
  deleteKey(): Promise<void>;
  listSpaces(): Promise<Space[]>;
  createSpace(title?: string): Promise<Space>;
  getSpace(id: string): Promise<Space>;
  patchSpace(id: string, patch: SpacePatch): Promise<Space>;
  /** 一次传一段口播（流式，x-filename 头）；多段就多次调用 */
  uploadInput(id: string, file: File, opts?: UploadOpts): Promise<Space & { uploaded?: UploadedInput }>;
  /** 按 inputs 下标删除一段口播（出片前） */
  deleteInput(id: string, index: number): Promise<Space>;
  uploadBackground(id: string, file: File, opts?: UploadOpts): Promise<Space>;
  /** 没有口播时服务端返回 400，调用方应先判断 */
  estimate(id: string): Promise<Estimate>;
  start(id: string): Promise<{ version: number; queued: number }>;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const OFFLINE = '连不上本机服务，请确认 pnpm serve 正在运行';
const UNREADABLE = '本机服务返回了无法识别的内容';
/** 校验 key 要请求可想 AI，给长一点 */
const TIMEOUT_MS = 20_000;
const KEY_TIMEOUT_MS = 45_000;

async function readError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return new ApiError(body.error, res.status);
  } catch {
    /* 非 JSON 错误体：下面按状态码给提示 */
  }
  if ([502, 503, 504].includes(res.status)) return new ApiError(OFFLINE, res.status);
  return new ApiError(`请求失败（${res.status}）`, res.status);
}

async function json<T>(path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json', ...init.headers } });
  } catch (err) {
    throw new ApiError(err instanceof DOMException && err.name === 'TimeoutError' ? '本机服务太久没有响应，请稍后再试' : OFFLINE, 0);
  }
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(UNREADABLE, res.status);
  }
}

/** fetch 拿不到上传进度，用 XHR 流式发送文件本体；signal 中止时 reject「已取消」 */
function sendFile<T>(path: string, file: File, { onProgress, signal }: UploadOpts = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ApiError('已取消', 0)); return; }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal?.addEventListener('abort', abort, { once: true });
    xhr.open('POST', path);
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onabort = () => reject(new ApiError('已取消', 0));
    xhr.onerror = () => reject(new ApiError('上传中断，请检查本机服务', 0));
    xhr.onloadend = () => signal?.removeEventListener('abort', abort);
    xhr.onload = () => {
      let body: { error?: string } & Record<string, unknown> = {};
      try { body = JSON.parse(xhr.responseText) as typeof body; } catch { /* 空或非 JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(new ApiError(body.error ?? ([502, 503, 504].includes(xhr.status) ? OFFLINE : `上传失败（${xhr.status}）`), xhr.status));
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
    saveKey: (key) => json('/api/key', { method: 'POST', body: JSON.stringify({ key }) }, KEY_TIMEOUT_MS),
    deleteKey: () => json('/api/key', { method: 'DELETE' }),
    listSpaces: () => json('/api/spaces'),
    createSpace: (title) => json('/api/spaces', { method: 'POST', body: JSON.stringify(title ? { title } : {}) }),
    getSpace: (id) => json(`/api/spaces/${enc(id)}`),
    patchSpace: (id, patch) => json(`/api/spaces/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    uploadInput: (id, file, opts) => sendFile(`/api/spaces/${enc(id)}/inputs`, file, opts),
    deleteInput: (id, index) => json(`/api/spaces/${enc(id)}/inputs/${index}`, { method: 'DELETE' }),
    uploadBackground: (id, file, opts) => sendFile(`/api/spaces/${enc(id)}/background`, file, opts),
    estimate: (id) => json(`/api/spaces/${enc(id)}/estimate`),
    start: (id) => json(`/api/spaces/${enc(id)}/start`, { method: 'POST' }),
  };
}

/** 假数据层按需加载：不带 ?mock=1 时生产包不会执行也不会下载 mock.ts */
function createLazyMockApi(params: URLSearchParams): Api {
  let loaded: Promise<Api> | undefined;
  const load = () => (loaded ??= import('./mock').then((m) => m.createMockApi(params)));
  return new Proxy({} as Api, {
    get: (_, name: keyof Api) => async (...args: unknown[]) => {
      const mock = await load();
      return (mock[name] as (...a: unknown[]) => unknown)(...args);
    },
  });
}

function mockEnabled(): boolean {
  if (import.meta.env.VITE_MOCK === '1') return true;
  return new URLSearchParams(window.location.search).get('mock') === '1';
}

export const isMock = mockEnabled();
export const api: Api = isMock ? createLazyMockApi(new URLSearchParams(window.location.search)) : createHttpApi();

/** 项目已花费：服务端给的 totalCostYuan，缺省时累加各版本 */
export const spentOf = (space: Space | undefined): number =>
  !space ? 0 : typeof space.totalCostYuan === 'number' ? space.totalCostYuan : space.versions.reduce((sum, v) => sum + v.costYuan, 0);
