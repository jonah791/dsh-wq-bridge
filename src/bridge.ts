/**
 * Python 桥客户端：管理 Python 子进程（stdio JSON-RPC）。
 * 请求-响应协议：每行一个 JSON {id, method, params} → {id, result} 或 {id, error}。
 */
import { spawn, type ChildProcess } from 'node:child_process'

export interface BridgeRequest {
  readonly id: number
  readonly method: string
  readonly params?: Record<string, unknown>
}

export class BridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

/**
 * Python 桥客户端。
 * @param pyScript - bridge_server.py 绝对路径
 * @param pythonBin - python 可执行（默认 'python'）
 * @param env - 额外环境变量（如 WQ 凭据）
 */
export class PythonBridge {
  private readonly proc: ChildProcess
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buf = ''
  private seq = 1
  private closed = false
  private readonly pyScript: string
  private readonly pythonBin: string

  constructor(pyScript: string, pythonBin = 'python', env: Record<string, string> = {}) {
    this.pyScript = pyScript
    this.pythonBin = pythonBin
    this.proc = spawn(this.pythonBin, [this.pyScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    this.proc.stdout?.on('data', (d: Buffer) => this.onData(d.toString('utf8')))
    this.proc.stderr?.on('data', (d: Buffer) => {
      const s = d.toString('utf8').trim()
      if (s) console.error('[wq-bridge:py]', s.slice(0, 500))
    })
    this.proc.on('exit', (code) => {
      this.closed = true
      const err = new BridgeError(`python bridge exited (code=${String(code)})`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })
    this.proc.on('error', (err) => {
      this.closed = true
      for (const p of this.pending.values()) p.reject(new BridgeError(`python bridge spawn failed: ${err.message}`))
      this.pending.clear()
    })
  }

  private onData(chunk: string): void {
    this.buf += chunk
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      let msg: { id?: number; result?: unknown; error?: string }
      try { msg = JSON.parse(t) } catch { continue }
      if (msg.id === undefined) continue
      const p = this.pending.get(msg.id)
      if (!p) continue
      this.pending.delete(msg.id)
      if (msg.error !== undefined) p.reject(new BridgeError(msg.error))
      else p.resolve(msg.result)
    }
  }

  /** 发一个请求并等待响应（默认 120s 超时——simulate 可达 90s+）。 */
  call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    if (this.closed) return Promise.reject(new BridgeError('bridge closed'))
    const id = this.seq++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError(`bridge timeout after ${timeoutMs}ms (${method})`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.proc.stdin?.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  /** 关闭桥（kill 子进程）。 */
  dispose(): void {
    this.closed = true
    try { this.proc.kill() } catch { /* noop */ }
  }
}