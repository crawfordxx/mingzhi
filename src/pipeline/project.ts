import { writeFileSync } from 'node:fs';
import type { Transcript } from '../asr/types.js';
import type { CaptionLine, TimedCaption } from '../captions/lines.js';
import type { CaptionsSource } from '../captions/polish.js';
import type { Cut } from '../cut/llm-cuts.js';
import type { EditPlan } from '../cut/plan.js';
import type { BackgroundSpec } from '../background/resolve.js';
import type { SubjectBox } from '../matting/composite.js';
import type { MediaInfo } from '../media/probe.js';

export interface ProjectArtifacts { wav?: string; cut?: string; person?: string; ass?: string; output?: string }

/** 工程文件 project.json：每一步完成后增量落盘，尚未完成的步骤对应字段缺省；全部完成时字段齐全 */
export interface ProjectFile {
  version: 1;
  input: string;
  createdAt: string;
  media?: MediaInfo;
  transcript?: Transcript;
  cuts?: Cut[];
  plan?: EditPlan;
  /** 字幕行（按字下标），供后续编辑 */
  captionLines?: CaptionLine[];
  captionsSource?: CaptionsSource;
  /** 字幕行映射到成片时间轴后的结果 */
  captions?: TimedCaption[];
  /** 换背景：背景来源与落地的图片路径（P2） */
  background?: { spec: BackgroundSpec; path: string };
  /** 人物在画面中的范围（中位数，0–1），供 P3 取景；抠不出人时为 null */
  subject?: SubjectBox | null;
  artifacts: ProjectArtifacts;
}

export type ProjectPatch = Partial<Omit<ProjectFile, 'version' | 'input' | 'createdAt' | 'artifacts'>> & { artifacts?: ProjectArtifacts };

/** 返回一个记录函数：每次合并补丁生成新的工程对象并整份写盘，返回最新对象 */
export function projectRecorder(path: string, input: string): (patch: ProjectPatch) => ProjectFile {
  let current: ProjectFile = { version: 1, input, createdAt: new Date().toISOString(), artifacts: {} };
  return (patch) => {
    current = { ...current, ...patch, artifacts: { ...current.artifacts, ...patch.artifacts } };
    writeFileSync(path, JSON.stringify(current, null, 2));
    return current;
  };
}
