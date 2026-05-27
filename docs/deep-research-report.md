# GKD Rule Studio 规则生成研究报告

## 样本与方法

本次只分析到 **一个** 上传仓库：`GKD_subscription-main`。我对其编译产物 `dist/AIsouler_gkd.json5` 做了程序化统计，并回到 `src/apps` 抽样核对原始写法。样本覆盖 **886 个 apps、2,074 个 groups、3,213 条规则对象、3,581 个 selector 字符串**；因此，这份结论足够支撑“首版自动生成器”的默认策略，但它更接近 **AIsouler 这套订阅的实战风格**，不能直接等价为整个 GKD 生态的唯一标准。（程序统计：上传仓库 `dist/AIsouler_gkd.json5`；样本目录：`src/apps`）

官方 API 语义也很重要，因为你的生成器最后要输出的是 **规则对象** 而不是仅仅输出一个 selector。GKD 官方文档确认：`rules` 可以直接写字符串，也可以写完整 rule 对象；`matches` 表示“全部 selector 都要命中，且点击最后一个 selector 的目标”；`anyMatches` 表示“任一分支命中即可”；`excludeMatches` 表示“命中则停止当前规则”；`activityIds` 采用 `startWith` 语义，且以 `.` 开头时会自动补成 `appId + activityId`；`@` 用来显式指定点击目标，没有 `@` 时默认点击最后一个属性选择器对应的节点。citeturn7view0turn8view0turn8view2turn11view0

对你的工具而言，最关键的不是“能不能拼出复杂 selector”，而是 **能否稳定地先生成简单、可解释、好验证的 selector**。这个仓库的强烈倾向是：**先用最短稳定锚点，再用 activityIds、上下文或父节点点击去收窄；只有在简单模式失败时，才上多跳关系、逻辑表达式、anyMatches、excludeMatches 或正则**。（样本：`src/apps/ai.ling.luka.app.ts:9-19`；`src/apps/com.kurogame.kjq.ts:31-43`；`src/apps/net.duohuo.cyc.ts:26-31`）

## 规则写法研究报告

### matches 模式的主流经验

按 **3,581 个 selector 的出现次数** 统计，允许重叠计数，最常见的信号是：`text` 出现在 **60.6%** 的 selector 中，类型前缀（例如 `Button[...]`、`ImageView[...]`）出现在 **35.2%**，`id` 为 **27.6%**，`vid` 为 **23.1%**，`desc` 为 **12.8%**；显式 `[name=...]` 只有 **7 条**，但“类型前缀 + 属性”其实非常常见。这和官方语法一致：`TextView[...]` 这类写法本质上是 `name` 的简写。citeturn11view0

从“精确锚点”角度看，**`[vid="..."]` 和 `[id="..."]` 是最值得自动生成器优先尝试的两类**。仓库里 `vid` 的**精确等值**写法有 **758** 条，而模糊 `vid*=/vid^=` 只有 **3** 条；`id` 的精确等值有 **770** 条，而 `id*= / id^= / id$=` 合计只有 **17** 条。这说明维护者明显偏好 **精确资源锚点**，而不是“后缀碰碰运气”。典型例子包括 `[vid="tv_skip"]` 的开屏广告、`[vid="close"]` 的弹窗关闭、`[id="scanLogin"]` 的登录确认，以及 `[id="com.ctm:id/iv_close"]` 这类原生关闭按钮。（样本：`src/apps/com.cebbank.mobile.cemb.ts:9-19`；`src/apps/com.kurogame.kjq.ts:31-43`；`src/apps/com.qidian.QDReader.ts:140-143`；`src/apps/com.ctm.ts:17-20`）

从“语义锚点”角度看，**`[text="..."]` 是最常见，但风险差异也最大**。仓库里 `text` 的精确等值有 **1,374** 条，`text*=` **198** 条，`text^=` **197** 条，`text$=` **94** 条，正则 `text~=` 只有 **1** 条。经验上，`text` 不是不能自动生成，而是必须区分两类：一类是 **稳定且场景唯一** 的文案，例如签到、确认登录、进入拷贝漫画；另一类是 **高误触短词**，例如“关闭”“取消”“确定”“以后再说”“暂不”，这类词只有在配合 `activityIds`、对话框标题、或结构关系时才值得高分。仓库里非常典型的写法是用 `matches` 数组先确认上下文，再点击动作按钮，例如通知权限中的 `['[text="通知服务未开启"]', '[text="取消"]']`，或者悬浮窗权限中的 `['[text*="悬浮窗权限"]', '[text="否" || text="暂不"]']`。官方也明确规定：`matches` 是“全部命中后点击最后一项”，这正是你做“上下文 + 目标”生成的基础。citeturn8view0turn11view0（样本：`src/apps/ai.ling.luka.app.ts:9-19`；`src/apps/com.taobao.taobao.ts:275-279`）

