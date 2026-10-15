# Spec：LibChecker 导入与广告 SDK 上下文（第一阶段）

日期：2026-10-14。状态：T1–T3 已实现，类型检查、224 项测试与浏览器流程检查通过；真实手机导出与 APK WebView 验收未完成。实施与验证记录：`docs/verification/libchecker-sdk-import.md`。

GitHub 规格与进度入口：[#8](https://github.com/jjjj31/gkd-rule-studio/issues/8)。

本阶段完成用户提出的第一步：导入 LibChecker 应用信息，匹配项目已有广告 SDK 签名，并在当前快照和规则生成中使用这些信息。GitHub spec Issue 是规格与进度入口，本文件保留规格正文。

## 目标与典型流程

用户在 LibChecker 中导出应用信息 → 在生成器首页导入文件 → 打开某应用的 GKD 快照 → 查看“应用包含的 SDK”和“当前页面的 SDK 特征” → 用这些证据辅助现有规则生成与 AI 求助。

例如，应用清单识别出穿山甲和优量汇，当前快照包含 `tt_splash_skip_btn`。界面分别显示应用包含两个 SDK、当前页面命中穿山甲特征；生成 prompt 优先检查快照中实际出现的穿山甲控件。导入清单本身不能证明当前广告的来源，也不能证明某个节点可安全点击。

阶段完成的依据是导入、关联和上下文准确，以及原有规则验证流程正常。第一阶段不承诺 SDK 识别全面覆盖，也不以 AI 输出必然改善作为验收标准。

## 已核实的依据

### 当前项目

核对基线：`02ba8d0927986d7d2fe11615ab24b166bd74b39f`。代码图谱已更新，并回到源码核实。

- `src/data/adSdkSignatures.ts`：签名表已有 `pangle`、`kwad`、`sigmob`、`gdt`、`jd`、`mbridge` 六个稳定 id；含包名／类名前缀、容器资源特征、专属跳过资源特征。当前整棵快照检测只返回首个 SDK，没有使用快照的 `activityId`。
- `src/lib/riskScoring.ts`：仅在目标控件命中 SDK 专属跳过特征时加分，并排除广告遮罩／热区。导入结果不得绕过此判断。
- `src/lib/helpPrompt.ts`、`src/lib/flowDraft.ts`：分别构建单步与多步求助 prompt；`src/components/AndroidLiteApp.tsx` 同时供内置 AI 和外部复制使用。
- `src/types/gkdSnapshot.ts`：快照含 `appId`、可空的 `activityId`、可选应用版本和节点树。
- `src/lib/subscriptionLibrary.ts`：可参照已有本地存储失败保留旧数据的处理方式。
- `android/app/src/main/java/com/gkdrulebuilder/android/MainActivity.java`：当前 WebView 未实现文件选择回调，需要补齐选择、取消及结果交付，才能在 APK 内导入文件。

### LibChecker

上游核对 commit：`625c4ecc40b0ed6d70e37ccdfb961867ffc1a622`。这是源码兼容性基线，不能冒充已验证的发行版本。

- [官方说明](https://github.com/LibChecker/LibChecker)：支持导出应用信息供 WebUI 读取。
- [导出实现与数据结构](https://github.com/LibChecker/LibChecker/blob/625c4ecc40b0ed6d70e37ccdfb961867ffc1a622/app/src/main/kotlin/com/absinthe/libchecker/domain/app/list/export/LcAppsExporter.kt)：ZIP 根目录的 `apps.json` 为报告数组；应用身份位于 `apkInfo.packageName`，`apkInfo.versionCode` 是字符串；组件信息位于 `apkInfo.components`。
- [上游序列化测试](https://github.com/LibChecker/LibChecker/blob/625c4ecc40b0ed6d70e37ccdfb961867ffc1a622/app/src/test/kotlin/com/absinthe/libchecker/domain/app/list/export/LcAppsSerializationTest.kt)：验证数组、可空字段及超出 JavaScript 安全整数范围的版本码。

该导出实现可能写出空的 `sdkSummary`，组件的 `sdk` 也可能为 null。第一版依据原始组件类名匹配现有签名表，不要求导出文件已带 SDK 名称。LibChecker 的 SDK 识别规则与 GKD 点击规则不能直接互换。

## 已确定的范围

| 项目 | 第一阶段决策 |
| --- | --- |
| 输入 | 本地 `.lcapps`／ZIP 导出及其解压后的 `apps.json` |
| 识别 | 使用现有六类 SDK 的类名前缀；一个应用可匹配多个 SDK |
| 关联 | 精确应用包名；应用版本用于标记是否与快照相符 |
| 页面证据 | 当前快照 Activity 和节点中的 SDK 特征，独立于导入结果收集 |
| 使用 | 工作区摘要、单步／多步 prompt、内置 AI 和外部复制 |
| 存储 | 本地保存必要应用信息和匹配证据，重启后恢复，可删除 |
| 规则执行 | 继续使用当前候选验证、评分、测试及导入流程 |

APK／DEX 扫描、后台扫描已安装应用、集成 LibChecker 原生 Bundle、下载整套 LibChecker 规则库、网络导入、SDK 版本推断、新广告模板、自动生成全局规则与自动执行不属于本阶段。

## 行为规格

### S1．文件读取与兼容性

- 接受本地 `.lcapps`／ZIP 文件及 JSON 文件，不要求连接 GKD 或配置 AI。以内容校验为准，扩展名及 MIME 只帮助文件选择。
- ZIP 只读取根目录唯一的 `apps.json`，忽略图标及其他条目，不解压整个归档，不访问图标链接，不将归档路径写入磁盘。缺失／重复条目、加密、不支持的压缩方式、损坏数据须给出可理解的错误。
- 使用成熟的 ZIP 实现，允许为此增加一个必要的轻量依赖；不手写 ZIP／DEFLATE。限制必须覆盖实际解压输出，不能只相信 ZIP 声明的大小。
- 导入上限：文件 32 MiB，`apps.json` 实际解压／读取后 64 MiB，报告 5,000 条，每应用组件 10,000 条，本地规范化内容 UTF-8 编码后 2 MiB。以上为第一版产品限制，不保证浏览器存储剩余配额；超过任一上限时拒绝，并保留原数据。
- JSON 使用标准 JSON 解析，可去除开头 UTF-8 BOM。只支持已核实的报告数组结构；不猜测 `apps`／`sdkList` 等其他结构。识别为快照数据库备份、APK 或不支持的旧版导出时提示“请选择 LibChecker 应用信息导出文件”。
- 每份报告必须有非空、合法的 `apkInfo.packageName` 和对象类型的 `apkInfo.components`；后者至少包含一个受支持的组件数组。`activities`、`services`、`receivers`、`providers` 缺失时按空数组处理，存在时必须为数组，各条目必须包含非空类名 `name`。所有数组都为空是合法输入。
- 应用名称、应用版本和 `analyzedAt` 为可选元数据；无有效值则省略。版本码接受十进制非负整数字符串；如兼容数字输入，只接受非负安全整数并转换成字符串，拒绝不安全数字，不能静默舍入。应用版本不是广告 SDK 版本。
- 同一文件中重复包名、任一必需字段错误或不安全版本码使整批失败，错误定位到报告序号／包名和字段；空数组提示“文件中没有应用”，不清空已有记录。
- 忽略未消费的额外字段，不保存权限、证书、设备资料、图标、完整应用清单原文或未经识别的组件明细。

### S2．应用 SDK 档案与本地保存

- 对四类组件的完整类名，使用 `AD_SDK_SIGNATURES.packagePrefixes` 匹配。前缀必须位于类名开头且以 `.` 分隔；例如 `com.qq.e.ads.ADActivity` 可匹配 `com.qq.e`，`com.qq.evil.AdActivity` 不匹配。
- 组件名不是 UI 资源名，不能在此使用 `containerSignals`、`skipSignals` 或“广告／关闭／skip”等泛化词。第一版也不依据任意 SDK 展示名、未验证的 `.so` 文件名推断 SDK。
- 收集所有匹配，按签名表顺序稳定输出，以 SDK id 去重；保留命中的组件类别、完整类名和签名前缀。一个应用可有零个、一个或多个受支持 SDK。
- 保存应用包名、名称（如有）、版本（如有）、上游分析时间（如有）、本机导入时间及匹配证据；分析时间和导入时间分别标记。
- 按包名更新：本次文件中同包名记录整体替换，包括新的零匹配结果；文件外已有应用保留。重复导入不产生重复应用或证据。解析、容量校验、序列化和整批持久化全部成功后才更新界面状态。
- 新文件失败或保存配额不足不覆盖旧缓存；加载损坏缓存时显示错误，不在加载过程中以空数据覆盖原值。使用独立存储 key 和本地 schema version，不改写现有订阅库、快照记忆或 AI session 存储。
- 支持按应用删除档案；删除失败保留显示中的旧记录。删除档案只移除本地导入背景，不改变现有规则、快照、候选或设备状态。
- 未匹配时显示“未识别到受支持的 SDK”，不能显示为“无广告 SDK”。

### S3．当前快照的 SDK 上下文

- 快照只关联 `profile.appId === snapshot.appId` 的档案，不能按应用名称关联。不同包名的数据不会进入当前摘要或 prompt。
- 双方有有效版本码时比较版本码；否则双方有版本名时比较版本名；无法比较时标记“版本未核对”。不同版本显示“导入信息与快照版本不同”；失配档案可在详情查看，但 SDK 名单不进入生成 prompt。快照中的应用信息不能被导入文件覆盖。
- 页面证据独立扫描当前 `activityId`、节点 `id`／`vid`／`name`。Activity 与完整类名采用类名前缀规则；SDK 专属资源特征沿用现有签名数据。一页可返回多个 SDK，不再以首个命中作为整页唯一 SDK。
- `ad_area`、`hotarea`、`splashhotarea` 等泛化资源词不能单独确认 SDK 归属。具体 Activity、SDK 类名或 SDK 专属资源是可呈现的页面证据；通用容器命中不能升级成专属跳过控件证据。
- 结果分别保留“应用清单证据”和“页面证据”，不合成一个虚假的已确认 SDK。即使档案版本失配或页面 SDK 不在导入名单中，页面证据仍保留；不根据静态名单排除其他 SDK。
- 导入证据不增加候选安全评分、不改变选择器命中结果，也不自动生成按钮、Activity 限定、组名或执行参数。真实跳过控件加分仍只由现有目标节点判断产生。
- 无导入结果时仍可收集页面证据；两类证据都缺失时继续原有生成流程，不阻止用户选点或生成规则。

### S4．界面与规则生成

- 首页提供“SDK 信息”入口，面板中提供“导入 LibChecker 文件”。导入、查看和删除不依赖 GKD 连接或快照。导入成功显示应用数量与匹配到受支持 SDK 的应用数量。
- 面板按应用名／包名搜索已有档案，可查看版本、导入时间、SDK 名单和组件证据，并删除单个应用。第一版没有 SDK 名称编辑、手动绑定其他应用或多来源管理。
- 打开快照后，在工作区显示两项简短摘要：“应用 SDK”和“页面特征”。空结果、未导入、版本失配分别显示准确状态，证据明细按需展开。
- SDK 信息仅作为规则生成背景。单步 `buildHelpPrompt` 和多步 `buildFlowHelpPrompt` 每个步骤使用同一套上下文格式；内置 AI、外部复制与不内嵌节点树的 prompt 路径行为一致。
- prompt 包含可用档案中的稳定 SDK id／名称、版本核对状态和少量证据，以及当前页面命中的 SDK／Activity／节点资源证据。每个 SDK 最多提供两条清单证据和两条页面证据，采用稳定顺序；不放入其他应用信息或完整导出内容。
- prompt 明确说明导入 SDK 清单仅代表应用包含，页面证据仍需结合节点树验证；只能点击当前页面实际可定位的关闭／跳过节点，不能仅凭 SDK 名单编造选择器。
- 版本未核对的清单可作为背景进入 prompt，但必须同时标记未核对；版本失配时只提示状态，省略该档案的 SDK 名单。只有 SDK 清单、没有当前快照时不能由此创建可执行规则。
- 新生成使用当前档案；既有 AI session 的 `originalPrompt`、已生成候选和测试状态保持原样。中途导入或删除后，可在下一个新 session 使用新上下文，不静默改写已有 session。
- `.lcapps` 导入及解析完全在本地；仅用户主动使用已有 AI 请求／复制入口时，所选应用的规范化上下文随现有 prompt 发送或复制。无需新增上传服务。
- APK 中补齐 WebView 文件选择：系统选择器能够选择未知扩展名／`application/octet-stream` 的导出；取消、重复选择、失败和 Activity 销毁时回调正确结束，不申请遍历全部存储的权限。

## 模块接口与实施位置

建议新增一个 LibChecker 导入模块，隐藏 ZIP／JSON 差异、结构校验和规范化，供界面及测试通过同一个接口调用；匹配与 prompt 使用现有共享位置，不在界面重复实现。

```ts
type AppSdkProfile = {
  appId: string;
  appName?: string;
  versionCode?: string;
  versionName?: string;
  analyzedAt?: string;
  importedAt: string;
  sdks: Array<{
    sdkId: string;
    evidence: Array<{
      componentType: 'activity' | 'service' | 'receiver' | 'provider';
      name: string;
      matchedPrefix: string;
    }>;
  }>;
};

// 名称可按项目习惯调整；字段语义、失败时不覆盖及来源区分不可省略。
declare function readLibCheckerProfiles(file: File, importedAt: string): Promise<AppSdkProfile[]>;
declare function resolveAdSdkContext(snapshot: ParsedGkdSnapshot, profile?: AppSdkProfile): AdSdkContext;
```

`AdSdkContext` 至少返回版本核对状态、可用于 prompt 的清单匹配及当前页面匹配，页面证据含来源字段、Activity 或节点编号和命中特征；无需额外数值置信度。纯匹配／上下文计算接受显式数据，不自行读取存储、联网或发送 AI 请求。存储函数按既有模式接受可替换的 Storage 接口，以验证失败保留旧值。

预计触及：新增导入／档案存储及上下文模块与类型；现有 `adSdkSignatures.ts` 的共享签名数据；`helpPrompt.ts`、`flowDraft.ts`、`AndroidLiteApp.tsx` 的传参；一个 SDK 信息面板及必要样式；Android 文件选择。`riskScoring.ts` 的安全评分语义保持现状，以回归测试确认。

## 整体验收

- [ ] 同一份按上游结构构造的数据，ZIP 与 `apps.json` 导入后得到相同档案；单应用、多应用、无 SDK 和多 SDK 均可处理。
- [ ] `sdkSummary` 为空／组件 `sdk` 为 null 时仍从类名匹配；普通组件不会误报，类名前缀相似的反例不命中。
- [ ] 版本码大于安全整数范围但以字符串给出时完整保存；不安全数字输入、必需结构错误、重复包名、损坏 ZIP、重复 `apps.json` 和超限输入均失败且保留旧缓存。
- [ ] 重复导入按包名替换；零匹配结果可替换旧 SDK；文件外应用保留。重启、断网、删除和存储失败行为符合 S2。
- [ ] A 应用档案不会进入同名 B 应用的摘要／prompt；版本相符、失配及缺失状态准确。
- [ ] 应用清单与当前页面来源分别呈现；清单含穿山甲、页面含快手时保留差异；Activity 命中、多个页面 SDK 和通用资源词反例均有验证。
- [ ] 单步／多步、内置 AI／外部复制均包含相同来源语义和必要证据；多步逐步骤关联，没有跨应用泄漏。导入原文不进入请求或复制内容。
- [ ] 只有静态 SDK 名单的普通页面，候选评分与导入前一致；原有跳过控件加分及广告遮罩扣分测试仍通过。
- [ ] 无导入数据时原生成流程可用；导入／删除不改写已保存 AI session 和测试状态。
- [ ] 桌面浏览器和实际 Android WebView 都可选择文件；取消及再次选择正常。留存一份脱敏真实 `.lcapps` 样本、导出端版本／commit、Android／WebView 版本与验证记录；源码核对或浏览器 mock 不替代设备验收。

## 实施 ticket

- [x] [T1／#9：LibChecker 文件解析、SDK 档案与本地保存](https://github.com/jjjj31/gkd-rule-studio/issues/9)，对应 S1、S2。本地正文：`docs/tickets/libchecker-sdk-import/01-import-and-storage.md`。
- [x] [T2／#10：SDK 页面证据、版本关联与共享 prompt](https://github.com/jjjj31/gkd-rule-studio/issues/10)，对应 S3 及 S4 的生成路径；依赖 T1。本地正文：`docs/tickets/libchecker-sdk-import/02-context-and-prompt.md`。
- [ ] [T3／#11：SDK 信息界面、Android 文件选择与端到端验收](https://github.com/jjjj31/gkd-rule-studio/issues/11)，对应 S4 及整体验收；依赖 T1、T2。界面与 Android 文件选择已实现并通过浏览器检查，真实导出与真机 WebView 验收未完成。本地正文：`docs/tickets/libchecker-sdk-import/03-ui-and-device-validation.md`。

T1、T2 可以用脱敏合成 fixture 独立验收。功能总体完成必须包含 T3 的真实导出和 WebView 验证；缺少设备证据时保持相关验收项未完成。
