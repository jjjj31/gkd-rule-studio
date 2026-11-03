# GKD 社区手机规则编写经验（2026-10-29）

范围：查阅 GKD 官方项目说明、订阅模板、快照审查工具，以及官方规则仓库中的社区 Issue 与评论。Issue 案例主要发表于 2023 年，规则语义类经验可用于设计提示；具体运行时行为仍应以当前 GKD 版本和真机验证为准。

## 可复用的经验

1. **从手机当前界面抓快照开始，再写选择器。** 快照保留无障碍节点树和应用界面信息；截图适合指出目标位置，但单独截图不足以检查节点属性和父子关系。提规则或求助时应附快照链接/压缩包，并标出要操作的目标和预期行为。官方订阅仓库的 issue 模板要求提交快照；社区维护者在 [#228](https://github.com/gkd-kit/subscription/issues/228) 也要求补充标注目标或直接给出选择器。

2. **`matches` 数组表达有顺序的条件与点击目标，不是 OR。** 社区在 [#1336](https://github.com/gkd-kit/subscription/issues/1336#issuecomment-1784730687) 指出：数组前面的选择器用于条件判断，最后一项提供点击目标；示例中两条互斥路径被误放在同一个数组里，导致条件和目标无法同时满足。需要表达不同路径时，拆成独立规则/`key`，或依据快照设计共同条件与目标。此结论来自 2023 年该仓库维护者讨论，编码前应再对照当前官方选择器和规则 API。

3. **一个界面流程中的多个点击步骤要分开建模。** [#1336](https://github.com/gkd-kit/subscription/issues/1336#issuecomment-1784730687) 给出的修正是：先用一个 `key` 识别并点击关闭/菜单目标，再用下一条规则点击“不感兴趣”。第一步要加足够上下文或状态条件，避免目标持续存在时重复点击。

4. **同时采集触发前、触发后和容易误触的页面。** [#1336](https://github.com/gkd-kit/subscription/issues/1336#issuecomment-1784730687) 中的微信规则以多张快照逐次补强条件：增加稳定容器特征、用 `childCount` 区分处理前后状态、用 `visibleToUser=true` 避免不可见反馈项误触发。经验是每个状态都要有对应快照，条件要能说明“何时该点、何时不该点”。

5. **静态选择器命中不能替代真机运行验证。** [#1336](https://github.com/gkd-kit/subscription/issues/1336) 记录了快照内可选中、选择器执行也能点，但实际规则无法触发的情况；讨论还发现蒙层可能遮挡目标。官方 [inspect 工具](https://github.com/gkd-kit/inspect) 支持连接设备、实时执行点击选择器和启用订阅，适合作为手机端验收路径。验证要区分“快照匹配”“实时规则触发”“点击后页面符合预期”。

6. **命中稀有或不稳定广告时，规则应默认关闭或明确风险。** [#228](https://github.com/gkd-kit/subscription/issues/228) 中维护者合入规则时注明默认关闭；在当时测试版本里长时间没有复现该广告。应用版本、账号和投放状态都可能影响重现，缺少真机复现时不应把“写出了选择器”当作“验证成功”。

## 对安卓版 Rule Studio 的直接建议

- 采集入口优先保留 GKD 手机快照，并在界面上要求用户点选目标、说明期望动作；截图可作辅助标注。
- 对 `matches` 数组逐项说明角色，展示最终点击的是哪一项；检测到疑似把互斥候选当 OR 时提示拆规则。
- 多步流程按状态分条呈现，展示每步的触发条件、目标和防重复条件。
- 支持把多张快照作为正例、反例及不同流程状态；每次改规则后重新显示逐张命中和点击目标。
- 将静态验证、手机实时触发、点击后的结果分别记录，任何一层未知都不要显示为“已验证”。
- 记录应用包名、版本、Activity、快照时间和设备信息，便于复现应用版本或界面差异。

## 一手来源

- [gkd-kit/gkd README](https://github.com/gkd-kit/gkd)：说明 GKD 基于高级选择器、订阅规则和快照审查工作；规则通过本地规则或订阅添加。
- [gkd-kit/subscription](https://github.com/gkd-kit/subscription)：社区规则仓库，Issue 模板要求提交待适配界面的快照。
- [gkd-kit/subscription #1336：学小易在实机中无法触发规则](https://github.com/gkd-kit/subscription/issues/1336)：包含真实规则、快照、设备表现与维护者的 `matches`/多步骤解释。
- [gkd-kit/subscription #228：今日头条小视频广告](https://github.com/gkd-kit/subscription/issues/228)：包含目标标注请求、广告稀有和默认关闭的讨论。
- [gkd-kit/inspect README](https://github.com/gkd-kit/inspect)：列出快照审查、实时执行点击选择器、连接 GKD HTTP 服务等能力。
- [gkd-kit/subscription-template README](https://github.com/gkd-kit/subscription-template)：官方订阅模板的工程组织和构建流程，适合讨论规则库发布，不替代单条规则的手机验证。

