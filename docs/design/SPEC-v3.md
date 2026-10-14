# 明知AI剪辑 · 第三轮初稿 Spec（3 个全新风格）

> 内容、真实字幕、真实帧、受众、反 slop 规则沿用 `SPEC.md`；**布局与交互范式完全沿用 `SPEC-v2-chat.md`**（左对话流 + 右 9:16 大预览 + 最左极窄项目栏，没有时间线/轨道/检查器；对话里有设置卡、剪辑直播可重播、v1/v2 版本卡、@时间引用、内联选项、处理中状态、输入框）。两份都先完整读完。
> 前两轮已被用户否决的风格：Linear 暗色、杉浦编辑风、Igloo 冰晶玻璃、苹果暗场光晕、apple.com 白底、Liquid Glass。**不要做得像其中任何一个。**

## 用户的品质标准（原话，硬要求）
「作为品质标准，目标是达到 awwwards、webbyawards、FWA 能获奖的品质，通过自我检查，反复提升品质，直到达到那个品质标准为止。」

## 技术栈（硬要求）
- **React 18 + motion（framer-motion）** 做全部 UI 动画：`https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js`、`react-dom@18.3.1/umd/react-dom.production.min.js`、`https://cdn.jsdelivr.net/npm/framer-motion@11.11.13/dist/framer-motion.js`（全局 `Motion`），JSX 用 `@babel/standalone@7.26.4`。用 layout 动画、AnimatePresence、spring、stagger，而不是 CSS keyframes 堆砌。
- 需要 3D 时用 Three.js `three@0.160.0`（ES module），只做氛围层或一处 hero。
- 单文件 HTML，图片走相对路径 `assets/...`。

## 素材
- 真实成片帧：`assets/frame_*.jpg`、`assets/speaker_bottom.jpg`
- **GPT Image 2.5 生成的真实虚拟背景**：`assets/bg/01-study.jpg`（书房）、`02-studio.jpg`（极简工作室）、`03-cafe.jpg`（咖啡馆）、`10-concrete.jpg`（水泥灰墙）。其余 6 个预设（夜景落地窗、科技暗色、日式和室、绿植阳台、图书馆、黄昏天台）还没生成，用诚实占位 + 「待生成」。处理中那条消息里用户选了「夜景落地窗」，所以它显示为正在生成。
- 不要用 Midjourney；需要额外图片时只能用诚实占位。

## 必须参考的设计资源（每个都要 WebFetch 打开看，按需取用；最终在 HTML 顶部注释里写「参考清单」：每条资源借鉴了什么、用在哪个元素上，至少落地 5 条）
1. https://motion.dev/docs/react-scroll-animations（对话流滚动时的进入/视差）
2. https://prompt-motion.com/（动效提示词与动效模式）
3. unsection.com（现成模块）
4. bentogrids.com（便当网格：可用于设置卡、v1 摘要、自检结果）
5. 60fps.design（微交互细节：按钮、chip、发送、@标签飞入）
6. jiro.build（AI 设计提示词：可借来定风格关键词）
7. navbar.gallery（左项目栏 + 顶部条）
8. footer.design（对话流底部/输入框区域的收尾）
9. cta.gallery（「开始出片」「导出」主 CTA）
10. https://styles.refero.design/（风格系统：先在这里找到与你方向匹配的真实风格作为锚点）
打不开的站点如实记录，不要假装参考过。

## 三个方向（每个 subagent 只做自己那一个）
- **D · 工业硬件（Teenage Engineering / Braun / Dieter Rams）** → `D-industrial.html`：浅暖灰机身、一个信号橙、等宽数字、LED 状态灯、旋钮/拨杆式控件、印刷标签感；AI 剪辑过程像一台机器在运转（VU 表、计数器滚动）。
- **E · 创作者潮玩新粗野主义（Gumroad / Figma Config / Poolsuite）** → `E-neobrutal.html`：高饱和撞色、粗黑描边、硬投影、贴纸、手写批注；面向博主的活泼与自信，动效弹性十足但不廉价。
- **F · 电影暗房（胶片显影 / 片场场记板 / 暗房安全灯）** → `F-darkroom.html`：暖琥珀安全灯红/橙、胶片颗粒、齿孔、显影液里慢慢浮现的画面、电影感衬线标题；Three.js 可做一处胶片卷或漏光 hero；剪辑直播用「显影」隐喻。

## 品质自检循环（硬要求）
完成后按以下 5 维自评，每维 0–10，**任一维 < 8.5 就继续改**，最多 5 轮；每轮截图（1440×900）并用 Read 看图后再打分，写下扣分原因：
哲学一致性 / 视觉层级 / 细节执行（对齐、间距、字体、对比度 ≥4.5）/ 功能性（交互全可点、无控制台报错）/ 创新性（能否在 Awwwards 首页被记住）。
另外必须截 2 张状态图：重播剪辑过程进行中、对比模式开启。

## 交付
`/Users/crawford/workspace/mingzhi/onetake/design-demos/<D-industrial|E-neobrutal|F-darkroom>.html` + 同名 `.png`（默认态）+ `-replay.png` + `-compare.png`。截图用本机已缓存的 Chromium + 自写 Playwright 脚本，脚本放 scratchpad 下你自己的子目录。
回报：文件路径、参考清单摘要、每轮 5 维分数变化、form 来自内容哪里、已知缺陷。