**`[text*="跳过"]` / `[text^="跳过"]` 是开屏广告里非常成熟的一类模式，但它不是裸用，而是几乎总带保护条件。** 仓库里常见的保护条件包括 `text.length<10`、`width<500`、`height<300`、`visibleToUser=true`，本质上是在排除超大 CTA、列表项、搜索框、以及动态内容区。官方“查询优化”文档也说明，`id/vid/text/text^/text*/text$` 这类首属性表达式能与 `fastQuery` 形成高效组合；因此对你的生成器来说，**“跳过类模糊文本 + 长度/尺寸/可见性保护”** 是一个非常适合 MVP 的中风险策略。citeturn10view0（样本：`src/apps/com.xunlei.downloadprovider.ts:20-24`；`src/apps/com.chunqiu.ah.ts:18-22`；`src/apps/com.baidu.tieba.ts:18-22`）

**`[desc="..."]` 的价值在于无文字按钮和无障碍友好的关闭图标。** 它的量级不大，但质量通常不错，尤其适合“关闭喵”“我知道了”“确定”这类 accessibility label 明确的按钮。仓库里 `desc` 精确等值 **209** 条，模糊 `desc*= / desc^= / desc$=` 合计 **50** 条，正则只有 **1** 条。这说明 `desc` 适合做 **高分补充策略**，不适合作为生成器的唯一主路径。（样本：`src/apps/com.gentle.ppcat.ts:36-39`；`src/apps/com.xsj.app.ts:41-43`；`src/apps/com.tencent.mm.ts:510-513`）

**“name + 属性”在仓库里分成两类：类型前缀常见，显式 `[name=...]` 极少。** `Button[text="签到"]`、`Image[text="关闭弹屏"]`、`TextView[text="不感兴趣"]` 这类写法很多，因为它们比裸 `[text="..."]` 更稳；但显式 `[name$="UIText" || name$="ViewGroup"]` 只有极少数案例，多见于 Compose、Flutter、WebView 混合层或特殊 SDK，因此它更适合高级版，而不是首版默认策略。官方语法说明也明确把 `TextView` 这种前缀视为 `name` 的简写，这恰好支持你把“类型前缀”做成一个单独策略层。citeturn11view0（样本：`src/apps/com.kuangxiangciweimao.novel.ts:53-55`；`src/apps/com.eg.android.AlipayGphone.ts:271-273`；`src/apps/com.dragon.read.ts:239-244`）

**`@` 是仓库里极其常用的“点击目标重定向”机制。** 3,581 个 selector 里，有 **1,427** 条包含 `@`。官方语法说明：`@` 表示“选择此节点”，并且 **一条规则最后一个 `@` 生效**；如果没有 `@`，默认取最后一个属性选择器作为点击目标。对自动生成器来说，这意味着两条硬规则：第一，**最终产出的 selector 最好只保留一个 `@`**；第二，**当用户点到的是文案子节点、图标子节点，但真正可点击的是父容器时，应该自动尝试“抬升点击目标”**。仓库里最典型的形态就是 `@[clickable=true] > [text="跳过"]`，也就是“看到子文本，但点击父节点”；还会出现 `@[text="取消"] + [text="立即升级"]` 这种“取消按钮和正向 CTA 同层，显式指定点左侧取消”的模式。citeturn11view0（样本：`src/apps/net.duohuo.cyc.ts:26-31`；`src/apps/cn.xuexi.android.ts:9-17`）

结构关系方面，仓库里 **一跳关系非常多，多跳关系主要留给高级场景**。大致上，包含 `>` 的 selector 有 **1,177** 条，包含 `<` 的有 **798** 条，包含 `+` 的有 **753** 条，包含 `-` 的有 **487** 条。你真正该先做好的，是这三类：一是 **直接父子**，如 `@[clickable=true] > [text="跳过"]`；二是 **相邻按钮配对**，如 `[text="取消"] + [text="允许"]`、`[text="温馨提示"] +2 [text="确定"]`；三是 **从标题或广告标识回溯到关闭位**，如 `[text="开启通知"] <n * > [text="暂不开启"]`。而 `<n`、`<<n`、`+5`、混合多跳、嵌套关系，虽然实际仓库里不少，但更适合高级版与 AI 兜底。官方语法文档也把 `+ - > < <<` 统一定义为关系操作符；这说明你的生成器不需要一开始就覆盖全语法，而是可以按“跳数”分层实现。citeturn11view0（样本：`src/apps/com.google.android.documentsui.ts:20-22`；`src/apps/com.rocoplayer.app.nm.ts:9-18`；`src/apps/com.baidu.tieba.ts:64-68`）

