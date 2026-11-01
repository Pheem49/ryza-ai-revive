# 统合架构：airi + N.E.K.O. + AgentAtelierR → ryza-ai-revive 的下一版

> **交接入口**：接手的人（或 agent）先读 **§12 交接须知**（先读什么、本工作确立的约定、常用命令、三个坑），
> 再看 **§11 实施进度**（P0 / S1–S7 / 打包的提交号与实测数字、未完清单），然后按 §3 的目标架构动手。
> 当前状态：**1.2.16 / versionCode 19**，提交 `d7eb5eb`，11 项检查全绿（含 `voice_regression` 80 断言）。

对象：`projects/ryza-ai-revive`（Ryza Chat **v1.2.16**）
参考：`moeru-ai/airi`（MIT）、`Project-N-E-K-O/N.E.K.O`（**Apache-2.0**）、`onion-aqua/AgentAtelierR`（**无许可**）
日期：2026-09-18
还原点：ryza 仓库 tag **`pre-unification-20260918`** @ `fbac9d2`（工作区干净）；workspace 提交 `0bbabce`
配套：[`ryza-airi-realtime-layer-design.md`](ryza-airi-realtime-layer-design.md)、[`../reports/airi-vs-ryza-ai-revive-assessment.md`](../reports/airi-vs-ryza-ai-revive-assessment.md)、[`../reports/ryza-vs-agentatelierr-feature-gap.md`](../reports/ryza-vs-agentatelierr-feature-gap.md)

---

## 0. 结论

**"统合"的正确做法不是把三个项目合成一个代码库，而是在 ryza 这一个代码库里把三家的长处各取一层。**

原因很硬：三个项目是三种语言、三种架构，没有可合并的交集。

| 项目 | 形态 | 能拿的 | 不能拿的 |
|---|---|---|---|
| **airi** | Vue3+Pinia+Vite monorepo（TS） | **范式与描述符**：provider 注册表、意图/播放语义、TTS 分句、spark 主动性；其"实时层"**上游自己写了抽取规格禁止 Vue/Pinia/localStorage**，所以那一层是干净的 | UI/舞台（Vue 组件树，会毁掉你的官方 UI 保真）；`stage-ui-spine`（单角色展示器，没有场景引擎） |
| **N.E.K.O.** | Python 3.11 三进程后端 + **原生 JS/Jinja 前端** + Electron（Apache-2.0） | **逻辑与参数**：三阶段断句（Silero VAD 门 → 语义端点）、**onset 打断**、协作式代际令牌、按 `speech_id` 清播放队列、文本相似度回声抑制、TurnOwner/ProactivePhase 状态机、**CI 强制的分层与 core contract** | 整个后端（Python；你是纯前端 + `/_proxy`）；插件 ZMQ 进程模型；它的记忆服务 |
| **AgentAtelierR** | Dart/Flutter（作者已确认有许可：用户 2026-09-18 与群主确认；仓库内无 LICENSE 文件） | **只取"做法"**：NPC 多说话人协议与频率分档、本地皮肤导入的校验规则、原生闹钟、提示词卡槽 | 代码是 Dart、做法已经够用，所以本轮不抄代码——不是因为许可 |

三家合起来正好补齐你的三块空白：**airi 给"提供商与管线的形状"，N.E.K.O. 给"何时算说完、何时该打断"的判定逻辑，AgentAtelierR 给"角色之外的人与物"（NPC、服装、提醒）**。而你自己的三块资产（一比一保真、Spine 场景引擎、权威 RPG 世界状态）**一个都不能丢**——那才是三家都没有的东西。

### 最重要的一条技术判断

**你要的"打断"，airi 没有，N.E.K.O. 有，而且它的判定逻辑是可以在浏览器里复现的。**

- airi：`grep -r "barge"` 全仓 0 匹配。打断只在"发消息/按停止/静音/切供应商"时发生，麦克风听到你说话**不会**停她的嘴。
- N.E.K.O.：**真 onset 打断**。`input_audio_buffer.speech_started` → `handle_interruption()` → `cancel_response()`；独立 ASR 路径上本地 VAD 的 `SPEECH_STARTED`（确认 200 ms 后）直接触发 `handle_interruption`。两条路径都在**你开口的瞬间**切断生成。
- 而且它的核心是 **ONNX 模型 + 几个纯逻辑文件**，不依赖它的 Python 服务：Silero VAD v6.2.1（MIT）、Smart Turn v3.2（BSD-2-Clause）。**在 `onnxruntime-web` 里跑得动**，所以你能做一个**纯前端、离线**的断句/打断管线——这比 airi 的"纯静音计时 + 干脆禁麦"高一个档次。

### 三条主线

1. **把"谁在说话"变成唯一权威**（新增 `turn.js`：意图队列 + 播放管理 + 代际令牌 + 打断出口）。
2. **把"何时算说完/何时该抢话"变成可验证的判定**（新增 `vad.js` + `endpoint.js` + `echo.js`，参数照抄 N.E.K.O. 的实测值）。
3. **把"角色之外的世界"补上**（新增 `npc.js` + `proactive.js`；`providers.js` 表化；原生闹钟下到壳）。

配套一条工程纪律：**先用守卫脚本把边界冻住，再动代码**——这是"防止跨模块冲突"的可执行版本，也是 N.E.K.O. 的做法（它有 `scripts/check_module_layering.py` 与 `scripts/check_core_contracts.py` 进 CI）。

---

## 1. 现状实测（动刀前的事实基线）

### 1.1 代码规模与耦合（本机实测）

| 文件 | 行数 | 它调用谁 | 谁调用它 |
|---|---|---|---|
| `avatar.js` | 2,827 | config, util | api, app, config, onboarding |
| `app.js` | 2,560 | **13 个模块** | **10 个模块回引 `App.`** |
| `api.js` | 1,384 | avatar, config, i18n, memory, nsfw, world | app, memory, quests |
| `i18n.js` | 1,196 | config | 9 个模块 |
| `quests.js` | 627 | api, config, fx, game, i18n, util | app, game |
| `world.js` | 621 | config, game, i18n | api, app, audio, onboarding |
| `game.js` | 441 | config, i18n, quests, util | app, daily, memory, quests, world |
| 其余 11 个 | 1,940 | — | — |
| **合计** | **11,596 行 / 18 个模块** | | |

**诊断**：问题不是"`app.js` 太大"，而是 **`App` 是全局枢纽**——18 个模块里 10 个回引它，另外还有三对**互相引用**（`config↔avatar`、`memory↔api`、`game↔quests`）。这正是 `高内聚低耦合` 要治的东西，也是跨模块 bug 的温床。

### 1.2 三个已知的"结构性"缺陷（不是单点 bug）

1. `/_proxy` 有**三份独立实现**、三种语言（`scripts/serve.py` 160 行 Python / `desktop/main.js` Electron 自定义协议 / `android/.../AssetServer.java` Java），靠人肉同步。
2. `Api.chat` **没有请求代际令牌**（AUDIT §11.4-3，重试条连发会乱序落账）——而打断**必须有**它。
3. `App.playUrl` 没有"中途停掉一个正在播的音频"的出口（`turn.js` 要补的第一个能力）。

### 1.4 P0 已落地：边界守卫与实测基线

已提交（ryza 仓库 `09012ce`）：`config/layers.json`（边界声明）+ `scripts/layering_check.js`（报告模式，`--strict` 才失败）。**未改动 `web/js` 任何一行。**

`node scripts/layering_check.js` 的实测基线：

| 检查 | 结果 |
|---|---|
| A 层间引用 | **11 项**越层。集中三类：`quests/daily/world`(core) 反向调 `app`/`audio`/`fx`/`api`；`avatar`(render) → `app`；`api`(io) → `avatar`（协议层直读渲染层的 `Avatar._emotion`，这是最该先修的一条——它让实时层无法 headless 测） |
| B 循环依赖 | **0 项未声明且不经枢纽的硬环**；1 条已声明（`game↔quests`，AUDIT §6.2 刻意设计）；**12 条经 UI 枢纽的环**（不计违规，但正是"`App` 是全局枢纽"的直接证据，也是拆 `app.js` 的目标） |
| C core 纯度 | **4 项**未声明触达：`quests`（DOM×37）、`world`（DOM×42 + `fetch`×4）、`daily`（DOM×15）、`i18n`（`querySelector`×1，即 `I18n.apply` 直接刷 DOM）。1 项已声明例外：`config` 的 dev 水合 `fetch`（打包后 404） |
| D 三端契约 | **0 项**——`/_proxy` 的 4 个契约标记在三端齐全 ✅ |
| E 版本字面量 | **3 项**：`User-Agent: RyzaChat/1.2.13` 硬写在**三个宿主**里，而当前版本是 1.2.15。`stamp_version.js` 只管 `desktop/package.json` 与 `build.gradle`，不管 UA ⇒ 已经静默漂了两个版本。**这是守卫抓到的第一个真实 bug。** |

基线同时确认：6 套行为回归 + `privacy_check.py` 全绿（boot_smoke 38 / game_logic 96 / memory 37 / nsfw_intent 77 / electron_storage 7 条断言，`motion_regression` 与 `expression_coverage` 以 `OK` 行输出并全过）。

### 1.5 第一刀解耦（已落地）：渲染层不再反向依赖 UI，冗余时段表收口

按你"最怕冗余 + 高耦合导致后续修复牵扯很多东西"的优先级，先动最脏的一处而不是先加功能。**实测结论修正了你的印象**：`avatar.js → App` 只有 6 处（3 个 `App.toast` + 一处每帧读 `App._voiceAnalyser`/`App.audio.paused`），反向 `app.js → Avatar` 有 37 处。所以问题不是"缠成一团"，而是**三个方向不对**：

| 反模式 | 实测 | 改法 |
|---|---|---|
| 渲染层回调 UI 枢纽 | `avatar.js` 调 `App.toast` ×3、每帧读 `App` 的音频对象 | 改为**注入**：`Avatar.setNotice(fn)` + `Avatar.setVoiceSource(fn)`，`app.js` 在 init 时接上。默认惰性 ⇒ headless 回归仍能单独加载 avatar.js |
| 私有成员当公共 API 用 | `app.js` 读写 `Avatar._panelFrac`、读 `Avatar._hideChara`、用 `Avatar._cssZoom`；`api.js` 读 `Avatar._emotion` | 加公开取值器/设值器：`panelFraction()/setPanelFraction()/isHidden()/cssZoom()/currentEmotion()`；`_cssZoom` 保留为别名（AUDIT 文档引用它，不改名以免文档失效） |
| 协议层侧读渲染层 | `api.js` 的 `fishEmotion()` 去读 `Avatar._emotion` 给 Fish 打情感标签 | 改成**参数下传**：`Api.speak(text, lang, mode, emotion)` ← `App.speakThen(text, emotion)`（emotion 本来就在作用域里） |
| 同一张表在多个模块各写一遍 | 时段表存在 3 处：`world.hourToTod`、`world.todStartHour`（同一对象字面量写了两遍）、`alarm.todForHour`，靠注释维持一致，且**已经分叉**（alarm 少了 `h%24` 归一） | `util.js` 成为唯一来源：`Util.hourToTod` / `TOD_START` / `TOD_VOICE`；`world` 与 `alarm` 全部委托。**逐分支核对过输出完全一致**（含 NaN/越界），`alarm` 顺带补上归一 |
| 测试摸私有字段 | `motion_regression.js` 直写 `Avatar._panelFrac` | 改用 `Avatar.setPanelFraction()` |

