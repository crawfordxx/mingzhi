import { useEffect, useState } from 'react';
import { cancelRender, continueRender, delayRender, staticFile } from 'remotion';
import { loadFont } from '@remotion/fonts';

/** 声明整段字重范围：可变字体按需取字重，静态字体也不会被浏览器合成假粗体 */
const WEIGHT_RANGE = '100 900';

export function loadCaptionFont(family: string, file: string): Promise<void> {
  return loadFont({ family, url: staticFile(`fonts/${file}`), weight: WEIGHT_RANGE });
}

/**
 * 在合成里等字体加载完成再出帧。file 为空（字体未下载）时不等待，字幕落到系统字体栈。
 * 字体文件存在却加载失败属于异常，直接让渲染失败，避免静默出错字体。
 */
export function useCaptionFont(family: string, file: string): void {
  const [handle] = useState(() => (file ? delayRender(`字幕字体 ${family}`) : null));
  useEffect(() => {
    if (handle === null) return;
    loadCaptionFont(family, file).then(() => continueRender(handle), (e: unknown) => cancelRender(e));
  }, [handle, family, file]);
}