复杂表达式在仓库里是**少数但有价值**的能力。包含 `||` 的 selector 有 **407** 条，包含 `&&` 的有 **377** 条，正则 `~=` 只有 **2** 条。经验上，`||` 的主要用途是 **版本差异 / 文案差异 / 简繁差异合并**，例如 `[text="否" || text="暂不"]`、`[text="允许" || text="允許"]`；正则则只在文本模式非常不稳定、但又有明显句式时才使用。这类写法对人工或 AI 很友好，但不适合首版自动生成器把它当成默认产物，因为一旦生成得过宽，就很难解释误触原因。官方优化文档还提示：只有当最终属性选择器的**第一个属性表达式**是 `id/vid/text` 家族时，`fastQuery` 才能发挥效果；如果你把 `childCount` 写在 `id` 前面，优化就没了；如果用了 `!(...)`，内部快查会被取消。citeturn10view0turn11view0（样本：`src/apps/com.taobao.taobao.ts:275-279`；`src/apps/com.tencent.mm.ts:158-162`；`src/apps/com.miui.player.ts:93-97`）

### activityIds、groups、rules 的经验总结

这套仓库最重要的规律之一，是 **activityIds 不是“可有可无的附加项”，而是绝大多数规则的核心收窄条件**。如果看“最终生效规则作用域”，3,213 条规则中，**88.2%** 实际受 `activityIds` 约束，只有 **11.8%** 完全不写。进一步看分组类型：**局部广告 98.6%**、**分段广告 98.3%**、**全屏广告 95.4%**、**功能类 95.8%**、**权限提示 90.5%**、**评价提示 91.2%** 都高度依赖 activity 约束；唯一例外是 **开屏广告**，只有 **3.8%** 受 activity 约束。（程序统计：上传仓库 `dist/AIsouler_gkd.json5`）

这意味着你的工具应该把 `activityIds` 生成策略写成“强约束开关”，而不是“可选美化项”。我的建议很明确：**只要核心信号是 generic text、`@` 抬父、兄弟关系、祖先关系、广告标签回溯、或 feed/list 内局部关闭，就默认强制写 `activityIds`；只有开屏广告、且主锚点本身已经是强 skip 信号时，才允许不写。** 仓库中与此完全一致：开屏广告常用 `matchTime=10000 + actionMaximum=1 + resetMatch='app'` 去缩短危险窗口，而不是靠 activity 去硬锁；相反，局部广告、分段广告、权限弹窗几乎总是先锁界面再选节点。（样本：`src/apps/info.muge.appshare.ts:9-24`；`src/apps/ai.ling.luka.app.ts:9-19`；`src/apps/com.apkpure.aegon.ts:44-58`） citeturn7view0turn7view4

关于 `activityIds` 的具体写法，仓库里**单个 activity** 远多于数组：group 级单字符串 **186** 组，规则级单字符串 **1,962** 条；**多 activity** 主要出现在“同类页面跨多个容器复用”的场景，比如同一类广告入口在多个 Tab/Activity 都会出现，或同一功能在不同入口复用同一个模板。`com.apkpure.aegon` 的“更新界面软件推荐”就是典型的多 activityIds 场景；而 `ai.ling.luka.app` 的通知权限则是典型单 activity 场景。官方文档确认：`activityIds` 用的是 `startWith` 逻辑，以 `.` 开头可以写短名，这非常适合你的生成器优先输出短相对名。citeturn7view0turn8view2（样本：`src/apps/com.apkpure.aegon.ts:44-58`；`src/apps/ai.ling.luka.app.ts:16-19`）

`groups` 的命名风格非常统一，适合你做规则分类器。按前缀统计，最多的是 **全屏广告 587 组**、**局部广告 332 组**、**功能类 280 组**、**更新提示 225 组**、**权限提示 190 组**、**开屏广告 156 组**、**分段广告 130 组**、**通知提示 59 组**、**评价提示 56 组**、**青少年模式 10 组**。其中“普通确认弹窗”并不是一个独立大前缀，它更多被吸收到 **通知提示** 或 **功能类** 里，例如“公告弹窗”“温馨提示弹窗”“自动确认登录”。这意味着你的生成器如果要自动建议 group name，最好先做“规则类型分类器”，而不是硬编码一套固定前缀。（样本：`src/apps/info.muge.appshare.ts:230-242`；`src/apps/com.rocoplayer.app.nm.ts:9-18`；`src/apps/com.qidian.QDReader.ts:140-143`）

