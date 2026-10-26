# GKD 本地规则读取与更新能力调查（2026-10-26）

调查目标：[T07](../tickets/rule-authoring-optimization/07-local-rules-capability.md)。结论基于 README 指向的 fork、邻近 clone、已连接 GitHub 上的远端源码与发布资产，以及本机只读环境检查。没有修改 GKD 或 Rule Studio 产品代码，也没有写入、删除或替换任何设备规则。

## 结论

**当前 fork 只提供本地规则的追加写入，没有可供 T08 使用的规则读取或更新（含删除）HTTP 契约。** 以 `jjjj31/gkd@f84b8415efb2695bae0463da9b2d2da56752bbc0`（`main`，2026-07-21）为准，HTTP 路由仅新增：

| 能力 | 源码事实 | 对 T08 的含义 |
|---|---|---|
| 读取本地规则 | fork HTTP 路由未注册读取本地规则的 endpoint；`subsMapFlow` 仅用于服务端 append 内部 | 不能列出已有规则、启用状态或适用范围；已有覆盖提示受外部能力阻塞 |
| 追加规则 | `POST /api/localRules/append`；请求 `{ app, dedupe? }`；响应含 `ok/action/appId/appName/addedGroups/addedRules/skippedDuplicates` | 可用于新增，不能据此证明已有目标的覆盖情况 |
| 更新指定规则/规则组 | 未注册按身份更新的 endpoint；源码中的 UI 能整体重写本地订阅，但不是 HTTP API | 不支持从 Rule Studio 通过已核实契约替换指定规则或规则组 |
| 删除指定规则/规则组 | 未注册按身份删除的 endpoint；UI 删除走内部 `updateSubscription` | 不支持通过已核实 HTTP 契约删除或自动替换 |
| 稳定规则身份 | append 生成 `group.key`/`rule.key`，但不返回这些 key 或最终完整订阅；去重只比较 selector 字符串集合 | 无法建立“原规则副本 ↔ 写入后规则”的稳定关联，不能安全替换 |

因此 T08 应保持**受外部能力阻塞**，不实现“仅检测本地且适用的已启用规则”、目标覆盖检测或替换操作。复制、测试和 append 导入路径可以继续使用。若仅把 append 的 selector 去重当作已有规则检测，它只能说明当前本地订阅中是否出现过相同 selector 字符串，不能说明规则已启用、适用于当前 app/activity/app version，也不能识别不同 selector 命中同一目标。源码已经排除现有可请求的读取能力；这仍不构成某台实际设备的 API 实测。

## 版本、来源与证据

