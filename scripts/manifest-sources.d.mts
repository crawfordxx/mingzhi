import type { ManifestItem } from './manifest-lib.mjs';

export const NODE_VERSION: string;
export const CHROME_VERSION: string;
export const FFMPEG_STATIC_TAG: string;
export function sourceItems(): ManifestItem[];
export const ASSETS_TAG: string;
export function hostedUrls(path: string): string[];
