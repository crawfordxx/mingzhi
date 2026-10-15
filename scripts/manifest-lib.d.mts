// manifest-lib.mjs 的类型声明（供 tests 使用；脚本本身是纯 .mjs，不经 tsc）
import type { ZodObject } from 'zod';

export const SCHEMA_VERSION: 1;
export const KINDS: readonly string[];
export const PLATFORMS: readonly string[];
export const UNPACKS: readonly string[];
export const KIND_ORDER: readonly string[];
export const DEFAULT_RELEASE_REPO: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ManifestItem = any;
export interface Manifest { version: string; items: ManifestItem[] }
export interface Lock { schemaVersion: 1; items: ManifestItem[] }
export interface AppSpec { platform: string; path: string }
export interface UrlResult { url: string; ok: boolean; sha256?: string; size?: number; seconds: number; error?: string }
type FetchOpts = { fetch?: typeof fetch; timeoutMs?: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const itemFields: ZodObject<any>;
export function validateManifest(data: unknown): Manifest;
export function validateLock(data: unknown): Lock;
export function filterItems<T extends { platform: string; kind: string }>(items: T[], opts?: { platform?: string; kind?: string }): T[];
export function parseAppSpecs(specs: string[]): AppSpec[];
export function sha256File(path: string): Promise<string>;
export function makeAppItem(spec: AppSpec, opts: { appVersion: string; repoUrl?: string }): Promise<ManifestItem>;
export function buildManifest(lock: Lock, opts: { appVersion: string; appItems?: ManifestItem[] }): Manifest;
export function buildManifestWithApps(lock: Lock, opts: { appVersion: string; apps: AppSpec[]; repoUrl?: string }): Promise<Manifest>;
export function isGithubUrl(url: string): boolean;
export function hashUrl(url: string, opts?: FetchOpts & { onProgress?: (bytes: number) => void }): Promise<{ sha256: string; size: number }>;
export function verifyItem(item: ManifestItem, opts?: FetchOpts & { onProgress?: (url: string, bytes: number) => void }): Promise<UrlResult[]>;
