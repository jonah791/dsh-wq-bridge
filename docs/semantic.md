# 语义文档：dsh-wq-bridge（WorldQuant BRAIN 平台桥）

| 项 | 值 |
|----|----|
| 能力名 | dsh-wq-bridge（插件内 `name = 'wq-bridge'`；组合行 id `wq-bridge`；工具前缀 `wq_`） |
| 主副本路径 | `self-plugins/dsh-wq-bridge/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-wq-bridge/src/index.ts`（556 行）、`src/bridge.ts`（100 行）、`python/bridge_server.py`（391 行） |
| 版本 | v0.1.1（`package.json`；README 状态行自称「v0.3 阶段 1-4」——两套口径并存） |
| 挂载位置 | `.dsh/profiles/web/cordis.patch.yml` 第 56 行 `- insert:` / 第 57 行 `- id: wq-bridge` / 第 58 行 `name: dsh-wq-bridge`（**该行无 config**，三项配置全走默认值） |
| 状态 | **draft**（补课文档；验收条目多数待线上复核，不得按「已实现」理解） |
| 依赖服务 | `inject = ['tools']`（+ `@deepseek-ai/schemastery` 配置 schema） |
| 外部依赖 | AlphaFactory 包（`E:/alice/projects/self/alphafactory`）、Windows 侧 Python（实测为 hermes venv 解释器）、WQ BRAIN 凭据（经 `.env` 注入子进程环境） |

## 1 · 定位与反定位
**定位**：把主人既有的 AlphaFactory Python 平台能力（`AlphaOrchestrator` + `tools.py` 纯计算 + `results/` 档案）经**长驻 Python 子进程 + stdio JSON-RPC** 暴露成 30 个 `wq_*` DSH 工具，让模型在同一会话完成「查配额 → 读探索/精炼上下文 → 撞车与语法预检 → 回测 → 四关评估 → 入库/判废/弱信号 → 查档案」的完整挖掘回路，**Python 核心零重写**。

**反定位（本文不管什么）**：
- 不管 AlphaFactory 内部实现（算法与档案 schema——那是 Python 侧语义，以其自身文档为准）
- 不管挖掘方法论（属于技能 `alpha-mining`：何时弃用、何时换腿、四关怎么读）
- 不管 web 生命周期与热重载（属于 `dsh-agent-sentinel` / `dsh-agent-guardian`，见 AGENTS.md §5.2/§5.19）
- **不是** WQ 平台的替代客户端，也**不是**因子库本体——它只是「通道 + 工具面」

## 2 · 术语表
| 术语 | 含义 |
|------|------|
| 桥（bridge） | `PythonBridge`（`src/bridge.ts`）管理的**长驻**子进程：挂载时急切 `spawn`，卸载时 `kill` |
| 行协议 | stdin 每行 `{id, method, params}`，stdout 每行 `{id, result}`/`{id, error}`；按 `id` 配对，支持并发 |
| `method` | Python 侧方法名（如 `simulate`），与工具名 `wq_simulate` **不同名**；映射见 §4.3 |
| pending 池 | `<output_dir>/<session_name>/_pending_sims.json`：simulate **前**登记的表达式台账，进程被杀后的回收依据 |
| 崩溃兜底 | `wq_recover_pending` → `orchestrator.recover_pending()`：扫池按表达式回收 WQ 已建 alpha；未命中留池下次再试 |
| 四关 | Gate1 七项 checks → Gate2 PnL corr<0.6576 → Gate3 S≥1.5 且 F≥1.5 → Gate4 年度一致性（fail-closed） |
| `ALPHA_ROOT` | Python 包根：TS 侧由 `dirname(dirname(envFile))` 推出并注入环境；Python 侧默认 `E:/alice/projects/self` |
| `executable` | `wq_ping` 返回的 `sys.executable`——诊断 PATH 里的 `python` 是否为 shim/launcher（2026-08-27 增强） |

