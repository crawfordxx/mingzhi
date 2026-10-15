# 明知AI剪辑 · 决策清单（2026-10-14 用户已确认）

## 产品
- **名称**：明知AI剪辑（英文 Mingzhi）
- **定位**：开源口播 AI 剪辑工作台。用户只录一条竖屏口播 → 全自动出片 → 多轮对话修改。**不是剪辑软件**：没有时间线、轨道、检查器
- **许可证**：MIT（README 注明：Remotion 对 >3 人公司需购买其商业授权）
- **成片标准**：以 `~/workspace/小马学长AI/第2期/成片_B_换背景.mp4` 为黄金样本（1080×1920 · 上半屏信息卡 + 下半屏换背景人像 · 烧录字幕 · 开头 3 张钩子卡 · 结尾三连 CTA）

## 分发与运行
- **平台**：macOS + Windows，按零技术用户设计，全程不开终端
- **启动器**：几 MB 的小启动器（Tauri 或 Bun 编译单文件），首次运行下载 Node 运行时 / ffmpeg 静态版 / Chrome Headless Shell / 本地模型到应用目录（断点续传 + 哈希校验 + 国内镜像），起本机服务并自动打开浏览器；之后秒开
- **技术栈**：纯 JS，不依赖 Python
- **签名**：macOS 买 Apple 开发者账号做签名 + 公证；Windows 暂不签，README 说明 SmartScreen 放行方式
- **最低配置**：Apple M1 或 8 核 x86、16GB 内存；低配先出 540p 预览
- **更新**：查 GitHub Releases，用户点击才更新；**默认不收集任何数据**
- **界面语言**：只做中文；README 中英双语

## AI 能力（产品只接「可想 AI」；kkhub 仅用于制作设计素材，不进产品；全部走「可想 AI」kexiangai.com，用户自己注册填 key，仓库不含任何 key，注册链接不带邀请码）
- **key 存储**：系统钥匙串优先，退回 600 权限配置文件；首次填入即校验
- **语言模型**：剪口误 `openai/gpt-5.6-sol`（`reasoning_effort: low`；2026-10-14 在生口播上对比 8 个模型后由 gemini-3.5-flash 改来，见 `docs/acceptance/p1.md` 第 9 节）；写分镜/卡片文案 `gemini-3.5-flash`（**必须 `reasoning_effort: low`**，实测默认推理量翻倍、耗时 30s）；轻量任务 `gemini-3.1-flash-lite`；视觉自检 `gemini-3.5-flash`；设置里可切「高质量模式」= Claude Opus 5.5（默认关）
- **生图**：KImage2 / 2.5 = GPT Image 2 / 2.5
- **生视频**：Seedance 2.0 / 2.5（含真人素材先过审核接口）
- **不用**：Midjourney（可想没有）
- **⚠️ 实测约束**：可想套餐**同一时间只能跑 1 个任务**（超出报「任务超过套餐限制」）→ 所有生图/生视频请求**串行排队**；余额不足会直接 400
- **联网搜索**：可想 Responses API + `web_search` 工具，**用 `openai/gpt-5.6-luna`**（实测 8s、约 ¥0.02/次、带 url_citation；gemini 走 Responses 返回空，不可用）

## 本地能力（音频不出本机）
- **ASR**：sherpa-onnx-node 1.13.8 + Silero VAD 切段 + **SenseVoice**（`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` int8 ~228MB），**关闭 ITN** 逐字原样输出；断句/同音纠错/数字格式交给 Gemini 字幕校对。实测 117s 音频 1.2s 识别完；Paraformer 2024 版不输出时间戳（弃用），2023-09 版可作备选
- **背景音乐**：内置 ~20 首免版权曲库（按情绪分类），Gemini 选曲，本地人声压低（ducking）
- **音效**：内置 CC0 音效包（转场 whoosh、点击、数字跳动）
- **抠像换背景**：onnxruntime 跑 RobustVideoMatting；背景虚化 + 色温/亮度匹配（2026-10-15 用户确认继续用 RVM：其代码与权重为 GPL-3.0，运行时从上游下载、不入库，README 写明）
- **渲染**：Remotion（React），Three.js 经 @remotion/three；成片动画全部帧驱动（motion.dev 只用于工作台 UI）

