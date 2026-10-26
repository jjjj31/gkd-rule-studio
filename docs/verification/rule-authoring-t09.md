# T09 多快照正反例验证与集成说明

日期：2026-10-26。Ticket：[T09](../tickets/rule-authoring-optimization/09-multi-snapshot-validation.md)。需求依据：[规则制作优化规格](../specs/rule-authoring-optimization-spec.md) 的用户故事 38–41、实现决策 17–18 和测试决策 9。共享规则验证入口来自 T01：`validateAppRuleAgainstSnapshot(snapshot, app): SelectorValidation[]`。

## 已实现

- `src/lib/multiSnapshotValidation.ts` 的 App 级命中/未知/无效状态只调用 core 的 `validateAiCandidateAgainstSnapshot({ app, id, title, summary, risk }, snapshot)`，不维护第二套规则聚合。逐规则 `validateAppRuleAgainstSnapshot` 结果只作为 `rules` 证据保留，用于解释命中规则与实际目标。
- 单条规则内部 `matches` 的全部约束由 core 处理。多规则正反例解释遵循 core 的 App 级契约：已知任一规则命中时，反例 fail；正例存在 `partial`／`invalid` 时不能冒充完整通过，保持 unknown。
- 反例因已知规则命中而失败时，优先显示“反例存在已知误命中，不应匹配”，再说明其他规则未完整验证；`targets` 展示这些已确认误触的实际节点，并按节点 ID 去重。其它规则的 `partial` 不能隐藏已知误触。正例为 unknown 时不展示未完整确认的点击目标。
- 正例要求 `satisfied`，反例要求 `unsatisfied`；正例不命中、反例误触均单独显示失败。`partial` 始终显示未知，`invalid` 显示规则错误，均不从其它样例的结果推导通过。
- 样例 metadata 仅保存 `id`、`appId`、`expectation`、`sourceLabel`、`nodeCount`，当前会话 React state 中保存；没有 localStorage、IndexedDB 或网络上传。规则、节点和截图非空时 `sourceLabel` 区分当前快照与设备快照。
- 每次规则内容变化生成新的 `{ token, appKey }`；异步设备加载完成时同时核对运行 token、当前 App、函数闭包中的 App 与快照身份。规则或 App 已变化时，新返回的截图 URL 立即释放且不加入样例。
- 父组件传入的当前快照只在组件内存中引用，`ownedUrl=false`。只有组件自己通过 `loadSnapshot` 新建的截图 URL 会因删除样例、切 App 或卸载而 `URL.revokeObjectURL`；父组件的当前快照 URL 不回收。
- 可添加当前快照为正例或反例；有 `availableSnapshots` 和 `loadSnapshot` 时，还可从同 App 的设备快照列表载入样例。重复快照不会重复加入，也不会覆盖已有预期。
- 样例列表逐张显示目标节点 ID、文字/描述/资源标识兜底标签、点击边界、命中数、状态、诊断、正/反例与来源。删除样例不会删除快照文件，也不会改写规则或流程。

## 集成接口

主组件挂载独立面板：

```tsx
import { MultiSnapshotValidationPanel } from "./MultiSnapshotValidationPanel";

{activeRuleDraft && snapshot && (
  <MultiSnapshotValidationPanel
    app={activeRuleDraft}
    snapshot={snapshot}
    availableSnapshots={snapshots}
    loadSnapshot={
      client ? (id) => client.loadSnapshot(id) : undefined
    }
  />
)}
```

对应 props 精确为：

```ts
interface MultiSnapshotValidationPanelProps {
  app: AppRuleDraft;
  snapshot: ParsedGkdSnapshot;
  availableSnapshots?: DeviceSnapshotSummary[];
  loadSnapshot?: (id: number) => Promise<ParsedGkdSnapshot>;
}
```

挂载位置应为单条规则工作区，与多步骤流程步骤列表分开；不要把它接进 `flowSteps` 或导出规则。`app` 必须是当前完整 `activeRuleDraft`，变化时传新对象；组件自动重算。`snapshot` 必须是父组件持有并负责回收的当前快照。`availableSnapshots` 传现有 `snapshots`；`client?.loadSnapshot` 需用 `client ? (id) => client.loadSnapshot(id) : undefined` 绑定，不能传入未绑定方法。无需新增持久化或上传调用。

## 红绿与自动检查

先新增 `src/lib/multiSnapshotValidation.test.ts`，在模块不存在时得到失败；随后先实现纯验证与判定，再实现组件。组件测试使用 React 的 `renderToStaticMarkup`，不新增测试依赖，也不 mock 内部 matcher。

