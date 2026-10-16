/**
 * 成片最终编码（响度统一那一步把渲染件重编码一遍）：H.264 crf + maxrate/bufsize 限制码率。
 * 1080×1920 / 30fps 的口播片：crf 19 在平坦画面上只要 2–4 Mbps，maxrate 10 Mbps 兜住运动和噪声多的最坏情况（约 8–12 Mbps 区间的中点），
 * 15 秒片 ≤ 20 MB（10 Mbps × 15 秒 ≈ 18.8 MB，含音频约 19.5 MB）。bufsize 取 maxrate 的 1.5 倍（1.5 秒）：留一点起伏空间，又让短片的平均码率不会比 maxrate 高出太多（上限 = maxrate + bufsize / 片长）
 */
export const FINAL_ENCODE = { crf: 19, maxrateKbps: 10_000, bufsizeKbps: 15_000, preset: 'medium' } as const;

/**
 * 最终编码的视频参数；yuv420p 保证手机和各平台都能直接播。
 * Remotion 渲染件是全幅范围的 yuvj420p，ffmpeg 只给 -pix_fmt yuv420p 时会原样保留全幅范围，所以显式用 scale 转成标准（tv）范围，亮度不偏
 */
export function finalVideoArgs(): string[] {
  return [
    '-c:v', 'libx264', '-preset', FINAL_ENCODE.preset, '-crf', String(FINAL_ENCODE.crf),
    '-maxrate', `${FINAL_ENCODE.maxrateKbps}k`, '-bufsize', `${FINAL_ENCODE.bufsizeKbps}k`,
    '-vf', 'scale=out_range=tv', '-pix_fmt', 'yuv420p', '-color_range', 'tv',
  ];
}
