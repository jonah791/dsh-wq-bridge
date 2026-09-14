/**
 * dsh-wq-bridge：WorldQuant BRAIN 平台桥（Python Bridge 模式）。
 *
 * TS 壳管理 Python 子进程（stdio JSON-RPC），向 DSH 工具面暴露
 * AlphaFactory 的平台能力（wq_api + orchestrator 只读面）。
 * Python 核心 100% 保留（215 测试资产不重写）。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PythonBridge } from './bridge.js'
import { buildStamp, readPackageVersion, wqTrace, wrapToolExecute } from './trace.ts'

export const name = 'wq-bridge'
export const inject = ['tools'] as const

export interface Config {
  /** Python 可执行 */
  pythonBin: string
  /** .env 文件路径（WQ 凭据；缺省读项目 .env） */
  envFile: string
  /** 桥超时（ms） */
  timeoutMs: number
}
export const Config = z.object({
  pythonBin: z.string().default('python'),
  envFile: z.string().default('E:/alice/projects/self/alphafactory/.env'),
  timeoutMs: z.number().default(120000),
})

const HERE = dirname(fileURLToPath(import.meta.url))

// 构建自证（Q1）：<version>@<自身模块 mtime ms>——版本号会说谎，mtime 不会。
const OWN_FILE = fileURLToPath(import.meta.url)
const BUILD = buildStamp(OWN_FILE, readPackageVersion(OWN_FILE))

/** 可被轨迹包装的工具定义形状（结构化最小面，避免把 cordis 泛型拖进接线层）。 */
type AnyToolDefinition = {
  name: string
  execute: (args: any, exec: any) => Promise<any>
}

/** 读取 .env 中的键值（简单解析：KEY=VALUE 行）。 */
function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const raw = readFileSync(path, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (m?.[1] !== undefined && m?.[2] !== undefined) out[m[1]] = m[2]

    }
  } catch { /* 无 .env 则仅环境变量 */ }
  return out
}