**守卫读数变化**（同一个 `layering_check`）：

| | 改前 | 改后 |
|---|---|---|
| 越层引用 | 11 | **9**（`avatar→app`、`api→avatar` 消失） |
| 经 UI 枢纽的环 | 12 | **9** |
| 未声明的硬环 | 0 | **1** ⚠️ 见下 |

⚠️ **坦白一件事**：硬环从 0 变 1 **不是变差，是原先被遮住的暴露了**。拆掉 `avatar→app` 这条枢纽边之后，环检测不再只走"经过 app 的长路径"，于是露出两条**本来就存在**的短环：

1. `api ↔ memory` —— **已修**。`memory.js` 里其实早有 `setSummarizer` 注入口，只是还留着一个 `global.Api` 兜底分支；改成宿主注入（`Memory.setLLM(fn)`，`app.js` 接 `Api.complete`），memory 就不再引用 Api，环消失。
2. `game → quests → api → world → game` —— **待修**。根因是 `quests.js:158` 直接 `Api.chat(...)` 现生成动态任务文案（核心玩法模块自己在做 LLM 传输），加上 `api→world`、`world→game`。修法与 memory 同构：把"生成文案"注入进 `Quests`，而不是让它调 `Api`。**这一刀需要单独做，因为要确认动态任务的调用时序。**

其余读数未变：core 未声明触达 4（`quests`/`world`/`daily`/`i18n` 混渲染，下一刀）、三端契约 0 ✅、版本字面量 3（UA 漂移，未修）。

**验收**：6 套行为回归 + `motion_regression` + `expression_coverage` + `privacy_check` **全绿**；`avatar.js` 里已无任何非注释的 `App.` 引用。

> 设计说明：`game↔quests` 与 `config fetch` 这两条**不是违规而是刻意设计**，已在 `layers.json` 的 `allowCycles` / `coreExceptions` 里连同理由声明。守卫的价值在于"把刻意的和事故的分开"——不声明就等于给耦合开绿灯。




- 官方 APK 只有 **2 套可运行角色骨骼**（`crf_skn_002_0001_01` 坐 / `_99` 站）——你的 `skins.json` 与 AgentAtelierR 的审计独立得出同一结论。
- 你的 203 个骨架**全为 Spine 4.2.43**；200 套场景目录 + 2 套皮肤 + objects。
- 你的 `chara_icons/` 36 张立绘与 AgentAtelierR 文档里列的 33 位 NPC 图**逐一对得上**（同一来源）。

---

## 2. 逐家长处清单（拿什么、为什么、落到哪、许可）

### 2.1 取自 airi（MIT，可抄代码，需带声明）

| 项 | 具体是什么 | 落到 ryza |
|---|---|---|
| Provider 注册表 | 描述符 = 一个返回"OpenAI 调用参数"的函数：TTS `{baseURL, model, fetch?, voice?}`、STT `{baseURL, model, fetch?}`；调用永远是 `@xsai/generate-speech` / `generate-transcription`（公开 npm，MIT），TTS 回 `ArrayBuffer`。17 个可移植 TTS + 5 个 STT，其中 **VOICEVOX（`localhost:50021`）/ AivisSpeech（`10101`）是本地 HTTP、日语原生** | 新增 `providers.js`；`api.js` 的按 provider 手写分支退场 |
| 意图/播放语义 | `behavior: 'queue'\|'interrupt'\|'replace'` + `priority` + `ownerId` + `cancel(reason)`；每次播放一个 `AbortController`；`stopByIntent/stopByOwner/stopAll`；并发上限（`ttsMaxConcurrent` 默认 4、`maxVoices` 默认 1） | `turn.js` 的核心语义 |
| TTS 分句器 | 长回复按标点切块、逐块合成 → 首句先响 | `turn.js` 的 chunker；长回复首字节延迟立刻改善 |
| spark 主动性 | 任务表 `{priority, status, dueAt}` + 2 s tick + 60 s 到期窗口 + 30 s×3 次重排；反应以 `priority:'high', behavior:'interrupt'` 开意图（**主动发言压掉当前台词**） | `proactive.js` 的调度骨架（触发器换成你的世界状态） |
| 工具能力探测 | 端点不支持 tools 时的错误串匹配 + **按模型键记忆禁用**（Ollama/Azure/Cloudflare 三种报错） | 只在你将来加工具时用；现在保持"不上 tools" |

### 2.2 取自 N.E.K.O.（Apache-2.0，可抄代码/参数，需带 NOTICE）

这是**本次最有价值的一家**，而且它的主前端也是**原生 JS + 全局函数**（`static/app/*.js`），架构文化和你接近。

| 项 | 具体是什么（实测参数） | 落到 ryza |
|---|---|---|
| **三阶段断句** | ① 能耗/RNNoise 节流（`bootstrap_onset 0.35` / `baseline_margin 0.12` / `min_onset 0.20` / `max_onset 0.65` / `baseline_alpha 0.05`）；② **Silero VAD**（512 样本窗 @16 kHz，onset **0.5**、offset **0.35**、最短语音 **200 ms**、候选静音 **300 ms**，v6.2.1 ONNX，MIT）；③ **Smart Turn v3.2 语义端点**（阈值 0.5、最长音频 8 s、确认 1.0 s、推理错误上限 3，ONNX，BSD-2-Clause） | 新增 `vad.js` + `endpoint.js`。**先做 ①②（纯静音判定），再用 spike 验证 ③ 能否进 onnxruntime-web** |
| **onset 打断** | 你开口的瞬间（不是说完）就 `handle_interruption()` → 取消生成 → 清播放。两条路径的触发点都写死了：realtime 走 `speech_started`，本地 ASR 走 VAD `SPEECH_STARTED` | `turn.js` 的 `interrupt('user-barge-in')`；触发源是 `vad.js` 的 onset 事件 |
| **协作式代际令牌** | 不做 AbortController，而是 `_response_generation` 自增 + 流式循环里 `if not _response_generation_is_active(gen): break`（还专门处理了"重试 sleep 期间被打断不该再起一轮"） | **正好修掉 AUDIT §11.4-3**；`Api.chat` 加 `epoch`，`turn.js` 打断时 `epoch++` |
| 按 `speech_id` 清播放 | 后端发 `{"type":"user_activity","interrupted_speech_id":...}`；前端 `clearAudioQueueWithoutDecoderReset()` → 对所有已排程 source `stop()` + 停口型；**关键约束：`scheduleAheadTime = 5`（最多预排 5 秒音频）⇒ 只取消生成不够，必须清队列**；头部未到时用 700 ms 宽限 | 你现在是单个 clip，`source.stop()` 就够；**一旦做流式分块 TTS（airi 那套），这条必须一起做**，否则会出现"已经排进 Web Audio 的 5 秒还在响" |
| **文本相似度回声抑制** | `_looks_like_recent_ai_echo()`：回看 **20 s / 1200 字符**，`SequenceMatcher.ratio() >= 0.88`（整串或滑窗，最小 6 个归一化字符 / 窗口 10）命中就丢弃转写 | `echo.js`，≈50 行，**几乎可以逐行译成 JS**。这是你自己那套里最缺的一块 |
| 半双工只作为可选项 | 只在 Focus 模式且播放中才抑制麦克风（`focus_suppressed = focusMode && isPlaying`），其余时候麦克风**一直开着**，靠 AEC + 文本回声兜底；另有 `hard_mute`（用户静音键） | 你的麦克风策略：默认常开 + `echoCancellation:true` + 文本回声抑制；**把"说话时禁麦"降级为可选项**（airi 是 800 ms 冷却，N.E.K.O. 只在 Focus 模式做——两者都说明常开是主流） |
| **TurnOwner / ProactivePhase 状态机** | `TurnOwner {NONE, USER, PROACTIVE}` + `ProactivePhase {IDLE, PHASE1, PHASE2, COMMITTING}`；**任何 proactive 阶段遇到 `USER_INPUT` 都 sticky preempt**（用户永远优先）；无锁 O(1) 读，订阅者在锁外派发 | `turn.js` 的顶层状态机——比"idle/listening/thinking/speaking"更贴合"她主动开口被打断"这个真场景 |
| 生命周期状态机 | `VoiceLifecycleState {OFF, LOCAL_LISTEN, PREWARMING, ACTIVE, DRAINING, WARM_IDLE, DEEP_SLEEP, BACKOFF, BLOCKED, SUSPENDED}` | 精简为可用的子集（OFF/LISTENING/ACTIVE/PAUSED/BLOCKED） |
| **抑制租约带 TTL** | `voice_input/suppression.py`：`default_ttl_seconds=30` / `hard_ttl_seconds=60` / `callback_timeout_seconds=10`，可撤销租约 + 到期自动释放 | 防"禁麦后忘了恢复"这一类死锁 bug；你的 `_bubbleHold/_bubbleKeep` 也吃这个模式 |
| 身份/代际令牌纪律 | 每个边界都带令牌（`VoiceIngressToken {session_epoch, connection_id, lease_generation, route_generation, audio_generation}`），过期结果返回 `STALE` 而**不抛异常** | 你的 `motion_regression` 播种时钟 + `_pokeUnmuteReady()` 已经是这个思路，推广到语音/LLM/播放三条链 |
| **CI 强制的分层与契约** | `scripts/check_module_layering.py` + `scripts/check_core_contracts.py` 进 CI；`docs/contributing/code-style.md` 明确"保持 module-layer 顺序"；825 个测试文件 | **`scripts/layering_check.js`**（见 §6.1）——这是本次"防止跨模块冲突"的抓手 |
| 5 层记忆 + 混合召回 | Working / Recent(`recent.json`) / Facts(`facts.json`) / Reflections / Persona；召回 `hybrid_recall.py` = **BM25 over 活跃 facts/reflections + 可选 cosine，用 reciprocal-rank fusion 融合**（≤8 条，无 reranker LLM）；证据分带读时衰减、晋升/否定/归档；`recall_memory` 工具 | 你的 `memory.js` 是"每 N 轮压卡片 + 同层再压"。**可借鉴的是"事实层与反思层分开 + 检索时融合排序"**，尤其契合 §4.3 的"状态即记忆" |
| 桌面活动感知 | `SystemSignalCollector`（5 s 轮询取前台窗口标题/进程名、CPU、空闲秒数、GPU）+ `ActivityStateMachine`(49 KB) → `ActivitySnapshot`；隐私规则写明"窗口标题/进程名不得写入持久日志或遥测" | 你的 `vision.js` 可先取"前台应用名"这种轻量信号，比整屏截图省得多（Windows 侧 `GetForegroundWindow`，Electron 有 `BrowserWindow` 等价物） |
| 视觉口型（加分项） | VRM 侧 `vrm-lipsync-formant.js`：**共振峰→五元音权重**（F1 200–1000 Hz、F2 1000–3000 Hz + 各元音参考值），比能量标量高级 | 你已有"音量包络"口型；这个是**可选升级**，能明显改善口型可信度，且能直接换掉你现在的包络标量 |

