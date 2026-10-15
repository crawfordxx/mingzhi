// README 用的插画：用可想 GPT Image 2（GPT-Image-2.5-Flare）生成，画面里不出现任何人物。
// 用法：MINGZHI_KX_KEY=... NODE_USE_ENV_PROXY=1 pnpm tsx scripts/readme/gen-art.ts <名字> <输出.jpg> [比例]
// key 只从环境变量读，不打印、不落盘。
import { downloadTo, KexiangTaskClient } from '../../src/llm/kexiang-task.js';

const PROMPTS: Record<string, string> = {
  // 深色模式横幅的画框：与工作台 01-studio.webp 同一间书房，换成夜里
  'studio-night':
    'Thick impasto oil painting, palette-knife texture, same composition as a sunlit home studio but at night: '
    + 'a camera on a black tripod facing an empty wooden chair, tall bookshelves full of books on the left, climbing ivy, '
    + 'a large window showing a deep cobalt blue night sky with a city glow, a small warm brass desk lamp casting amber light, '
    + 'patterned persian rug on the floor. Deep ultramarine and prussian blue shadows with warm amber highlights. '
    + 'Painterly, rich, expressive brush strokes, like the post-impressionists. Wide composition. '
    + 'Absolutely no people, no faces, no figures, no text, no letters, no watermark.',
};

const [name, out, size = '3:2'] = process.argv.slice(2);
const prompt = PROMPTS[name];
if (!prompt || !out) {
  console.error(`用法：tsx scripts/readme/gen-art.ts <${Object.keys(PROMPTS).join('|')}> <输出.jpg> [比例]`);
  process.exit(1);
}
const client = new KexiangTaskClient(process.env.MINGZHI_KX_KEY ?? '');
const r = await client.run(
  { modelName: 'GPT-Image-2.5-Flare', modelType: 'text2img', prompt, size, resolution: '2k', quality: 'medium', output_format: 'jpeg' },
  { kind: 'image', label: `README 插画 ${name}` },
);
await downloadTo(r.url, out);
console.log(`ok ${out} 花费 ¥${r.cost ?? '未返回'}`);