export function apply(ctx: Context, config: Config): void {
  const pyScript = join(HERE, '../python/bridge_server.py')
  const env = loadEnvFile(config.envFile)
  // ALPHA_ROOT 注入：envFile 位于 <ALPHA_ROOT>/alphafactory/.env → 向上两级
  if (!env.ALPHA_ROOT) env.ALPHA_ROOT = dirname(dirname(config.envFile))
  const bridge = new PythonBridge(pyScript, config.pythonBin, env)
  ctx.effect(() => () => bridge.dispose(), 'wq-bridge.dispose')

  const call = <T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number) =>
    bridge.call<T>(method, params, timeoutMs ?? config.timeoutMs)

  /**
   * 工具注册（带自证轨迹）：每个 `wq_*` 调用落 `begin`/`end` 两行到
   * `<DSH_HOME>/wq-trace.jsonl`（纯逻辑见 ./trace.ts）。
   * 有 `begin` 无 `end` = 桥卡死/进程死亡——**单行记录无法表达这个故障**，故必须两行。
   */
  const register = <D extends AnyToolDefinition>(definition: D): void => {
    const traced = {
      ...definition,
      execute: wrapToolExecute(definition.name, definition.execute, { build: BUILD }),
    } as D
    ctx.tools.register(traced as unknown as Parameters<typeof ctx.tools.register>[0])
  }

  // 桥就绪自报（Q1）：每次 apply 一行，含解释器/脚本/超时（**不含凭据**）
  wqTrace({
    phase: 'boot',
    build: BUILD,
    tool: 'apply',
    durationMs: 0,
    ok: true,
    note: `pyScript=${pyScript} pythonBin=${config.pythonBin} timeoutMs=${String(config.timeoutMs)} envKeys=${String(Object.keys(env).length)}`,
  })

  // ---------- wq_ping：连通性 ----------
  register(defineTool({
    name: 'wq_ping',
    description: '测试 WQ 桥连通性（Python 子进程存活 + 版本 + 真实解释器路径）。executable 暴露 sys.executable——诊断 PATH 里 python 是否为 shim/launcher（2026-08-27 双桥根因增强）。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, pong: { type: 'boolean', required: true }, py: { type: 'string', required: true }, executable: { type: 'string', required: true } } },
      render: (a, v) => [{ type: 'text', text: (v.ok ? '桥连通 (Python ' + v.py + ')' : '桥异常') + '\n解释器: ' + (v.executable ?? '?') }],
    },
    async execute() {
      return await call<{ ok: boolean; pong: boolean; py: string; executable: string }>('ping')
    },
  }))

  // ---------- wq_alpha_count：五库计数 ----------
  register(defineTool({
    name: 'wq_alpha_count',
    description: 'AlphaFactory 五库计数（submitted/ready/candidates/weak/waste）——快速状态概览。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          submitted: { type: 'integer', required: true },
          ready: { type: 'integer', required: true },
          candidates: { type: 'integer', required: true },
          weak: { type: 'integer', required: true },
          waste: { type: 'integer', required: true },
        },
      },
      render: (a, v) => [{ type: 'text', text: '五库：submitted ' + v.submitted + ' / ready ' + v.ready + ' / candidates ' + v.candidates + ' / weak ' + v.weak + ' / waste ' + v.waste }],
    },
    async execute() {
      return await call<{ ok: boolean; submitted: number; ready: number; candidates: number; weak: number; waste: number }>('alpha_count')
    },
  }))

  // ---------- wq_quota：配额监控 ----------
  register(defineTool({
    name: 'wq_quota',
    description: 'WorldQuant BRAIN 配额监控（今日 simulate 数/平台 alpha 总数）——挖掘前必查，防配额烧穿。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, quota: { type: 'json', required: true } } },
      render: (a, v) => [{ type: 'text', text: JSON.stringify(v.quota) }],
    },
    async execute() {
      return await call<{ ok: boolean; quota: JsonValue }>('quota')
    },
  }))

  // ---------- wq_context_explore：探索上下文 ----------
  register(defineTool({
    name: 'wq_context_explore',
    description: '探索模式上下文（字段库/算子库/未用格点/盲点摘要/模因/组合方法论）——挖掘轮开局必读。section 可选分块（grid/fields/datasets/operators/saturation/blindspots/meme/weak/combo），只取一节避免 60K 全文被入口守卫折叠（2026-08-26 增强）。',
    parameters: {
      section: { type: 'string', description: '只取指定节：grid/fields/datasets/operators/saturation/blindspots/meme/weak/combo；留空=全量' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, context: { type: 'string', required: true } } },
      // 2026-08-27 修复：之前 render 只显示长度摘要（"N 字符·节:xx"）——成员看不到 context 内容
      // （功能有但不可见，t10 反馈）。改为显示 context 前 1500 字符，直接可见内容；完整在 tool result。
      render: (a, v) => {
        const ctx = v.context ?? ''
        const head = ctx.slice(0, 1500)
        const lines = [`探索上下文${a.section ? '·节:' + a.section : ''}（${ctx.length} 字符）:`, head]
        if (ctx.length > 1500) lines.push('...（完整内容在 tool result，需全文可用 expand）')
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const r = await call<{ ok: boolean; context?: string; error?: string }>('context_explore', { section: args.section })
      if (!r.ok) throw new Error(r.error ?? 'context_explore failed')
      return { ok: true, context: r.context ?? '' }
    },
  }))

  // ---------- 核心工具面（阶段 2：dsh-alpha-mine 前置） ----------

  // 通用渲染：JSON 文本
  // 2026-08-27 修复类型错误：去掉显式 ContentBlock[] 返回标注——dsh-llm 双版本导致 ContentBlock
  // 类型实例冲突（node_modules 根 vs .pnpm），显式标注让 jsonRender 的返回类型与 schema 期望不兼容
  // → 构建 exit 1（虽然 tsc 仍 emit）。改隐式推断（wq_simulate 已验证不报错）。
  type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jsonRender = (prefix: string) => (a: Record<string, unknown>, v: Record<string, unknown>): any =>
    [{ type: 'text' as const, text: prefix + JSON.stringify(v).slice(0, 2000) }]

  // wq_simulate：核心挖掘动作（90s+ 长调用）
  // 2026-08-27 增强：自定义 render 摘要——核心指标 + consistency 摘要总可见。
  // 之前用 jsonRender 截断 2000 字符，with_consistency 的 consistency 字段在 JSON 末尾被截掉看不到（功能有但结果不可见=白做）。
  register(defineTool({
    name: 'wq_simulate',
    description: 'WQ 回测一个表达式（~90-150s）。universe 只传股票池名（TOP3000 等），region 才是 USA。settings_override 传六项（neutralization/decay/nanHandling/truncation/pasteurization/unitHandling）。返回 SimulationResult（含 sharpe/fitness/turnover/checks/effective_settings）。with_consistency=true 时自动补跑年度一致性检查（返回 consistency 字段，V3b 教训 2026-08-26）。',
    parameters: {
      expression: { type: 'string', required: true, description: 'FASTEXPR 表达式（≤500 字符）' },
      universe: { type: 'string', description: '股票池（TOP3000 等）' },
      settings_override: { type: 'json', description: '六项设置覆盖' },
      with_consistency: { type: 'boolean', description: 'simulate 后自动补跑年度一致性（consistency 字段），默认 false' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, simulation: { type: 'json', required: true } } }, render: (a, v) => {
      const s = (v.simulation ?? {}) as Record<string, unknown>
      // 2026-08-27 修复（pension render bug 根因）：simulate 失败（success=false + error）时
      // 旧 render 只显示 S=? F=? 把 error 吞了——误以为「字段解析 bug」。现在优先显示 error。
      if (s.success === false) {
        const err = String(s.error ?? 'unknown error')
        const empty = s.empty_factor ? ' [EMPTY_FACTOR]' : ''
        return [{ type: 'text' as const, text: `simulate FAILED${empty}: ${err}` }]
      }
      const lines = [`simulate: S=${String(s.sharpe ?? '?')} F=${String(s.fitness ?? '?')} TO=${String(s.turnover ?? '?')} returns=${String(s.returns ?? '?')} alpha=${String(s.alpha_id ?? '?')}`]
      if (s.empty_factor) lines.push('⚠️ EMPTY_FACTOR（PnL 全零/longCount=0，勿再 simulate 同字段）')
      const checks = s.checks as Record<string, string> | undefined
      if (checks && typeof checks === 'object') lines.push('checks: ' + Object.entries(checks).map(([k, val]) => `${k}=${String(val)}`).join(' '))
      const c = s.consistency as Record<string, unknown> | undefined
      if (c && typeof c === 'object') {
        lines.push(`consistency: passed=${String(c.passed ?? '?')} years=${String(c.years ?? '?')} pos=${String(c.positive_years ?? '?')} retention=${String(c.retention ?? '?')} minSh= ${String(c.min_sharpe ?? '?')}`)
      }
      return [{ type: 'text' as const, text: lines.join('\n') }]
    } },
    async execute(args) {
      const r = await call<{ ok: boolean; simulation?: unknown; error?: string }>('simulate', { expression: args.expression, universe: args.universe, settings_override: args.settings_override, with_consistency: args.with_consistency }, 300_000)
      if (!r.ok) throw new Error(r.error ?? 'simulate failed')
      return { ok: true, simulation: r.simulation as JsonValue }
    },
  }))

  // wq_recover_pending：崩溃兜底——找回超时/进程被杀后 WQ 已建的模拟
  register(defineTool({
    name: 'wq_recover_pending',
    description: '崩溃兜底：找回 pending 池中 WQ 已建但本地超时的模拟（按表达式回收）。任何 simulate 超时后先调它，命中即取结果继续；未命中才考虑重试。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, result: { type: 'json', required: true } } }, render: jsonRender('recover: ') },
    async execute() {
      const r = await call<{ ok: boolean; result?: JsonValue; error?: string }>('recover_pending', undefined, 180_000)
      if (!r.ok) throw new Error(r.error ?? 'recover failed')
      return { ok: true, result: r.result as JsonValue }
    },
  }))

  // wq_check_expression：表达式静态校验
  register(defineTool({
    name: 'wq_check_expression',
    description: '表达式静态校验（长度/语法/字段存在性/风险字段）。simulate 前可先查。',
    parameters: { expression: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, check: { type: 'json', required: true } } }, render: jsonRender('check: ') },
    async execute(args) {
      const r = await call<{ ok: boolean; check?: unknown; error?: string }>('check_expression', { expression: args.expression })
      if (!r.ok) throw new Error(r.error ?? 'check failed')
      return { ok: true, check: r.check as JsonValue }
    },
  }))

  // wq_similarity_hint：撞车预检（simulate 前必查）
  register(defineTool({
    name: 'wq_similarity_hint',
    description: '撞车预检（simulate 前必查）：max_similarity/most_similar（词袋）、waste_sims（废渣池对比 sim>0.7 弃用）、weak_sims（弱池对比 sim>0.7 换腿再试）、corr_risk（共享腿权重≥0.4 vs ready/submitted）、vs_*_legs 腿级共享明细。template_sim=true 不触发弃用。预检是换腿不是终止。',
    parameters: { expression: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, hint: { type: 'json', required: true } } }, render: jsonRender('hint: ') },
    async execute(args) {
      const r = await call<{ ok: boolean; hint?: unknown; error?: string }>('similarity_hint', { expression: args.expression })
      if (!r.ok) throw new Error(r.error ?? 'hint failed')
      return { ok: true, hint: r.hint as JsonValue }
    },
  }))

  // wq_evaluate_submittability：四关评估
  // 2026-08-27 增强：自定义 render 摘要——submittable/gates/max_corr/blocks/ready_note 总可见。
  // 之前用 jsonRender 截断 2000 字符，blocks/ready_note 在末尾被截掉（与 simulate consistency 同款缺陷）。
  register(defineTool({
    name: 'wq_evaluate_submittability',
    description: '四关评估：Gate1 七项 checks → Gate2 PnL corr<0.6576（平台实测被拒线）→ Gate3 S≥1.5 且 F≥1.5 → Gate4 年度一致性（fail-closed）。判定前自动 wait_pnl 稳定值。返回 gates/submittable/max_corr/blocks/ready_note。',
    parameters: {
      alpha_id: { type: 'string', required: true },
      sharpe: { type: 'number', required: true },
      fitness: { type: 'number', required: true },
      checks: { type: 'json', description: 'checks 全量字典 {check_name: PASS/FAIL}' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, evaluation: { type: 'json', required: true } } }, render: (a, v) => {
      const e = (v.evaluation ?? {}) as Record<string, unknown>
      const lines = [`evaluate: submittable=${String(e.submittable ?? '?')} max_corr=${String(e.max_corr ?? '?')}`]
      const gates = e.gates as Record<string, unknown> | undefined
      if (gates && typeof gates === 'object') {
        for (const [k, val] of Object.entries(gates)) {
          const g = val as Record<string, unknown> | undefined
          lines.push(`  ${k}: ${g && typeof g === 'object' && 'passed' in g ? String(g.passed) : String(val)}${g && typeof g === 'object' && 'detail' in g ? ' — ' + String(g.detail) : ''}`)
        }
      }
      const blocks = e.blocks as unknown
      if (Array.isArray(blocks) && blocks.length > 0) lines.push('  blocks: ' + blocks.map(String).join(' | '))
      if (e.ready_note) lines.push('  ready_note: ' + String(e.ready_note))
      return [{ type: 'text' as const, text: lines.join('\n') }]
    } },
    async execute(args) {
      const r = await call<{ ok: boolean; evaluation?: unknown; error?: string }>('evaluate_submittability', { alpha_id: args.alpha_id, sharpe: args.sharpe, fitness: args.fitness, checks: args.checks }, 300_000)
      if (!r.ok) throw new Error(r.error ?? 'evaluate failed')
      return { ok: true, evaluation: r.evaluation as JsonValue }
    },
  }))

  // wq_add_to_zoo：入库
  register(defineTool({
    name: 'wq_add_to_zoo',
    description: '入库（tier 自动判定：四关全过→ready；否则→candidates）。mode 值域 explore/refine。sharpe/fitness 必须传真值（0 会静默入库空 metrics）。ready 门槛 S≥1.5 且 F≥1.5 + checks 全绿 + corr<0.6576。',
    parameters: {
      expression: { type: 'string', required: true },
      alpha_id: { type: 'string', required: true },
      mode: { type: 'string', enum: ['explore', 'refine'], description: '默认 explore' },
      parent_id: { type: 'string' },
      expected_effect: { type: 'string' },
      sharpe: { type: 'number', required: true },
      fitness: { type: 'number', required: true },
      checks: { type: 'json' },
      turnover: { type: 'number' },
      returns: { type: 'json' },
      grade: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, result: { type: 'json', required: true } } }, render: jsonRender('add_to_zoo: ') },
    async execute(args) {
      const r = await call<{ ok: boolean; result?: unknown; error?: string }>('add_to_zoo', { expression: args.expression, alpha_id: args.alpha_id, mode: args.mode, parent_id: args.parent_id, expected_effect: args.expected_effect, sharpe: args.sharpe, fitness: args.fitness, checks: args.checks, turnover: args.turnover, returns: args.returns, grade: args.grade }, 300_000)
      if (!r.ok) throw new Error(r.error ?? 'add_to_zoo failed')
      return { ok: true, result: r.result as JsonValue }
    },
  }))

  // wq_context_refine：精炼上下文
  register(defineTool({
    name: 'wq_context_refine',
    description: '精炼模式上下文（父代链/Refine Targets/blocks 明细）——精炼轮开局必读。',
    parameters: { alpha_id: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, context: { type: 'string', required: true } } }, render: (a, v) => {
      // 2026-08-27 修复：之前只显示「精炼上下文 N 字符」——成员看不到父代链/targets/blocks 内容
      // （t10 反馈「render 只显示摘要」同类问题）。改为显示 context 前 1500 字符。
      const ctx = v.context ?? ''
      const head = ctx.slice(0, 1500)
      const lines = [`精炼上下文（${ctx.length} 字符）:`, head]
      if (ctx.length > 1500) lines.push('...（完整内容在 tool result，需全文可用 expand）')
      return [{ type: 'text' as const, text: lines.join('\n') }]
    } },
    async execute(args) {
      const r = await call<{ ok: boolean; context?: string; error?: string }>('context_refine', { alpha_id: args.alpha_id })
      if (!r.ok) throw new Error(r.error ?? 'context_refine failed')
      return { ok: true, context: r.context ?? '' }
    },
  }))

  // wq_suggest_next_round：轮次调度建议
  register(defineTool({
    name: 'wq_suggest_next_round',
    description: '轮次调度建议（explore/refine/combo/maintain）——量化状态驱动，供主 agent 决策参考（信息不裁决）。',
    parameters: { recent_rounds: { type: 'array', items: { type: 'string' }, description: '最近轮次类型列表' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, suggestion: { type: 'json', required: true } } }, render: jsonRender('suggest: ') },
    async execute(args) {
      const r = await call<{ ok: boolean; suggestion?: unknown; error?: string }>('suggest_next_round', { recent_rounds: args.recent_rounds })
      if (!r.ok) throw new Error(r.error ?? 'suggest failed')
      return { ok: true, suggestion: r.suggestion as JsonValue }
    },
  }))

  // wq_report_blindspot：盲点登记
  register(defineTool({
    name: 'wq_report_blindspot',
    description: '登记新盲点。archive 必须传枚举（operator/dataset/family）。盲点归纳机制：返回含 summary_due: True 时表示已达 100 整数倍，需回报主 agent 执行归纳。',
    parameters: {
      archive: { type: 'string', required: true, description: 'operator/dataset/family' },
      issue: { type: 'string', required: true, description: '问题描述（>20 字符）' },
      evidence: { type: 'string', required: true },
      fix_suggestion: { type: 'string' },
      operator: { type: 'string' },
      dataset: { type: 'string' },
      family: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, result: { type: 'json', required: true } } }, render: jsonRender('blindspot: ') },
    async execute(args) {
      const r = await call<{ ok: boolean; result?: unknown; error?: string }>('report_blindspot', { archive: args.archive, issue: args.issue, evidence: args.evidence, fix_suggestion: args.fix_suggestion, operator: args.operator, dataset: args.dataset, family: args.family })
      if (!r.ok) throw new Error(r.error ?? 'blindspot failed')
      return { ok: true, result: r.result as JsonValue }
    },
  }))

  // wq_mark_as_waste：废渣判定
  register(defineTool({
    name: 'wq_mark_as_waste',
    description: '把判定没救的候选移入废渣池（停止投入）。',
    parameters: { alpha_id: { type: 'string', required: true }, reason: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, result: { type: 'json', required: true } } }, render: jsonRender('waste: ') },
    async execute(args) {
      const r = await call<{ ok: boolean; result?: unknown; error?: string }>('mark_as_waste', { alpha_id: args.alpha_id, reason: args.reason })
      if (!r.ok) throw new Error(r.error ?? 'waste failed')
      return { ok: true, result: r.result as JsonValue }
    },
  }))

  // wq_add_weak_signal：弱信号入库（组合素材）
  register(defineTool({
    name: 'wq_add_weak_signal',
    description: '弱信号入库（组合轮素材）：F∈[0.3,1.0)（S∈[0.5,1.3) 资格线）的单因子，有经济逻辑就入弱信号池而非判废。reason 必须写经济逻辑。',
    parameters: {
      expression: { type: 'string', required: true },
      alpha_id: { type: 'string', required: true },
      sharpe: { type: 'number', required: true },
      fitness: { type: 'number', required: true },
      reason: { type: 'string', required: true },
      corr: { type: 'number' },
      force: { type: 'boolean' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, result: { type: 'json', required: true } } }, render: jsonRender('weak: ') },
    async execute(args) {
      const r = await call<{ ok: boolean; result?: unknown; error?: string }>('add_weak_signal', { expression: args.expression, alpha_id: args.alpha_id, sharpe: args.sharpe, fitness: args.fitness, reason: args.reason, corr: args.corr, force: args.force })
      if (!r.ok) throw new Error(r.error ?? 'weak failed')
      return { ok: true, result: r.result as JsonValue }
    },
  }))

  // wq_corr_with：两因子 PnL 相关
  register(defineTool({
    name: 'wq_corr_with',
    description: '两因子 PnL 相关性（|corr|≥0.7 撞车；0.6576 平台被拒线）。',
    parameters: { alpha_id: { type: 'string', required: true }, ref_id: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, corr: { type: 'json', required: true } } }, render: jsonRender('corr: ') },
    async execute(args) {
      const r = await call<{ ok: boolean; corr?: unknown; error?: string }>('corr_with', { alpha_id: args.alpha_id, ref_id: args.ref_id })
      if (!r.ok) throw new Error(r.error ?? 'corr failed')
      return { ok: true, corr: r.corr as JsonValue }
    },
  }))

  // wq_compute_correlation：单因子 vs ACTIVE/全库 PnL 相关（口径可选）
  register(defineTool({
    name: 'wq_compute_correlation',
    description: '单因子 PnL 相关（口径可选）：include_ready=true=全库（submitted+ready，保守默认）；false=仅 ACTIVE（与 WQ 提交 SELF_CORRELATION 判定一致，也是 wq_evaluate_submittability Gate2 主口径）。候选池文件 correlation.max_corr/stale_corr 是入库快照——禁止用于提交决策，一律本工具实测（评估必须实测，禁止信库内旧值）。',
    parameters: { alpha_id: { type: 'string', required: true }, include_ready: { type: 'boolean', description: 'true=全库口径（默认）/ false=仅 ACTIVE' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, corr: { type: 'json', required: true } } }, render: jsonRender('corr: ') },
    async execute(args) {
      const r = await call<{ ok: boolean; corr?: unknown; error?: string }>('compute_correlation', { alpha_id: args.alpha_id, include_ready: args.include_ready })
      if (!r.ok) throw new Error(r.error ?? 'corr failed')
      return { ok: true, corr: r.corr as JsonValue }
    },
  }))

  // ---------- analyze 域（表达式分析） ----------
  register(defineTool({
    name: 'wq_analyze_parse',
    description: '解析表达式为结构树（词法/语法层）。',
    parameters: { expression: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, tree: { type: 'json', required: true } } }, render: jsonRender('tree: ') },
    async execute(args) {
      const r = await call<{ ok: boolean; tree?: JsonValue; error?: string }>('analyze_parse', { expression: args.expression })
      if (!r.ok) throw new Error(r.error ?? 'parse failed')
      return { ok: true, tree: r.tree as JsonValue }
    },
  }))
  register(defineTool({
    name: 'wq_analyze_similarity',
    description: '两表达式结构相似度（词袋：op/field/签名加权）。',
    parameters: { expr1: { type: 'string', required: true }, expr2: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, similarity: { type: 'number', required: true } } }, render: (a, v) => [{ type: 'text' as const, text: 'similarity: ' + v.similarity }] },
    async execute(args) {
      const r = await call<{ ok: boolean; similarity?: number; error?: string }>('analyze_similarity', { expr1: args.expr1, expr2: args.expr2 })
      if (!r.ok) throw new Error(r.error ?? 'similarity failed')
      return { ok: true, similarity: r.similarity ?? 0 }
    },
  }))
  register(defineTool({
    name: 'wq_analyze_calibrated',
    description: '标定相似度（结构相似度→PnL corr 估计，78 样本回归 1.573x-0.033）。',
    parameters: { expr1: { type: 'string', required: true }, expr2: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, similarity: { type: 'number', required: true } } }, render: (a, v) => [{ type: 'text' as const, text: 'calibrated: ' + v.similarity }] },
    async execute(args) {
      const r = await call<{ ok: boolean; similarity?: number; error?: string }>('analyze_calibrated', { expr1: args.expr1, expr2: args.expr2 })
      if (!r.ok) throw new Error(r.error ?? 'calibrated failed')
      return { ok: true, similarity: r.similarity ?? 0 }
    },
  }))
  register(defineTool({
    name: 'wq_analyze_classify',
    description: '表达式信号族分类（S→B→K 分层）。',
    parameters: { expression: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, classification: { type: 'json', required: true } } }, render: jsonRender('class: ') },
    async execute(args) {
      const r = await call<{ ok: boolean; classification?: JsonValue; error?: string }>('analyze_classify', { expression: args.expression })
      if (!r.ok) throw new Error(r.error ?? 'classify failed')
      return { ok: true, classification: r.classification as JsonValue }
    },
  }))
  // ---------- knowledge 域（档案确定性查询） ----------
  register(defineTool({
    name: 'wq_knowledge_blindspots',
    description: '盲点档案查询（可过滤 archive=operator/dataset/family）。规模 657+ 条，默认返回前 50。',
    parameters: {
      archive: { type: 'string', description: 'operator/dataset/family' },
      operator: { type: 'string' }, dataset: { type: 'string' }, family: { type: 'string' },
      limit: { type: 'integer', description: '返回条数上限（默认 50）' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, total: { type: 'integer', required: true }, entries: { type: 'json', required: true } } }, render: (a, v) => [{ type: 'text' as const, text: '盲点 ' + v.total + ' 条（显示 ' + (Array.isArray(v.entries) ? v.entries.length : 0) + '）' }] },
    async execute(args) {
      const r = await call<{ ok: boolean; total?: number; entries?: JsonValue; error?: string }>('knowledge_blindspots', { archive: args.archive, operator: args.operator, dataset: args.dataset, family: args.family, limit: args.limit })
      if (!r.ok) throw new Error(r.error ?? 'blindspots failed')
      return { ok: true, total: r.total ?? 0, entries: r.entries as JsonValue }
    },
  }))
  register(defineTool({
    name: 'wq_knowledge_summary',
    description: '盲点归纳摘要（100 条归纳产物，替代全文进上下文的 -84% 版本）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, summary: { type: 'json', required: true } } }, render: jsonRender('summary: ') },
    async execute() {
      const r = await call<{ ok: boolean; summary?: JsonValue; error?: string }>('knowledge_summary')
      if (!r.ok) throw new Error(r.error ?? 'summary failed')
      return { ok: true, summary: r.summary as JsonValue }
    },
  }))
  register(defineTool({
    name: 'wq_knowledge_meme',
    description: '模因库（跨家族算子子树三态：活性/饱和/有毒）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, meme: { type: 'json', required: true } } }, render: jsonRender('meme: ') },
    async execute() {
      const r = await call<{ ok: boolean; meme?: JsonValue; error?: string }>('knowledge_meme')
      if (!r.ok) throw new Error(r.error ?? 'meme failed')
      return { ok: true, meme: r.meme as JsonValue }
    },
  }))
  register(defineTool({
    name: 'wq_knowledge_templates',
    description: '表达式模板库（验证过的家族骨架 + 参数定稿 + 禁区）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, templates: { type: 'json', required: true } } }, render: jsonRender('templates: ') },
    async execute() {
      const r = await call<{ ok: boolean; templates?: JsonValue; error?: string }>('knowledge_templates')
      if (!r.ok) throw new Error(r.error ?? 'templates failed')
      return { ok: true, templates: r.templates as JsonValue }
    },
  }))
  register(defineTool({
    name: 'wq_knowledge_family_tree',
    description: '血统树（精炼变体可追溯：父代链/毒父代警示）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, tree: { type: 'json', required: true } } }, render: jsonRender('tree: ') },
    async execute() {
      const r = await call<{ ok: boolean; tree?: JsonValue; error?: string }>('knowledge_family_tree')
      if (!r.ok) throw new Error(r.error ?? 'family_tree failed')
      return { ok: true, tree: r.tree as JsonValue }
    },
  }))
  register(defineTool({
    name: 'wq_knowledge_dead_roots',
    description: '判死词根（盲点证伪字段：内置 + 外部 extra 双轨）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, builtin: { type: 'json', required: true }, extra: { type: 'json', required: true }, total: { type: 'integer', required: true } } }, render: (a, v) => [{ type: 'text' as const, text: '判死词根 ' + v.total + ' 个' }] },
    async execute() {
      const r = await call<{ ok: boolean; builtin?: JsonValue; extra?: JsonValue; total?: number; error?: string }>('knowledge_dead_roots')
      if (!r.ok) throw new Error(r.error ?? 'dead_roots failed')
      return { ok: true, builtin: r.builtin as JsonValue, extra: r.extra as JsonValue, total: r.total ?? 0 }
    },
  }))

  // ---------- wq_submitted / wq_ready / wq_weak：库读取 ----------
  register(defineTool({
    name: 'wq_submitted',
    description: '已提交因子库（ACTIVE）完整列表。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, submitted: { type: 'json', required: true } } },
      render: (a, v) => [{ type: 'text', text: 'submitted ' + (Array.isArray(v.submitted) ? v.submitted.length : '?') + ' 条' }],
    },
    async execute() {
      return await call<{ ok: boolean; submitted: JsonValue }>('submitted')
    },
  }))

  register(defineTool({
    name: 'wq_ready',
    description: '待提交因子库（ready，四关全过）完整列表。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, ready: { type: 'json', required: true } } },
      render: (a, v) => [{ type: 'text', text: 'ready ' + (Array.isArray(v.ready) ? v.ready.length : '?') + ' 条' }],
    },
    async execute() {
      return await call<{ ok: boolean; ready: JsonValue }>('ready')
    },
  }))

  register(defineTool({
    name: 'wq_weak_pool',
    description: '弱信号池（组合轮素材）完整列表。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, weak: { type: 'json', required: true } } },
      render: (a, v) => [{ type: 'text', text: 'weak ' + (Array.isArray(v.weak) ? v.weak.length : '?') + ' 条' }],
    },
    async execute() {
      return await call<{ ok: boolean; weak: JsonValue }>('weak_pool')
    },
  }))
}