| 项 | 核实结果 |
|---|---|
| fork 地址 | [jjjj31/gkd](https://github.com/jjjj31/gkd)，由项目 `README.md` 的“我 fork 了一个支持本地规则导入的 GKD 版本”链接给出 |
| 本地 clone | `C:\Users\kmttjnm\Desktop\各种项目\project\gkd-main`；origin 为 `https://github.com/jjjj31/gkd.git`；本地 `master` 与 `origin/main` 均为 `f84b8415` |
| 远端 ref | GitHub `main` 的 SHA 为 `f84b8415efb2695bae0463da9b2d2da56752bbc0`；功能提交为 `4866d1a570efe1c569efcb7938f0d6cc07f138ea`（`feat: add HTTP-based local subscription rule import via /localRules/append endpoint`） |
| 发布资产 | GitHub Release `local-rules-api-beta` 指向 `main`；仅有 `GKD-LocalRulesApi-Beta-debug.apk`，SHA-256 `d5df63701788b714f631260cfd9204d81bb7d7ba1fb392b317d19b603783a63c` |
| 源码版本 | `app/build.gradle.kts` 声明 `versionCode = 92`、`versionName = "1.12.1"`；debug 构建使用 application ID 后缀 `.debug`，即 `li.songe.gkd.debug` |
| 源码入口 | [`LocalRulesApi.kt`](https://github.com/jjjj31/gkd/blob/f84b8415efb2695bae0463da9b2d2da56752bbc0/app/src/main/kotlin/li/songe/gkd/util/LocalRulesApi.kt)、[`HttpService.kt`](https://github.com/jjjj31/gkd/blob/f84b8415efb2695bae0463da9b2d2da56752bbc0/app/src/main/kotlin/li/songe/gkd/service/HttpService.kt)、[`RawSubscription.kt`](https://github.com/jjjj31/gkd/blob/f84b8415efb2695bae0463da9b2d2da56752bbc0/app/src/main/kotlin/li/songe/gkd/data/RawSubscription.kt)、[`SubsState.kt`](https://github.com/jjjj31/gkd/blob/f84b8415efb2695bae0463da9b2d2da56752bbc0/app/src/main/kotlin/li/songe/gkd/util/SubsState.kt)、[`AppRule.kt`](https://github.com/jjjj31/gkd/blob/f84b8415efb2695bae0463da9b2d2da56752bbc0/app/src/main/kotlin/li/songe/gkd/data/AppRule.kt) |
| 客户端事实 | `src/lib/deviceApi.ts` 仅暴露 `updateSubscription` 和 `appendLocalRules`；`src/lib/gkdTarget.ts` 将 `li.songe.gkd.debug` 作为 Beta 目标 |

README 示例写作 `POST /localRules/append`，但 `HttpService.kt` 的实际路由位于 `route("/api")` 内，客户端也发往 `/api/localRules/append`。可执行契约以源码和客户端实际请求为准；README 路径不能作为对接依据。

## 已核实写入契约

完整 endpoint：`POST <origin>/api/localRules/append`，`Content-Type: application/json`。

```ts
type LocalRulesAppendRequest = {
  app: {
    id: string;
    name: string | null;
    groups: RawAppGroup[];
  };
  dedupe?: boolean; // 默认 true
};

type LocalRulesAppendResponse = {
  ok: boolean;          // 源码默认 true
  action: "append";     // 源码默认 append
  appId: string;
  appName: string | null;
  addedGroups: number;
  addedRules: number;
  skippedDuplicates: number;
};
```

请求后的服务端行为已有 fork 单测和源码：查找 `app.id` 相同的 app；收集其现有规则的全部 `matches`、`excludeMatches`、`anyMatches`、`excludeAllMatches` selector 字符串；`dedupe=true` 时，只要传入规则的任一 selector 字符串已存在，就跳过整条规则；新组使用现有最大 `group.key + 1`，新组内规则从 `rule.key=0` 重新编号。没有新增规则时仍返回成功响应，counts 反映零写入。

有实际写入时，服务端把结果写成本地订阅 `id=-2`，并把其 `SubsItem.enable` 设为 `true`、`enableUpdate=false`、更新时间。响应**不包含**最终规则 key、完整规则正文、订阅版本或其他规则。append 在 app 已存在时只补缺失的组，不能把同名组当作可替换对象。

## 字段完整性与适用性

数据模型本身携带识别判定所需的大部分字段，但现有 HTTP 接口不会返回这些字段，而且有效启用值不是单个 `enable` 布尔值。

| 所需信息 | fork 模型/运行语义中的实际位置 | 通过现有 HTTP append 是否可得 | 缺失时的影响 |
|---|---|---|---|
| 应用归属 | `RawApp.id`、`app.name`、`groups`；append 以 `app.id` 查找/创建 | 请求知道提交 app；无法回读设备上的范围 | 只能检查提交内容，不能确定某条设备规则属于哪个 app |
| 规则内容 | `RawAppGroup.rules`；规则含 `matches`、`anyMatches`、`excludeMatches`、`excludeAllMatches`、`action`、`preKeys` 等 | 否；只返回计数 | 可检测提交的 selector，无法枚举已有规则全文；不能做完整规则等价或目标覆盖 |
| selector 去重 | append 内部扫描当前 app 全部 selector 字符串 | 只能看到 `skippedDuplicates` 总数 | 不能定位哪条规则重复，且不是“已有的规则读取接口” |
| group 身份 | 组 `key`；append 分配新 key，不返回 key | 否 | 不能把一次写入后的组与来源稳定对应；不能按组安全编辑/替换 |
| rule 身份 | 规则 `key`、`preKeys`；append 将组内新规则从 0 重新编号，不返回 key | 否 | 来源 key 不能作为设备身份；不能按规则安全编辑/替换 |
| 组启用状态 | `RawAppGroup.enable`，可被 `SubsConfig.enable`、category config/default 覆盖 | 否 | 不能确认是否启用；只能将启用状态视为未知 |
| 本地订阅启用状态 | `SubsItem.enable`；append 实际写入时设为 `true` | 响应不返回，源码只证明新写入路径将其设为 true | 不能读取当前订阅开关，也不能证明已有规则当前仍启用 |
| app 启用状态 | `AppConfig.enable`；若未配置，GKD 根据已安装应用信息推进/过滤 app rules | 否 | 不能仅凭规则 app ID 判断此设备现在是否适用 |
| Activity 范围 | 规则 `activityIds`/`excludeActivityIds` 可覆盖组同名字段；实际匹配用 `startsWith`，并有全局 exclude config | 否 | 不能从“同 app”推断当前快照页面适用，无法可靠做覆盖提示 |
| app 版本范围 | 规则 `versionCode`/`versionName` 可覆盖组字段；`IntegerMatcher`/`StringMatcher` 在运行时匹配目标 app 版本 | 否 | 不知道规则是否对当前 app 版本有效，版本条件不满足时应显示信息不足 |
| 规则合法性/匹配时间等 | selector parse/type check、`matchTime`、`actionMaximum`、`actionCd`、`matchRoot`、`resetMatch` 等 | 否 | 不能区分禁用、非法、过期匹配窗口和有效规则 |
| 订阅版本/冲突 | 本地订阅 `version`；UI 更新时生成并写文件 | 否 | 无乐观并发/版本前置条件；不能做安全更新或冲突提示 |

即使未来提供 append 之外的读取，T08 也必须读取规则原始字段、匹配的 config 层和当前快照的 app/activity/version，才能显示“已启用且适用”。只返回 `RawSubscription` 也不足以代表有效启用范围，因为 `SubsConfig` 和 `AppConfig` 是独立的持久化状态。

## 更新与删除边界

源码内部有两条相关能力，但不能被误写成 HTTP 契约：

- 本地规则编辑器 `UpsertRuleGroupVm`/`RuleGroupState` 能检查 group key/name、保留 group key、重写整个本地订阅、删除整个组及相应 config；这些是 GKD UI 内部操作。
- `POST /api/updateSubscription` 是内存订阅更新接口，服务端强制改为 `id=-1`、名称为“内存订阅”、`version=0`、作者为 `@gkd-kit/inspect`；它不是本地规则 `id=-2` 的定向更新或删除。

当前 HTTP 路由还提供 `deleteSnapshot`，仅删除快照；不能删除规则。`localRules/append` 不提供 target key、subscription version、expected mtime/ETag 或 field-preserving update，因此没有可核实的冲突与字段保留失败行为。

## T08 可实现范围与降级契约

在当前能力下，T08 可实施的最小安全范围只有：

1. 设备目标为官方版或目标包名不匹配时，显示“不支持读取本地规则”，保留复制/手动导入。
2. 对支持 fork 的 append 路径，可以保留现有 `dedupe` 行为，但只把它描述为“导入时按 selector 字符串去重”，不显示为已有覆盖检查。
3. 已有规则检测状态应明确为 `unsupported`（确定目标不支持）或 `unchecked/error`（请求、超时、权限、字段不完整），不能映射为 `no duplicates`。
4. 读取失败或字段不足时继续允许选点、生成、验证、测试和复制/导入；不出现替换按钮，不改变已有规则或订阅。
5. 表达式重复与目标覆盖继续作为两种未来结果；在没有规则正文与快照匹配前，不把 selector 字符串去重、组名或 app ID 当作目标覆盖证据。

后续若 fork 增加能力，至少应提供一条只读接口，返回当前设备的本地订阅规则与该快照所需的启用/范围事实，并明确 schema/version/排序；若要更新，还应提供按稳定身份或可验证 snapshot version 的显式操作，返回前后版本和字段保留结果。它们目前**不存在于已核实 ref**，本 ticket 不虚构端点。

为便于后续 fork 实现或重新评估，需要的语义如下。这个形状是**需求草案，不是现有 endpoint**。

```ts
// 需求草案：当前 ref 未提供此请求或响应。
type LocalRulesReadRequest = {
  appId: string;
  activityId: string | null;
  appVersionCode: number | null;
  appVersionName: string | null;
};

type LocalRuleView = {
  subscription: { id: -2; version: number };
  group: { key: number; name: string; enabled: boolean | null };
  rule: { key: number | null; enabled: boolean | null; content: RawAppRule };
  applicability: "applicable" | "inapplicable" | "unknown";
  reason: string[];
};
```

读取结果至少要包含稳定的 `(subsId=-2, appId, groupKey, ruleKey)` 引用、完整 `RawAppRule`、最终生效的组/app/订阅启用值及其来源、已解析的 Activity/version 条件和 `subscription.version`。`enabled` 应为计算后的值并保留规则原文；`enabled: null`/`applicability: "unknown"` 表示缺少配置或设备事实，不能当作未启用或未命中。若数据源只能返回原始 `RawSubscription`，还需同时返回 `SubsItem`、`AppConfig`、`SubsConfig` 和 category 配置，或由服务端计算上述字段。

若要替换，建议独立提供显式操作：以 `(subsId, appId, groupKey, ruleKey, expectedSubscriptionVersion)` 为身份和前置条件，只更新指定规则内容及必要的启用字段；若版本或身份冲突，返回明确 conflict，不自动追加另一份规则。该建议同样**尚未实现**。

## 实际验证与未验收范围

- GitHub 已连接工具读取了 `main` branch、`LocalRulesApi.kt`、`HttpService.kt`、`RawSubscription.kt`、相关 commit 与 release；远端 `main` SHA 与本地 clone 一致。
- 本地源码核实 fork 的 `LocalRulesApiTest.kt` 覆盖新组追加与新 key、缺失 app 创建和 selector 去重、全部重复时零组写入。客户端单文件测试 `pnpm exec vitest run src/lib/deviceApi.test.ts` 通过 5/5，确认实际请求路径和 append payload。该测试使用模拟 HTTP，仅证明客户端行为，不证明设备上的读取或规则执行。
- `pnpm run typecheck` 在本次调查时失败：其他并行改动已加入 `getNodeSelectionOptions`、`validateAppRuleAgainstSnapshot` 的测试，但对应导出尚未落地。这是跨 agent 集成红灯，不是 T07 文档的验证通过。
- `adb devices -l` 返回空列表，本机也没有 8888 端口监听；因此没有进行只读 `getServerInfo`、`getSnapshots` 或设备回读。fork Android 单测也没有实际运行：本机默认 Java 11，而当前 Gradle 配置需要 JDK 17，且未配置 Android SDK。
- 未验收：真实设备上的 append 回读、规则启用/版本/activity 的实际结果、规则触发、HTTP 读取能力（源码明确不存在）以及更新/删除（源码明确不存在）。不得以本轮模拟接口或源码单测宣称设备有效。

## 可复现检查

运行目录：`C:\Users\kmttjnm\Desktop\各种项目\project\gkd-main`。Shell：PowerShell。

```powershell
git remote -v
git rev-parse HEAD origin/main
rg -n "localRules|fun appendLocalRules|route\(\"/api\"\)" app/src/main/kotlin/li/songe/gkd
rg -n "versionCode =|versionName =|applicationIdSuffix" app/build.gradle.kts
```

运行目录：`C:\Users\kmttjnm\Desktop\各种项目\project\gkd-rule-builder`。Shell：PowerShell。

```powershell
pnpm exec vitest run src/lib/deviceApi.test.ts
adb devices -l
```
