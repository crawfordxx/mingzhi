// 用可想 AI 的 Seedance（KVideo2.0-Mini）把油画世界做成 4 秒图生视频（树叶轻摆、光斑移动）
// 首尾帧同一张图（frame2video）→ 无缝循环。
// 用法：source kx.env && NODE_USE_ENV_PROXY=1 npx tsx promo/film/tools/seedance.ts <首帧URL文件> <输出mp4> <modelType>
import { readFileSync } from 'node:fs';
import { KexiangTaskClient, downloadTo } from '../../../src/llm/kexiang-task.js';

const [urlFile, out, modelType = 'frame2video'] = process.argv.slice(2);
const imageUrl = readFileSync(urlFile, 'utf8').trim();
const prompt = '这幅印象派油画里的花园轻轻地活过来：门边和前景的叶子、藤蔓、红色天竺葵被微风吹得轻微摇摆，阳光的光斑在石地上缓慢移动；镜头完全固定，不推不移不旋转；画面构图、笔触、色彩保持不变；画面里没有人、没有动物、没有文字';
const client = new KexiangTaskClient(process.env.MINGZHI_KX_KEY ?? '');
const t0 = Date.now();
const res = await client.run(
  { modelName: 'KVideo2.0-Mini', modelType, content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl }, role: 'first_frame' }, { type: 'image_url', image_url: { url: imageUrl }, role: 'last_frame' }], ratio: '16:9', duration: 4, resolution: '720p', watermark: false, generate_audio: false },
  { kind: 'video', timeoutMs: 25 * 60_000, onStatus: (s) => console.log('status', s, Math.round((Date.now() - t0) / 1000) + 's') },
);
console.log('taskId', res.taskId, 'cost', res.cost);
await downloadTo(res.url, out);
console.log('saved', out);