### 2.3 取自 AgentAtelierR（做法优先：代码是 Dart，做法已够用）

| 项 | 做法（可学） | 落到 ryza |
|---|---|---|
| **NPC 多说话人** | 每行以 `旁白：`/`莱莎：`/`角色[ID]：`/`译文：` 开头；NPC 有自己的头像+名字气泡；候选按 `bases` 打分（精确 stageId = pct×100、同 field ×50、同 area ×25，阈值 0.05，按分数再按 `resolveOrder`，取前 6）注入提示词；每轮最多 1–2 位 NPC；4 档互动频率（默认 normal）；NPC 台词**不带** face/action/语音标签、**不进** TTS/表情/动作管线 | `npc.js`。**你已有 33 张立绘 + 34 位 NPC 数据（含 `companions`）+ `met_charas`**，缺的只是协议、渲染与一句话人设 |
| 本地皮肤导入 | ZIP 整套（≤64 MB、≤64 条目、禁 `..`/绝对路径/符号链接、只允许 `skel/atlas/png/json`、单页 atlas、PNG IHDR 尺寸必须匹配 atlas、**骨架必须 Spine 4.2**、必须含 `motion_A_001_idle`）+ 单独替换贴图页（PNG 尺寸必须完全相同） | 你**内部已有**贴图页变体机制（NSFW `{pageBase}nsfw.png`）→ 先做"玩家可替换贴图页"，再做 ZIP 导入 |
| 原生后台闹钟 | Flutter `Alarm.scheduled` + Android 全屏 intent + 锁屏响铃 + 5 分钟贪睡 + `Permission.scheduleExactAlarm`；4 种提醒类型 × 普通/耳语两版音频 | **你 HANDOFF「还剩的」第 1 条**。下到 `android/` 壳用 `AlarmManager`；桌面用 Electron 排程 |
| 提示词卡 / 世界书 ×5 槽 | 人物卡/世界书各 5 槽 + 用户设定槽，旧内容迁移到 1 号槽，导入导出带上 | 与你要拆的 `settings.js` 一起做 |
| 聊天体验三件套 | 附件（10 MB/个与/批）、建议回复（**每 10 分钟 3 次**、不自动代替用户发言）、继续/撤回上一条/重播上一条语音 | `talk` 层增量；注意你的"同轮不双计"纪律 |
| 旁白分离 + 只显示译文 + 主题 | `ChatSpeaker.narrator` 单独渲染；`translationOnly` 只影响显示、不影响存储与 TTS；7 主题色 + 7 文字色 | `api.js` 解析层 + CSS |
| 相机捏合缩放 | `_scale`/`_verticalOffset`/`_pinchDetected`/`onScaleUpdate` + 点击消歧 | ⚠️ **必须"在钳制窗口内缩放"**，否则撞你 AUDIT §9/§11.6 的构图约束 |

### 2.4 你已有、三家都没有（必须守住）

1. **一比一保真**：203 骨架 / 200 场景 / 3609 资源逐一核对过；官方 UI 逐像素比对。
2. **Spine 场景引擎**：双骨架同画布、板内钳制相机（`_coverFor` 取最大 quad）、姿态无关背景窗口、`sofa_root` 家具锁定、视线对齐、`BB_*`∩可见轮廓热区、逐骨骼 `_aimSm` 平滑。**airi 的 `stage-ui-spine` 一样都没有。**
3. **权威世界状态**：`game.js` 的 `applyDelta` 唯一写入口 + 34 NPC 按天漂移 + 时间流逝三模式 + 8 段主线 + 双背包 + 每日登录。
4. **工程资产**：6 套回归 + `privacy_check.py` 双闸门 + `stamp_version.js` 单一版本源 + "安装包与源码逐文件哈希一致"。

---

## 3. 目标架构

### 3.1 分层与依赖方向（只允许向下）

```
L4  ui/         app.js(拆) onboarding.js kbd.js shell.js        只装配 DOM，不写状态
L3  features/   npc.js proactive.js vision.js settings.js        可拔插玩法；只经只读门面读 L2
L2  voice/      turn.js vad.js endpoint.js echo.js stt.js        实时层；不读 game/world
L2' io/         api.js providers.js protocol.js                  只认协议，不认玩法
L1  render/     avatar.js audio.js fx.js alarm.js                画布与视听
L0  core/       util.js i18n.js config.js world.js game.js       纯逻辑/数据：无 DOM、无 I/O
                quests.js daily.js memory.js nsfw.js
```

**四条硬边界（守卫脚本会检查）**：

1. `core/` 不得引用 `render/`、`ui/`、`io/`、`voice/`（它必须能在 Node 里 headless 跑——你现有 4 套回归正是这么测的）。
2. `voice/` 不得引用 `game.js` / `world.js` / `quests.js`（实时层不知道什么是体力、任务、地点）。唯一例外是 `proactive.js`，且只经**只读门面** `state_read.js`。
3. `render/` 不得引用 `ui/`；`ui/` 不得直接写 `Game`（`applyDelta` 仍是唯一写入口）。
4. 禁止**循环依赖**；`App` **不得**再被 `core/` 与 `io/` 回引（这是当前 10 处回引要拆掉的东西）。

> **不搬文件也能冻结边界**：把上述规则写进 `config/layers.json`（声明每个模块允许依赖谁），由守卫脚本比对实际引用。**先冻结、后搬家**，避免 18 个文件大挪移带来的 `index.html`/`boot_smoke.js`/`privacy_check` 连锁改动。目录重整列为可选的低优先项。

### 3.2 新增模块与归属

| 新模块 | 属层 | 职责 | 不许做 |
|---|---|---|---|
| `turn.js` | L2 | **"谁在说话"的唯一权威**：意图队列（priority/behavior/owner）+ 播放管理（每次播放一个取消令牌）+ 代际令牌 + 打断出口 + 半双工门 | 不知玩法；不合成 TTS；不解析 LLM |
| `vad.js` | L2 | 麦克风采集 → 能耗节流 → Silero VAD 门 → 发出 `SPEECH_STARTED`/`CANDIDATE_PAUSE` | 不做断句决策（那是 `endpoint.js`） |
| `endpoint.js` | L2 | 候选停顿 → 语义端点判定（阶段一：静音计时；阶段二：Smart Turn ONNX） | 不发 TTS、不管播放 |
| `echo.js` | L2 | 文本相似度回声抑制（回看 20 s / 1200 字符 / 0.88） | 不碰转写以外的流程 |
| `stt.js` | L2 | 转写（浏览器 Web Speech 优先，提供商兜底，走 `/_proxy`） | 不自己决定发送 |
| `providers.js` | L2' | TTS/STT/视觉提供商表 + 描述符 + 凭据字段映射 | 不知道 UI |
| `npc.js` | L3 | 多说话人协议解析 + NPC 气泡渲染 + 候选打分 + 互动频率 | 不改 `Game`；NPC 不进 TTS/表情/动作 |
| `proactive.js` | L3 | 世界状态 → 主动意图（读 `state_read`，写意图） | **不写状态** |
| `vision.js` | L3 | 截屏/前台应用 → 视觉或上下文 | 不自动改变玩法 |
| `state_read.js` | L0 | **只读门面**：把 `Game`/`World`/`Quests` 的公开查询收口成一组函数 | 不提供任何写入口 |

`state_read.js` 是关键：它让 `proactive.js` 与 `npc.js` 能读世界状态而不与三个 core 模块相互引用，从而**打断 `game↔quests↔world` 那张引用网**。

---

## 4. 交互逻辑设计（三家合起来的那一套）

### 4.1 状态机（N.E.K.O. 的模型 + 你的场景）

```
TurnOwner:      NONE | USER | PROACTIVE
ProactivePhase: IDLE | PREPARE | SPEAKING | COMMITTING
VoiceState:     OFF | LISTENING | ACTIVE | PAUSED | BLOCKED
```

规则（照抄 N.E.K.O. 的 sticky preempt）：

- `USER_INPUT` 在任何 proactive 阶段都**优先抢占**并置粘性标记（她主动开口时你一说话，她立刻让位）。
- `PROACTIVE` 只能在 `TurnOwner == NONE` 时开始（她不能在你说完前插话）。
- 打断出口只有一个：`Turn.interrupt(reason)` → 取消意图 → **代际令牌 +1** → 停止播放 → 复位口型/`playbackRate`/`_bubbleKeep`。

### 4.2 打断的完整时序（vad → turn → api）

```
[你开口] vad.js: SPEECH_STARTED（Silero onset 0.5，确认 200ms）
   │
   ├─ 若 Turn.isSpeaking() 且未被回声抑制挡住：
   │     Turn.interrupt('user-barge-in')
   │       ├─ Api 代际令牌 +1  →  流式循环见 gen 失效即 break（协作式，非 AbortController）
   │       ├─ 停当前播放（source.stop() + disconnect）
   │       ├─ 丢弃未播的分句意图（cancelIntent）
   │       └─ 复位：口型 / playbackRate（ASMR）/ _bubbleKeep / _pokeUnmuteReady
   └─ 进入 LISTENING；vad.js 继续发 CANDIDATE_PAUSE
         └─ endpoint.js 判定说完 → stt.js 转写 → echo.js 过滤 → App.say(text)
```

**三条必须一起做的防护**（否则会变成"老是抢话"的坏功能）：

