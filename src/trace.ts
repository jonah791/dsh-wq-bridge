/**
 * WQ 桥调用自证轨迹（可维护性 S4 证据层 · 2026-09-14）。
 *
 * 动机：本插件是 30 个 `wq_*` 工具的**唯一入口**（统一走 `call()` → Python 子进程 JSON-RPC），
 * 但调用历史完全不可见——哪个工具、哪个表达式、耗时多久、成功与否、失败报文是什么，
 * 只存在于工具返回值与会话事件流里；宿主 logger 不落盘（AGENTS.md §5.22 规则 1）。
 * 结果是：`simulate` 超时/桥挂掉后，只能外部写脚本反解源码与会话流。
 *
 * 修法：每次调用落侧车 JSONL——`<DSH_HOME>/wq-trace.jsonl`。
 * 阶段枚举：`boot`（桥就绪自报）→ `begin`（调用发起）→ `end`（调用返回/抛错）。
 * **一次调用两行**（begin/end）：断点即「有 begin 无 end」= 桥卡死/进程死亡（这类故障
 * 正是本插件最需要可诊断的形态——只有单行『结束』记录时，卡死表现为「什么都没写」，不可辨）。
 *
 * 轨迹回答的五问（技能 plugin-maintainability 判据）：
 *   Q1 线上跑哪个构建 → `build`（`<version>@<trace 模块 mtime ms>`）
 *   Q2 谁发起         → `tool`（工具名）+ `pid`（哪个 web 进程）——调用者是模型，工具名即入口
 *   Q3 断在哪一段      → `phase`（有 begin 无 end = 卡死）+ `error`（桥错误报文，截 300 字符）
 *   Q4 结果质量        → `ok` + `resultBytes`（返回载荷量级）；**完整结果与会话事件流 join**
 *   Q5 耗时与预算      → `durationMs`（对照该工具自己的 `timeoutMs`：simulate 300s / 默认 120s）
 *
 * **隐私纪律（硬性）**：本轨迹**严禁**出现凭据——`summarizeParams` 对敏感键（password/pwd/
 * secret/token/credential/cookie/api_key/user 前缀/login/email/chat_id）一律写 `[redacted]`，
 * 其余值截断留摘要；桥的 env（含 `.env` 里的 WQ 凭据）**从不进入轨迹**。
 *
 * 观测绝不反噬主流程（技能 C4）：全部 IO 失败吞错并返回 `false`——写不进去也照常调用桥。
 *
 * @module dsh-wq-bridge/trace
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 阶段枚举。 */
export type WqTracePhase = 'boot' | 'begin' | 'end'

/** 一行 WQ 调用轨迹。 */
export interface WqTraceEntry {
  /** 写入时刻（ms epoch）。 */
  atMs: number
  phase: WqTracePhase
  /** 构建标识 `<version>@<模块 mtime ms>`（Q1）。 */
  build: string
  /** 工具名（`wq_simulate` …；boot 阶段为 `apply`）。 */
  tool: string
  /** 进程 pid（桥活在 web 进程内，pid 区分实例）。 */
  pid: number
  /** 耗时（ms）：boot=0；begin=0；end=实际调用耗时（Q5）。 */
  durationMs: number
  /** 结果状态：begin=已发起；end=true/false；boot=true。 */
  ok: boolean
  /** 关键参数摘要（**已脱敏 + 截断**，见 `summarizeParams`）。 */
  params?: string
  /** 返回载荷字符数（Q4 量级；仅 end 成功时）。 */
  resultBytes?: number
  /** 失败报文（截 300 字符）。 */
  error?: string
  /** 自由附注（boot 自报：pythonBin / pyScript / timeout 等，**不含凭据**）。 */
  note?: string
}

/** 敏感键模式（**凭据/身份严禁落盘**）：命中即写 `[redacted]`。 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /pass/i, /pwd/i, /secret/i, /token/i, /credential/i, /cookie/i,
  /api[_-]?key/i, /^user/i, /^login/i, /email/i, /chat[_-]?id/i,
]

/** 事件型长文本键（保留更多字符——它们才是排障要看的内容）。 */
const LONG_VALUE_KEYS: readonly string[] = ['expression', 'expr1', 'expr2']

/** 默认单次调用写入上限（字符）——轨迹是索引，不是全文仓库。 */
export const DEFAULT_PARAMS_MAX = 500

/** 解析 DSH_HOME：环境变量优先，缺省 `<homedir>/.dsh`（单一真源）。 */
export function resolveHome(
  env: Record<string, string | undefined> = process.env,
  fallback = homedir(),
): string {
  const raw = env['DSH_HOME']
  return raw !== undefined && raw.trim() !== '' ? raw : join(fallback, '.dsh')
}

/** 轨迹文件路径（纯函数）。 */
export function wqTracePath(home: string): string {
  return join(home, 'wq-trace.jsonl')
}