覆盖行为：

- 同一规则的正例命中与反例不命中独立通过。
- 首条规则未命中、后续规则命中时，正例仍通过且反例因任一规则命中而失败。
- 多条规则命中同一节点时目标去重；全部未命中并存在未知规则时保持 unknown。
- 已知规则误触与另一条 `partial` 并存时，反例仍 fail 并展示已知实际目标；正例存在同一 `partial` 时保持 unknown。
- 用户可见 message 明确包含“反例存在已知误命中”；partial 时追加“其他规则未完整验证”。
- 反例误触、正例未命中分别失败。
- `partial` 保持未知，`invalid` 明确失败，不展示可执行目标。
- 规则内容修改后从新规则重算；旧 token 或不同 `appKey` 的异步结果被拒绝。
- App 与样例不一致时不验证，避免跨 App 结果串用。
- metadata 不含 `blob:` URL；父传入 URL 不回收，只有组件自建的 `ownedUrl=true` 资源会回收。
- 组件静态渲染可添加当前快照为正/反例，并暴露同 App 设备快照选择与加载边界。

运行目录：`C:\Users\kmttjnm\Desktop\各种项目\project\gkd-rule-builder`。Shell：PowerShell。

```powershell
npx vitest run src/lib/multiSnapshotValidation.test.ts
git diff --check -- src/lib/multiSnapshotValidation.ts src/lib/multiSnapshotValidation.test.ts src/components/MultiSnapshotValidationPanel.tsx src/components/MultiSnapshotValidationPanel.css
```

2026-10-26 改为复用 core 单入口并修正反例文案后，T09 专项 9/9 通过；与 T01 matcher、条件编辑回归合并复跑，3 个测试文件、62 项测试全部通过。`npm run typecheck` 与 T09 写集 `git diff --check` 通过。设备与挂载后浏览器交互仍待主工作区验收。

## 待 core 确认的共同契约

建议 core 统一按以下形状向 T09/AI 多快照调用方提供结果；当前 T09 已按此语义调用现有 `validateAiCandidateAgainstSnapshot`，没有另建 `aggregateRuleValidations`：

```ts
AppRule 命中 = core 对单条规则的匹配结果 satisfied
规则之间 = 任一 rule satisfied 即可
App 状态 = known hit -> 可显示命中；全部 unsatisfied -> unsatisfied；否则 partial/invalid -> 保守 unknown
```

若 core 提供逐规则 `rules`，应同时约定每条规则保留自己的 `status`、`clickNodes` 和 `diagnostics`。这样多快照调用方可以在 negative 已确认误触时展示实际目标，同时让 positive 中存在 `partial`／`invalid` 的规则保持 unknown。此次环境没有可用的 Codex 线程消息工具，未能直接给 core 发消息；请主 agent 将本契约转交 core。

## 主工作区验收与截图

挂载后需在真实工作区完成以下操作，截图保存到正式验证路径，例如 `docs/verification/rule-authoring-t09-workspace.png`：

1. 选一条已有规则，把当前快照分别添加为正例与反例，确认每张卡片显示独立结果、预期、点击目标 ID 和命中数。
2. 把正例改成会不命中的规则，确认正例显示失败；反例误触时确认显示“反例被误触”，且没有总体平均通过。
3. 将含版本范围或其它未知条件的规则作为样例，确认显示 `partial / 未知`，不能显示为设备有效。
4. 修改规则后确认重算；切 App 确认样例隔离。连接设备后从现有快照列表添加同 App 样例、删除样例，并检查无流程步骤变化。
5. 使用浏览器网络面板确认添加、验证、删除过程没有额外上传请求。

截图要求：保存真实挂载后的工作区 PNG，画面应包含规则上下文、正例/反例卡片和具体状态；同时保存验收文本与实际设备/GKD 版本（若测试设备）。不要保存 `blob:` URL、包含未脱敏个人数据的快照或控制台截图为唯一证据。父组件的当前快照 URL 不得由本面板回收；如浏览器流程发现资源泄漏或误回收，应回填本节结论。

## 未验收

- 本 ticket 未修改 `AndroidLiteApp.tsx` 的挂载、样式布局与工作区状态；主 agent 集成前没有真实页面截图。
- 未连接 Android 设备，未从真实设备 HTTP 加载多张快照；设备加载错误、移动端布局、删除后的资源回收和 WebView 行为需主工作区实测。
- 静态全树通过不代表事件查询范围、冷却、累计次数、`preKeys` 或设备动作有效；面板没有提供这种结论。
