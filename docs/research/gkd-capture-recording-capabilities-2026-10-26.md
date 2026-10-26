# GKD 捕获入口与点击录制能力调查（2026-10-26）

本文回答 T10（看到目标界面后捕获并进入工作区）和 T11（用一次用户点击或长按辅助选点）能否基于现有能力实现。调查对象是 Rule Studio 当前工作区与 `fktpp2022/gkd` 的 `research/local-rule-authoring-capture-feasibility` 分支（提交 `b53bed6972465b022617a7eb0d786e682bab6fa2`）；后者是当前 fork 的研究分支，不把它当作已发布 APK 的版本保证。

结论先行：**T10 的源码能力调查完成，复用快照入口的路径成立，产品设备原型待设备验收；T11 的录制原型应暂缓。** 现有 GKD fork 能采集当前前台快照、保存节点树与截图，并可通过 HTTP 读取；也已有无障碍窗口状态/内容事件、可切换的全局匹配开关和可选事件日志。当前 Rule Studio 没有“捕获后直接打开工作区并返回”的原生桥，现有 fork 也没有“一次用户点击对应点击前节点”的专用事件接口或可调用的录制会话暂停/恢复契约。缺少后两者时，不能把截图坐标猜节点、停止 Rule Studio 自己发请求或模拟 HTTP 响应说成点击录制。

## 核实边界