1. **回声抑制（三层）**：`getUserMedia({echoCancellation:true, noiseSuppression:true, autoGainControl:true})` + `echo.js` 文本相似度 0.88 + **首句保护窗口**（开始播后 600–800 ms 内不响应打断）。
2. **误触抑制**：Silero 双阈值（onset 0.5 / offset 0.35）+ 最短语音 200 ms + 能耗节流（`min_onset 0.20` / `max_onset 0.65` 自适应基线）。
3. **一致复位**：所有复位走 `Turn` 的**同一个 stop 出口**——照你 `_pokeUnmuteReady()` 那个"两处共用出口条件"的既有做法。

### 4.3 主动性（把 spark 的骨架接上你的世界状态）

调度骨架抄 airi（2 s tick / 60 s 到期窗口 / 30 s×3 重排 / `priority:'high'`+`interrupt` 压掉当前台词），**触发器换成世界状态**（经 `state_read.js` 只读）：

- 体力见底 / 睡觉恢复；任务到期或推进；每日登录里程碑；闹钟；时段变化（`real`/`flow`）；NPC 出现在同地点；刚搬家；背包满；出航解锁。

**`proactive.js` 不写状态**——要推进游戏态就让 LLM 走既有 `<state>` 通道，否则破掉"`applyDelta` 是唯一写入口"。

### 4.4 "状态即记忆"（N.E.K.O. 的事实层/反思层分层 + RRF 融合）

N.E.K.O. 的召回是 **BM25 + 可选 cosine 的 reciprocal-rank fusion**，不是纯向量——这印证了你该走的方向：**记忆的主索引是世界状态，不是 embedding**。

- 事实层：她知道的客观事实（见过谁、去过哪、有什么物品、任务做到哪）——**大部分直接来自 `Game.s`，不需要额外存储**。
- 反思层：你的 `memory.js` 卡片（会话/会话总结）保留。
- 召回：两路各取前 N，用 RRF 融合（`score = Σ 1/(k + rank)`，k 取 60 是常规值），取 ≤8 条。
- 这比 airi 的"记忆未实现"和你现在的"纯时间序压卡片"都更进一层，而且**是三家都做不到的**（它们没有权威世界状态）。

---

## 5. 前端优化清单

| 项 | 内容 | 约束 |
|---|---|---|
| 设置层拆分 | `app.js` 的 forms + 语言矩阵 + 作弊 + 存档槽（约 1.1k 行）→ `settings.js`；**提示词卡 5 槽 + 世界书**顺便做进去 | 必须同步改 `index.html` 的 script 顺序、`boot_smoke.js` 的文件清单、`App.buildSettings/buildCharaForm/_renderSlots` 三个入口名 |
| 语音 UI | 麦克风按钮（按住/切换）+ 四个 Turn 状态的可见反馈（听/想/说/静）+ 打断提示 | 任何 `clientX - rect.left` 都要除以 `Avatar._cssZoom(el)`（AUDIT §7）；`#bubble-wrap` 保持 `pointer-events:none` |
| NPC 气泡 | 头像（`World.iconFor`）+ 名字 + 正文；不进 TTS/表情/动作 | 不能抢莱莎立绘与热区 |
| 旁白 / 译文 | `旁白：` 行单独样式；"只显示译文"开关 | 显示层不影响存储与 TTS（照 AgentAtelierR 的做法） |
| 主题 | 主题色 + 对话文字色（可选） | 别动 `.view:not(#view-talk)` 的暗底（AUDIT §"非对话视图必须保持暗底"） |
| 聊天体验 | 附件 / 建议回复 / 继续 / 撤回 / 重播 | 与"talk 类任务同轮不双计"的既有纪律对齐 |
| 相机 | 捏合缩放 + 平移，**在钳制窗口内** | 不得破坏 §9/§11.6 的构图与"切姿态背景不跳位" |
| 闹钟 | 下到 `android/`（`AlarmManager` + 全屏 intent + 精确闹钟权限）与 Electron 排程 | 复用现有 `alarm.js` 的时段映射与 `todForHour` |

---

## 6. 代码层优化

### 6.1 守卫脚本（**先做这个**，N.E.K.O. 的做法）

新增 `scripts/layering_check.js`，三项断言：

1. **分层方向**：按 `config/layers.json` 声明的允许依赖，扫描各模块实际引用（`X.` / `window.X`），报出越层与未声明依赖。
2. **无循环依赖**：把实际引用矩阵做环检测。
3. **`/_proxy` 三端契约一致**：断言路由表在 `scripts/serve.py` / `desktop/main.js` / `android/.../AssetServer.java` 三处同时存在（把现有 `nsfw_intent_regression.js` 里那 4 条路由断言升级为通用检查）。

进现有回归流程（`node scripts/layering_check.js` 加进 HANDOFF 的测试清单），这样"改一处三处同步"从人肉纪律变成门禁——**这正是"防止跨模块冲突"的可执行版本**。

### 6.2 拆 `app.js`（第二刀）

分三批、每批独立可验证：

1. `settings.js`（forms + 语言矩阵 + 作弊 + 存档槽 + 提示词卡槽）——你已论证过的那一刀。
2. `talk.js`（对话循环、气泡、打字、历史、全文回看）。
3. `sheets.js` + `hud.js`（背包/任务/状态/人物面板、HUD 簇）。

每批之后：6 套回归全绿 + `layering_check.js` 通过 + git 提交。

### 6.3 provider 表化（第三刀）

`api.js` 里按 provider 手写的分支 → `providers.js` 声明表。目标：消灭 AUDIT §6.9 那一类"切端点串凭据"的 bug **类别**。

---

## 7. 实施阶段（每阶段可独立验证 + 回归 + git 提交）

| 阶段 | 内容 | 前置 | 验收 |
|---|---|---|---|
| **P0** | `config/layers.json` + `scripts/layering_check.js`；跑出当前越层/环依赖清单 | 无 | 脚本可运行；输出**当前真实**违规清单（不急着全修） |
| **P1** | `turn.js` + `Api.chat` 代际令牌 + 播放停止出口 | P0 | 新回归 `voice_regression.js`：打断语义/优先级/无泄漏/一致复位；6 套旧回归全绿 |
| **P2** | `providers.js` 表化（含 VOICEVOX/AivisSpeech 本地日语） | P1 | 设置页可用；`layering_check` 通过 |
| **P3** | `vad.js` + `stt.js`（浏览器 Web Speech 零依赖版）+ 麦克风 UI | P1 | 三宿主上"麦克风 → 输入框 → `App.say()`"通路；安卓 WebView 实测 |
| **P4** | 真 onset 打断（`vad.js` onset → `Turn.interrupt`）+ `echo.js` | P3 | 回归：回声不误触、首句保护、打断后一致复位 |
| **P5** | 拆 `settings.js`（含提示词卡 5 槽） | P0 | `boot_smoke` 更新；回归全绿 |
| **P6** | `npc.js` 多说话人 + 互动频率（轻量人设） | P1 | NPC 气泡渲染；NPC 不进 TTS/表情/动作；候选打分断言 |
| **P7** | `proactive.js` + `state_read.js` | P1 | 世界状态触发的主动意图；sticky preempt 断言 |
| **P8** | 原生闹钟（Android `AlarmManager` + Electron） | — | 后台/锁屏可响；独立于语音链 |
| **P9** | `endpoint.js` 语义端点（Smart Turn ONNX） | **需先通过 spike** | 断句正确率对比纯静音基线 |
| **P10** | 前端增量：旁白/译文/主题/附件/建议回复/继续撤回重播/相机缩放 | 各独立 | 逐项截图走查 |

**最小可用切片 = P0+P1+P3**（守卫 → 唯一说话权威 → 能说话），约 5–7 天。

---

## 8. 必须先验证的未知项（不许猜）

按你"不能猜测而是要确认实际"的要求，以下四项在动手前要各做一次 spike（写最小可运行验证，不写进正式代码）：

| # | 未知项 | 为什么必须验 | 怎么验 |
|---|---|---|---|
| 1 | **`onnxruntime-web` 能否在三个宿主里跑 Silero VAD v6.2.1** | 决定 P3/P4 是纯前端还是需要侧车进程 | 在 `serve.py` + Electron + Android WebView 各跑一次 512 样本窗推理；量 CPU/延迟；安卓是最大风险 |
| 2 | **Smart Turn v3.2 ONNX 能否在浏览器跑（体积/速度/是否需量化）** | 决定 P9 做不做；模型不在仓库里，要自己取（N.E.K.O. 用 `scripts/prepare_voice_turn_assets.py` 下载） | 取模型 → onnxruntime-web 推理一次 → 记录体积与单次耗时 |
| 3 | **麦克风在 Android WebView 的可用性** | 决定手机端是"可用"还是"降级为按键说话" | 真机测 `getUserMedia` + `echoCancellation` + Web Speech API |
| 4 | **`/devtools` 类前置：Electron 侧 `desktopCapturer` 与前台窗口读取在你的 `ryza://app/` 自定义协议下是否可用** | 决定 P10 的 `vision.js` 与"前台应用"感知 | 在 `desktop/main.js` 里最小验证 |

### 8.1 这四个 spike 的第一个已经做完了（2026-09-18，实测数字，别再重复调研）

**① `onnxruntime-web` 跑 Silero VAD v6.2.1 —— 结论：可行，但桌面壳今天会失败。**

| 宿主 | 结果 | 证据 |
|---|---|---|
| 浏览器（`scripts/serve.py`） | **今天就能跑，零改动** | Chromium 130 / Edge 153 各跑 24 次推理；Python 的 `mimetypes` 把 `.wasm`→`application/wasm`、`.mjs`→`text/javascript` |
| Electron `ryza://app/` | **先补两个 MIME 项才能跑** | 用 `desktop/main.js` 原样的 MIME 表 → **hard fail**（`.mjs` 被当 octet-stream，Chromium 的模块 MIME 检查直接拒）；补 `.mjs`+`.wasm` 后与 HTTP 宿主完全一致 |
| Android WebView | **条件可行，未验证** | 三条前置见下 |

实测数字：ORT **onnxruntime-web 1.22.0**（MIT，wasm-only IIFE）、Silero 模型 **2,327,524 B**、
建会话 199–210 ms、**每次推理（`[1,576]`，24 次）min 0.20 / median 0.40 / max 1.6 ms**
（512/16000 = 32 ms 一窗的预算下远远够用）。**用的是 wasm EP**，且因为全仓没有
COOP/COEP，永远 `crossOriginIsolated=false`、无 `SharedArrayBuffer`，ORT 只能单线程
（这正是实测通过的那种模式）。

