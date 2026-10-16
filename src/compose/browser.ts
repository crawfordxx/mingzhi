/**
 * 启动器（P6）把 Chrome Headless Shell 装在 runtime/ 下，用环境变量 MINGZHI_CHROME 指定可执行文件。
 * 设了就让 Remotion 用它（传 browserExecutable）；没设时不带这个字段，Remotion 照旧自己找浏览器。
 * 每次调用现读环境变量，不在模块加载时缓存。
 */
export function browserOptions(env: NodeJS.ProcessEnv = process.env): { browserExecutable?: string } {
  const path = env.MINGZHI_CHROME;
  return path ? { browserExecutable: path } : {};
}