/** 键是否敏感（凭据/身份类）。 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

/** 单值摘要（纯函数）：敏感键 → `[redacted]`；字符串截断；容器给形状。 */
export function summarizeValue(key: string, value: unknown): string {
  if (isSensitiveKey(key)) return '[redacted]'
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') {
    const limit = LONG_VALUE_KEYS.includes(key) ? 160 : 80
    return value.length > limit ? value.slice(0, limit) + '…' : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${String(value.length)} items]`
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value)
      return json.length > 80 ? json.slice(0, 80) + '…' : json
    } catch {
      return '[object]'
    }
  }
  return String(value)
}

/**
 * 关键参数摘要（纯函数）：`key=value; key=value`，敏感键脱敏、长值截断、整体封顶。
 * 入参非对象（undefined / null）→ 空串。
 */
export function summarizeParams(params: unknown, maxLen = DEFAULT_PARAMS_MAX): string {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === undefined) continue
    parts.push(`${key}=${summarizeValue(key, value)}`)
  }
  const joined = parts.join('; ')
  return joined.length > maxLen ? joined.slice(0, maxLen) + '…' : joined
}

/** 文件 mtime（ms；不可得为 0）。 */
export function mtimeOf(file: string): number {
  try {
    return Math.round(statSync(file).mtimeMs)
  } catch {
    return 0
  }
}

/** 从 `<file>` 所在包的 package.json 读版本（读不到返回空串，不抛）。 */
export function readPackageVersion(file: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(file), '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** 构建标识 `<version>@<模块 mtime ms>`。 */
export function buildStamp(file: string, version = ''): string {
  return version !== '' ? `${version}@${String(mtimeOf(file))}` : `unknown@${String(mtimeOf(file))}`
}

/** 稳定序列化（键序固定 + 单行 JSON）。 */
export function serializeTraceEntry(entry: WqTraceEntry): string {
  const ordered: WqTraceEntry = {
    atMs: entry.atMs,
    phase: entry.phase,
    build: entry.build,
    tool: entry.tool,
    pid: entry.pid,
    durationMs: entry.durationMs,
    ok: entry.ok,
    ...(entry.params !== undefined ? { params: entry.params } : {}),
    ...(entry.resultBytes !== undefined ? { resultBytes: entry.resultBytes } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.note !== undefined ? { note: entry.note } : {}),
  }
  return JSON.stringify(ordered)
}

/** 容错解析：坏行/半行/空行跳过，不抛。 */
export function parseTraceEntries(text: string): WqTraceEntry[] {
  const out: WqTraceEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    try {
      const parsed = JSON.parse(line) as WqTraceEntry
      if (typeof parsed.atMs === 'number' && typeof parsed.phase === 'string') out.push(parsed)
    } catch {
      continue
    }
  }
  return out
}

/** 读轨迹文件；缺失/不可读返回空数组。 */
export function readTraceEntries(path: string): WqTraceEntry[] {
  try {
    return parseTraceEntries(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/** 追加一行（失败即吞并返回 false：观测绝不反噬桥调用）。 */
export function appendTraceEntry(path: string, entry: WqTraceEntry): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, serializeTraceEntry(entry) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 记一笔 WQ 轨迹（薄接线：补 atMs/pid，路径缺省 `<DSH_HOME>/wq-trace.jsonl`）。 */
export function wqTrace(
  entry: Omit<WqTraceEntry, 'atMs' | 'pid'>,
  opts: { path?: string; home?: string; now?: number; pid?: number } = {},
): boolean {
  const path = opts.path ?? wqTracePath(opts.home ?? resolveHome())
  return appendTraceEntry(path, { atMs: opts.now ?? Date.now(), pid: opts.pid ?? process.pid, ...entry })
}

/**
 * 包装工具执行体：`begin` → 调用 → `end`（成功带结果量级 / 失败带报文且**原样重抛**）。
 *
 * 设计要点：**纯函数 + 注入时钟**（`now` 可注入 → 耗时判定可离线单测）；
 * 观测失败绝不改变返回值/异常传播（`wqTrace` 全部吞错）。
 */
export function wrapToolExecute<A, R>(
  tool: string,
  execute: (args: A, exec: unknown) => Promise<R>,
  opts: { path?: string; home?: string; now?: () => number; build?: string; pid?: number } = {},
): (args: A, exec: unknown) => Promise<R> {
  const now = opts.now ?? Date.now
  const record = (entry: Omit<WqTraceEntry, 'atMs' | 'pid' | 'build'>): boolean =>
    wqTrace(
      { build: opts.build ?? 'unknown@0', ...entry },
      { ...(opts.path !== undefined ? { path: opts.path } : {}), ...(opts.pid !== undefined ? { pid: opts.pid } : {}), now: now() },
    )
  return async (args: A, exec: unknown): Promise<R> => {
    const startedAt = now()
    const params = summarizeParams(args)
    record({ phase: 'begin', tool, durationMs: 0, ok: true, ...(params !== '' ? { params } : {}) })
    try {
      const result = await execute(args, exec)
      let resultBytes: number | undefined
      try {
        resultBytes = JSON.stringify(result)?.length
      } catch {
        resultBytes = undefined // 循环引用等：量级缺失不影响轨迹
      }
      record({
        phase: 'end', tool, durationMs: now() - startedAt, ok: true,
        ...(resultBytes !== undefined ? { resultBytes } : {}),
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      record({ phase: 'end', tool, durationMs: now() - startedAt, ok: false, error: message.slice(0, 300) })
      throw error // 异常传播不变——观测层不吞业务错误
    }
  }
}