三个坑（都实测过）：
* Silero 的 I/O 名与 N.E.K.O. manifest 里写的不一样：输入 `input/state/sr`、输出 `output/stateN`
  （N.E.K.O. 自己也是按下标取的，照做）。
* **合成音频不能当正样本**：合成的"像语音"帧只有第一窗冒到 0.47–0.57、随后掉回 0.004；
  真实语音 243 窗 median **0.99997**、静音 0.008。冒烟测试必须喂真音频，否则等于没测。
* `wasmPaths` 留空即可（ORT 从 `document.currentScript.src` 推）；**相对路径 `vendor/` 会失败**
  （被解析成 `/vendor/vendor/...`），用绝对路径或留空。

**② Smart Turn v3.2 —— 可取得、数值正常，但优先级低于 VAD。**
HuggingFace `pipecat-ai/smart-turn-v3`（rev `f766f81`，**8,679,182 B**，SHA-256 与 N.E.K.O.
的 pin 一致，BSD-2-Clause）。单线程推理 **median 151 ms**（N.E.K.O. 原生目标 ≤30 ms，约 5×），
每次候选停顿只跑一次，可接受。输出名是 `logits` 但值已在 [0,1]，下标 0 即概率。
**必须有真的 Whisper log-mel 特征**：我的朴素 DFT 移植用真特征得 说话 0.242 / 静音 0.987（合理），
而造零/随机特征都得 ~0.98 ⇒ **没有特征提取器就没法测**。

**安卓的三条前置（缺一即失败，都没法在无真机时确认）**：`AssetServer` 的 MIME 表要有
`.mjs`/`.wasm`（**已在 S10a 补上并纳入守卫检查 F**）；三个资产（ort 的 mjs+wasm 11.2 MB、
Silero 2.3 MB、Smart Turn 8.7 MB，共约 22 MB）要打进 APK；**WebView 必须支持 WebAssembly SIMD
（Chromium ≥ 91）**——ORT 1.22 只发 SIMD 版 wasm，这一条是唯一的"可能翻成不行"的因素。

许可证：Silero VAD v6.2.1 **MIT**（SHA-256 `1a153a22…8788e3`，与 npm `@ricky0123/vad-web@0.0.31`
的 `silero_vad_v6.onnx` 逐字节相同）、Smart Turn v3.2 **BSD-2-Clause**、onnxruntime-web **MIT**、
vad-web **ISC**。provenance 在 `temp/vad-spike/ARTIFACTS.txt`（temp/ 可清理，要复现按此 URL 重抓）。

另外两条**已在本次核实、无需再验**：你的 203 个骨架全是 Spine 4.2.43（读文件头确认）；airi 的 `pipelines-audio` / `provider-inference` 确为 Vue-free（上游抽取规格为证）。

---

## 9. 许可与归属（照抄代码前必读）

| 来源 | 许可 | 可否抄代码 | 义务 |
|---|---|---|---|
| airi | MIT | ✅ | 带版权与许可全文。注意 **Spine 运行时不在 MIT 内**（Spine Runtimes License，需自持 Spine Editor 许可——这是你既有义务） |
| N.E.K.O. | **Apache-2.0** | ✅ | 带 NOTICE 与变更说明。模型：Silero v6.2.1 **MIT**、Smart Turn v3.2 **BSD-2-Clause**、CampPlus **Apache-2.0**；**ONNX 权重不在仓库里，需自行下载**（对你有利） |
| AgentAtelierR | 作者已确认有许可（用户 2026-09-18 与群主确认；**仓库内没有 LICENSE 文件**，所以下游读者无法从仓库自行得知授权范围） | 本轮未抄代码 | 若日后要抄，先在仓库里补一份许可声明，别只靠聊天记录 |
| 官方 APK 素材 | 不属于你 | ❌ 不可分发 | 既有边界不变 |
| airi 的 Live2D/VRM 预设模型 | 仓库内无许可文本（模型 zip 被 gitignore） | ❌ | 不碰 |
| `unspeech` | SDK MIT / **服务端 AGPL-3.0** | ⚠️ | **不用**（你有自己的 `/_proxy`） |
| `model-bank` | npm 上 `license: null` | ❌ | 抄 airi 描述符时剥掉 |

新增第三方文件建议统一放 `web/vendor/<name>/` 并在 `docs/third_party/` 留声明——与你现有 `web/vendor/spine-webgl.js` 的做法一致。

---

## 10. 明确不做

- ❌ 把客户端重写进 airi/Vue（丢官方 UI 保真 + 丢"安装包与源码逐文件哈希一致"）。
- ❌ 用 airi 的 `stage-ui-spine` 替换 `avatar.js`（它是单角色展示器：单骨架、背景是静态贴图、无骨骼钩子、无热区、**Spine 连口型都没有**）。
- ❌ 引入 N.E.K.O. 的 Python 后端 / 三进程模型 / ZMQ 插件（你是纯前端 + `/_proxy`）。
- ❌ 抄 AgentAtelierR 的代码（无许可）。
- ❌ airi 的扩展 iframe 路线（扩展 iframe 原点是 `127.0.0.1:<随机端口>`，端口每次启动都变 ⇒ localStorage 不跨重启，而你的存档全在那里）。
- ❌ 为了语音去引入打包器（`vad-web` 官方支持 `<script>` + `onnxWASMBasePath`/`baseAssetPath` 免打包用法）。
- ❌ 在没通过 §8 spike 前，把 P9（语义端点）排进计划。

---

## 11. 实施进度（goal 模式，2026-09-18）

> ⚠️ 本节是 **2026-09-18 的进度快照**，不是当前状态。之后几轮把表里的“未完”
> 又做掉了多项（见 `docs/HANDOFF.md`：S10b 本地皮肤导入、S9 相机缩放/译文/重播+收藏、
> S6 后半以外的设置层拆分，以及 1.2.19–1.2.22 的 issue 轮）。**当前测试数量、
> 提交号与未完成项一律以 `docs/HANDOFF.md` 顶部那节为准。**

按 §7 的顺序推进，每个阶段都跑全套回归 + 守卫 + 隐私/版本检查，全绿才提交。

| 阶段 | 提交 | 内容 | 验收 |
|---|---|---|---|
| **P0** | `09012ce` | `config/layers.json` 边界声明 + `scripts/layering_check.js`（五项检查，报告模式） | 实测基线：越层 11、未声明硬环 0、core 触达 4、三端契约 0、版本字面量 3 |
| **S1** | `bff8303` `76c76f7` | 全部向上引用改**注入**（quests/daily/world/alarm）；`i18n` 去 DOM（`App.applyI18n`）；`Quests.setGenerator` 断掉 `game→quests→api→world→game` 环；`Memory.setLLM` 断掉 `api↔memory`；时段表收口到 `Util`；UA 版本字面量纳入 `stamp_version.js --check` | 守卫转 `--strict`：**五项全 0**；枢纽环 12→1；6 套回归 + privacy 全绿 |
| **S2** | `4890174` | `turn.js`（意图模型：priority + queue/interrupt/replace，cancelIntent/interrupt/stopAll，两端队列走同一个 `promote()`）；`api.js` 回复**代际令牌** + 在飞 XHR 中止（修 AUDIT 11.4-3）；`App.playSpeech` 带 signal；新增 `scripts/voice_regression.js` | 28 断言；7 套回归全绿。**回归抓到 turn.js 一个真 bug**：`interrupt` 取消当前意图却不推进队列 |
| **S3** | `ff48132` | `providers.js` 提供商注册表 + 凭据单点解析（杀 AUDIT 6.9 那类"切端点串凭据"）；**VOICEVOX / AivisSpeech 本地日语引擎**（一份实现两行注册）；select 与表单由注册表生成 | 断言 +10（含"切 provider 不带旧 key/baseUrl"） |
| **S4** | `b054fe9` | `echo.js`（文本回声抑制，参数取自 N.E.K.O.：回看 20 s / 1200 字符 / ≥0.88 / LCS 比值）+ `voice.js`（麦克风、Web Speech、半双工门、识别器反复中断则放弃）+ 麦克风 UI（用源包自带 `voicetoggle.svg`）+ 设置开关 | 断言 +15；**测试桩写错一次**（Web Speech 的 `results[i][0].transcript` 结构），代码无问题 |
| **S5** | `eaf837b` | **onset 打断**：用识别器自带 `onspeechstart`（真 onset，无需 VAD 模型）；确认窗口 240 ms、首句保护 700 ms、咳嗽/中途结束丢弃；**默认关闭**并把风险写进设置页可见文案 | 断言 +6，共 62 条 |
| **S6a** | `0daec22` | 拆 `settings.js`：表单装配 ~630 行搬出，App 留同名薄委托；通用字段原语（`_field`/`_select`/`_switch`/`_range`/`_title`）留在 app.js（闹钟表单与记忆编辑器也在用） | app.js **2813 → 2194 行**；`boot_smoke` 抓出隐藏依赖 `TEXT_SPEEDS` → 改为 `Config.TEXT_SPEEDS`（数据归 core） |
| **S7** | `ebc2bf1` | `npc.js`：多说话人协议（`角色[ID]：`/`莱莎：`/`旁白：`，**无前缀仍是一段莱莎台词**）+ 候选打分（同舞台 > 同 field > 同 area，各 × base pct，再按 resolveOrder）+ 提示词块（含"不许创作未给出的设定"）+ 4 档互动频率；渲染按"说话人节拍"，**只有她的台词进 TTS/表情** | 断言 +18，共 **80** 条 |
| **打包** | `d7eb5eb` | 版本 **1.2.16**（code 19）经单一来源盖章（含三端 UA）；出 `RyzaChat-Setup-1.2.16.exe`（646 MB）与 `RyzaChat-1.2.16.apk`（563 MB / 3667 成员） | 两包双闸门隐私检查通过；**逐成员核对**包内确实含 6 个新模块 |
| **S11a** | (本轮) | **真正的语音输入**：`stt.js` 麦克风采集（getUserMedia 带上 echoCancellation/noiseSuppression/autoGainControl —— 文档声称过、代码从未申请）+ 能量门（N.E.K.O. 的 bootstrap_onset 0.35 / min_onset 0.20 / max_onset 0.65 / baseline_alpha 0.05、最短语音 200 ms、候选静音 300 ms、pre-roll 700 ms）+ 自己写 WAV（webm 分块不可裁剪）→ 注入的传输端口 → `api.js` 的 `Api.transcribe` 走 `/_proxy` 的 multipart `/audio/transcriptions`；`providers.js` 加 stt 行；`voice.js` 变成一个闸门两个引擎（浏览器识别器 / 自采+转写），识别器报 network 时**自动切到采集**（Electron 实测：构造器在、`start()` 成功、onset 触发，然后 network）；安卓补 RECORD_AUDIO + onPermissionRequest | 新增 `scripts/stt_regression.js`（54 断言，含反向对照）；12 项检查全绿 |
| **R1** | `56016c7` | **复核轮**（先读代码再信文档）：守卫补上"限定全局/别名"引用形状 → 露出并修掉 2 处真越层；语音链 5 处行为与文档不符；boot 装配移出异步链；NPC 提示词与解析器口径统一；语言/物品/情绪/语速/思考强度各自收口到单一权威 | 断言 80 → **100**，**每条新断言都做了反向对照**（把旧行为改回去必须失败）；11 项检查全绿 |