在 `rules` 层面，最显著的事实是：**`matches` 绝对主导，`anyMatches` 和 `excludeMatches` 都是少数高级能力。** 3,213 条规则里，`matches` 出现 **3,126** 次；`anyMatches` 只有 **58** 条；`excludeMatches` 只有 **34** 条；`preKeys` 有 **238** 条。进一步看 `matches` 的形态，**91.6%** 是单 selector，**8.4%** 是双 selector 的“上下文 + 目标”链。这个比例对你的 MVP 非常关键：**首版生成器只要把“单 selector”与“双 selector context chain”这两类做好，就已经覆盖仓库里绝大多数写法。** 官方规则语义也完全支持这种设计。citeturn8view0turn8view4（样本：`src/apps/ai.ling.luka.app.ts:16-19`；`src/apps/com.taobao.taobao.ts:275-279`；`src/apps/info.muge.appshare.ts:101-106`）

### fastQuery、matchTime、actionMaximum、resetMatch 的场景归纳

`fastQuery` 在这套仓库里并不是“随手一开”，而是有明显偏向。它出现在 **38.2% 的 groups** 和 **43.5% 的 rules** 中，在 **更新提示、权限提示、分段广告、青少年模式、开屏广告** 里最常见。官方文档解释得很清楚：它依赖 Android 的按 `viewId`/`text` 快速查找能力，只有当**末尾属性选择器的第一个属性表达式**属于 `id/vid/text/text^/text*/text$` 家族时，这个优化才真正成立；而且属性顺序会影响优化是否生效。对你的生成器来说，这直接变成了一个确定性规则：**凡是你准备自动加 `fastQuery: true` 的 selector，都必须把 `id/vid/text` 家族表达式排在第一个属性表达式位置。** citeturn10view0turn7view0

`matchTime` 主要是 **短时危险窗口控制器**。仓库里 group 级 `matchTime` 有 **907** 组，其中 **903 组**都是 `10000` 毫秒；rule 级非常少。官方文档特别点名：当某些页面的 activityId 太宽、但目标只会在短时间出现时，有限匹配窗口可以减少误触。这和仓库的实际写法完全一致：开屏广告、更新提示、权限提示、公告弹窗、青少年模式，最常见的就是 `matchTime: 10000`。citeturn7view0（样本：`src/apps/com.cebbank.mobile.cemb.ts:9-19`；`src/apps/cn.xuexi.android.ts:9-17`；`src/apps/ai.ling.luka.app.ts:9-19`）

`actionMaximum` 在仓库里几乎等价于“**一次性弹窗就点一次**”。group 级共有 **1,058** 组设置了它，其中 **1,049** 组是 `1`；少数是 `2` 或 `3`。官方文档也把它直接解释为适用于开屏广告、更新弹窗、青少年弹窗这类“只需要触发一次”的规则。少量 `actionMaximum=2/3` 的例外，往往出现在 **虚假跳过按钮**、**多阶段弹窗**、或者 **同一组里有多个变体** 的场景。`com.weilaishanhai.oopz` 甚至在说明里明确写出：该 app 部分开屏广告存在“虚假跳过按钮”，不能适配所有情况，所以把 `actionMaximum` 放宽到 2 并配合优先窗口。citeturn7view0（样本：`src/apps/com.weilaishanhai.oopz.ts:9-21`）

`resetMatch` 是最容易被自动生成器忽略、但实际上非常有用的字段。官方默认是 `'activity'`，但这套仓库里**绝大多数显式设置都改成了 `'app'`**：group 级共有 **996** 组显式设置，其中 **993** 组是 `'app'`，只有 **3** 组是 `'activity'`；rule 级还有 **1** 个 `'match'`。经验上可以直接总结成三条：**一次性广告/弹窗** 用 `'app'`；**同一 activity 内反复切换的功能流** 可以考虑 `'match'`；**必须在同一 activity 刷新后再次触发的流程** 才考虑 `'activity'`。仓库中的钉钉扫码登录、支付宝余额宝转出勾选、京东“展开全部订单信息”正好对应这三类。citeturn7view0（样本：`src/apps/com.alibaba.android.rimet.ts:81-90`；`src/apps/com.eg.android.AlipayGphone.ts:556-566`；`src/apps/com.jingdong.app.mall.ts:292-302`）

