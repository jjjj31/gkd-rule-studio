# GKD 规则生成基准：数据、方案 B/C 结果与复现

## 结论

- 方案 C（用真机数据集评测并优化本地启发式）把测试集语义 Top-1 从 66.4% 提升到 98.5%，Top-3 从 76.7% 提升到 98.7%，任一候选命中 98.7%。
- 方案 B（相似案例检索）在 610 条测试样本上，Top-1 检索到同类型规则的比例为 98.4%，Top-3 为 99.5%，检索结果全部来自其他应用（跨应用 100%）。
- 方案 D（48 特征点对点逻辑回归排序模型）测试集 Top-1 98.69%，只比当前规则排序高 1 条；该增益来自“是否唯一命中用户所选控件”这一个特征，不接入生产。
- 95.9% 那一版有测量问题：排序用的命中集合带了 `activityIds` 范围，Activity 与快照不一致时命中集合为空，排序退化成纯按基础分。改为只按选择器判断命中后，同一套规则引擎直接到 98.5%。
- 新增跨版本稳定性基准：同一应用、同一 Activity、同一控件的两张快照，用 A 生成的 Top-1 规则去验证 B。2,230 对样本上稳定性从 63.3% 提升到 **70.2%**（按写法分三档重排），单张快照命中率保持 98.5%。

## 数据集

数据根目录：`D:\gkd-dataset`

| 项目 | 数量 |
| --- | --- |
| 已下载快照 | 5,563 |
| AST 验证通过的真值对 | 6,419 |
| 清洗后保留 | 5,539 |
| 训练集 | 4,566 条 / 771 应用 |
| 验证集 | 363 条 / 73 应用 |
| 测试集 | 610 条 / 101 应用 |
| Few-Shot 库 | 4,566 条 |

切分方式：按 `appId` 的 SHA1 做 80/10/10 切分，同一应用只出现在一个集合，测试集应用在训练集中完全未见。

清洗剔除：

| 原因 | 数量 |
| --- | --- |
| 选择器在快照中命中多个目标（无法确定唯一真值） | 121 |
| 同一快照内重复目标（保留首条） | 759 |
| 快照文件缺失 | 0 |

## 方案 C：启发式候选评测

测试集 610 条，指标为“候选点击的节点集合是否等于官方标注目标节点”。

| 版本 | Top-1 | Top-3 | Top-5 | 任一命中 |
| --- | --- | --- | --- | --- |
| 基线（旧选择器引擎） | 66.4% | 76.7% | 80.5% | 83.6% |
| 加载 beta 选择器引擎 | 69.8% | 81.1% | 85.1% | 88.5% |
| + 同框候选偏离降权 | 77.5% | 85.7% | 86.9% | 88.5% |
| + 全部策略偏离降权 | 80.3% | 85.9% | 87.0% | 88.5% |
| + 匿名可点控件文字锚点 | 81.0% | 86.6% | 87.9% | 89.2% |
| + 视觉摞合并与硬排序 | **86.7%** | **88.2%** | **89.0%** | **89.2%** |
| + 多命中自动收窄 | **88.4%** | **89.8%** | **90.7%** | **90.8%** |
| + 层级结构收窄 | **93.0%** | **94.4%** | **95.2%** | **95.4%** |
| + 匿名结构兜底 | 95.9% | 97.7% | 98.5% | 98.7% |
| + 排序只看选择器命中，不绑定 activityIds | **98.5%** | **98.7%** | **98.7%** | **98.7%** |

“视觉摞”指文字、图标、背景容器拥有几乎相同矩形的节点组。安卓界面里这类重叠非常常见：
610 条测试样本中，每个目标周围中位数有 14 个近乎同尺寸的节点。它们多数是父子关系或同父兄弟，
视觉上是同一个控件，不能互相判为“点偏”。

“多命中自动收窄”针对目标文本在界面上重复出现的情况：当 `[text="关闭"]` 这类选择器同时命中多个控件时，
自动尝试用唯一的祖先文字、相邻兄弟文字或父容器加约束，并要求收窄后的最终规则只点中用户所选控件。
动作计划如果在最后一步放宽了选择器，该收窄候选会被丢弃，避免“收窄后反而点到别的控件”。

“层级结构收窄”针对没有文字、id、vid 的匿名控件：用 `childCount`、宽高上限、直接父容器
和父容器下的子控件类型组合定位。这里同时修复了一个根因 bug：数值 `eq` 曾被序列化成
`childCount="1"`，GKD 会按字符串处理，导致所有结构条件都匹配不到；正确写法是 `childCount=1`。

“匿名结构兜底”会先把“类型 + 可点性 + childCount + 尺寸”作为普通候选生成；仍不唯一时，
再依次尝试加 `index`、`depth`，最后两者同时加。`index`/`depth` 稳定性较差，因此基础分较低，
只在没有文字/id/vid 可用时启用，并在候选说明里提示换版本后需复核。

分类 Top-1：

| 规则形态 | 样本数 | Top-1 |
| --- | --- | --- |
| `attr_only` | 199 | 100% |
| `sibling` | 91 | 100% |
| `hierarchy` | 253 | 96.4% |
| `union` | 67 | 100% |

