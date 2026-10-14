# P1 遗留事项（终审后延期）

来源：P1 子 agent 执行台账。后续阶段动到相关模块时顺手处理。

## 终审裁定延期 / 搁置
- Ruling: 延期 片头片尾保留(对生口播是正确行为)、改写幅度校验、usage 记录(P4)、MAX_CUT_RATIO 告警化(P5)、淡入起音(待人耳)、--no-captions、Windows 字体(P3)、ASR 异步缓存与结构化 ProgressEvent(P5)
- parked — 超宽行退回原字丢校对（47/55 采用）— Ruling: A2 按裁定实现，改进（提示词收紧或语义重拆对齐下标）放 P3 字幕样式阶段 — 代价：成片约 15% 字幕行保留 ASR 错字
- parked — 音轨长于画面时末段画面短于音频（maxFrame 用容器时长）— Ruling: 延期，口播素材少见，整体时长不受影响 — 代价：个别素材结尾定格
- parked — 429/5xx 时 res.text() 抛错不可重试、读体超时报错原因不准；project.json 非原子写；filter.txt 不清理且需 ffmpeg≥7；输出=输入判断大小写敏感 — Ruling: 全部延期为小项 — 代价：极端情况报错信息不准

## 各任务审查留下的小问题（其中 MINGZHI_DATA_DIR 空串、样片注释、parseProbe NaN、fetch-models 截断、网络错误重试、单个坏剪切项、提示词空结果、16 vs 14 字、validateLines 注释、project.json 落盘时机 已在终审修复轮解决）
- Task 1: minor (deferred): config 测试 mkdtemp 未清理临时目录
- Task 1: minor (deferred): MINGZHI_DATA_DIR 为空串时 dataDir='' （?? 而非 ||）
- Task 1: minor (deferred): 无 packageManager 字段 / esbuild onlyBuiltDependencies
- Task 2: minor (deferred): make-fixture.sh 注释写约 14 秒，实际 19.4 秒
- Task 2: minor (deferred): extractWav16k 测试只断言文件大小，未校验 16k/单声道（plan-mandated）
- Task 2: minor (deferred): parseProbe 对 duration "N/A" 会得到 NaN
- Task 3: minor (deferred): fetch-models 中断下载会留下截断文件且下次被当作已存在（P6 启动器下载器需 .part+校验）
- Task 3: minor (deferred): buildTokens 未校验 timestamps 与 tokens 长度一致
- Task 3: minor (deferred): VAD 循环丢弃末尾不足 512 采样（≤32ms）
- Task 3: minor (deferred): modelsReady=false / 采样率错误 / 0.5s 上限 缺少单测
- Task 4: minor (deferred): 重试耗尽后仍多 sleep 一次（plan-mandated）
- Task 4: minor (deferred): fetch 网络错误/超时不重试（plan-mandated，真实环境较可能发生——终审时考虑修）
- Task 4: minor (deferred): 重试耗尽、返回结构异常分支缺测试
- Task 5: minor (deferred): 单个非法 cut 项导致整体 validateCuts 抛错（plan-mandated，真实 LLM 下可能出现——终审考虑改为丢弃坏项）
- Task 5: minor (deferred): 合并相邻剪切时保留第一项的 type/reason
- Task 5: minor (deferred): 越界剪切被静默丢弃无日志
- Task 5: minor (deferred): 提示词未说明无需剪时返回 {"cuts":[]}；slip 示例含标点
- Task 6: minor (deferred): 剪切覆盖段首/整段/相互重叠、mapToOutput 边界无测试
- Task 6: minor (deferred): 零宽剪切会把保留段切成两段相接区间
- Task 6: minor (deferred): mergeGap 在 pad 之后计算，注释读起来像原始间隔
- Task 7: minor (deferred): buildCutFilter 对短于 2×fade 的片段无保护（上游 minKeep 0.25 兜住）
- Task 7: minor (deferred): [0:a] 写死，无音轨输入报错不友好（runPipeline 已先检查 hasAudio）
- Task 7: minor (deferred): 渲染测试未断言分辨率/编码/音轨；长视频上百段性能未测（T10 实测）
- Task 8: minor (deferred): 校验字数 16 vs 提示词 14 不一致，WrapStyle 2 不自动换行，16 字可能贴边（T9/T10 实渲确认）
- Task 8: minor (deferred): escapeText 双写反斜杠；模型名硬编码未复用 CUT_MODEL；字幕时长无上限
- Task 8: minor (deferred): validateLines 注释仍写「首尾都是保留下标」
- Task 9: minor (deferred): project.json 在烧录成功后才写，烧录失败会丢转写与剪切结果
- Task 9: minor (deferred): 管线测试未断言成片分辨率/字幕确实渲染
