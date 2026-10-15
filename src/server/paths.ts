import { homedir } from 'node:os';
import { sep } from 'node:path';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 抹掉推给浏览器的文字里的本机绝对路径：项目目录内的路径改成项目内相对路径（v2/final.mp4），
 * 其余用户主目录下的路径把主目录缩成 ~（截图分享时不露出用户名）。
 */
export function pathScrubber(spacesRoot: string, home: string = homedir()): (text: string) => string {
  const project = new RegExp(`${escapeRe(spacesRoot + sep)}[A-Za-z0-9_-]+${escapeRe(sep)}`, 'g');
  const hasHome = home.length > 1;
  return (text) => {
    const relative = text.replace(project, '');
    return hasHome ? relative.split(home).join('~') : relative;
  };
}
