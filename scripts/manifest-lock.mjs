// --update-lock 的核心逻辑：哪些条目要重新下载计算、怎么合并回锁定清单。
// 下载函数由调用方注入（hash(url) -> { sha256, size, seconds }），便于离线测试。

/** 是否必须重新下载：新增条目、url 变了、或来源给出的已知 sha256 与旧值不同。
 *  dest / exec / optional / license 等元数据变化不影响下载内容，沿用旧的 sha256 与 size 即可 */
export function needsRecompute(old, draft) {
  if (!old) return true;
  if (JSON.stringify(old.urls) !== JSON.stringify(draft.urls)) return true;
  return Boolean(draft.sha256) && draft.sha256 !== old.sha256;
}

/** 按 url 优先级下载并取 hash：同一 url 最多试两次，已知 sha256 不符（镜像 200 返回限流页等）则直接换下一个 url */
export async function hashFirstGood(draft, { hash, log = () => {} }) {
  for (const url of draft.urls) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        log(`  下载 ${url}${attempt > 1 ? '（重试）' : ''}`);
        const got = await hash(url);
        if (!draft.sha256 || draft.sha256 === got.sha256) return got;
        log(`  与已知 sha256 不符（实际 ${got.sha256}），弃用此 url`);
        break;
      } catch (e) {
        log(`  失败（${e.message}）`);
      }
    }
  }
  throw new Error(`${draft.id} 所有 url 都下载失败或与已知 sha256 不符`);
}

/**
 * 由来源条目（drafts）与旧锁定清单（existing）得到新的条目列表，保持 drafts 的顺序。
 * - wanted 之外的条目（被 --platform/--only 过滤掉）：原样保留旧条目；没有旧条目则无从保留，跳过
 * - wanted 内：需要重算（或 force）才下载，否则以 draft 的元数据 + 旧 sha256/size 为准
 * - 每算完一项调用 save(部分结果 + 后面尚未轮到的旧条目)，中断后可续
 */
export async function updateLockItems({ drafts, existing, wanted, force = false, hash, log = () => {}, save = () => {} }) {
  const byId = new Map(existing.map((i) => [i.id, i]));
  const items = [];
  for (const [index, draft] of drafts.entries()) {
    const old = byId.get(draft.id);
    if (!wanted.has(draft.id)) {
      if (old) items.push(old);
      continue;
    }
    if (old && !force && !needsRecompute(old, draft)) {
      items.push({ ...draft, sha256: old.sha256, size: old.size });
      continue;
    }
    log(`计算 ${draft.id}`);
    const { sha256, size } = await hashFirstGood(draft, { hash, log });
    items.push({ ...draft, sha256, size });
    save([...items, ...drafts.slice(index + 1).map((d) => byId.get(d.id)).filter(Boolean)]);
  }
  return items;
}
