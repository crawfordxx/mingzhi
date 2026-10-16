import type { ManifestItem } from './manifest-lib.mjs';

export function needsRecompute(old: ManifestItem | undefined, draft: ManifestItem): boolean;
export function hashFirstGood(
  draft: ManifestItem,
  opts: { hash: (url: string) => Promise<{ sha256: string; size: number }>; log?: (msg: string) => void },
): Promise<{ sha256: string; size: number }>;
export function updateLockItems(opts: {
  drafts: ManifestItem[];
  existing: ManifestItem[];
  wanted: Set<string>;
  force?: boolean;
  hash: (url: string) => Promise<{ sha256: string; size: number }>;
  log?: (msg: string) => void;
  save?: (items: ManifestItem[]) => void;
}): Promise<ManifestItem[]>;
