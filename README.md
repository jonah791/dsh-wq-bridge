# dsh-wq-bridge — WorldQuant BRAIN 平台桥（Python Bridge 模式）

**为 DeepSeek Harness (DSH) 打造的 AlphaFactory 平台桥**：TS 壳管理 Python 子进程（stdio JSON-RPC），向 DSH 工具面暴露 AlphaFactory 的平台能力。

> 状态：v0.3（阶段 1-4 完成：27 工具 + 全主 agent 挖掘循环实证）。DSH 为预览版（0.1.0-rc），无兼容承诺。


## 安装

```bash
cd <你的 self-plugins 目录>
git clone https://github.com/jonah791/dsh-wq-bridge.git
cd dsh-wq-bridge
pnpm install
pnpm build
```

## 架构

```
DSH 工具面 (TS) ←→ PythonBridge (stdio JSON-RPC) ←→ bridge_server.py ←→ AlphaOrchestrator (Python)
```

- **Python 核心 100% 保留**（AlphaFactory 215 测试资产不重写）
- 桥为长驻子进程（无每次启动开销）；请求-响应按 id 配对，支持并发
- 凭据：读 AlphaFactory 的 .env（WQ_USERNAME/WQ_PASSWORD）注入子进程
- dispose 时 kill 子进程（插件生命周期绑定）

## 工具面（v0.3 全量 27 工具，按域分组）

### 平台/只读（5）
| 工具 | 职责 |
|---|---|
| `wq_ping` | 桥连通性（Python 版本） |
| `wq_alpha_count` | 五库计数 |
| `wq_quota` | WQ 配额监控（挖掘前必查） |
| `wq_context_explore` | 探索上下文（开局必读） |
| `wq_context_refine` | 精炼上下文 |

### 核心挖掘（12）
| 工具 | 职责 |
|---|---|
| `wq_simulate` | WQ 回测（~90-150s，300s 桥超时） |
| `wq_recover_pending` | 崩溃兜底（超时后按表达式找回） |
| `wq_check_expression` | 表达式静态校验 |
| `wq_similarity_hint` | 撞车预检（simulate 前必查） |
| `wq_evaluate_submittability` | 四关评估 |
| `wq_add_to_zoo` | 入库（四关过→ready，否则→candidates） |
| `wq_suggest_next_round` | 轮次调度建议 |
| `wq_report_blindspot` | 盲点登记 |
| `wq_mark_as_waste` | 废渣判定 |
| `wq_add_weak_signal` | 弱信号入库（组合素材） |
| `wq_corr_with` / `wq_compute_correlation` | PnL 相关实测 |

### 分析（4，tools.py 纯计算）
| 工具 | 职责 |
|---|---|
| `wq_analyze_parse` | 表达式结构树 |
| `wq_analyze_similarity` | 结构相似度 |
| `wq_analyze_calibrated` | 标定相似度（→PnL corr 估计） |
| `wq_analyze_classify` | 信号族分类 |

### 知识（6，档案确定性查询）
| 工具 | 职责 |
|---|---|
| `wq_knowledge_blindspots` | 盲点档案（过滤） |
| `wq_knowledge_summary` | 盲点归纳摘要 |
| `wq_knowledge_meme` | 模因库 |
| `wq_knowledge_templates` | 模板库 |
| `wq_knowledge_family_tree` | 血统树 |
| `wq_knowledge_dead_roots` | 判死词根 |

### 库读取（3）
| 工具 | 职责 |
|---|---|
| `wq_submitted` / `wq_ready` / `wq_weak_pool` | 三库读取 |

## 组合

```yaml
- insert:
    - id: wq-bridge
      name: dsh-wq-bridge
```

## 测试

```sh
node node_modules/typescript/lib/tsc.js -p tsconfig.json && node --test
```

6/6 tests（mock python 服务：往返/参数/错误/并发/超时/dispose）。

## 实测证据（2026-08-15）

- 全主 agent 挖掘闭环：quota → context_explore（fn_mne_a 必答格点）→ check/similarity 预检（零撞车）→ simulate（sharpe 0.11，弱信号）→ add_to_zoo（candidates）
- 桥超时教训：simulate 需 300s（WQ 90-150s 波动）；recover_pending 兜底找回
- suggest_next_round 真实建议（combo：弱池 4 素材，rule2_combo）

## 演进

- 后续：四域拆分（mine/analyze/knowledge 独立插件）按需进行；领域知识桥接 dsh-agent-memory

## 相关

- [我的数字生命爱丽丝 — 插件生态中心（架构总览）](https://github.com/jonah791/alice-digital-life)

## License

MIT
