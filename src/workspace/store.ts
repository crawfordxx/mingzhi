import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackgroundSpec } from '../background/resolve.js';
import type { CaptionStyleId } from '../captions/styles.js';

export interface SpaceSettings {
  background?: BackgroundSpec;
  captionStyle: CaptionStyleId;
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

const SPACE_FILE = 'space.json';
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 项目目录布局：<root>/<id>/space.json、<root>/<id>/base/（共用素材与中间产物）、<root>/<id>/v<n>/（各版本产物） */
export class SpaceStore {
  constructor(private readonly root: string) {}

  create(title: string, inputs: string[], settings: SpaceSettings): Space {
    const space: Space = {
      id: randomUUID().slice(0, 8),
      title,
      createdAt: new Date().toISOString(),
      inputs: [...inputs],
      versions: [],
      settings: { ...settings },
    };
    mkdirSync(this.baseDir(space.id), { recursive: true });
    this.save(space);
    return space;
  }

  list(): Space[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && ID_PATTERN.test(d.name) && existsSync(join(this.root, d.name, SPACE_FILE)))
      .map((d) => this.get(d.name))
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

  baseDir(id: string): string {
    return join(this.projectDir(id), 'base');
  }

  versionDir(id: string, n: number): string {
    return join(this.projectDir(id), `v${n}`);
  }

  addVersion(id: string, meta: Omit<VersionMeta, 'n' | 'createdAt'>): VersionMeta {
    const space = this.get(id);
    const n = space.versions.reduce((max, v) => Math.max(max, v.n), 0) + 1;
    const version: VersionMeta = { ...meta, n, createdAt: new Date().toISOString() };
    mkdirSync(this.versionDir(id, n), { recursive: true });
    this.save({ ...space, versions: [...space.versions, version] });
    return version;
  }

  updateVersion(id: string, n: number, patch: Partial<VersionMeta>): VersionMeta {
    const space = this.get(id);
    const current = space.versions.find((v) => v.n === n);
    if (!current) throw new Error(`版本不存在：v${n}`);
    const updated: VersionMeta = { ...current, ...patch, n: current.n, createdAt: current.createdAt };
    this.save({ ...space, versions: space.versions.map((v) => (v.n === n ? updated : v)) });
    return updated;
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
