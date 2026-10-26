# T03 节点消歧本地验证

日期：2026-10-26

## 交付边界

独立组件 `NodeSelectionPanel` 和 `nodePicker` 候选 helper 已实现。主 agent 负责把它接入 `AndroidLiteApp`；本次不修改 `AndroidLiteApp`、`ScreenshotCanvas`、`regionCandidates`、类型文件或选择器引擎。

面板把选点节点与实际点击节点分开显示。实际点击列表只来自调用方传入的 `clickNodes`；列表同时展示标签、类型、可点击性、绝对像素范围、选点/父节点/同点角色。单一可选项不渲染切换按钮，无节点时显示重新采集操作。

## 公开行为检查

运行目录：仓库根目录；Shell：PowerShell

```powershell
npm test -- --run src/lib/nodePicker.test.ts
npm run typecheck
```

结果：

- 2026-10-26：`nodePicker.test.ts` 10 项通过。
- 2026-10-26：共享 `tsc -b --pretty false` 曾通过；并行 ticket 后续落红时，T03 文件用独立严格类型检查复验通过。
- `code-review-graph update` 成功；新增组件未形成可查询的独立文件节点，影响结论以源码、单测和 typecheck 为准。

覆盖行为：

- 选中文字节点时返回该节点及可点祖先，标签和类型可读。
- 不把占屏幕 95% 以上的整屏容器作为候选。
- 同一点包含多个有意义节点时，可以切换文字节点、热区和父节点。
- 列表选中已有节点时，其中心范围重新参与同点候选，不沿用另一种点击位置。
- `clickNodes=[]` 时不冒充已确认点击范围。
- 单一目标不新增必经选择；无快照/无节点展示恢复文案。

## 未完成验证

- 尚未在 Android WebView 中验收拖动、缩放、列表和返回操作。
- 最终高亮及 `clickNodes` 的真实数据依赖 T01 的共享验证接口和主 agent 集成；本记录不声称设备验收或 T01 已完成。
- 节点编号只作为区分信息；稳定选择器质量仍由现有候选生成和验证链路负责。