从风险控制角度看，这个仓库还给了你几个很实用的“反误触”注释证据：有的规则必须加 `actionDelay`，否则会误触；有的页面要用 `excludeMatches` 排除搜索页，否则会点到键盘；有的开屏广告如果用 `[text*="跳过"]` 会误触搜索框，因此改成 `vid`；还有的场景不能用 `clickCenter`，必须点 `clickable=true` 节点本身。这些都不是理论问题，而是维护者已经踩过的坑。官方动作说明也支持这个判断：`clickCenter` 会点屏幕坐标，如果节点被遮挡，实际点到的是最上层节点；而 `clickNode` / 默认 `click` 在节点可点时更安全。citeturn8view3（样本：`src/apps/com.magicalstory.AppStore.ts:15-23`；`src/apps/info.muge.appshare.ts:157-160`；`src/apps/tv.danmaku.bili.ts:19-22,288-296`）

## Selector 自动生成策略表

下面的“推荐分数”表示**生成优先级基准分**，不是最终置信度。最终置信度还应再叠加：命中数、activityIds 是否齐全、点击节点 bounds、是否命中危险 CTA 文案、以及是否需要人工确认。（评分依据：上传仓库统计 + 官方 `matches/@/fastQuery` 语义 + 仓库误触注释案例） citeturn8view0turn10view0turn11view0turn8view3

| strategyName | 适用条件 | 生成 selector 形态 | 推荐分数 | 风险等级 | 适合场景 | 不适合场景 | 是否适合 MVP | 原因 |
|---|---|---|---:|---|---|---|---|---|
| exactVid | 点击节点有非空 `vid`，快照内唯一命中 | `[vid="xxx"]` | 95 | low | 开屏、弹窗关闭、公告确认 | `vid` 重复、空值、广告 SDK 复用层 | 是 | 仓库中 `vid` 精确写法多，且天然适合 `fastQuery` |
| exactId | 点击节点有完整 `id`，快照内唯一命中 | `[id="pkg:id/xxx"]` | 93 | low | 原生按钮、登录确认、系统弹窗 | 多壳 package 变化、广告 SDK 动态 id | 是 | 精确资源锚点稳定，`fastQuery` 友好 |
| exactDesc | 点击节点有明确 `desc`，且是按钮/图标语义 | `[desc="xxx"]` | 82 | low | 图标关闭、无文字按钮、我知道了 | 描述文案动态、营销词 | 是 | 量不如 `id/vid/text` 大，但常用于关闭图标 |
| typePlusExactAttr | 节点类型明显有帮助 | `Button[text="签到"]` / `ImageView[desc="关闭"]` | 84 | low | 原生控件、签到/确认、图标关闭 | WebView/Compose 混合层类型漂移 | 是 | 比裸文本更稳，类型前缀在仓库里很常见 |
| exactTextWithContext | 目标文本是“取消/暂不/以后再说”等短词，但可找到标题或语义上下文 | `matches: ['[text="标题"]','[text="取消"]']` | 80 | medium | 权限、更新、评分、公告 | feed 列表、广告卡片、主页面复用词 | 是 | 仓库里双 selector `matches` 主要就用在这类场景 |
| textSkipGuarded | 文本含“跳过”，且小尺寸、短文本、可见 | `[text*="跳过"][text.length<10][width<...][height<...][visibleToUser=true]` | 78 | medium | 开屏广告、倒计时跳过 | 搜索框、输入框、内容按钮 | 是 | 是最成熟的开屏 fallback 之一 |
| clickParentDirectChildText | 子文本可见但本身不可点，父节点 clickable | `@[clickable=true] > [text="跳过"]` | 76 | medium | 文案按钮、伪文本按钮、卡片关闭 | 父节点特别大、整卡可点广告 | 是 | `@` 是仓库高频机制，适合“抬点击” |
| clickParentByChildIdVid | 子节点有 `id/vid/desc`，父节点 clickable | `@[clickable=true] > [id="close"]` / `@[clickable=true] > [vid="close"]` | 79 | medium | 关闭图标、角标按钮 | 父容器占屏过大 | 是 | 兼顾稳定锚点与可点击性 |
| simpleSiblingCancelVsCTA | 取消按钮和正向 CTA 同层可定位 | `@[text="取消"] + [text="立即升级"]` / `[text="取消"] + [text="允许"]` | 74 | medium | 更新、权限、评分、确认框 | 信息流广告卡片、复杂布局 | 是 | 一跳兄弟关系可解释、规则短 |
| simpleContextRelation | 需要一跳结构辅助，但不需要多跳 | `[text="温馨提示"] +2 [text="确定"]` / `ViewGroup > [text="广告"]` | 72 | medium | 传统弹窗、简单卡片 | 深层嵌套 WebView / Compose | 是 | 一跳关系足够覆盖很多“标题 + 按钮” |
| idSuffixFallback | 只有 id 后缀稳定，包名前缀不稳定 | `[id$="nativeclose"]` / `[id$="tv_close"]` | 68 | medium | 多壳/多包名、广告 SDK | 后缀太常见、容易串 | 否 | 仓库里有，但数量很少，适合次级 fallback |
| oneHopAncestorBacktrack | 需要从标题/广告标识回溯到关闭位 | `[text="升级提示"] < * + [vid="btn_close"]` | 66 | medium | 传统弹窗 close icon | 多层列表、复杂页面 | 否 | 有价值，但比一跳兄弟/父子更难解释 |
| logicalOrVariantUnion | 有明确版本差异或简繁差异 | `[text="否" \|\| text="暂不"]` | 62 | medium | 多文案版本兼容 | 首版单快照自动生成 | 否 | 适合“验证失败后扩展”，不适合首发默认 |
| anyMatchesVariantFallback | 同一动作在不同版本有多个候选按钮 | `anyMatches: ['A','B']` | 58 | medium | 多版本兼容、按钮风格变化 | 需要强可解释性的 MVP | 否 | 官方支持，但仓库里是少数高级用法 |
| excludeMatchesSafetyNet | 已知有误触页面或危险重叠态 | `excludeMatches: '[text="热门搜索"]'` | 55 | medium | 搜索页、安装流程、重叠页面 | 首版自动生成 | 否 | 更适合“验证后修正”而不是“首轮生成” |
| explicitNameAttr | 只有 `name` 模式可区分节点 | `[name$="UIText" \|\| name$="ViewGroup"]` | 45 | high | Compose/Flutter 特殊层 | 一般 native 页面 | 否 | 仓库极少，且维护成本高 |
| regexAttrFallback | 文案模式不固定，但句式稳定 | `[desc~=".*关闭.*按钮.*"]` | 35 | high | 极少数特殊描述 | 任何常规弹窗 | 否 | 样本极少，解释性差 |
| multiHopRelation | 需要 `<n`、`<<n`、`+5`、`>3` 这类多跳回溯 | `A <n * > B` / `A <<n B` | 40 | high | 广告卡片、复杂 WebView | 首版自动生成 | 否 | 适合高级版与 AI 兜底 |
| preKeysMultiStep | 需要“关闭原因 -> 确认关闭”这类联动 | `preKeys + 多规则` | 48 | high | 多阶段流程 | 简单单击场景 | 否 | 这是规则流，不是单 selector 问题 |

