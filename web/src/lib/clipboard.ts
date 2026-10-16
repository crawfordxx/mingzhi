/** 写入剪贴板；浏览器不允许（非安全上下文、权限被拒）时返回 false，由调用方提示手动复制 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
