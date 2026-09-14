<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: WorldQuant BRAIN 平台桥（Python Bridge 模式）——TS 壳管理长驻 Python 子进程（stdio JSON-RPC），把 AlphaFactory 的平台能力暴露为 30 个 wq_* DSH 工具，覆盖「查配额 → 读上下文 → 预检 → 回测 → 四关 → 入库/判废 → 查档案」完整挖掘回路；Python 核心零重写
  inject: 'tools'
  tools: wq_ping,wq_alpha_count,wq_quota,wq_context_explore,wq_context_refine,wq_simulate,wq_recover_pending,wq_check_expression,wq_similarity_hint,wq_evaluate_submittability,wq_add_to_zoo,wq_suggest_next_round,wq_report_blindspot,wq_mark_as_waste,wq_add_weak_signal,wq_corr_with,wq_compute_correlation,wq_analyze_parse,wq_analyze_similarity,wq_analyze_calibrated,wq_analyze_classify,wq_knowledge_blindspots,wq_knowledge_summary,wq_knowledge_meme,wq_knowledge_templates,wq_knowledge_family_tree,wq_knowledge_dead_roots,wq_submitted,wq_ready,wq_weak_pool
  runtime: host-only（长驻 Python 子进程 + stdio JSON-RPC）
  envDeps: 本机 Python 解释器 + AlphaFactory 平台目录（`python/alphafactory` 随包分发）+ 凭据（由 envFile 指向的 .env 提供，**值不进本仓库、不进工具参数**）；回测类工具需访问 WQ 平台
  boundary: 只是「通道 + 工具面」——不是 WQ 平台替代客户端、不是因子库本体；不管 AlphaFactory 内部实现、不管挖掘方法论（归技能 alpha-mining）
  compat: cordis ^4.0.1-rc.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.0.1-rc.1
-->
# dsh-wq-bridge

<p align="center">
  <a href="https://github.com/jonah791/dsh-wq-bridge"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-14%20passed-brightgreen" alt="tests">
</p>

**一句话**：一条通往 WorldQuant BRAIN 挖掘栈的桥——TS 壳管一个**长驻 Python 子进程**（stdio JSON-RPC），把 AlphaFactory 的平台能力暴露成 30 个 `wq_*` DSH 工具。

**为什么值得用**：既有 AlphaFactory 有 215 条测试的 Python 资产，重写成 TS 等于把验证过的算法与档案 schema 全部推倒重来。本桥只做**通道**：Python 核心 100% 保留、长驻进程无每次启动开销、请求-响应按 id 配对支持并发、凭据只从 `.env` 注入子进程而不进工具参数。代价是排障面变复杂（跨语言双进程），因此每次调用落两行自证轨迹——**「有 `begin` 无 `end`」就是桥卡死的指纹**（单行记录无从分辨）。

## 能力

30 个工具，按域分组（数量由 `grep -c "name: 'wq_" src/index.ts` 现测）。

