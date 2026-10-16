/** 截图网址核实（分镜卡片与 B-roll 节拍同一口径） */
export const hostOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/**
 * 模型给的网址只是记忆，必须用联网搜索结果核实：搜索结果里有完全相同的网址才用它；
 * 只对上域名时用搜索结果里同域名的那几条（路径可能是模型编的，截出来是 404）；其余按搜索结果的顺序
 */
export function verifiedOrder(hint: string | undefined, found: readonly string[]): string[] {
  const hintHost = hint ? hostOf(hint) : '';
  const same = (u: string): boolean => u.replace(/\/$/, '') === hint?.replace(/\/$/, '');
  const first = hint && found.some(same) ? [hint] : found.filter((u) => hintHost !== '' && hostOf(u) === hintHost);
  return [...new Set([...first, ...found])];
}