其他维度：

| 维度 | 样本数 | Top-1 |
| --- | --- | --- |
| 目标无 vid | 439 | 98.6% |
| 目标有 vid | 171 | 98.2% |

补充：选择器字符串完全一致（exact）的 Top-1 为 3.6%。这是预期结果——同一目标可以有多种等价写法，因此主指标采用语义命中，而不是字符串相等。

## 方案 B：相似案例检索

库为训练集 4,566 条，查询为测试集 610 条。特征包含控件类型、文本、vid、id、可点击性、父子与兄弟上下文，使用加权余弦相似度。

| 指标 | 结果 |
| --- | --- |
| Top-1 同规则类型 | 98.4% |
| Top-3 同规则类型 | 99.5% |
| Top-1 跨应用 | 100% |
| 平均 Top-1 相似度 | 0.959 |

检索结果用于构建 Few-Shot Prompt：给出 3 条同类型、跨应用的标准选择器及其目标节点描述，让模型学习“这类界面该用哪种写法”，而不是记忆具体应用。

## 方案 D：小型排序模型（实验，未接入生产）

做法：每条测试样本用现有策略生成全部候选，提取 48 个特征（命中数量、是否命中用户所选控件、
是否在视觉摞内、规则形态、条件属性、目标控件属性、策略名等），用 sklearn 逻辑回归训练
“这个候选是否唯一点中官方目标”，按模型分数重排候选。

| 指标 | 规则排序 | 排序模型 |
| --- | --- | --- |
| Top-1 | 98.52% | 98.69% |
| Top-3 | 98.69% | 98.69% |
| 任一候选命中 | 98.69% | 98.69% |

结论：模型只多排对 1 条（`12642798:59`），且这 1 条它选的是 `structuralTargetFallback`
（匿名 `index`/`depth` 结构规则），换版本容易失配；规则排序选的是更稳的
`ambiguousTargetNarrowing`。48 个特征里 25 个权重接近 0，第一权重是 `clickedPicked`（4.53），
第二是 `clickedVisualStack`（0.79），其余都在 1 以下。

因此不把模型接进生产：它没有提供超出“优先唯一命中用户所选控件”的信息，却要多带一份权重文件、
一套特征版本一致性和推理路径。训练与评测脚本保留，方便后续换目标（例如预测规则在换版本后的稳定性）时复用。

训练数据与权重：`D:\gkd-dataset\rank\`（`train/val/test.jsonl`、`ranker.json`）。

## 跨版本稳定性基准（规则质量的第二条轴）

现有 98.5% 只说明“在这张快照上点对了”，不说明“下次更新 App 还对”。为此新增
`bench/cross-version.bench.ts`：把 clean 集里 `appId + Activity + 控件标识（vid，或文字+类型）`
相同、但 `snapshotId` 不同的记录配成对，用 A 生成的 Top-1 规则去 B 上验证是否仍唯一点中同一控件。

规模：5,539 条清洗样本中配出 **2,230 对**，覆盖 376 个控件键。

| 指标 | 结果 |
| --- | --- |
| Top-1 跨版本稳定 | 63.3% → **70.2%**（分档重排后） |
| Top-3 稳定 | 74.2% |
| Top-5 稳定 | 75.2% |
| 候选里存在可用写法 | 75.8% |
| 无任何候选可用（生成缺口） | 24.2% |

按写法看稳定性（同一批数据，Top-1 采用该写法时）：

| 策略 | 样本 | 跨版本稳定 |
| --- | --- | --- |
| `stableResourceSemantic` | 176 | 98.3% |
| `exactId` | 130 | 75.4% |
| `exactVid` | 721 | 73.8% |
| `typePlusExactAttr` | 550 | 69.1% |
| `clickParentByChildIdVid` | 68 | 58.8% |
| `exactTextWithContext` | 337 | 39.2% |
| `ambiguousTargetNarrowing` | 209 | 20.1% |
| `clickParentDirectChildText` | 10 | 0% |

按锚点类型：`id` 77.1%、`vid` 69.3%、`text` 64.2%、纯结构 21.3%。
带 `width/height` 的条件 27.1%，带 `childCount` 的条件 21.6%——结构条件换版本后最容易失配。

据此把排序改成“同一命中档内按写法分三档”：`stableResourceSemantic` 一档，
`exactId/exactVid/typePlusExactAttr/textSkipGuarded` 二档，其余三档；档内仍按原分数。
只分三档是因为按 appId 奇偶分半后，中间几种写法波动很大（如 `exactId` 63.2% vs 92.7%），
细排名不可靠。该改动不改变单张快照的命中判断，98.5% 保持不变。

试过但无效：在 Top-5 里优先选“不含结构条件”的候选，跨版本只从 63.3% 到 63.6%，
还把单快照命中率从 87.5% 拉到 84.3%（该子集口径），因此没有采用。

## 复现

运行目录：仓库根目录。Shell：PowerShell。

```powershell
# 推荐：走 package.json 脚本（含 Windows 环境检查）
npm run bench:heuristic
npm run bench:rag
npm run bench:parity
npm run bench:rerank
npm run bench:extract-rank   # 生成排序特征（约 1.5 分钟）
python -X utf8 bench\train_ranker.py
npm run bench:rank           # 模型 vs 规则排序，写 D:\gkd-dataset\bench\rank-report.json
npm run bench:cross-version  # 跨版本稳定性，写 D:\gkd-dataset\bench\cross-version-report.json