### R1 复核轮（2026-09-18 第二轮）——文档没错的地方之外，有九处是错的

上一轮的文档说"11 项全绿、边界机器强制"，我先复跑（确实全绿），然后**读代码**而不是读结论。查出九处真实缺陷：

**① 守卫看不见这些漏引用的写法（最该修的一处）。** `\bAvatar\s*\.` 匹配不到 `var av = window.Avatar;`（后面没有点），于是 `nsfw`(core)→`avatar`(render)、`api`(io)→读 `Avatar._emotion/_attitude` 两条真越层**在 `--strict` 报 0 的情况下存在**。守卫现在识别 `window./global./globalThis./self.X`（赋值目标除外），一开就精确报出这两条、无其他误报；两处都改成注入端口（`Nsfw.setSink`、`Api.setScreenState` + `Avatar.screenState`）。守卫还带了**自检**：把模式改窄会立刻 FAIL（已用反向对照验过）。

**② 语音链五处"文档说做了、代码没做"。**
- `echo.js` 接进了麦克风，但**没有任何地方调用 `remember()`** ⇒ 文本回声过滤只能回答"不是"。现在由 `Voice.noteAssistantSpeech()` 收口，从合成端（唯一漏斗）喂入；回归也改成经 `Voice` 驱动，而不是自己调 `Echo.remember`（旧写法只能证明 echo.js 自身对，证明不了生产在用）。
- `Turn.interrupt` **不推进代际令牌**，于是"她想的时候打断"只停了声音、请求还在飞，回复照旧落地。文档写明它是唯一打断出口，现在才是。
- `App.say` 的 `.catch` **先改状态再判 stale** ⇒ 被作废的回复会把 `App.speaking`/Turn/发送键复位，谎称新一轮已结束；已把判断提到最前，并让被顶掉的回复不再开口。
- `playSpeech` 只在 `ended`/abort 结算：**加载失败（`error`）或 `play()` 被拒**时 Turn 永远停在 SPEAKING，而 `Voice` 用 `isSpeaking()` 当麦克风闸门 ⇒ **麦克风永久变聋**。两条路径都已结算。
- 打断会把 800 ms 冷却重新武装 ⇒ **吞掉导致打断的那句话**；麦克风关掉时待触发的打断计时器也没取消。

**③ boot 装配离"无声消失"只差一次抛错。** 所有端口原在 assets 加载链的 `.then` 里，外面那个 `.catch` 把任何错误一律报成"素材索引加载失败"；而 `boot_smoke` 的 Avatar 桩**少了 `setNotice`**，链在那一行就断了，**其后每个端口（memory/quests/daily/turn/voice）都没接上，套件却报 ALL PASS**。现在端口搬到 `App._wirePorts()`（纯闭包，同步于任何异步之前），catch 记录 `App._bootError`，`boot_smoke` 断言它为 null，`fx.js` 不再因为一个脱离文档的 canvas 把整条 boot 拖死，桩也补全了公开面。

**④ 提示词与解析器对"谁在说话"口径相反。** `npc.js` 的提示词承诺"无前缀的行是莱莎的"，解析器却是"接着上一位说"：NPC 说完后她那句被挂到 NPC 名下，且 `spokenText` 只留 `ryza` ⇒ **她的回答既没被朗读、还被标成别人的名字**。解析器改为与提示词一致，提示词同时要求"每一行都要写话者（多行台词的续行也要重写）"。
另外：语言映射一处多主（`voice.js` 私表缺 `hi`/`id`/`pt-br` ⇒ 七种 UI 语言里三种在用日语识别）→ 收口到 `Langs.sttTag`；`Api.chat` 新增 `standalone`（动态任务文案与"测试 LLM"按钮原本会分配代际令牌、**打断玩家自己的回复**，而 STALE 处理会静默丢弃 ⇒ 消息凭空消失）。

**⑤ 单一权威收口（都是"同一张表/同一段判断写了不止一遍"）。** 情绪/态度词表原本 `api.js` 与 `avatar.js` 各一份（io 与 render 不能互相 import ⇒ 放 core `Util`，加同一性断言）；`itemName/itemValue` 在 `game/quests/daily/app` 有 4~5 份，其中 **app.js 的背包列表漏了本地化**（同一物品在任务里是译名、在背包里是日文原名）；`|| 28` 语速兜底 4 处在表里根本没有 28 这个档（收口 `Config.textSpeed()`）；思考强度选项与校验在 `settings.js` 又写了一遍（收口 `Api.EFFORT_UI`，并断言每个档都有 i18n 标签）；语言选择器列表与 `LANG_NAMES` 已分叉（`Indonesia` vs `Bahasa Indonesia`，收口为从 `Langs.ALL` + `LANG_NAMES` 派生）。

**为什么这些值得先做而不是先上 S8**：其中三处是"功能根本没在工作"（回声过滤、莱莎台词被标错人、背包不本地化）和一处死锁（音频出错 ⇒ 麦克风永久变聋），比再加一个功能更值；而且边界守卫的盲点不补上，后面每加一个模块都会继续漏。


### 当前实测数字（交接基线）

- **11 项检查全绿**：`boot_smoke`（51 断言，含 boot 半途死与端口接线）/ `game_logic_regression` / `memory_regression` / `expression_coverage` / `nsfw_intent_regression` / `electron_storage_regression` / **`voice_regression`（100 断言）** / `motion_regression`（18 条 OK）/ `layering_check --strict` / `privacy_check.py web` / `stamp_version.js --check`
- `layering_check --strict`：越层 0、未声明硬环 0、core 未声明触达 0、三端契约 0、版本字面量 0；**枢纽环 2**（`app↔onboarding`、`app↔settings`）
- 新增模块（均已声明在 `config/layers.json`）：`turn.js` `providers.js` `echo.js` `voice.js` `npc.js` `settings.js`。`App` 不再是唯一枢纽
- 工作区干净，最新提交 `56016c7`（R1 复核轮）；**改动前还原点 `pre-unification-20260918` @ `fbac9d2`**
- **R1 之后的写法约定（新增，改代码时请沿用）**：
  1. 跨层引用一律**注入端口**，不许用 `window.X`/`global.X` 取别名绕过——守卫现在会看见（`Nsfw.setSink`、`Api.setScreenState`、`Voice.noteAssistantSpeech` 是三个例子）。
  2. 端口接线放 `App._wirePorts()`，**不许再放进 assets 加载链**；boot 链的抛错会记到 `App._bootError`，`boot_smoke` 断言它为空。
  3. 一个概念一个权威：情绪/态度词表 = `Util`；物品名/价值 = `Game.itemName/itemValue`；语速档 = `Config.textSpeed()`；思考强度档 = `Api.EFFORT_UI`；UI 语言列表 = `Langs.ALL` + `LANG_NAMES`；识别器 BCP-47 = `Langs.sttTag`。
  4. 新回归断言必须做**反向对照**（把旧行为改回去，断言必须失败）——否则不知道它是否真的在测东西。R1 的每条新断言都验过。

### 未完（按优先级）

| 阶段 | 内容 | 前置/风险 |
|---|---|---|
| **S6 后半** | 提示词卡 / 世界书 ×5 槽（**功能，不是拆分**） | 参考 AgentAtelierR 的分槽与导入导出；落到 settings.js |
| **S11b** | 按 spike 结果上 Silero VAD：把 `ort.wasm.min.js` + `ort-wasm-simd-threaded.mjs/.wasm` + `silero_vad.onnx` 放进 `web/vendor/ort/` 与 `web/models/`（MIT/ISC，带许可声明），`vad.js` 取代 `stt.js` 里的能量门 | 桌面与浏览器已实测可行（MIME 已在 S10a 补好）；安卓待真机确认 SIMD。**这一步才会把断句从能量门升级成模型**，`endpoint.js`(Smart Turn) 再往后 |
| **S10b** | 本地皮肤导入：先做贴图页替换（PNG 尺寸必须与 atlas 页完全相同；机制已就绪——`skinsIndex[].variants` 是现成的注册点，`setAtlasVariant` 已经会用它），整套 ZIP 导入按 AgentAtelierR 的校验规则（≤64 MB / ≤64 条目 / 禁 `..` 与符号链接 / 单页 atlas / 骨架必须 Spine 4.2 / 必须含 `motion_A_001_idle`） | 持久化要想清楚：贴图页是 MB 级 PNG，localStorage 会吃紧，可能要引入 IndexedDB（目前全项目只用 localStorage） |
| **S8** | `proactive.js` + `state_read.js`（只读门面） | 抄 airi 的 spark 骨架（2 s tick / 60 s 窗口 / 30 s×3 重排 / priority high + interrupt），触发器换成世界状态（体力/任务到期/时段/NPC 在场/每日登录/闹钟）；**只读，不写状态**（`applyDelta` 仍是唯一写入口） |
| **S9** | 前端增量：旁白/译文/主题/附件/建议回复/继续撤回重播/相机缩放 | 每项独立，逐项截图走查；相机缩放必须"在钳制窗口内"，否则撞 AUDIT §9/§11.6 的构图约束 |
| ~~**S10 闹钟**~~ | **已完成**（`4fd4de8`）：原生 `AlarmManager`/全屏 intent/开机重排/5 分钟贪睡/精确闹钟权限回退 + 网页侧接线（原生成为唯一触发权威、每次改动下推、前台点火钩子）；MIME 一致性进守卫（检查 F） | 无真机 ⇒ 锁屏响铃/开机重排/权限回退属**仅代码审查**，未在硬件验证 |
| **NPC 人设** | 每位 NPC 一句话人设 | 包内只有 `name` + `note`；完整设定在官方服务器、不在 APK → **不许编**。（轻量协议已经能用，这一步是可选增强） |

**仍未做的 spike（不许猜着做）**：① `onnxruntime-web` 跑 Silero VAD 在三宿主（安卓 WebView 风险最高）；② Smart Turn v3.2 模型体积/单次耗时；③ 安卓 WebView 的 `getUserMedia` 与回声消除；④ Electron `desktopCapturer` / 前台窗口在 `ryza://app/` 协议下是否可用。S5 因此改用识别器自带的 onset 事件——它是真 onset，且不需要这些 spike。