## 3 · 概念模型
```
模型（爱丽丝）─ 30 个 wq_* 工具 ─→ src/index.ts apply() L49
  ├─ L50  pyScript = join(HERE,'../python/bridge_server.py')   ← HERE = lib/ 产物目录
  ├─ L51/53  loadEnvFile(config.envFile) + 注入 ALPHA_ROOT
  ├─ L54  new PythonBridge → bridge.ts:38 spawn(pythonBin,[pyScript])  ← 急切启动（非懒加载）
  ├─ L57  call() → bridge.ts:79 按 id 发请求 + 超时；L55 ctx.effect → bridge.ts:96 proc.kill()
  ▼
python/bridge_server.py main() L374 → handle() L37（30 个 method 分支）→ orch() L15（懒建 orchestrator）
  ▼
AlphaFactory results/（六个档案 + pending 池） · WQ BRAIN 平台（经 wq_api）
```
不变量（invariants）：
1. **I1 一插件一桥**：`apply` 只构造一个 `PythonBridge`，全部工具共用一个子进程（`grep -c "new PythonBridge" src/index.ts` = 1）。
2. **I2 id 配对并发安全**：响应按 `id` 从 `pending` Map 取回调；未知 `id` / 不可解析行**丢弃不报错**（`bridge.ts:64-71`）。
3. **I3 工具数 = 30 且与 Python 分支 1:1**：`grep -c "name: 'wq_" src/index.ts` = 30，`grep -c 'if method ==' python/bridge_server.py` = 30（逐条比对，无死方法）。
4. **I4 凭据只走环境变量**：`.env` 解析结果经 `spawn` 的 `env` 注入；凭据**不进工具参数、不进返回值、不落盘**（工具 schema 无凭据字段）。
5. **I5 先落盘后提交**：`simulate` 前 `_mark_pending` 写池、结束 `_clear_pending` 清池——「池里有它」= 可能已在 WQ 侧建了 alpha。

## 4 · 契约

### 4.1 配置（`Config` schema · `src/index.ts:27-31`，挂载行未覆盖任何一项）
| 字段 | 默认 | 说明 |
|------|------|------|
| `pythonBin` | `'python'` | 子进程可执行名/路径；解析结果由 `wq_ping.executable` 自证 |
| `envFile` | `'E:/alice/projects/self/alphafactory/.env'` | 凭据与 `ALPHA_ROOT` 来源；文件缺失**静默为空**（仅继承环境变量） |
| `timeoutMs` | `120000` | 每次 `call` 的默认超时；单工具可覆盖（见 4.2） |

### 4.2 状态 → 裁决表
| 输入状态 | 裁决 | 依据 |
|---------|------|------|
| Python 返回 `{ok:true,…}` | 工具返回结构化结果；`render` 产出摘要文本 | 各工具 `execute` |
| Python 返回 `{ok:false,error}` | TS 侧 `throw new Error(error)`（报错，**不静默**） | 各 execute 的 `if (!r.ok) throw` |
| 协议层 `error` 字段 / 子进程 exit / spawn 失败 | 分别 `BridgeError(msg)`、`bridge closed`、`spawn failed`——该次及后续调用全 reject；**插件本身不报挂载错**（降级为「每个工具都报错」） | `bridge.ts:47-57,73` |
| `call` 超时 | `reject(new BridgeError('bridge timeout after Nms (method)'))` + 从 `pending` 摘除（**不杀子进程**） | `bridge.ts:83-86` |
| 单工具超时覆盖 | `wq_simulate`/`wq_evaluate_submittability`/`wq_add_to_zoo` = **300000**；`wq_recover_pending` = **180000**；其余 = `config.timeoutMs` | `index.ts:181/254/279/194` |
| `settings_override` 传成 JSON 字符串 | Python 侧 `json.loads` 归一为 dict；解析失败/非对象 → 明确错误（2026-08-28 防御） | `bridge_server.py:116-123` |
| simulate 命中 R116 交换律重复 | 自动去重预检**拦截返回错误、零配额消耗**；预检自身异常则放行 | `bridge_server.py:126-132` |
| `context_explore(section)` 关键词未命中 | 返回 `{ok:true, context:''}` + `note`（**不是错误**） | `bridge_server.py:91-93` |
| `knowledge_summary` 规则 >20 条 | 截断前 20 条 + `truncated` 计数（防被入口守卫折叠） | `bridge_server.py:327-331` |
| `suggest_next_round` 传字符串列表 | Python 侧包装为 `[{'type': t}]` 再交 orchestrator | `bridge_server.py:205-207` |
| 未知 method | `{ok:false, error:'unknown method: …'}` | `bridge_server.py:372` |