## MVP 第一版优先策略

MVP 应该优先做 **低风险、强解释、可在单个快照中验证唯一命中** 的策略。我建议把第一版控制在下面这 **10 条**：

- `exactVid`：先试 `[vid="xxx"]`，如果唯一命中且目标可点，直接输出；这是最稳妥的第一优先级。
- `exactId`：其次试 `[id="pkg:id/xxx"]`，适合原生按钮与确认弹窗。
- `exactDesc`：适合关闭图标、无文字确认按钮、`我知道了` 一类节点。
- `typePlusExactAttr`：例如 `Button[text="签到"]`、`ImageView[desc="关闭"]`，用于降低裸文本歧义。
- `exactTextWithContext`：当目标文本是“取消/暂不/以后再说”等 generic 短词时，自动构造 `matches` 数组，把标题或提示文案放前面，动作按钮放最后。
- `textSkipGuarded`：专门给开屏广告准备，要求同时满足“跳过语义 + 短文本 + 小尺寸 + visibleToUser”。
- `clickParentDirectChildText`：当点击节点本身不可点，而父节点 clickable 时，自动升格为 `@[clickable=true] > child`。
- `clickParentByChildIdVid`：当关闭图标本身只是图片层或子节点，但父节点是点击热区时，自动改成父点击。
- `simpleSiblingCancelVsCTA`：针对更新/权限/评分/确认类弹窗，当“取消/暂不”与“允许/立即升级/好评”是同层关系时，生成一跳兄弟关系。
- `simpleContextRelation`：只支持一跳关系，不支持多跳；例如“温馨提示 +2 确定”“父容器 > 子按钮”。

