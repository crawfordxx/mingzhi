/**
 * 工作台 HTTP 客户端，对齐 Task 6 实现（src/server/，路由表见 task-6-report.md）。
 * vite 开发服务里地址栏带 ?mock=1、或构建时 VITE_MOCK=1 时改用 ./mock.ts（按需动态加载）的内存假数据；
 * 正式构建里 __MOCK_ALLOWED__ 为 false，假数据层整个被摇掉（见 lib/mockGate.ts）。
 */
import { mockEnabled } from './lib/mockGate';

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
  /** 对话修改（规划）累计花费 */
  chatCostYuan?: number;
}

/** 剪辑直播事件（src/workspace/events.ts 的 WorkEvent）；detail 形状见 src/pipeline/detail.ts */
export interface WorkEvent {
  seq: number;
  /** 毫秒时间戳 */
  t: number;
  spaceId: string;
  version: number;
  step: string;
  message: string;
  detail?: { kind: string; data: unknown };
}

/** 修改操作（src/edit/ops.ts）：前端只透传，不解释字段 */
export type EditOp = { type: string } & Record<string, unknown>;
export interface EditOption { label: string; ops: EditOp[] }
/** 对话修改的回复（EditPlan + 基于哪个版本） */
export interface EditReply { reply: string; ops: EditOp[]; options?: EditOption[]; version: number; costYuan?: number; chatCostYuan?: number }
export interface Queued { version: number; queued: number }

export interface ShotState { start: number; end: number; layout: 'split' | 'full'; card?: { template: string; props: Record<string, unknown> } }
/** 版本状态里前端用到的部分（分镜取卡片名、时长） */
export interface VersionState {
  storyboard: { shots: ShotState[] };
  captions: { start: number; end: number; text: string }[];
  plan: { outputDurationSec: number; sourceDurationSec: number };
}
export interface ExportResult { dir: string; files: string[] }
export type EventSink = (e: WorkEvent) => void

export interface Status {
  version: string;
  keyConfigured: boolean;
  modelsReady: boolean;
  assetsReady: boolean;
  ffmpegReady: boolean;
  /** 服务以假模型模式启动（仅测试） */
  fake?: boolean;
}
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
  start(id: string): Promise<Queued>;
  /** 一句话修改 → 修改方案（不执行）；version 缺省 = 最新完成版本 */
  messages(id: string, message: string, version?: number): Promise<EditReply>;
  /** 执行修改，出新版本；dropped 是被校验丢弃的原因 */
  apply(id: string, ops: EditOp[], parent?: number, summary?: string): Promise<Queued & { dropped: string[] }>;
  revert(id: string, n: number): Promise<Queued>;
  cancel(id: string): Promise<void>;
  exportVersion(id: string, n: number): Promise<ExportResult>;
  versionState(id: string, n: number): Promise<VersionState>;
  /** 订阅某个版本的事件：先补历史再推实时；断线自动重连（onStatus 报告在线与否）；返回取消订阅 */
  events(id: string, version: number, sink: EventSink, onStatus?: (online: boolean) => void): () => void;
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
/** 修改规划要等模型、导出要复制大文件 */
const PLAN_TIMEOUT_MS = 120_000;

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
    messages: (id, message, version) => {
      const body = JSON.stringify({ message, ...(version ? { version } : {}) });
      return json(`/api/spaces/${enc(id)}/messages`, { method: 'POST', body }, PLAN_TIMEOUT_MS);
    },
    apply: (id, ops, parent, summary) => {
      const body = JSON.stringify({ ops, ...(parent ? { parent } : {}), ...(summary ? { summary } : {}) });
      return json(`/api/spaces/${enc(id)}/apply`, { method: 'POST', body });
    },
    revert: (id, n) => json(`/api/spaces/${enc(id)}/versions/${n}/revert`, { method: 'POST' }),
    cancel: (id) => json(`/api/spaces/${enc(id)}/cancel`, { method: 'POST' }),
    exportVersion: (id, n) => json(`/api/spaces/${enc(id)}/versions/${n}/export`, { method: 'POST' }, PLAN_TIMEOUT_MS),
    versionState: (id, n) => json(`/api/spaces/${enc(id)}/versions/${n}/state`),
    events: (id, version, sink, onStatus) => openEvents(`/api/spaces/${enc(id)}/events?version=${version}`, sink, onStatus),
  };
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * SSE：EventSource 自己会断线重连（带 Last-Event-ID）；但服务端回了非 200 等情况它会彻底放弃，
 * 这时按 1、2、4…30 秒指数退避重新连，并用 lastEventId 查询参数只补之后的事件。再按 seq 去重一次。
 * onStatus(false) 表示断开（界面提示「直播断开，正在重连」），连上后 onStatus(true)。
 */
function openEvents(url: string, sink: EventSink, onStatus?: (online: boolean) => void): () => void {
  let last = 0;
  let retry = 0;
  let timer = 0;
  let source: EventSource | undefined;
  const connect = () => {
    source = new EventSource(last ? `${url}&lastEventId=${last}` : url);
    source.onopen = () => { retry = 0; onStatus?.(true); };
    source.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data as string) as WorkEvent;
        if (e.seq > last) { last = e.seq; sink(e); }
      } catch {
        /* 坏行忽略 */
      }
    };
    source.onerror = () => {
      onStatus?.(false);
      if (source?.readyState !== EventSource.CLOSED) return; // 浏览器还在自己重连
      timer = window.setTimeout(connect, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retry));
      retry += 1;
    };
  };
  connect();
  return () => { window.clearTimeout(timer); source?.close(); };
}

/** 成片与封面（服务端只放行这三个文件） */
export const mediaUrl = (id: string, n: number, file: 'final.mp4' | 'cover-3x4.png' | 'cover-4x3.png'): string => `/media/${enc(id)}/${n}/${file}`;

/** 假数据层按需加载：不带 ?mock=1 时生产包不会执行也不会下载 mock.ts */
function createLazyMockApi(params: URLSearchParams): Api {
  let loaded: Promise<Api> | undefined;
  const load = () => (loaded ??= import('./mock').then((m) => m.createMockApi(params)));
  // events 是同步返回「取消订阅」的，单独包一层：加载完再订阅，期间取消则不订阅
  const events: Api['events'] = (id, version, sink, onStatus) => {
    let close: (() => void) | undefined;
    let dead = false;
    void load().then((m) => { if (!dead) close = m.events(id, version, sink, onStatus); });
    return () => { dead = true; close?.(); };
  };
  return new Proxy({} as Api, {
    get: (_, name: keyof Api) => (name === 'events' ? events : async (...args: unknown[]) => {
      const mock = await load();
      return (mock[name] as (...a: unknown[]) => unknown)(...args);
    }),
  });
}

export const isMock = __MOCK_ALLOWED__ && mockEnabled({ allowed: true, forced: import.meta.env.VITE_MOCK === '1', search: window.location.search });
export const api: Api = isMock ? createLazyMockApi(new URLSearchParams(window.location.search)) : createHttpApi();

/** 项目已花费：服务端给的 totalCostYuan，缺省时累加各版本 */
export const spentOf = (space: Space | undefined): number =>
  !space ? 0 : typeof space.totalCostYuan === 'number' ? space.totalCostYuan : space.versions.reduce((sum, v) => sum + v.costYuan, 0);

/** 出过片（或正在出）才算开始；首版失败后回到设置卡，可以重新开始 */
export const startedOf = (space: Space): boolean => !!space.job || space.versions.some((v) => v.status !== 'failed');