| 项目 | 本机实测 | 结论 |
|---|---|---|
| Android 设备 | `adb devices -l`：无设备 | 无 Android/厂商 ROM、真实手指或目标 APK 验收 |
| GKD HTTP | 本机 8888 无监听 | 未连接服务，未从设备取得真实 `serverInfo`、快照或回包 |
| GKD 源码 | `fktpp2022/gkd` 的 `research/local-rule-authoring-capture-feasibility` 分支，提交 `b53bed6` | 只证明该分支源码存在对应入口；不等于所有 Beta/Debug APK 都已包含 |
| Rule Studio 源码 | 当前共享工作区，保留已有脏修改 | 已核对客户端协议和 Android 宿主实现 |
| 上游设备实验 | [#14](https://github.com/fktpp2022/gkd/issues/14) 在 API 37 模拟器上的结果与日志 | 作为外部实验证据引用，**不替代本项目的设备验收** |

本调查没有安装工具、启动模拟器、打开可见窗口、连接或导航用户应用，也没有修改 GKD 的持久设置。HTTP 端口和 `adb` 状态只做了只读检查。

## T10：看到目标界面后捕获并进入工作区

### 可确认的源码能力

1. **服务端确有 HTTP 快照入口。** `gkd-app/.../service/HttpService.kt` 的 `createServer` 把 `captureSnapshot` 接到 `SnapshotCaptureHost.capture()`；`network/inspection/InspectionServer.kt` 注册 `POST /api/captureSnapshot`，并同时提供 `/api/getSnapshots` / `getSnapshot` / `getScreenshot` 的 HTTP POST 路由。服务端 `getSnapshot` 直接返回已提交快照 JSON，`getScreenshot` 返回已提交截图文件。
2. **Rule Studio 客户端已有捕获方法，但没有调用者。** `src/lib/deviceApi.ts` 的 `DeviceApiClient.captureSnapshot()` 会 POST `/api/captureSnapshot`；当前 `src/components/AndroidLiteApp.tsx` 只调用 `getSnapshots/loadSnapshot` 等读取路径，没有入口调用 `captureSnapshot`。不能把“接口封装存在”当成产品入口已经可用。
3. **已有系统触发入口。** fork 的快照悬浮按钮（`ButtonService.onClickView()`）、快捷设置磁贴（`SnapshotTileService`）和受限的外部 `ExposeService` 都能触发同一采集函数。悬浮按钮是唯一直接在目标前台采集的现有系统界面路径；磁贴展开时会遮住原应用，代码会先返回/等待前台包变化，再捕获新页面，不能描述成“从通知栏捕获原页”。
4. **采集必须有无障碍根节点。** `SnapshotCaptureHost.capture()` 通过 `A11yRuntime.service` 和 `getRoot()` 取当前活动窗口；没有无障碍服务或没有根节点时分别抛出 `ACCESSIBILITY_UNAVAILABLE` / `SCREEN_NODES_UNAVAILABLE`。节点只从 `rootInActiveWindow` 的单个根开始，其他窗口、IME 和系统栏节点不会合并进同一快照。
5. **截图与节点是两个来源。** 采集并发读取节点树和无障碍截图；Android 11 及以下无障碍截图能力不可用，会生成缺失截图的占位图；`FLAG_SECURE` 窗口可能只有占位/疑似受保护截图。截图失败不等于节点树不可读，但“截图与节点来自完全相同的一帧”不能保证。采集期间页面变化、节点遍历耗时和截图异步完成都会产生不一致风险；上游 [#1037](https://github.com/gkd-kit/gkd/issues/1037) 已记录耗时导致快照变成另一页的案例。
6. **保存语义是持久快照。** `SnapshotCaptureRepository.capture()` 用时间戳作为 ID，`SnapshotStore.save()` 先写暂存目录，再移动到一个已提交目录，并插入数据库记录；截图、完整节点 JSON、最小摘要 JSON 一并保存。提交失败会清理暂存目录。快照不会自动过期，只能通过明确的 `SnapshotStore.delete` / HTTP `deleteSnapshot` 删除。
7. **当前宿主不能从 Rule Studio 直接触发 GKD 采集。** Android 宿主 `MainActivity.java` 只暴露通用 `postJson` 网络代理、文件/剪贴板/更新/应用扫描等桥；没有跳转 GKD、获取其外部调用 token、触发系统磁贴、调用 `ExposeService` 或创建悬浮按钮的桥。网页对 GKD HTTP 的“捕获”只能调用已存在的 `/api/captureSnapshot`，这需要 GKD HTTP 服务正在运行且源设备确实暴露了该路由；HTTP 不是 Android 内部意图，不能启动悬浮入口。
8. **工作区入口已经存在。** `AndroidLiteApp` 连接服务后调用 `getSnapshots()`，选择快照后由 `loadSnapshot(id)` 并行读取节点和截图，并进入已有截图选点、候选和工作区链路。因此 T10 的“捕获完成后怎么进入工作区”可以复用现有快照读取/选择逻辑，不需要新建规则处理链。

### 最小可行路径与未完成的部分

源码层面最小路径是：

1. 用户在目标应用前台打开 GKD 已有捕获入口（优先验证悬浮按钮，HTTP 入口仅适用于服务可达场景）。
2. GKD 采集并持久保存一个普通 `ComplexSnapshot`；HTTP 接口返回该对象，客户端可直接使用其中的时间戳 `id`，随后读取已提交截图。
3. Rule Studio 刷新 `getSnapshots`，按该 `id` 读取快照和截图，进入现有工作区。
4. 工作区完成/返回后保留该用户快照；若正式产品需要“临时快照”，必须另行定义专用临时生命周期和删除确认，不能把普通快照自动删掉，更不能清理历史用户快照。

这条路径还有两个产品级缺口没有由源码自动补上：一是 Android 宿主没有 `open GKD / back to Rule Studio` 的可恢复跳转协议；二是 GKD HTTP 的 `/api/captureSnapshot` 在目标服务端返回的是 `ComplexSnapshot`，截图另走 `/api/getScreenshot?id=...`，当前捕获方法没有把两者原子交付到工作区。客户端若只把 `captureSnapshot()` 当作“已经打开工作区”会漏掉第二步和失败恢复。

### T10 能力与限制

| 场景 | 现有证据 | 状态 |
|---|---|---|
| 目标前台捕获快照 | fork `SnapshotCaptureHost.capture()` + HTTP 路由 | 源码能力已确认，设备未验收 |
| 节点/截图写入后读取 | `SnapshotStore` 文件布局 + `/api/getSnapshots` / `getSnapshot` / `getScreenshot` | 源码能力已确认，设备未验收 |
| 捕获后进入 Rule Studio 工作区 | AndroidLiteApp 的 `loadSnapshot` 链 | 源码复用路径已确认，端到端未验收 |
| 返回原应用并恢复 | 当前 Rule Studio Android 宿主只有有限外部 URL/设置跳转，无 GKD 专用返回契约 | **缺失** |
| 悬浮入口捕获 | ButtonService、OverlayWindowService | 现有系统入口，设备时序未验收 |
| 通知栏磁贴捕获原页 | SnapshotTileService 会返回/等待前台包变化 | **不能承诺捕获原页** |
| 权限丢失/其他窗口 | 服务端有无障碍/根节点错误；单根节点采集 | 失败会被拒绝，但多窗口/系统覆盖未在本项目实测 |
| 空截图/无节点 | 截图缺失占位、无根节点异常 | 源码有降级/错误，设备表现待验收 |
| 采集期间页面变化 | 无稳定画面指纹或事务级前后校验 | **无法可靠判断** |
| 临时快照自动清理 | 普通快照无 TTL，只有显式删除 | 不能自动清理用户快照 |
| 进程退出恢复 | 已提交快照持久存在，宿主工作区状态另有前端记忆 | 需要设备上核对恢复点，不能假定采集会话可恢复 |

### T10 正式实现条件

若继续产品化，先定义一个明确的采集入口契约，至少包含：

- `startCapture` 返回值中同时能唯一定位已提交节点 JSON 和截图，区分捕获中/已提交/失败状态；`captureSnapshot` 不应让客户端猜时间戳 ID。
- 捕获前后前台包名、activity、屏幕尺寸和至少一种节点/截图指纹；任一变化或截图/节点缺失时返回“不完整快照”，工作区可提示重采。
- 权限丢失、其他窗口、`FLAG_SECURE`、空节点和进程中止的可恢复错误码；不允许把占位截图当作成功画面。
- 工作区返回原应用的明确入口与恢复路径。Android 宿主需有正式的原生跳转能力；当前调查不修改宿主或 manifest。
- 临时会话与用户保存快照分开存储；失败或退出只清理本次未提交暂存，不删除已存在用户快照。

这些条件都未在当前 Rule Studio 与 fork HTTP 契约中完整成立。因此 T10 不是空功能，但也不是可发布的“捕获后直接进工作区”功能；没有设备时设备原型保持待验收。

## T11：一次点击/长按辅助选点

### 现有事件和规则执行控制

1. **当前订阅并非点击事件。** `gkd-android/src/main/res/xml/a11y_info.xml` 订阅 `typeWindowContentChanged|typeWindowStateChanged`，`A11yExt.isUseful()` 也只接受这两类事件。`A11yRuleEngine.onA11yEvent()` 把这些事件用于规则匹配和前台页面跟踪，不是 `TYPE_VIEW_CLICKED` / `TYPE_VIEW_LONG_CLICKED` 观察器。
2. **事件日志不是录制节点接口。** `EventService` / `A11yEventLog` 保存的是事件摘要（时间、类型、包、类名、文本等），不保存点击前的完整节点身份，也不提供“这次用户点击对应哪个快照节点”的同步结果。
3. **全局匹配开关具有可恢复的语义。** `SettingsStore.enableMatch` 默认开启；`AppStore.toggleEnableMatch()` 只做布尔翻转；`A11yRuleEngine` 在事件消费和查询入口检查该值。理论上可通过记录旧值 -> 设置为 `false` -> 结束后恢复旧值来暂停匹配，但它是持久设置，不是录制会话级 lease；HTTP 当前不暴露这一开关，进程退出、并发修改和恢复失败都没有事务保证。
4. **HTTP 没有暂停/恢复契约。** `InspectionServer` 只注册快照、订阅、选择器动作等路由，没有 `pauseMatch` / `resumeMatch` / `startRecording` / `cancelRecording` 一类端点。`GkdTileService` 的快捷磁贴会切换同类设置，但它不是可等待、可校验的会话接口，不能拿来冒充录制期间受控暂停。
5. **采集不能自动成为点击前快照。** 现有 `captureSnapshot` 是一次显式采集，点击事件没有把它关联到具体坐标、时间或节点。若在用户点击后才采集，得到的是点击后的页面；若在录制开始时采集，又需要稳定的画面指纹来证明点击前页面没有变化。当前两者都不由接口保证。

### 外部设备实验能证明什么

[#14](https://github.com/fktpp2022/gkd/issues/14) 在 Android 17 / API 37 x86_64 Google APIs 模拟器上用临时探针观察了点击事件，原始记录在 fork 的 `docs/research/observed-user-taps.log`：

| 表面 | 用户点击/长按观察 | 对 T11 的意义 |
|---|---|---|
| 原生 Button | 用户点击收到 `TYPE_VIEW_CLICKED`，source 能解析出 text/viewId/bounds | 只有当点击前快照存在且身份能匹配时，才可能映射 |
| 原生 TextView 长按 | 收到 `TYPE_VIEW_LONG_CLICKED`，对应用户长按节点 | 长按可观察，但同样缺录制会话与点击前快照关联 |
| WebView HTML 按钮 | 用户点击收到 `TYPE_VIEW_CLICKED`，DOM id 以 `viewIdResourceName` 暴露 | 该 WebView/provider 样本可能映射；其他 WebView 未证明 |
| WebView canvas | 收到事件，但只有 `vid=c`、无文本/desc、不可点击 | 语义身份不够，**不能猜成可靠目标** |
| 自行消失按钮 | 点击后视图 `GONE` 前没有可用事件 | 不能承诺自行消失目标可录制 |
| Compose 用户点击 | 没有点击事件 | **不支持**当前 Compose 用户点击录制路径 |
| GKD 自身 `performAction(ACTION_CLICK)` | 原生节点事件 action=16；Compose 也会产生事件 | 规则引擎必须真正暂停；不能只关闭 Rule Studio 测试请求 |
| `dispatchGesture` / adb 注入点击 | 与用户点击在事件上相同 | 不能只凭事件断言来源；需要互斥录制态与用户确认 |

该实验还观察到：Settings 的被点击 source 可能是无文本/ID 的空白容器，Compose source 在导航后不可解析；WebView 使用 Google WebView `145.0.7632.218`。这些都说明“有事件”不等于“能可靠映射到点击前节点”。

外部实验是设备证据，但不是本项目的设备验收，也没有覆盖目标 GKD APK、当前 Rule Studio 工程、厂商 ROM、Android 8–11 或所有 WebView provider。T11 ticket 中“原生 View、WebView、Compose、长按、自行消失目标分别记录结果”的 checkbox 不能因复制上游报告而打勾。

### T11 为什么暂缓

录制成功至少需要同时满足以下条件：

1. 在用户动作前生成快照，并记录可比较的 app/activity/screen 指纹。
2. 在录制 session 期间通过明确接口暂停 GKD 规则执行，保存原始开关/执行状态；完成、取消、异常和进程恢复都只恢复由本 session 修改的状态。
3. 接收一次点击或长按事件，同时拿到事件时间和 source/坐标等足够信息。
4. 在点击前快照中按节点身份唯一映射；歧义、无可观察事件或页面变化时失败并回到截图选点。
5. 成功后只替换选点，继续进入现有 `pickExistingNode` / 候选生成 / 验证链；不能因“录制完成”标记规则有效。

当前已有第 5 步的 Rule Studio 节点链基础；第 1–4 步缺少可验证的正式能力，尤其缺少稳定的点击前快照关联和录制会话暂停/恢复 API。因缺能力而不做 UI 原型，避免一个看似能录制、实际只能产生坐标猜测的假原型。

## 正式实现所需的最小外部契约

以下是后续跨项目实现所需的概念契约，不是本次新增端点，也不是当前已存在的 API：

```text
startRecordingSession(captureBeforeTap, pauseMatch)
  -> sessionId, beforeSnapshot, previousMatchState

observeOneTap(sessionId, acceptedEventTypes)
  -> eventType, time, appId, activityId, sourceNodeIdentity | explicitNoEvent

finishRecordingSession(sessionId, outcome)
  -> mappingResult, pausedStateRestored
```

事件结果应该明确区分：

- 点击/长按事件存在且能映射到点击前快照节点；
- 事件存在但节点语义不足或快照中不唯一；
- 事件不存在（如 Compose 用户点击、自行消失目标）；
- 页面/app/activity/屏幕指纹变化；
- 暂停或恢复失败，Rule Studio 必须回到现有截图选点，不能继续声称录制成功。

同时需要 GKD 服务端支持受控暂停和恢复。可直接采用 `enableMatch` 的布尔语义作为内部状态源，但正式接口必须提供会话所有权、旧状态读取、幂等恢复和失败反馈；Rule Studio 自身“停止发测试请求”不属于这个能力。

## 建议与验收状态

- **T10：**继续调查/原型，优先在支持的 GKD 版本上验证现有悬浮快照按钮 -> 读取快照 -> Rule Studio 工作区 -> 返回应用。需要补入口返回契约和临时快照生命周期后再考虑产品化；本次无可连接设备，设备验收不通过。
- **T11：**受外部能力阻塞，暂缓实现。先由 GKD fork 提供事件映射与录制期暂停/恢复，再在连接设备上分别测试原生 View、WebView provider、Compose、长按、自行消失目标、跨应用窗口与厂商 ROM。本报告不把外部模拟器实验当作本项目验收，也没有创建空原型。
- **验证图例：**源码结论 = 已核实源码；上游实验 = 可作为假设/接口需求依据，仍需本项目设备复核；设备结论 = 本次没有。

## 源码索引

- Rule Studio：`src/lib/deviceApi.ts`、`src/components/AndroidLiteApp.tsx`、`android/app/src/main/java/com/gkdrulebuilder/android/MainActivity.java`、`android/app/src/main/AndroidManifest.xml`。
- GKD fork：`gkd-app/src/androidMain/kotlin/li/gkd/app/service/HttpService.kt`、`.../network/inspection/InspectionServer.kt`、`.../snapshot/SnapshotCaptureHost.kt`、`.../snapshot/SnapshotCaptureRepository.kt`、`.../snapshot/SnapshotStore.kt`、`.../snapshot/SnapshotFileLayout.kt`、`.../a11y/A11yRuleEngine.kt`、`.../a11y/A11yExt.kt`、`.../service/EventService.kt`、`.../store/AppStore.kt`、`gkd-android/src/main/res/xml/a11y_info.xml`。
- 外部实验：[fktpp2022/gkd#14](https://github.com/fktpp2022/gkd/issues/14)，其分支 `docs/research/observed-user-taps.md`、`observed-user-taps.log` 和 `click-event-semantics.md`。
