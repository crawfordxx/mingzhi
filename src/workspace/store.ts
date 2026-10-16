import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackgroundSpec } from '../background/resolve.js';
import type { CaptionStyleId } from '../captions/styles.js';
import type { CoverStyleId } from '../cover/styles.js';
import { roundYuan } from '../cost/meter.js';

export interface SpaceSettings {
  background?: BackgroundSpec;
  captionStyle: CaptionStyleId;
  /** 首个版本的封面风格；缺省 bauhaus */
  coverStyle?: CoverStyleId;
  budgetYuan: number;
  broll: boolean;
  maxVideos: number;
  /** 颗粒质感层；新项目默认开，旧项目没有这个字段时按「用到 B-roll 才开」（见 compose/layout 的 grainOn） */
  grain?: boolean;
}

export interface VersionMeta {
  n: number;
  createdAt: string;
  parent?: number;
  summary: string;
  /** 和父版本相比画面内容变了的镜头序号（首个版本为空） */
  changedShots: number[];
  /** 各镜头（按序号）的画面内容哈希，下一版据此和本版比较；旧数据没有 */
  shotHashes?: string[];
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
  /** 对话修改（只规划、未出新版本）累计花费，元 */
  chatCostYuan?: number;
}

const SPACE_FILE = 'space.json';

/** 项目累计花费（元）：各版本（含失败与取消的）+ 对话规划；预算上限按项目计 */
export const projectSpentYuan = (space: Space): number =>
  roundYuan(space.versions.reduce((s, v) => s + v.costYuan, 0) + (space.chatCostYuan ?? 0));
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 项目目录布局：<root>/<id>/space.json、<root>/<id>/base/（共用素材与中间产物）、<root>/<id>/v<n>/（各版本产物） */
export class SpaceStore {
  constructor(private readonly root: string) {}

  create(title: string, inputs: string[], settings: SpaceSettings): Space {
    const space: Space = {
      id: randomUUID().slice(0, 8),
      title,
      createdAt: new Date().toISOString(),
      inputs: structuredClone(inputs),
      versions: [],
      settings: structuredClone(settings),
    };
    mkdirSync(this.baseDir(space.id), { recursive: true });
    this.save(space);
    return space;
  }

  list(): Space[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && ID_PATTERN.test(d.name) && existsSync(join(this.root, d.name, SPACE_FILE)))
      .flatMap((d) => this.tryGet(d.name))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Space {
    const file = this.spaceFile(id);
    if (!existsSync(file)) throw new Error(`项目不存在：${id}`);
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Space;
    } catch {
      throw new Error(`项目文件已损坏：${file}`);
    }
  }

  /** 列表里遇到损坏的项目只跳过并告警，不让一个坏文件拖垮整个侧栏 */
  private tryGet(id: string): Space[] {
    try {
      return [this.get(id)];
    } catch (err) {
      console.warn(`跳过无法读取的项目 ${id}：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  baseDir(id: string): string {
    return join(this.projectDir(id), 'base');
  }

  versionDir(id: string, n: number): string {
    if (!Number.isInteger(n) || n < 1) throw new Error(`版本号不合法：${String(n)}`);
    return join(this.projectDir(id), `v${n}`);
  }

  addVersion(id: string, meta: Omit<VersionMeta, 'n' | 'createdAt'>): VersionMeta {
    const space = this.get(id);
    const n = space.versions.reduce((max, v) => Math.max(max, v.n), 0) + 1;
    const version: VersionMeta = { ...structuredClone(meta), n, createdAt: new Date().toISOString() };
    mkdirSync(this.versionDir(id, n), { recursive: true });
    this.save({ ...space, versions: [...space.versions, version] });
    return version;
  }

  updateVersion(id: string, n: number, patch: Partial<VersionMeta>): VersionMeta {
    const space = this.get(id);
    const current = space.versions.find((v) => v.n === n);
    if (!current) throw new Error(`版本不存在：v${n}`);
    const updated: VersionMeta = { ...current, ...structuredClone(patch), n: current.n, createdAt: current.createdAt };
    this.save({ ...space, versions: space.versions.map((v) => (v.n === n ? updated : v)) });
    return updated;
  }

  /** 读-改-写：在同一个同步块里读最新的 space.json 再写回，不覆盖期间别处（运行器、对话记账）的修改 */
  update(id: string, fn: (space: Space) => Space): Space {
    const next = fn(this.get(id));
    if (next.id !== id) throw new Error('不能改项目 id');
    this.save(next);
    return next;
  }

  rename(id: string, title: string): Space {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('标题不能为空');
    const renamed = { ...this.get(id), title: trimmed };
    this.save(renamed);
    return renamed;
  }

  private projectDir(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error(`项目 id 不合法：${id}`);
    return join(this.root, id);
  }

  private spaceFile(id: string): string {
    return join(this.projectDir(id), SPACE_FILE);
  }

  /** 先写临时文件再 rename，保证读到的永远是完整 JSON */
  private save(space: Space): void {
    const file = this.spaceFile(space.id);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(space, null, 2)}\n`);
    renameSync(tmp, file);
  }
}
