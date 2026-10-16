// bundle-lib.mjs 的类型声明（供 tests 使用；脚本本身是纯 .mjs，不经 tsc）
export const APP_ENTRIES: readonly string[];
export const UNSAFE_CHARS: string;
export const DEVICE_NAMES: readonly string[];
export const UNPACK_RATIO: number;
export const MIN_UNPACK_BUDGET: number;
export const MAX_ENTRIES: number;
export function unpackBudget(archiveSize: number): number;
export function currentPlatform(platform?: string, arch?: string): string;
export function nameProblem(name: string): string | undefined;
export interface Problem { path: string; reason: string }
export function checkNames(paths: string[]): Problem[];
export function keepPath(relPath: string, platform: string): boolean;
export interface Entry { path: string; type: 'dir' | 'file'; mode: number; size: number }
export function collectEntries(root: string, platform: string): { entries: Entry[]; problems: Problem[] };
export interface TarStats { files: number; dirs: number; bytes: number; size: number }
export function writeTarZst(root: string, entries: Entry[], out: string, opts?: { level?: number; mtime?: number }): Promise<TarStats>;