## 出片管线（v1 全做）
1. 本地 ASR → Gemini 判断气口/口误/重复 → ffmpeg 剪
2. 换背景：10 张预设（书房/极简工作室/咖啡馆/夜景落地窗/科技暗色/日式和室/绿植阳台/图书馆/黄昏天台/水泥灰墙，已生成于 `docs/design/assets/bg/`）+ 上传 + 一句话生成
3. 分镜：模板库（20–30 个卡片/转场组件）+ JSON 分镜；模板表达不了的镜头由 AI 生成自定义组件，经渲染→截图→视觉自检通过才采用
4. B-roll 优先级：网页截图 > GPT Image 生图 > 图库（Pexels）> 搜索 > Seedance（只用于关键钩子镜头）
5. 开头钩子卡、结尾 CTA、转场动画、烧录字幕（6–8 套样式预设，字体打包本地：思源黑体/思源宋体/得意黑/霞鹜文楷/站酷快乐体/站酷庆科黄油体 等）
6. 封面 4:3 + 3:4：GPT Image 2（`GPT-Image-2-Official` text2img，1k medium ¥0.6/张）按所选风格生成整张封面并直接排中文标题、预留人物区；Gemini 读图核对标题文字，错则重生一次；人物用本地 RVM 抠出的透明人像合成（不上传人脸）。风格预设 10 种（包豪斯/瑞士国际主义/孟菲斯/杂志极简/赛博霓虹/国潮/孔版印刷/新粗野主义/千禧 Y2K/日系清新），用户可选（2026-10-15 用户要求）
7. **品质自检**：硬性检查（字幕不撞卡片/平台安全区、对比度 ≥4.5、无黑帧、无爆音、-14 LUFS、30fps）+ Gemini 视觉四维打分（版式/层级/动效节奏/品牌一致性），任一 <8 重做该段，最多 2 次
8. **花费控制**：开跑前显示预估花费，点一次确认；每条视频默认上限 ¥10（可调）；超限自动降级（Seedance → 生图 + Ken Burns）。按实测 ¥2.4/4 秒，¥10 上限下每条视频 Seedance 最多 1–2 个镜头，默认只给开头钩子用

## 工作台交互（对话式）
- 布局：最左 Spaces 项目栏 / 左对话流 / 右大预览（9:16）
- 首次：一张设置卡（上传口播 + 选背景 + 选字幕样式 + 预估花费）→「开始出片」
- 等待期：**剪辑直播**（转录逐行出现、气口被划掉、分镜逐张出现、自检分数跳出），可重播
- 修改：多轮对话；点/暂停预览插入「@mm:ss 卡片名」引用；AI 回复可带可点选的内联选项
- 版本：每轮出新版本（v1→v2→v3），只重渲受影响段；可回退；可双版本对比同步播放
- 输入格式：支持 1–N 段口播（AI 按语义重排）；输出 v1 只做 9:16

## 视觉
- **选定 G1 · ego 原味浅色**（见 `docs/design/direction-approved.md` 与 `docs/design/G1-ego-light.html`）
- 品质标准：Awwwards / Webby / FWA 获奖水准，自检循环直至达标

## 仓库
- 正式仓库：`~/workspace/mingzhi/`（git 已初始化）；设计稿在 `docs/design/`，本清单在 `docs/DECISIONS.md`

## 可想 AI 实测记录（2026-10-14）
| 测试 | 模型 | 结果 |
|---|---|---|
| 口误判断（带时间戳文字稿 → JSON） | gemini-3.5-flash 默认 | 全对；30.8s；推理 4666 token（≈¥0.32/小段，太贵） |
| 同上 | gemini-3.5-flash `reasoning_effort=low` | 全对；16.2s；推理 2110 token → **选用** |
| 同上 | gemini-3.1-flash-lite | 4.0s 但误删正文（丢了「一共」）→ **不能用于剪口误** |
| 看图自检（成片帧 → 四维 JSON） | gemini-3.5-flash | 15.5s；准确指出参考成片首帧「字幕压住卡片注释」→ **可用** |
| 联网搜索 | gpt-5.6-luna + web_search | 8s；精确找到 github.com/eternity4719/HowToLiveBetter → **可用** |
| 联网搜索 | gemini-3.5-flash + web_search | 返回空 → 不可用 |
| 生图 GPT-Image-2.5-Flare 1k medium | — | ¥0.2/张，约 20s；**套餐并发上限 1** |
| 生视频 KVideo2.0-Mini 文生视频 4s 720p 1:1 无音频 | Seedance 2.0 Mini | **¥2.4/条**，139s；出片 960×960 **24fps**（需转 30fps）；推镜+水珠质感好 → 可用。样片 `docs/research/seedance-2.0-mini-4s-720p.mp4` |
