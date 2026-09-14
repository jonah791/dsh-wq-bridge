/**
 * WQ 调用轨迹单测（跑 lib 产物）。
 *
 * 覆盖：脱敏/摘要/路径/序列化/解析 + 正常与失败落盘 + **尸体测试**（不可写路径 → false 且不抛，
 * 且**不改变返回值/异常传播**）+ **隐私尸体测试**（喂 password/username/token/WQ_PASSWORD →
 * 断言凭据与用户名**绝不出现在落盘行里**）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendTraceEntry,
  buildStamp,
  isSensitiveKey,
  mtimeOf,
  parseTraceEntries,
  readPackageVersion,
  readTraceEntries,
  resolveHome,
  serializeTraceEntry,
  summarizeParams,
  summarizeValue,
  wqTrace,
  wqTracePath,
  wrapToolExecute,
} from '../lib/trace.js'

const tmp = mkdtempSync(join(tmpdir(), 'wq-trace-test-'))
const base = (entry) => ({
  atMs: 1_700_000_000_000,
  phase: 'end',
  build: '0.1.1@42',
  tool: 'wq_simulate',
  pid: 777,
  durationMs: 91_234,
  ok: true,
  ...entry,
})

test('resolveHome / wqTracePath：DSH_HOME 优先，路径锚定单一文件名', () => {
  assert.equal(resolveHome({ DSH_HOME: 'E:/alice/.dsh' }, '/home/x'), 'E:/alice/.dsh')
  assert.equal(resolveHome({ DSH_HOME: ' ' }, '/home/x'), join('/home/x', '.dsh'))
  assert.equal(wqTracePath('/h/.dsh'), join('/h/.dsh', 'wq-trace.jsonl'))
})

test('isSensitiveKey：凭据/身份键命中；业务键不误伤（keyword/expression/alpha_id）', () => {
  for (const key of ['password', 'WQ_PASSWORD', 'pwd', 'secret', 'token', 'api_key', 'apiKey',
    'credential', 'cookie', 'username', 'user', 'login', 'email', 'chat_id']) {
    assert.equal(isSensitiveKey(key), true, key + ' 应判敏感')
  }
  for (const key of ['expression', 'expr1', 'expr2', 'alpha_id', 'keyword', 'sharpe', 'universe', 'section']) {
    assert.equal(isSensitiveKey(key), false, key + ' 不应判敏感')
  }
})

test('summarizeValue：截断/容器形状/空值；敏感键一律 [redacted]', () => {
  assert.equal(summarizeValue('expression', 'x'.repeat(300)).length, 161) // 160 + …（事件型键长限）
  assert.equal(summarizeValue('universe', 'y'.repeat(300)).length, 81)    // 普通键 80 + …
  assert.equal(summarizeValue('sharpe', 1.5), '1.5')
  assert.equal(summarizeValue('force', true), 'true')
  assert.equal(summarizeValue('checks', [1, 2, 3]), '[3 items]')
  assert.equal(summarizeValue('settings_override', { decay: 4 }), '{"decay":4}')
  assert.equal(summarizeValue('settings_override', { n: 'z'.repeat(200) }).endsWith('…'), true)
  assert.equal(summarizeValue('reason', null), 'null')
  assert.equal(summarizeValue('password', 'hunter2'), '[redacted]')
})

test('summarizeParams：拼装 + 跳过 undefined + 整体封顶 + 非对象返回空', () => {
  const line = summarizeParams({ expression: 'rank(close)', universe: 'TOP3000', with_consistency: undefined })
  assert.equal(line, 'expression=rank(close); universe=TOP3000')
  assert.equal(summarizeParams(undefined), '')
  assert.equal(summarizeParams(null), '')
  assert.equal(summarizeParams('str'), '')
  assert.ok(summarizeParams({ expression: 'z'.repeat(2000) }, 100).length <= 101)
})

test('隐私尸体测试：凭据/用户名绝不出现在落盘行里', () => {
  const path = join(tmp, 'privacy', 'wq-trace.jsonl')
  const params = {
    username: 'alice-secret-user',
    password: 'hunter2-must-not-land',
    WQ_PASSWORD: 'p@ss-must-not-land',
    token: 'tok-must-not-land',
    email: 'someone@example.com',
    expression: 'rank(close)',
  }
  assert.equal(wqTrace(base({ phase: 'begin', tool: 'wq_ping', params: summarizeParams(params) }), { path, now: 1, pid: 2 }), true)
  const raw = readFileSync(path, 'utf8')
  for (const secret of ['alice-secret-user', 'hunter2-must-not-land', 'p@ss-must-not-land', 'tok-must-not-land', 'someone@example.com']) {
    assert.equal(raw.includes(secret), false, secret + ' 泄漏进了轨迹！')
  }
  assert.ok(raw.includes('username=[redacted]'))
  assert.ok(raw.includes('password=[redacted]'))
  assert.ok(raw.includes('expression=rank(close)')) // 业务参数保留（排障要看）
})

test('serializeTraceEntry：单行 + 键序固定 + 缺省字段不污染', () => {
  const line = serializeTraceEntry(base({}))
  assert.equal(line.includes('\n'), false)
  assert.deepEqual(Object.keys(JSON.parse(line)), [
    'atMs', 'phase', 'build', 'tool', 'pid', 'durationMs', 'ok',
  ])
  const full = JSON.parse(serializeTraceEntry(base({ params: 'a=1', resultBytes: 12, error: 'boom', note: 'boot' })))
  assert.deepEqual(Object.keys(full).slice(7), ['params', 'resultBytes', 'error', 'note'])
})

test('parseTraceEntries：坏行/半行/空行/null 跳过；readTraceEntries 缺失/误读返回空数组', () => {
  const good = serializeTraceEntry(base({}))
  const text = ['', good, '  ', '{"atMs":1,"phase":"end"', '{"tool":"x"}', 'null', '0', 'nope'].join('\n')
  const parsed = parseTraceEntries(text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].tool, 'wq_simulate')
  assert.deepEqual(readTraceEntries(join(tmp, 'nope', 'wq-trace.jsonl')), [])
  assert.deepEqual(readTraceEntries(tmp), [])
})

test('appendTraceEntry：追加可回读（begin/end 两行 = 一次调用）', () => {
  const path = join(tmp, 'ok', 'wq-trace.jsonl')
  assert.equal(appendTraceEntry(path, base({ phase: 'begin', durationMs: 0, ok: true })), true)
  assert.equal(appendTraceEntry(path, base({ durationMs: 91_234 })), true)
  const back = readTraceEntries(path)
  assert.deepEqual(back.map((e) => e.phase), ['begin', 'end'])
})

test('尸体测试：父路径是普通文件 → 返回 false 且不抛（观测不反噬桥调用）', () => {
  const blocker = join(tmp, 'blocker')
  writeFileSync(blocker, 'not a dir', 'utf8')
  assert.doesNotThrow(() => {
    assert.equal(appendTraceEntry(join(blocker, 'wq-trace.jsonl'), base({})), false)
    assert.equal(wqTrace(base({}), { path: join(blocker, 'wq-trace.jsonl'), now: 1, pid: 1 }), false)
  })
})

test('构建自证：buildStamp/readPackageVersion/mtimeOf', () => {
  const root = join(tmp, 'pkg')
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.1' }), 'utf8')
  const self = join(root, 'lib', 'trace.js')
  writeFileSync(self, '// x', 'utf8')
  assert.equal(readPackageVersion(self), '0.1.1')
  assert.ok(mtimeOf(self) > 0)
  assert.equal(buildStamp(self, '0.1.1'), '0.1.1@' + String(mtimeOf(self)))
  assert.equal(buildStamp(join(root, 'missing.js'), ''), 'unknown@0')
})

test('wrapToolExecute 正常路径：begin/end 两行 + 耗时（注入时钟）+ 结果量级', async () => {
  const path = join(tmp, 'wrap', 'wq-trace.jsonl')
  // 注入时钟：now() 在包装体内被调用 4 次（startedAt / begin.atMs / end.durationMs / end.atMs）
  const times = [100, 100, 350, 350]
  const wrapped = wrapToolExecute('wq_simulate', async (args) => ({ ok: true, echo: args.expression }), {
    path, build: 'b@1', pid: 9, now: () => times.shift() ?? 350,
  })
  const result = await wrapped({ expression: 'rank(close)', universe: 'TOP3000' }, {})
  assert.deepEqual(result, { ok: true, echo: 'rank(close)' })
  const lines = readTraceEntries(path)
  assert.deepEqual(lines.map((e) => e.phase), ['begin', 'end'])
  assert.equal(lines[0].params, 'expression=rank(close); universe=TOP3000')
  assert.equal(lines[0].durationMs, 0)
  assert.equal(lines[1].durationMs, 250)      // 注入时钟：350 - 100
  assert.equal(lines[1].ok, true)
  assert.equal(lines[1].resultBytes, JSON.stringify({ ok: true, echo: 'rank(close)' }).length)
  assert.equal(lines[1].pid, 9)
  assert.equal(lines[1].build, 'b@1')
})

test('wrapToolExecute 失败路径：end 记 ok=false + error，且异常原样重抛', async () => {
  const path = join(tmp, 'wrap-fail', 'wq-trace.jsonl')
  const wrapped = wrapToolExecute('wq_simulate', async () => { throw new Error('bridge timeout after 120000ms (simulate)') }, {
    path, build: 'b@1', pid: 9, now: () => 1,
  })
  await assert.rejects(() => wrapped({ expression: 'x' }, {}), /bridge timeout after 120000ms/)
  const lines = readTraceEntries(path)
  assert.deepEqual(lines.map((e) => e.phase), ['begin', 'end'])
  assert.equal(lines[1].ok, false)
  assert.equal(lines[1].error, 'bridge timeout after 120000ms (simulate)')
})

test('wrapToolExecute 观测失败不反噬：不可写路径下返回值照常、不抛', async () => {
  const blocker = join(tmp, 'blocker')
  const wrapped = wrapToolExecute('wq_ping', async () => ({ ok: true, pong: true }), {
    path: join(blocker, 'wq-trace.jsonl'), build: 'b@1', now: () => 1,
  })
  assert.deepEqual(await wrapped({}, {}), { ok: true, pong: true })
})

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true })
})