| 域 | 工具 | 职责 |
|----|------|------|
| 平台/只读（5） | `wq_ping` | 桥连通性（Python 版本 + **真实解释器路径**，诊断 PATH 里是否为 shim/launcher） |
| | `wq_alpha_count` | 五库计数（submitted/ready/candidates/weak/waste） |
| | `wq_quota` | WQ 配额监控（今日 simulate 数 / 平台 alpha 总数）——**挖掘前必查** |
| | `wq_context_explore` | 探索上下文（字段库/算子库/未用格点/盲点摘要/模因/组合方法论）；`section` 可分块只取一节 |
| | `wq_context_refine` | 精炼上下文（父代链 / Refine Targets / blocks 明细） |
| 核心挖掘（11） | `wq_simulate` | 回测一个表达式（约 90–150s；单工具超时 **300s**），可带 `with_consistency` 补跑年度一致性 |
| | `wq_recover_pending` | 崩溃兜底：找回 pending 池里「WQ 已建但本地超时」的模拟（按表达式回收）；超时 **180s** |
| | `wq_check_expression` | 表达式静态校验（长度/语法/字段存在性/风险字段） |
| | `wq_similarity_hint` | 撞车预检（`simulate` 前必查）：词袋相似度 + 废渣/弱池对比 + 腿级共享明细 |
| | `wq_evaluate_submittability` | 四关评估（checks → PnL corr → S/F 门槛 → 年度一致性），超时 **300s**，判定前自动等 PnL 稳定 |
| | `wq_add_to_zoo` | 入库（四关全过 → ready，否则 → candidates），超时 **300s** |
| | `wq_suggest_next_round` | 轮次调度建议（explore/refine/combo/maintain）——信息不裁决 |
| | `wq_report_blindspot` | 登记新盲点（达 100 整数倍时回报需归纳） |
| | `wq_mark_as_waste` | 把没救的候选移入废渣池（停止投入） |
| | `wq_add_weak_signal` | 弱信号入库（组合轮素材；`reason` 必写经济逻辑） |
| | `wq_corr_with` / `wq_compute_correlation` | PnL 相关实测（撞车线 0.6576；**评估必须实测，禁止信库内旧值**） |
| 分析（4） | `wq_analyze_parse` | 表达式解析为结构树（词法/语法层） |
| | `wq_analyze_similarity` | 两表达式结构相似度（词袋：op/field/签名加权） |
| | `wq_analyze_calibrated` | 标定相似度（结构相似度 → PnL corr 估计） |
| | `wq_analyze_classify` | 信号族分类（S→B→K 分层） |
| 知识（6） | `wq_knowledge_blindspots` | 盲点档案查询（可过滤 archive=operator/dataset/family） |
| | `wq_knowledge_summary` | 盲点归纳摘要（规则 >20 条时截断前 20 + `truncated` 计数） |
| | `wq_knowledge_meme` | 模因库（跨家族算子子树三态：活性/饱和/有毒） |
| | `wq_knowledge_templates` | 表达式模板库（家族骨架 + 参数定稿 + 禁区） |
| | `wq_knowledge_family_tree` | 血统树（父代链 / 毒父代警示） |
| | `wq_knowledge_dead_roots` | 判死词根（内置 + 外部 extra 双轨） |
| 库读取（3） | `wq_submitted` / `wq_ready` / `wq_weak_pool` | 已提交库 / 待提交库 / 弱信号池完整列表 |

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-wq-bridge": "link:<工作区>/self-plugins/dsh-wq-bridge"
```

**2) 挂组合**（agent 预设行；凭据由 `envFile` 指向的 `.env` 提供）：

```yaml
- insert:
    - id: wq-bridge
      name: dsh-wq-bridge
      config:
        pythonBin: python
        envFile: <AlphaFactory 根>/.env
        timeoutMs: 120000
