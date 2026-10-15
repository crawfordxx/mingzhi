/** 与 src/cli.ts 一致的真实命令：mingzhi edit <口播> --bg <预设id|图片> | --bg-prompt "…" --caption-style <id> --cover-style <id> --budget <元> */
import type { Space } from '../api';

export const DEFAULT_COVER = 'bauhaus';

export interface CliArg { flag: string; value: string }

export function bgArg(space: Space): CliArg | undefined {
  const bg = space.settings.background;
  if (!bg) return undefined;
  if (bg.kind === 'preset') return { flag: '--bg', value: bg.id };
  if (bg.kind === 'file') return { flag: '--bg', value: bg.path.split(/[\\/]/).pop() ?? bg.path };
  return { flag: '--bg-prompt', value: `"${bg.prompt}"` };
}

/** 命令的参数部分（不含口播文件） */
export function cliArgs(space: Space): CliArg[] {
  const s = space.settings;
  const bg = bgArg(space);
  return [
    ...(bg ? [bg] : []),
    { flag: '--caption-style', value: s.captionStyle },
    { flag: '--cover-style', value: s.coverStyle ?? DEFAULT_COVER },
    { flag: '--budget', value: String(s.budgetYuan) },
  ];
}

export const cliLine = (space: Space): string =>
  ['mingzhi edit', space.inputs[0] ?? '<口播视频>', ...cliArgs(space).map((a) => `${a.flag} ${a.value}`)].join(' ');