### R1 已确认但**故意没做**的（下次别当未知项重复调研）

| 项 | 现状（已核实） | 为什么留着 |
|---|---|---|
| 打断不中止**在飞的 TTS/翻译请求** | `turn.js` 的 signal 传给了 synth 端口，但 `app.js` 的端口实现忽略它；`Api.speak/translate` 没有 signal 参数 | 只是浪费一次请求（blob 到手会被丢弃），不影响正确性；要改得把 signal 串进 `Api.speak`/`translate` 的传输层，属独立一刀。**已把 turn.js 里那句夸大的注释改成实话** |
| `Api._inflight` 是单槽 | 两次同代际的 `chat` 只有后一次会被 abort 掉；正确性仍由 `isStale` 保 | 需要按代际存集合，等真的有并发聊天需求再改 |
| 回声过滤最短 6 字符 | 日语「うん」「はい」这类短句不进回声检查 | **这是 N.E.K.O. 的实测参数**（归一化后 <6 字符不判），改了会误伤正常短句；属于参数取舍不是 bug |
| 识别器 `onend` 复用可能双启 | 关掉再打开时，迟到的 `onend` 可能触发第二次 `start()`（真机会 `InvalidStateError`，随后被吞成"关麦"） | 要真机（三宿主）复现才好定改法；属 spike 范围 |
| 三端 `/_proxy` 行为仍有差异 | desktop 的 GET 超时 180 s（另两端 120 s）；desktop 会把 `HEAD/OPTIONS/PUT` 原样转发（另两端本地应答或 405）；只有 Android 每次响应都带 `ACAO:*` | 守卫只查"路由标记齐全"。差异都在边缘（XHR 必带 Content-Length、GET 音频不会跑 180 s），但**要同步就该按 desktop 为准收一遍** |
| 默认 TTS 模型 id 三处重复 | `config.DEFAULTS` / `providers.js` / `api.js` 的兜底 | 清空模型名时会拿到 api.js 的兜底值，改默认值要动三处 |
| `util.js` 里时段有两个表 | `TOD_START`（代表小时 6/12/17/21）与 `hourToTod` 的边界（5/11/17/20）相差一小时，同文件但两套数 | 语义不同（代表采样点 vs 边界）却都叫"start"，容易改错；应在同一处派生 |
| 零散死代码 | `.field-row` CSS 无人使用；`app.fullscreen` 写了不读；`Api.screenTagLine/detectThinkingStyle/QWEN_DEFAULT_BASE` 无外部消费者；Android `MainActivity` 的 `8765` 写了两遍 | 都不影响行为；清理时注意 `_localProxy`/`setSummarizer` 是**测试接缝**，不是死代码 |


---

## 12. 交接须知（给下一个 agent）

### 先读什么

1. `projects/ryza-ai-revive/AGENTS.md` + `structure.md`（本工作区规范，输出位置约束）
2. 本文件 §0–§11（三家长处怎么取舍、目标架构、交互设计）
3. 项目内 `docs/HANDOFF.md`（**本地维护稿，gitignored**：完整现状 + 那份很长的「不要退回去」清单 + 测试/打包命令）
4. 项目内 `docs/AUDIT.md`（**同样 gitignored**：历史决策与证据；冲突时以 `web/assets/` 原始 JSON + 真机实测为准）
5. 两份调研报告：`reports/airi-vs-ryza-ai-revive-assessment.md`、`reports/ryza-vs-agentatelierr-feature-gap.md`

> ⚠️ `docs/AUDIT.md`、`docs/HANDOFF.md`、`docs/PROJECT.internal.md`、`docs/reference/*` 在 ryza 仓库里是 **gitignored 的本地稿**——只在本机存在，不会被 clone 带走。改动前先读它们。

### 本工作确立的约定（改代码时请沿用）

1. **跨模块只经注入的端口，不向上调用**。已建立的端口名：`Avatar.setNotice/setVoiceSource`、`Avatar.screenState/currentEmotion/currentAttitude`（读）、`Memory.setLLM/setSummarizer`、`Quests.setCelebrate/setPresenter/setGenerator/setNotice/setNavigator`、`Daily.setCelebrate/setPresenter`、`World.setNotice`、`Alarm.setEditor`、`Turn.setSynth/setPlayer/setTurnCanceller`、`Voice.setSink/setSpeaker/setNotice/setLang/setEcho/setBargeIn`、**`Nsfw.setSink`**（变体名 → `Avatar.setAtlasVariant`）、**`Api.setScreenState`**（宿主提供屏上表情/态度）。默认惰性，所以每个模块都能在 headless 回归里单独加载。
   - **别用 `window.X` / `global.X` 取别名来绕层**：守卫的引用检测现在读这种形状（赋值目标除外），一绕就违规。
   - **端口接线在 `App._wirePorts()`，同步于任何异步之前**。别放回 assets 加载链——那里一抛错，后面的端口全都不接而界面看着还活着（R1 抓到的就是这一例）。
2. **一个关注点只有一个权威**："谁在说话"= `turn.js`；"回复是否还有效" = `api.js` 的代际令牌（`Turn.interrupt` 与 `beginTurn` 都推进它）；"时段分带" = `Util`；"哪个 provider 用哪套凭据" = `providers.js`；"情绪/态度词表" = `Util.EMOTIONS/ATTITUDES`；"物品名与价值" = `Game.itemName/itemValue`；"语速档" = `Config.textSpeed()`；"思考强度档" = `Api.EFFORT_UI`；"UI 语言列表" = `Langs.ALL` + `LANG_NAMES`；"识别器 BCP-47" = `Langs.sttTag`。别在调用方重新判断一遍。
3. **侧路请求要声明 `standalone: true`**（动态任务文案、设置页"测试 LLM"）。不声明就分配代际令牌 ⇒ 会打断玩家自己的回复，而 STALE 是静默丢弃，消息会凭空消失。
3. **core 层不碰 DOM/网络**（`config` 的 dev 水合与 `world` 的同源数据表是 `layers.json` 里**已声明**的例外）。`quests`/`world`/`daily` 例外地自带 view 段（`ownsView`），但仍不许向上引用。
4. **不要引入打包器**。第三方库走 `web/vendor/` 的预构建产物（如 `spine-webgl.js`），新模块用 `index.html` 的 `<script>` 顺序加载；`settings.js` 必须在 `app.js` **之前**。
5. **每阶段：全绿才提交**。改了 `avatar.js`/注视相关必跑 `motion_regression`；改了 `app.js`/模块加载必跑 `boot_smoke`；改了语音/回合必跑 `voice_regression`；任何改动都跑 `layering_check --strict`。别把"报告模式"当借口——它已经是守卫。
6. **不许猜**。数据不确定就回 `web/assets/` 原始文件核；行为不确定就写最小验证跑一遍。本轮已有三次"先验再改"的例子（`onnxruntime` 那条被主动放弃改用识别器 onset；`MIN_SCORE` 量纲问题；`TEXT_SPEEDS` 隐藏依赖）。

### 常用命令

```powershell
# 开发
cd projects/ryza-ai-revive
python scripts/serve.py                 # 浏览器 http://127.0.0.1:8765/
cd desktop; npx electron .              # 桌面（首次需 npm install）

# 全套验证（改完必须全绿）
node scripts/boot_smoke.js
node scripts/game_logic_regression.js
node scripts/memory_regression.js
node scripts/expression_coverage.js
node scripts/nsfw_intent_regression.js
node scripts/electron_storage_regression.js
node scripts/voice_regression.js
node scripts/stt_regression.js         # 语音输入：能量门/端点/WAV/multipart/引擎切换
node scripts/motion_regression.js
node scripts/layering_check.js --strict
python scripts/privacy_check.py web
node scripts/stamp_version.js --check

# 打包（版本单一来源：先改 config/version.json，再 stamp 会同步 package.json / build.gradle / 三端 UA）
powershell -File scripts/build_desktop.ps1     # → output/desktop/RyzaChat-Setup-<ver>.exe
powershell -File scripts/build_apk.ps1         # → output/android/RyzaChat-<ver>.apk
# Android 工具链路径：config/android-tools.local.txt（本机自行填写，含 jdk17 + android-34 + build-tools 34；该文件不入库）
```

### 三个已知的坑

1. **`git commit -m "…"` 里有反引号会被 shell 当命令替换**，提交信息会被吃掉（本轮发生过一次，用 `git commit -F -` + heredoc 修的）。同理，**Python 经 stdin heredoc 处理中文会因编码出问题**，中英混排的脚本改动请用编辑器工具而不是 `python - <<PY`。
2. **测试桩写错比代码错更难查**。本轮两次失败（Web Speech 的 `results[i][0].transcript` 结构、标签行必须在第一行）都是测试错、代码对——遇到失败先确认是桩还是实现。**反向对照**：改完断言要把旧行为改回去跑一次，确认它真的会失败（R1 的每条新断言都做了）。桩还有一个反向风险：桩**少了方法**会让真实代码在某一行抛错并被吞掉（R1 发现 `boot_smoke` 的 Avatar 桩少 `setNotice`，其后所有端口都没接上却报 ALL PASS）。
3. **`voice_regression.js` 有看门狗**：永不 settle 的 promise 会让 node 排空事件循环并以 0 退出（看着像通过）。别删那个 watchdog。
4. **`/tmp` 在 Git Bash 与 Python 里不是同一个地方**（Python 看到的是盘符根的 `\tmp`）：跨这两个工具做"备份→改→还原"的脚本，路径要用仓库内目录（如 `temp/`），否则还原会失败并把改动留在树里。

---

## 13. 参考项目与上游文件路径（索引）

> **权威来源是 URL**。本地副本（下面「本地留存」）按项目规范属于 `temp/`，**可随时清理，不要让后续工作依赖它们**。

### 13.1 三个参考项目

| 项目 | URL | 许可 | 我们用到的是哪一层 |
|---|---|---|---|
| **airi** | https://github.com/moeru-ai/airi | MIT（`Copyright (c) 2024-PRESENT Neko Ayaka`） | **范式与描述符**：provider 注册表、意图/播放语义、TTS 分句、spark 主动性。UI/舞台/Spine 层**不用** |
| **N.E.K.O.** | https://github.com/Project-N-E-K-O/N.E.K.O | Apache-2.0（`Copyright 2025-2026 Project N.E.K.O. Team`） | **判定逻辑与参数**：三阶段断句、onset 打断、代际令牌、文本回声抑制、回合状态机、CI 强制分层 |
| **AgentAtelierR**（"别人的莱莎"） | https://github.com/onion-aqua/AgentAtelierR | 仓库内**无 LICENSE 文件**；作者已确认有许可（用户与群主确认） | **只有"做法"**（Dart，与你的 JS 不同构）：NPC 多说话人协议与频率分档、本地皮肤导入的校验规则、原生闹钟、提示词卡槽 |