```

**3) 30 秒验证**：

```
wq_ping
```

期望：返回 Python 版本与**真实解释器路径**（`executable`）——若路径是 shim/launcher 而非真实 venv 内的解释器，后续调用会以难以定位的方式失败，故这一条是第一步。随后 `wq_alpha_count` 应返回五库计数（只读、零配额消耗）。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `pythonBin` | `'python'` | 子进程可执行名/路径；解析结果由 `wq_ping.executable` 自证 |
| `envFile` | 指向 AlphaFactory 的 `.env`（部署相关值，建议由组合层显式给出） | 凭据与 `ALPHA_ROOT` 来源；**文件缺失会静默为空**（仅继承进程环境变量）——配置写错时表现为「平台调用失败」而不是「配置错误」，排障时先查这里 |
| `timeoutMs` | `120000` | 每次 `call` 的默认超时；单工具可覆盖（`wq_simulate` / `wq_evaluate_submittability` / `wq_add_to_zoo` = 300000，`wq_recover_pending` = 180000） |

**凭据纪律**：凭据只从 `envFile` 读入并注入子进程；**工具 schema 里没有任何凭据字段**，轨迹里也绝不落凭据值（有端到端隐私尸体测试）。

## 落盘与自证（出问题时先看这里）

**本插件的侧车轨迹**：`<DSH_HOME>/wq-trace.jsonl`（append-only，一行一阶段，`DSH_HOME` 缺省 `~/.dsh`；无轮转，见 §10 U7）。此外 AlphaFactory 侧维护 pending 登记文件（`results/.../_pending_sims.json`，simulate 前登记、结束清除、`wq_recover_pending` 扫描）。

| 阶段 | 含义 |
|------|------|
| `boot` | 插件装载自报（工具面 + 生效面） |
| `begin` | 每次 `wq_*` 调用开始（`durationMs: 0`，落工具名与参数摘要） |
| `end` | 调用收尾（`durationMs` / `ok` / `resultBytes`；失败带 `error` 截 300 字符） |

| 字段 | 语义 |
|------|------|
| `atMs` / `build` | 写入时刻 / `<version>@<模块 mtime ms>` |
| `tool` / `params` | 工具名 / 参数摘要（白名单 + 脱敏 + 截断） |
| `phase` / `error` | 阶段枚举 / 桥错误报文（截 300 字符） |
| `durationMs` / `ok` / `resultBytes` | 耗时 / 是否成功 / 载荷字符数 |

**一条命令答五问**：

```bash
tail -4 "$DSH_HOME/wq-trace.jsonl"
# ① 线上跑的是哪个构建 → build = "<版本>@<模块 mtime ms>"
# ② 谁发起 / 调了什么   → tool + params（白名单脱敏摘要）
# ③ 断在哪一段         → phase 枚举；**有 begin 无 end = 桥卡死**（这是本插件最重要的故障指纹）
#                       有 end 且 ok=false → error 给出桥错误报文
# ④ 结果质量           → resultBytes（载荷量级；注意它只记字符数，不解析内容——判定语义属 AlphaFactory，不在插件层复制）
# ⑤ 耗时与预算         → durationMs vs 该工具的超时档位（默认 120s / simulate 300s / recover 180s）
```

隐私红线：`password` / `username` / `token` / `email` 类键的值**一个字都不落盘**（落 `[redacted]`），有端到端尸体测试锁定；观测失败一律吞错返回 `false`，**绝不影响工具结果**。

## 生效判据与回退

**生效判据**（三选一）：
1. 行为级：`wq_ping` 返回真实解释器路径 + `wq_alpha_count` 返回五库计数 ⇒ 桥活着且工具面已注册；
2. 轨迹级：`tail -1 "$DSH_HOME/wq-trace.jsonl"` 的 `build` 里 mtime **等于** `lib/index.js` 的 mtime ⇒ 进程在跑当前构建；
3. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）的 `live` 含 `dsh-wq-bridge`、`stale` 为空 ⇒ 判据 2 的机器化版本。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，**进程启动时间必须晚于产物 mtime** 才算「在跑它」。缺这一条时不得宣称「已生效」。
> 桥特有的失效形态：子进程已死（协议层错 / exit / spawn 失败）时**插件本身不报挂载错**，而是**每个工具各自报错**（`bridge closed` / `python bridge exited (code=…)`）——所以「挂载成功」不等于「桥可用」，必须用 `wq_ping` 单独证明。

**回退**：
- 源码级：`git -C self-plugins/dsh-wq-bridge revert <commit>` → 重新构建 → 预检 → 重启；
- 组合级：预设里给 `wq-bridge` 行加 `disabled: true`（或移除该行）→ 哨兵重启（插件卸载时 `ctx.effect` 会 kill 子进程，生命周期绑定）；
- 运行期：轨迹文件可随时删除；**pending 池不清**（`_pending_sims.json` 是崩溃兜底资产，删了会让「已建但超时」的模拟找不回来）——如需清理请用 `wq_recover_pending` 收口。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"（跑 lib/ 产物，与运行时同源）
```