这 10 条之所以适合 MVP，不是因为它们“最全”，而是因为它们基本都能在你当前的产品流程里做成 **确定性算法**：用户点击截图目标节点后，先取原节点属性；若不可点，抬一层 clickable 父；若文本过于 generic，就补上下文；若还是多命中，再回退到人工确认。仓库本身也强烈支持这种分层思路：大多数规则要么是单 selector，要么是两个 `matches` 的上下文链；真正依赖 `anyMatches`、正则、多跳关系的比例并不高。（样本：`src/apps/ai.ling.luka.app.ts:16-19`；`src/apps/com.cebbank.mobile.cemb.ts:15-19`；`src/apps/net.duohuo.cyc.ts:26-31`；`src/apps/com.google.android.documentsui.ts:20-22`）

## 高级版本后续策略

高级版再做的内容，我建议集中在“复杂结构 + 兼容差异 + 多阶段流程”这三类：

- 多跳祖先/子孙关系：`<n`、`<<n`、`+5`、`>3` 这类关系式。
- 显式 `name` 属性和复杂类型约束：`[name$="UIText"]`、`[name$="ViewGroup"]`。
- 逻辑表达式：`||`、`&&`、带取反的组合选择器。
- 版本兼容 fallback：`anyMatches` 的 2~4 分支备选。
- 排除安全网：`excludeMatches` / `excludeActivityIds`。
- 多规则联动：`preKeys`、“关闭广告 -> 选择关闭原因 -> 确认关闭”。
- `matchRoot` 场景：事件节点不在目标子树中时，从根重查。
- `id$=` / `text$=` / `desc^=` 等模糊匹配扩展。
- 特殊动作策略：`position`、`clickCenter`、`back`、`swipe`。
- 多快照归纳：同一规则根据多个快照自动合并成 `logicalOrVariantUnion` 或 `multiActivityScope`。

这些内容不是“不重要”，而是 **更依赖验证环节和人工理解**。尤其是多跳关系、`excludeMatches`、正则和 `anyMatches`，一旦生成错了，误触很难解释；而首版工具最需要的是“点一下就能看懂为什么这么生成”。

## TypeScript 模块设计建议

### selectorStrategies.ts

这个模块建议做成 **策略注册表 + 统一候选接口**，不要把逻辑散在 picker 或 scoring 里。核心职责是：接收 `GenerationContext`，输出若干 `SelectorCandidate`。`GenerationContext` 至少应包含：当前 appId、activityId、被点击节点、祖先链、兄弟节点、命中点坐标、快照全树、初步规则类型。`SelectorCandidate` 至少应包含：`matches`、可选 `activityIds`、`strategyName`、`baseScore`、`needsAtTarget`、`requiresFastQueryFriendlyOrder`、`debugReason`。

这里要特别做两件事。第一，**统一输出完整 rule 结构**，即便最终序列化时可以压缩成字符串 shorthand，也不要在生成阶段直接用 shorthand，因为那会让后面的风险评分和验证更难做；而且官方 API 也明确说明，字符串规则只是 `matches` 的简写。citeturn7view0 第二，**把 fastQuery 友好的属性顺序内置到策略里**：凡是准备打 `fastQuery: true` 的候选，必须把 `id/vid/text` 家族表达式放到第一个属性表达式位置，否则就算字段写出来，也拿不到查询优化。citeturn10view0

### riskScoring.ts

这个模块不要只给一个总分，而应该输出 `RiskBreakdown`。我建议评分公式写成显式累计项，便于前端展示：

`finalScore = baseScore + uniquenessBonus + activityBonus + compactBoundsBonus + clickableBonus + contextBonus - genericTextPenalty - ctaPenalty - largeParentPenalty - multiHitPenalty - complexityPenalty - noActivityPenalty`

其中，最关键的确定性规则可以直接定死：

- `hitCount === 1`：`+18`；`hitCount > 1`：每多一个 `-12`。
- 单 activityId：`+12`；多 activityIds：`+6`；没有 activityIds 且不是开屏：`-18`。
- 目标节点面积占屏幕 `<= 3%`：`+12`；`<= 8%`：`+6`；`> 20%`：`-18`；`> 35%`：`-35`。
- 如果最终点击目标文本/描述命中危险 CTA 词表：`-50` 直接降为人工确认。
- 如果文本是 “关闭/取消/确定/知道了/以后再说/暂不” 这类 generic 词，且没有上下文 selector：`-20`。
- 使用 `@` 且父节点面积明显大于子节点，比如 `parentArea / childArea > 6` 且 `parentArea > 20%`：再 `-20`。
- 含 `||`、`&&`、`<n`、`<<n`、正则、`anyMatches`、`excludeMatches`：按复杂度逐项扣分。

这样做的好处是：**用户能看到为什么分数低**，而不是只看到“低置信度”。

### nodePicker.ts

