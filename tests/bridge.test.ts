/**
 * PythonBridge 协议单测（node --test，mock python 服务）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PythonBridge, BridgeError } from '../src/bridge.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOCK = join(HERE, 'mock_server.py')

test('ping：请求-响应往返', async () => {
  const b = new PythonBridge(MOCK)
  try {
    const r = await b.call<{ ok: boolean; pong: boolean }>('ping')
    assert.equal(r.ok, true)
    assert.equal(r.pong, true)
  } finally { b.dispose() }
})

test('echo：参数透传', async () => {
  const b = new PythonBridge(MOCK)
  try {
    const r = await b.call<{ echo: { a: number } }>('echo', { a: 42 })
    assert.equal(r.echo.a, 42)
  } finally { b.dispose() }
})

test('错误：服务端 error 字段 → BridgeError', async () => {
  const b = new PythonBridge(MOCK)
  try {
    await assert.rejects(() => b.call('error'), (e: unknown) =>
      e instanceof BridgeError && e.message.includes('mock error boom'))
  } finally { b.dispose() }
})

test('并发：多个请求交错（id 配对正确）', async () => {
  const b = new PythonBridge(MOCK)
  try {
    const results = await Promise.all([
      b.call<{ echo: { i: number } }>('echo', { i: 1 }),
      b.call<{ echo: { i: number } }>('echo', { i: 2 }),
      b.call<{ echo: { i: number } }>('echo', { i: 3 }),
    ])
    assert.deepEqual(results.map(r => r.echo.i), [1, 2, 3])
  } finally { b.dispose() }
})

test('超时：短超时触发 BridgeError', async () => {
  const b = new PythonBridge(MOCK)
  try {
    await assert.rejects(() => b.call('sleep', { ms: 300 }, 50), (e: unknown) =>
      e instanceof BridgeError && e.message.includes('timeout'))
  } finally { b.dispose() }
})

test('dispose 后调用 → 拒绝', async () => {
  const b = new PythonBridge(MOCK)
  b.dispose()
  await assert.rejects(() => b.call('ping'), (e: unknown) => e instanceof BridgeError)
})