# 全量启发式评测，写 D:\gkd-dataset\bench\heuristic-report.json
npx vitest run --config bench/vitest.config.ts heuristic

# 检索质量评测，写 D:\gkd-dataset\bench\rag-report.json
npx vitest run --config bench/vitest.config.ts rag

# TS 与 workbench JS 检索实现一致性
npx vitest run --config bench/vitest.config.ts parity

# 只跑前 60 条快速检查
$env:BENCH_LIMIT=60; npx vitest run --config bench/vitest.config.ts heuristic

# 单样本候选诊断（快照 ID:目标节点 ID）
$env:BENCH_SAMPLE="17456625:9"; npx vitest run --config bench/vitest.config.ts inspect
```

数据集路径可用 `$env:GKD_DATASET_DIR` 覆盖，默认 `D:\gkd-dataset`。

工作站：`node workbench/server.mjs`，默认 `http://127.0.0.1:8899`。选中快照与目标后，右侧“RAG 相似案例”面板展示 Top-K 案例，并可复制 Few-Shot Prompt。

## 本轮修复的问题

- `sibling` 与 `contextSibling` 的序列化方向相反：前者目标在左，后者上下文在左。方向计算已分开处理，避免兄弟选择器生成反向。
- 相似度点积误写为 `min(w_a, w_b)`，改为 `w_a * w_b`。
- 同框候选只按“是否同区域”排序，会把同区域但非用户所选控件排到前面。新增偏离惩罚后修正。
- 多命中收窄候选必须通过最终规则验证；动作计划放宽选择器导致点偏时直接丢弃。
- 数值 `eq`/`notEq` 被错误加引号，导致 `childCount=1` 变成 `childCount="1"`，结构选择器全部失效。已改为数值不加引号，并补单测。
- 候选排序曾用带 `activityIds` 的校验结果判断“点中了哪个节点”。Activity 与快照不一致时命中集合为空，
  所有候选排到同一档，排序退化成按基础分。现在排序只按选择器本身计算命中，规则范围不再参与候选比较。
- 同一命中档内新增按写法稳定性分三档排序（数据见“跨版本稳定性基准”），跨版本稳定 63.3% → 70.2%。

## 剩余瓶颈

- `hierarchy` 为 96.4%：9 条 Top-1 错题里 8 条是“没有任何候选唯一命中目标”，属于候选生成缺口，不是排序问题。
- 跨版本稳定性 70.2%，其中 24.2% 的快照对里没有任何候选能命中另一版本，这是下一阶段最大的缺口；
  另外 5.6% 是“候选里有但没排上”。
- 结构条件（`childCount`、宽高、`index`、`depth`）稳定性只有 21%–27%，只应在没有文字/id/vid 时使用。
- 当前只做检索增强，没有微调模型。若后续要训练专用模型，建议先用本数据集构造“快照特征 → 规则形态”的分类任务，再评估是否值得做生成式微调。

当前 9 条 Top-1 错题中，8 条没有唯一命中候选，只有 1 条是“正确候选存在但排序不对”。
下一步收益最大的是补这 8 条的生成路径（层级组合、同父兄弟、跨分支锚点），排序侧已经没有明显空间。

## 文件位置

| 内容 | 路径 |
| --- | --- |
| 清洗与切分脚本 | `.scratch/dataset-crawler/clean_dataset.py` |
| 数据集副本 | `D:\gkd-dataset\clean_dataset.py` |
| 清洗结果 | `D:\gkd-dataset\clean\` |
| 评测报告 | `D:\gkd-dataset\bench\` |
| 检索模块 | `src/lib/fewShotRetrieval.ts` |
| 视觉摞判定 | `src/lib/visualTarget.ts` |
| 多命中收窄 | `src/lib/selectorStrategies.ts`（策略 `ambiguousTargetNarrowing`） |
| 数值条件序列化 | `src/lib/selectorSerialize.ts`（测试 `src/lib/selectorSerializeNumeric.test.ts`） |
| 排序实验 | `bench/rerank.bench.ts`（报告 `D:\gkd-dataset\bench\rerank-report.json`） |
| 排序特征 | `src/lib/rankFeatures.ts` |
| 排序特征提取 | `bench/extract-rank-features.bench.ts`（输出 `D:\gkd-dataset\rank\`） |
| 排序模型训练 | `bench/train_ranker.py`（权重 `D:\gkd-dataset\rank\ranker.json`） |
| 排序模型评测 | `bench/rank.bench.ts`（报告 `D:\gkd-dataset\bench\rank-report.json`） |
| 跨版本稳定性基准 | `bench/cross-version.bench.ts`（报告 `D:\gkd-dataset\bench\cross-version-report.json`） |
| 工作站 RAG 接口 | `workbench/server.mjs` |