这个模块的职责不是“找一个点中的节点”这么简单，而是**根据用户点位构建稳定的候选语义上下文**。推荐流程是：

先取所有包含点击点的可见节点，按“层级更深、面积更小、中心离点击点更近”排序；第一候选作为 `pickedNode`。然后构建祖先链、兄弟列表、最近 clickable 祖先、最近 title/label/CTA 文本节点。接着把这些信息交给 `selectorStrategies.ts` 逐个生成候选，再把候选交给验证器跑一次命中测试。最后，按 `riskScoring.ts` 返回排序结果。

这个模块还应该内置几条硬规则。第一，**不可点击文本优先尝试 clickable 祖先，但最多抬到 3~4 层**；再往上大概率就变成“整卡可点”。第二，**如果被点击的是 Image/Icon 且本身无稳定属性，优先寻找同层的广告标签、标题、CTA 文案做上下文，而不是直接生成泛化的父节点点击。** 第三，**如果点中多个 close icon 候选，优先保留离点击点最近且面积最小的那个。** 这三条会直接提升首版可用性。

## 反流氓广告 UI 风险规则

下面这部分建议你直接落成产品内的“安全规则表”，而不是只存在文档里。

| 风险点 | 确定性规则 | 处理建议 |
|---|---|---|
| 避免点到下载 / 打开 / 查看详情 | 若**最终点击目标**的 `text/desc/id/vid` 命中 `下载、安装、打开、查看详情、浏览、去看看、去微信看看、立即下载、立即打开、去逛逛` 等词，且规则类型是广告/弹窗关闭，则直接判高危 | 直接降为人工确认；只有当这些词**只出现在上下文节点**而非最终点击目标时，才允许通过 |
| 识别父节点过大风险 | `@` 抬到父节点后，若父节点面积 `> 20%` 屏幕判中危，`> 35%` 判高危；若 `parentArea / childArea > 6` 且子节点是小 close icon，也判高危 | 优先尝试更近、更小的 clickable 祖先；否则要求人工确认 |
| 倒计时文本处理 | 仅当文本或描述包含“跳过”，并同时满足 `text.length<10`、`width/height` 小、`visibleToUser=true` 时，才允许作为开屏策略；**不要**对纯数字倒计时或“3s/5s”单独生成规则 | 开屏策略可高分；非开屏页面则降分 |
| 多个关闭按钮 | 若同一候选 selector 在当前快照命中多个 close/icon 节点，则必须排序：离点击点更近、面积更小、所在弹窗容器更紧的优先；若 top2 分差过小，弹人工确认 | 不允许静默写库 |
| 不可点击子节点与可点击父节点 | 子节点不可点击、父节点 clickable 时，允许自动生成 `@parent > child`；但父节点面积过大、或父节点本身有 CTA 语义时，不直接通过 | 优先保留 child 作为上下文，把 parent 只作为点击目标 |
| 低置信度提示 | 当 `finalScore < 70`、`hitCount != 1`、命中危险词、或使用高级策略（regex/anyMatches/excludeMatches/多跳关系）时，必须提示人工确认 | 前端展示：命中数、activityIds、点击节点 bounds、风险扣分、备选 selector 前三名 |

这套风险规则不是纸上谈兵，仓库里已经给出了多个实战警告。`com.weilaishanhai.oopz` 直接写明“部分开屏广告存在虚假跳过按钮，若点击会误触广告”；`tv.danmaku.bili` 明确备注 `[text*="跳过"]` 可能误触搜索框，因此改用 `vid`；同文件还提示某些场景使用 `clickCenter` 会误触，应该点击 `clickable=true` 节点；`info.muge.appshare` 用 `excludeMatches` 排除了搜索页，避免误触键盘；`com.magicalstory.AppStore` 甚至说明没加 `actionDelay` 会误触。再结合官方动作说明里对 `clickCenter` 的风险描述，你的工具完全可以把“安全优先”做成硬约束，而不是交给用户自己猜。citeturn8view3（样本：`src/apps/com.weilaishanhai.oopz.ts:9-21`；`src/apps/tv.danmaku.bili.ts:19-22,288-296`；`src/apps/info.muge.appshare.ts:157-160`；`src/apps/com.magicalstory.AppStore.ts:15-23`）

综合成一句最适合落地为算法的话，就是：

**先生成“短、准、唯一”的 selector；如果必须靠 generic text、结构关系或父节点点击才能成立，就强制加 activityIds、做 hitCount 验证、做 bounds 风险扣分；如果还不够稳，就不要自动写库，而是让用户确认。**

这也是这批规则样本给出的最稳定经验。
