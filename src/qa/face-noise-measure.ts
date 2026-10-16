import { personTransform, visualLayout } from '../compose/layout.js';
import { runBuffer } from '../media/exec.js';
import type { SubjectBox } from '../matting/composite.js';
import type { Shot } from '../storyboard/schema.js';
import { throwIfCancelled } from '../cancel.js';
import { faceNoiseRatio, faceSamples, laplacianEnergy, type FaceEnergy, type FaceSample } from './face-noise.js';

/** 人像视频的位置信息：与渲染时一致才能让基准对上成片里的人脸区域 */
export interface FacePerson { file: string; width: number; height: number; subject: SubjectBox | null }
export interface FaceNoiseOptions { ffmpeg: string; video: string; person: FacePerson; shots: Shot[]; signal?: AbortSignal }
export interface FaceNoiseResult { ratio: number; energies: FaceEnergy[]; samples: number }

/** 抽一帧、裁出矩形、转灰度，返回原始字节 */
const grayCrop = (ffmpeg: string, file: string, time: number, vf: string): Promise<Uint8Array> =>
  runBuffer(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', `${vf},format=gray`, '-f', 'rawvideo', '-']);

/** 一个取样点：成片里的人脸区域，与人像视频按同样缩放与位置裁出的同一区域（无颗粒基准，同样用双线性缩放） */
async function energyAt(o: FaceNoiseOptions, s: FaceSample): Promise<FaceEnergy> {
  const { person } = o;
  const layout = visualLayout(o.shots[s.shotIndex]);
  const t = personTransform(layout, person.subject, person.width, person.height);
  const { x, y, w, h } = s.rect;
  const film = await grayCrop(o.ffmpeg, o.video, s.time, `crop=${w}:${h}:${x}:${y}`);
  const scaled = `scale=${Math.round(person.width * t.scale)}:${Math.round(person.height * t.scale)}:flags=bilinear`;
  const base = await grayCrop(o.ffmpeg, person.file, s.time, `${scaled},crop=${w}:${h}:${x - Math.round(t.x)}:${y - Math.round(t.y)}`);
  return { time: s.time, film: laplacianEnergy(film, w, h), base: laplacianEnergy(base, w, h) };
}

/** 人脸区域高频噪声：没有人物框或没有可取样的镜头时返回 null（该项不检查） */
export async function measureFaceNoise(o: FaceNoiseOptions): Promise<FaceNoiseResult | null> {
  const samples = faceSamples(o.shots, o.person.subject, o.person.width, o.person.height);
  if (samples.length === 0) return null;
  const energies: FaceEnergy[] = [];
  for (const s of samples) {
    throwIfCancelled(o.signal);
    energies.push(await energyAt(o, s));
  }
  return { ratio: faceNoiseRatio(energies), energies, samples: samples.length };
}