**14 例离线测试**（14/14 通过），`tests/trace.test.mjs`——跟踪层：

- 每次 `wq_*` 调用自己落 `begin`/`end` 两行，断言 `map(phase) === ['begin','end']`；耗时（注入时钟 → `durationMs=250`）、`resultBytes`、`params` 齐备；
- 失败路径：`ok=false` + `error` 落盘，且**异常原样重抛**（观测不得吞掉业务错误）；
- 观测不反噬：不可写路径下返回值照常；
- **隐私尸体测试**：喂入用户名/口令/token/邮箱样本 → 断言落盘原文一个字都不出现、`username=[redacted]` 在场。

另有协议层测试 `tests/bridge.test.ts`（**6 例**，配 `tests/mock_server.py` 桩：往返/参数/错误/并发/超时/dispose）——它不是 `.mjs`，不在 `npm test` 的 glob 内，需单独跑：

```bash
node --test tests/bridge.test.ts     # 协议层 6 例（mock python 子进程）
```

**离线单测不需要 Python、不需要 WQ 凭据、不需要出网**：轨迹层是纯函数 + 临时目录；协议层用 `mock_server.py` 桩替代真实桥。**但插件的真实功能需要它们**：`wq_ping`/`wq_alpha_count` 等需要本机 Python 解释器与 AlphaFactory 资产，回测/评估/入库类工具还需要 WQ 平台凭据与网络——**没有这些时离线单测仍应全绿**，这正是分层的意义。

## 设计要点

- **桥是长驻子进程**：每次调用都 spawn 会把 WQ 的会话开销乘上调用次数；长驻进程 + 按 id 配对的请求-响应 + 并发支持，是这套架构的核心收益。`dispose` 时 kill 子进程（与插件生命周期绑定）。
- **超时只摘 pending，不杀进程**：`call` 超时拒绝并把自己的等待项从 `pending` 摘除，**不杀子进程**——因为超时的请求可能仍在平台侧执行，杀进程会同时废掉其他在飞请求。这也是 `wq_recover_pending` 存在的原因（超时的模拟可以按表达式找回来）。
- **「有 begin 无 end」是卡死指纹**：跨语言双进程的故障形态很难从返回值区分（超时与卡死都表现为「没结果」），故观测必须**成对落盘**——单行记录无法分辨。
- **凭据只进子进程**：TS 壳读 `.env` 后注入子进程环境，工具参数与返回值里都没有凭据字段；轨迹对凭据类键做值脱敏。
- **插件层不复制平台判定语义**：`resultBytes` 只记载荷量级、不解析 S/F/alpha_id；桥只记请求-响应两端，`orchestrator` 内部阶段（pending 写/清、去重命中、等 PnL 轮次）不落账（§10 U1）——需要更细的判定请 join 会话事件流的 tool result，不要在桥里再写一套摘要。
- **Python 侧参数防御**：`settings_override` 传成 JSON 字符串会在 Python 侧归一为 dict（解析失败/非对象给明确错误，而不是 `TypeError`）；`simulate` 命中交换律重复时**自动去重预检拦截、零配额消耗**；`context_explore(section)` 关键词未命中返回 `{ok:true, context:'', note}`（**不是错误**）；`suggest_next_round` 传字符串列表会被包装为对象列表再交 orchestrator。
- **`envFile` 缺失静默为空是已知的排障陷阱**：配置写错不会报「配置错误」，而是表现为平台调用失败——排查「为什么平台调用不通」时先确认 `.env` 真被读到。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、契约（配置 + 状态→裁决表 + 调用点清单 + 落盘产物）、可证伪验收清单（A1–A15）、未决问题（U1–U8） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `alpha-mining` | 量化因子挖掘方法论（设计→回测→四关→入库→提交 + 27/30 个 `wq_*` 工具的使用协议）——**本插件是工具面，技能是方法论** |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
