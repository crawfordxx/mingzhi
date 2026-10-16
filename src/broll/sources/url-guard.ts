import { isPublicHttpUrl } from '../search.js';
import type { Candidate } from './types.js';

/**
 * 外部 API 返回的网址一律只收公网 http(s)：拒绝 file:、javascript:、data: 等协议与本机、内网地址。
 * 这些字段会被下载、交给 ffmpeg 读、写进 credits 再在工作台渲染成链接，不校验就可能读本机文件、打内网或在工作台里执行脚本
 */
export const isRemoteUrl = (url: string | undefined): boolean => typeof url === 'string' && isPublicHttpUrl(url.trim());

/** 本机产物（截图、生成图）：url 与 thumb 是工作目录里的文件，不走网络 */
export const isLocalCandidate = (c: Pick<Candidate, 'source'>): boolean => c.source === 'screenshot' || c.source === 'generated';

/**
 * 图库候选的网址校验：原文件、作品页、预览图（有的话）不合格就丢掉整个候选；作者主页、许可链接不合格只去掉该字段。
 * 本机产物原样返回
 */
export function guardCandidate(c: Candidate): Candidate | undefined {
  if (isLocalCandidate(c)) return c;
  if (!isRemoteUrl(c.url) || !isRemoteUrl(c.page) || (c.thumb.trim() !== '' && !isRemoteUrl(c.thumb))) return undefined;
  const { authorUrl, licenseUrl, ...rest } = c;
  return { ...rest, ...(authorUrl && isRemoteUrl(authorUrl) ? { authorUrl } : {}), ...(licenseUrl && isRemoteUrl(licenseUrl) ? { licenseUrl } : {}) };
}

/** 下载与 ffmpeg 读远程地址之前的最后一道校验 */
export function assertRemoteUrl(url: string, what: string): void {
  if (!isRemoteUrl(url)) throw new Error(`${what}地址不是公网 http(s) 网址，已拒绝：${url.slice(0, 120)}`);
}