### 4.3 调用点清单
| 调用方 | 调用点（文件:符号 / 行号） | 时机 |
|-------|--------------------------|------|
| web profile 组合 | `.dsh/profiles/web/cordis.patch.yml:56-58`（`- insert:` / `id: wq-bridge` / `name: dsh-wq-bridge`） | web 启动挂载（无 config） |
| 插件本体 | `src/index.ts:16-17` `name = 'wq-bridge'` / `inject = ['tools']`；`:49` `apply(ctx, config)` | 模块加载 / 挂载时 |
| 插件本体 | `src/index.ts:50` `pyScript` → `<插件根>/python/bridge_server.py`（相对 **lib/** 产物解析）；`:51-53` `loadEnvFile(config.envFile)` + 注入 `ALPHA_ROOT` | 挂载时（各一次） |
| 插件本体 | `src/index.ts:54` → `src/bridge.ts:38` `spawn(pythonBin,[pyScript],{stdio:['pipe','pipe','pipe']})` | 挂载时（**急切**） |
| 插件本体 | `src/index.ts:55` `ctx.effect(() => () => bridge.dispose())` → `bridge.ts:96` `proc.kill()` | 插件卸载 / 进程退出 |
| 全部工具 | `src/index.ts:57-58` `call()` → `src/bridge.ts:79` `call(method, params, timeoutMs)` | 每次工具调用 |
| 桥 stderr | `src/bridge.ts:43-46` → `console.error('[wq-bridge:py]', …)`（截 500 字符，**不落盘**） | 子进程有 stderr 时 |
| Python 桥 | `python/bridge_server.py:374` `main()` → `:37` `handle(req)` → `:15` `orch()`（首次调用建 orchestrator） | 每条 stdin 行 / 首次平台调用 |
| 消费方（爱丽丝） | 技能 `alpha-mining` 的挖掘循环：`wq_quota` → `wq_context_explore` → `wq_check_expression`/`wq_similarity_hint` → `wq_simulate` → `wq_evaluate_submittability` → `wq_add_to_zoo`/`wq_add_weak_signal` | 每一轮挖掘 |
| 落盘/侧车产物 | `E:/alice/projects/self/alphafactory/results/v5_auto_20260806/_pending_sims.json`（写/清/扫：`orchestrator.py:439/450/461`） | simulate 前登记、结束清除、`wq_recover_pending` 扫描 |
| 落盘/侧车产物 | `…/alphafactory/results/{blindspot_registry,blindspot_summary,meme_registry,expression_templates,family_tree,dead_semantic_roots_extra}.json`（只读：`bridge_server.py:296-371`） | knowledge 域 6 工具 |
| 测试 | `tests/bridge.test.ts:13/22/30/38/50/58`（6 条）+ `tests/mock_server.py:9/11/13/15`（ping/echo/error/sleep 桩） | `pnpm test` / `node --test` |

**30 个工具注册点**（行号 = `src/index.ts` 内 `ctx.tools.register(defineTool({ name: …`）：
| 族 | 工具（注册行） |
|----|--------------|
| 平台/只读（5） | `wq_ping`:62、`wq_alpha_count`:76、`wq_quota`:100、`wq_context_explore`:114、`wq_context_refine`:287 |
| 核心挖掘（12） | `wq_simulate`:153、`wq_recover_pending`:189、`wq_check_expression`:202、`wq_similarity_hint`:215、`wq_evaluate_submittability`:230、`wq_add_to_zoo`:262、`wq_suggest_next_round`:308、`wq_report_blindspot`:321、`wq_mark_as_waste`:342、`wq_add_weak_signal`:355、`wq_corr_with`:376、`wq_compute_correlation`:389 |
| analyze（4） | `wq_analyze_parse`:402、`wq_analyze_similarity`:413、`wq_analyze_calibrated`:424、`wq_analyze_classify`:435 |
| knowledge（6） | `wq_knowledge_blindspots`:447、`wq_knowledge_summary`:462、`wq_knowledge_meme`:473、`wq_knowledge_templates`:484、`wq_knowledge_family_tree`:495、`wq_knowledge_dead_roots`:506 |
| 库读取（3） | `wq_submitted`:519、`wq_ready`:532、`wq_weak_pool`:545 |

工具名 → method 映射是**逐字同名去掉 `wq_` 前缀**（`wq_analyze_parse`→`analyze_parse`、`wq_weak_pool`→`weak_pool`），无例外。

## 5 · 边界与信任
- 能力边界 ≠ 沙箱：本插件能（经 Python 侧）**消耗 WQ 平台配额**、在 `results/` 写台账、读本机档案；工具面**不校验调用者意图**，边界靠上层（技能纪律 + 主人指令）。不越界清单：不训练模型、不写 WQ 平台数据（只走公开 API 面）、**不代主人提交 alpha**（无 submit 工具，四关只给判定）、不写 `results/` 之外路径。
- 失败面：
  - 写失败：`_mark_pending`/`_clear_pending` 异常经 `handle` 捕获转 `{ok:false,error}`，**不静默**；但「池写不进去还要不要继续 simulate」无显式策略（见 §10 U3）。
  - 读失败：`.env` 读不到 → 静默空对象（凭据缺失要到 Python 侧首次 `orch()` 才报 `WQ_USERNAME/WQ_PASSWORD 环境变量缺失`）；knowledge 档案缺失 → `{ok:false, error:'<域>: [Errno 2] …'}`。
  - 超时：单次 `call` 超时 → `BridgeError`（桥仍可服务）；`wq_simulate` 超时 ≠ WQ 侧没跑——**先 `wq_recover_pending` 再考虑重试**。
  - 桥死：`closed=true` 后**本次挂载内不自动重启**，恢复手段是重启 web 或热重载插件。

## 6 · 与既有机制的关系
- 与 **AGENTS.md §5.22（机制自证）**：本插件**当前不满足**——TS 侧只有 `console.error` 的 stderr 透传（宿主 logger 与进程 stderr 均不落盘），Python 侧也无 trace；唯一落盘痕迹是 `_pending_sims.json` 与 `results/` 档案。五问中「哪个构建 / 断在哪一段 / 耗时 vs 预算」**无法一条命令回答**（缺口见 §8、§10 U1）。
- 与 **§5.11（组合变更必验证）**：改 `src/` 后必须重建到 `lib/`，否则 web 仍跑旧构建；判据是**进程级**而非产物级。
- 与 **凭据纪律**：凭据只存在于 `.env` 与子进程环境——不落文档、不进工具参数、不落盘日志（本文只记键名不记值）。
- 与 **技能 `alpha-mining`**：技能给决策纪律（弃用/换腿/入库），本插件给动作与平台事实——技能是脑，本桥是手。工具随 `inject: ['tools']` 进入所有会话（含子代理），`toolface` 收窄是会话级而非插件级。

**生效判据（改代码/重启后怎么证明真的生效）**：
1. **进程级构建判据**：`lib/index.js` 的 mtime **早于**当前 web 进程启动时间（§5.11 口径）。实测：`lib/index.js` = `2026-09-13 07:19:46`，web（pid 7080）启动 = `2026-09-14 10:05:47` → **产物早于进程，判「线上跑的是当前构建」**。
2. **解释器自证**：`wq_ping.executable` 非空且为真实解释器路径。实测：`C:\Users\tr\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe`（Python 3.11.15）——桥跑在 **hermes venv python** 上，不是系统 python。
3. **Python 桥存活**：`wq_ping`/`wq_alpha_count` 返回 `ok:true`（而非 `bridge closed`/`bridge timeout`）；进程侧可 `Get-CimInstance Win32_Process | Where CommandLine -like '*bridge_server.py*'` 佐证。
4. **工具面在场**：本会话工具列表能列出 30 个 `wq_*`（或 `plugin_inspect dsh-wq-bridge` 显示 mounted）。

**回退**：本插件无独立版本锚点，回退即 `git revert` 最近一次提交（或 `git checkout <上一提交> -- src/ python/`）→ `pnpm build` → `preflight_check`（组合变更必须完整试运行；毫秒级返回 = 短路）→ 哨兵（`.hot-reload-flag`）/ `daemon_restart`；配置回退走 `plugin_configure dsh-wq-bridge`（patch 整体替换留 `.bak-<时间戳>`）。**注意**：回退 TS 壳不回退 Python 侧已产生的档案与 pending 池——先确认池已清或已回收。

## 7 · 可证伪验收清单
| # | 可证伪命题 | 证据（单测名/命令/grep/日志/文件） | 状态 |
|---|-----------|--------------------------------|------|
| A1 | 工具面恰好 **30** 个 `wq_*`（不是 README 标题的 27） | `grep -c "name: 'wq_" src/index.ts` = 30；本会话工具面同 30 | **已实测**（README 标题与技能描述「27」不符） |
| A2 | 30 工具与 30 个 Python method 分支 1:1，无死方法 | `grep -c 'if method ==' python/bridge_server.py` = 30 ↔ TS 各 `call('…')` | 已实测（人工比对 30↔30） |
| A3 | `wq_ping` 返回真实解释器路径 | 实测输出 `解释器: C:\Users\tr\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe` | **已实测** |
| A4 | 线上跑的是当前构建（进程晚于产物） | `lib/index.js` mtime `2026-09-13 07:19:46` < web pid 7080 启动 `2026-09-14 10:05:47` | **已实测** |
| A5 | 凭据不落盘、不进工具参数 | `grep -nE "WQ_PASSWORD\|WQ_USERNAME" src/index.ts` 只命中 `loadEnvFile` 结果对象；工具 schema 无凭据字段 | 待验收（源码核对） |
| A6 | 超时兜底闭环 + 池清空语义 | 造超时 → `_pending_sims.json` 含该表达式 → `wq_recover_pending` 返回 `recovered` 非空；正常结束后 `pending` 数组减 1 | 待验收 |
| A7 | 参数防御：`settings_override` 传字符串不 TypeError | `wq_simulate` 传 `'{"decay":4}'` → 成功或明确错误（**不得** `unexpected keyword`） | 待验收 |
| A8 | R116 自动去重零配额拦截 | 用已知重复表达式调 `wq_simulate` → 返回 `duplicate_of` 错误，且 `wq_quota` 今日计数不变 | 待验收 |
| A9 | section 分块不越界（grid 节只返回该节） | `wq_context_explore(section:'grid')` 字符数 ≪ 全量（历史教训：曾误返 62K 到文件尾） | 待验收 |
| A10 | knowledge 六个档案在场可读 | `ls results/{blindspot_registry,blindspot_summary,meme_registry,expression_templates,family_tree,dead_semantic_roots_extra}.json` 全命中 | 已实测（文件在场；工具读取行为待验收） |
| A11 | 桥死后失败不静默 | 杀掉 `bridge_server.py` → `wq_ping` 报 `bridge closed`/`python bridge exited (code=…)`，而非空结果 | 待验收 |
| A12 | 测试只覆盖协议层 | `node --test` 输出 6 pass；`grep -c wq_ tests/bridge.test.ts` = 0（index.ts 与 bridge_server.py 零覆盖） | 待验收（README 声明 6/6，本次未跑） |

## 8 · 与实现的关系
- 主实现：`src/index.ts`（工具注册 + 参数转发 + render）、`src/bridge.ts`（子进程与行协议）、`python/bridge_server.py`（30 个 method 分支 + 档案读取）；三者同仓同提交。
- 同语义副本：**无**。Python 侧 `AlphaOrchestrator` 的语义（五库判定、四关阈值、pending 回收策略）以 `E:/alice/projects/self/alphafactory` 仓库为准——本桥只描述「怎么调用」，不复制其判定逻辑（符合 I1）。README 的架构图 `DSH 工具面 ←→ PythonBridge(stdio JSON-RPC) ←→ bridge_server.py ←→ AlphaOrchestrator` 与源码逐层对应；凭据注入、长驻子进程、dispose kill 三项属实。
- **偏差与缺口（如实记录，不粉饰）**：
  1. **工具数口径不一致**：README 标题写「v0.3 全量 **27** 工具」，但其五张分组表实际合计 **30**（5+12+4+6+3），源码 `grep -c` = 30，本会话工具面 = 30；技能 `alpha-mining` 简介同样写「27 个」——**两处 27 均为陈旧数字**。
  2. **无落盘自证轨迹（§5.22 五问不可答）**：TS 壳无 trace 产物、stderr 不落盘，Python 侧亦无 trace——「哪个构建 / 谁发起 / 断在哪一段 / 耗时」在插件内无从取证。
  3. **配额口径是本地启发式**：`check_quota` 的「今日 simulate 数」= `glob(results/'*sim*.json')` 中 **mtime 为今天**的文件数（`orchestrator.py:2906-2919`），**不是 WQ 平台真值**（注释自陈「WQ doesn't expose simulate credits via API」）；`total_alphas` 来自 `list_alphas(limit=1)`。故 `wq_quota` 只作趋势参考，不能当「剩余额度」。
  4. **`session_name` 硬编码 + 目录双口径**：`bridge_server.py:28` 写死 `session_name="v5_auto_20260806"`；pending 池在 `results/<session>/`、knowledge 档案在父目录 `results/`——换 session 目录时前者路径变、后者不变。
  5. **测试覆盖不对称**：`tests/bridge.test.ts` 只覆盖 `bridge.ts` 6 条协议行为；`src/index.ts`（30 个参数构造与 render）与 `python/bridge_server.py`（30 分支）**零单测**——A5–A12 只能靠线上命令取证。
  6. **次要气味与未核实**：`bridge_server.py` 重复 `import json as _json`（`:32`/`:297`/`:357`）；`bridge.ts:79` 的类内默认 `timeoutMs = 120_000` 被 `index.ts:58` 的 `config.timeoutMs` 遮蔽（仅单测直接实例化时可达）；注释所称 hermes venv python「双进程」现象本次只实测到解释器路径（A3），**双进程未核实**；「AlphaFactory 215 测试资产」未核实。
- 未实现部分：无 submit（提交平台）工具——止步于「四关判定 + 入库本地五库」，提交是人工/外部动作。

## 9 · 实践修订记录
- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：长驻单桥 + stdio 行协议 + 30 工具面 + 凭据只经环境变量 + pending 池崩溃兜底 + 四关 fail-closed + knowledge 域只读六档。
  - 语义**被补充**：① `pyScript` 相对 **`lib/` 产物目录**解析（构建产物与 `python/` 必须同仓同发布，`package.json files` 已含 `lib`+`python`）；② 单工具超时覆盖的实际数值（simulate/evaluate/add_to_zoo 300s、recover 180s）；③ 全部落盘产物绝对路径（pending 池 + 六个档案），此前只散落于 Python 源码；④ 两条生效判据的现场读数（hermes venv 解释器、产物 mtime 早于 web 进程）。
  - 语义**被修正**：无（首次成文）。另记录两处**外部**偏差：README/技能简介的「27 工具」实为 30；`wq_quota` 的「今日 simulate」是本地文件计数而非平台额度。
  - 教训：① 桥类插件「通道」（spawn/超时/close）与「能力」（30 工具）是两层语义——通道语义不入文档，重启后无从判断「桥死了还是平台报错」；② 可 `grep` 的事实必须现测，README 的历史数字会漂移（27 vs 30）；③ 「配额监控」这类读数的**口径来源**必须写进文档，否则会被当平台真值用于决策。

## 10 · 未决问题
- **U1 机制自证缺口**：是否为 TS 壳补侧车轨迹（`<DSH_HOME>/wq-bridge-trace.jsonl`：`atMs/method/phase/waitedMs/error`）以满足 §5.22 五问？倾向：补最小版（每 `call` 一行）。
- **U2 工具数口径统一**：README 标题与技能 `alpha-mining` 的「27」是否改「30」？倾向：改（现测值），并立「工具数由 `grep -c` 现测」的纪律。
- **U3 pending 池写失败的策略**：写失败时「继续 simulate（放弃兜底）」还是「拒绝 simulate（保兜底）」？现状无显式声明。倾向：拒绝 + 报错（无兜底的 simulate 会白烧配额）。需主人裁决。
- **U4 `session_name` 硬编码与目录双口径**：pending 在 session 子目录、档案在父目录——统一到父目录 `results/`（对齐 `_RESULTS` 常量）？需 AlphaFactory 侧配合。
- **U5 双进程未核实**：是否需要一次进程树测量（`Get-CimInstance Win32_Process` 按 ParentProcessId 展开）确认是否真双进程、对超时与配额有无影响？
- **U6 测试面**：是否为 `index.ts` 参数构造抽纯函数（`buildSimulateParams(args)` 等）并补 4–6 条离线单测，把 A6/A7/A8 从「线上取证」降为「单测可证」？倾向：做。