### 13.2 上游具体文件（要照抄/对照时看这些）

**airi**
| 路径 | 内容 |
|---|---|
| `packages/pipelines-audio/src/speech-pipeline.ts` | 意图模型本体：`IntentBehavior = 'queue'\|'interrupt'\|'replace'`、`openIntent/cancelIntent/interrupt/stopAll`、`ttsMaxConcurrent`（默认 4）→ `turn.js` 的语义来源 |
| `packages/pipelines-audio/src/managers/playback-manager.ts` | 每次播放一个 `AbortController`、`stopByIntent/stopByOwner/stopAll`、`maxVoices`（默认 1）→ `Turn` 的取消出口 |
| `packages/pipelines-audio/src/processors/tts-chunker.ts` | 长回复按标点分句（**还没做，属于剩余项**） |
| `packages/provider-inference/src/providers/{cloud,local}/*` | 17 个 TTS / 5 个 STT 描述符；`local/voicevox/` 用假 `fetch` 调 `/audio_query` + `/synthesis` → `providers.js` 的本地引擎实现来源 |
| `packages/provider-inference/docs/provider-inference-extraction-phase-1-spec.md` | 上游自己写的抽取规格：**禁止** `vue`/`pinia`/`localStorage`/`indexedDB` 进入 provider 层（"可移植"是它的设计目标，不是我们的推断） |
| `packages/stage-ui-spine/src/**` | **反面参考**：单骨架、背景是静态贴图、无 `getBone`/`BoundingBox`/`hitTest`、Spine 无口型驱动 |
| `packages/plugin-sdk/**`、`apps/stage-tamagotchi/src/main/services/airi/plugins/**` | 扩展宿主（`extension.airi.json` v2、iframe widget、**资产原点 `127.0.0.1:<随机端口>`**）——这是"把 ryza 挂成 airi 扩展"被否掉的直接证据 |
| `packages/server-sdk/README.md`、`packages/plugin-protocol/src/types/events.ts` | WS 协议（`input:text` / `output:gen-ai:chat:message`；**没有 TTS 音频、没有角色卡、没有记忆事件**） |
| `packages/stage-ui/src/stores/character/{orchestrator/store.ts,notebook.ts}` | spark 主动性（2 s tick / 60 s 到期窗口 / 30 s×3 重排 / `priority:'high'` + `behavior:'interrupt'`）→ **S8 要抄的骨架** |

**N.E.K.O.（Apache-2.0，抄代码需带 NOTICE）**
| 路径 | 内容 |
|---|---|
| `main_logic/core/_shared.py`（`_looks_like_recent_ai_echo`，约 50 行） | 文本回声抑制：回看 **20 s / 1200 字符**、归一化后 `<6` 字符不判、`SequenceMatcher.ratio() >= 0.88` → **`echo.js` 的来源**（我们用 LCS 比值保持 0.88 的含义） |
| `main_logic/asr_client/endpointing/{config.py,silero_vad.py,coordinator.py,throttle_policy.py}` | 三阶段断句全部实测参数：Silero 512 样本窗 @16 kHz、onset **0.5**、offset **0.35**、最短语音 **200 ms**、候选静音 **300 ms**；Smart Turn v3.2 阈值 0.5、最长 8 s、确认 1.0 s；节流 `bootstrap_onset 0.35` / `min_onset 0.20` / `max_onset 0.65` / `baseline_alpha 0.05` → **P9 语义端点要用的参数（尚未做，需先 spike）** |
| `main_logic/asr_client/lifecycle.py` | `pre_roll_ms 700` / `confirm_speech_ms 240` / `candidate_pause_ms 320` / `trailing_audio_ms 400` → `voice.js` 的 `BARGE_CONFIRM_MS=240` 来源 |
| `main_logic/omni_offline_client/_lifecycle.py` + `_streaming.py` | **协作式代际令牌**（`_response_generation` + 流式循环里查是否还有效，不用 AbortController）→ `Api.newTurn/isStale` 的来源 |
| `main_logic/session_state.py` | `TurnOwner{NONE,USER,PROACTIVE}` + `ProactivePhase` + **用户输入在任何主动阶段 sticky preempt** → S8 状态机来源 |
| `main_logic/voice_input/suppression.py` | 抑制租约带 TTL（`default 30 s` / `hard 60 s`）→ 防"禁麦后忘了恢复" |
| `static/app/app-audio-capture.js` | `echoCancellation:true` 约束；Focus 模式下才 `focus_suppressed`（说明"说话时禁麦"只是可选） |
| `static/app/app-audio-playback.js` + `static/app/app-websocket.js` | 按 `speech_id` 清播放队列、`scheduleAheadTime = 5`（**预排 5 秒 ⇒ 只取消生成不够**）、`USER_ACTIVITY_CANCEL_GRACE_MS = 700` → **将来做流式分块 TTS 时必须一起做** |
| `docs/design/smart-turn-v3-provider-neutral.md` | 端点判定的设计文档（VAD 只发语音活动事件，从不提交回合） |
| `scripts/check_module_layering.py` + `scripts/check_core_contracts.py` | **CI 强制分层与 core 契约** → `scripts/layering_check.js` 的做法来源 |

**AgentAtelierR（做法参考；仓库无 LICENSE 文件）**
| 路径 | 内容 |
|---|---|
| `lib/src/character_catalog.dart` | NPC 候选打分（精确 `stageId` = pct×100 / 同 field ×50 / 同 area ×25，阈值 0.05，按 `resolveOrder`，取前 6）+ `buildEncounterPrompt`（"每轮最多 1–2 位"、"不因提及就假定在场"）→ **`npc.js` 的打分来源** |
| `lib/src/chat_segments.dart` | 说话人解析正则（`旁白|莱莎|译文|narrator|ryza|translation|角色[ID]`）+ `ttsTextForAssistantResponse` 只保留莱莎（**NPC 不进 TTS 的依据**）→ `npc.js` 的协议来源 |
| `lib/src/character_appearance.dart` + `lib/src/local_skin_store.dart` + `docs/LOCAL_SKIN_IMPORT.md` | 皮肤导入的两条路（整套 ZIP 的严格校验：≤64 MB / ≤64 条目 / 禁 `..` 与符号链接 / 单页 atlas / PNG 尺寸匹配 / **骨架必须 Spine 4.2** / 必须有 `motion_A_001_idle`；以及只替换贴图页）→ **S10 皮肤导入的规则来源** |
| `lib/src/alarm_screen.dart` + `lib/src/alarm_audio.dart` | 原生后台闹钟：Flutter `alarm` 包 + Android 全屏 intent + 锁屏响铃 + 5 分钟贪睡 + `Permission.scheduleExactAlarm`；4 种提醒类型 × 普通/耳语两版音频 → **S10 闹钟的做法来源** |
| `lib/src/character_prompt_editor.dart` + `lib/src/settings_slots.dart` | 提示词卡/世界书各 5 槽 + `SettingsSlotKind{user,character,world}` + 旧内容迁移 → **S6 后半（还未做）的来源** |
| `docs/animation_dynamics.md` | **它明确写了 "ports ideas from `zeroa234/ryza-ai-revive`（`web/js/avatar.js`）" 并引用了你的提交 `fbac9d21…` / `6b3a902`** —— 这是"它取用了你的东西"的直接证据 |
| `docs/ORIGINAL_ASSET_AUDIT.md` | 它独立得出的同一结论：APK 内只有 2 套可运行角色 Spine 包、3609 个文件 |

### 13.3 已核实的结论（**别重复调研**）

- airi **没有** VAD 打断：`grep -r "barge"` 全仓 0 匹配；打断只有发消息 / 停止按钮 / 静音 / 切 provider 四种
- airi 的**记忆子系统未实现**（官方 UI 写着暂不可用，`packages/memory-pgvector` 是空壳，向量记忆停在 issue #879）
- airi 的包全部 `"private": true`、**未发 npm**；没有 IIFE/UMD 产物 ⇒ 无法"免打包"地取用它的代码
- airi 扩展 iframe 的资产原点是 `http://127.0.0.1:<随机端口>`，**每次启动都变** ⇒ `localStorage` 不跨重启 ⇒ 你的存档全在那里，所以"把 ryza 挂成 airi 扩展"这条路不成立
- N.E.K.O. 的模型（Silero v6.2.1 MIT / Smart Turn v3.2 BSD-2-Clause）**权重不在仓库里**，要自己按 `scripts/prepare_voice_turn_assets.py` 取
- AgentAtelierR 与你的仓库**不是 fork 关系**（GitHub `fork:false`、Dart/Flutter、无 `web/js/`、无 `serve.py`、无 `/_proxy`）；它随包分发了你的 MIT 声明（`docs/third_party/ryza-ai-revive-LICENSE.txt`）
- 三家与你的对照事实：官方 APK 只有 **2 套可运行角色骨骼**（`crf_skn_002_0001_01` 坐 / `_99` 站）；你的 203 个骨架全是 **Spine 4.2.43**；你的 `chara_icons` 36 张与它文档里的 33 位 NPC 逐一对得上

### 13.4 本地留存（**可清理，别依赖**）

- `<本机 temp>/neko-inv/` —— 调研 N.E.K.O. 时抓取的 105 个源文件
- `projects/ryza-ai-revive/temp/repo/` —— 调研 AgentAtelierR 时抓取的 93 个源文件
- 两者都是 `temp/`，按项目规范**可随时清理**；要复现按 §13.1 的 URL 重新抓（airi 未落盘，只做了线上核对）

### 13.5 本工作的产出文档

| 文件 | 内容 |
|---|---|
| `docs/ryza-unification-architecture.md` | **本文件**：统合方案 + 目标架构 + 交互设计 + 实施进度 + 交接须知 + 参考索引 |
| `docs/ryza-airi-realtime-layer-design.md` | 第一份方案：只取 airi 的 Vue-free 实时层（后被 N.E.K.O. 的判定逻辑补强） |
| `reports/airi-vs-ryza-ai-revive-assessment.md` | airi 评估：不是底座、不能重写、三条路线逐条判 |
| `reports/ryza-vs-agentatelierr-feature-gap.md` | 功能差分：NPC 对话是真差距、服装其实平手、原生闹钟最该抄 |
