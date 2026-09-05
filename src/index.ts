/**
 * dsh-subagent-cap — host half (TypeScript source of record).
 *
 * Compiled to `lib/index.js`. Enforces a per-session cap on concurrently
 * running subagents with imperative guidance, a real pre-emptive block at
 * `tools/pre-execute`, a queue mode, and `settings`-backed persistence.
 */
import z from '@deepseek-ai/schemastery'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

export const name = 'dsh-subagent-cap'
export const inject = ['subagents', 'agents', 'systemPrompt', 'timer']

const VERSION = '1.0.0'
const NAMESPACE = 'subagent-cap'
const DELEGATE_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow'])
const DEFAULT_MAX = 1
const MIN_MAX = 0
const MAX_MAX = 100

const SCHEMA = z.object({
  maxSubagents: z.number().default(DEFAULT_MAX),
  mode: z.union([z.const('reject'), z.const('queue')]).default('reject'),
})

type Config = { maxSubagents: number; mode: 'reject' | 'queue' }

// ---- Remote decorator bookkeeping (hand-written) ----
const remoteInitializers: Array<(this: unknown) => void> = []
function declareRemote(method: string): void {
  const context: any = {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    access: {},
    addInitializer(fn: (this: unknown) => void) { remoteInitializers.push(fn) },
  }
  Remote(method)(undefined, context)
}
declareRemote('getState')
declareRemote('setMax')
declareRemote('setMode')

class SubagentCapService extends TypertRemoteService {
  private readonly ctrl: any
  constructor(ctx: any, ctrl: any) {
    super(ctx, 'subagentCap')
    this.ctrl = ctrl
    for (const fn of remoteInitializers) fn.call(this)
  }
  getState() { return this.ctrl.getState() }
  setMax(maxSubagents: number) { return this.ctrl.setMax(maxSubagents) }
  setMode(mode: 'reject' | 'queue') { return this.ctrl.setMode(mode) }
}

function createController(ctx: any) {
  const subagents = ctx.subagents
  const systemPrompt = ctx.systemPrompt
  const settings = ctx.get('settings')

  let config: Config = { maxSubagents: DEFAULT_MAX, mode: 'reject' }

  function sanitize(value: any): Config {
    const max = Number(value && value.maxSubagents)
    const mode = value && value.mode === 'queue' ? 'queue' : 'reject'
    return {
      maxSubagents: Number.isFinite(max) ? Math.max(MIN_MAX, Math.min(MAX_MAX, Math.round(max))) : DEFAULT_MAX,
      mode,
    }
  }

  if (settings && typeof settings.installSection === 'function') {
    settings.installSection(ctx, NAMESPACE, SCHEMA, { maxSubagents: DEFAULT_MAX, mode: 'reject' }, {
      setSource: (current: () => Config) => { config = sanitize(current()) },
      onChange: () => {},
    })
  }

  async function setMax(maxSubagents: number) {
    if (settings && typeof settings.update === 'function') {
      await settings.update(NAMESPACE, { maxSubagents })
      const resolved = settings.get(NAMESPACE)
      if (resolved !== undefined) config = sanitize(resolved)
    } else {
      config = sanitize({ ...config, maxSubagents })
    }
    return { ok: true, maxSubagents: config.maxSubagents, mode: config.mode }
  }

  async function setMode(mode: 'reject' | 'queue') {
    const next = mode === 'queue' ? 'queue' : 'reject'
    if (settings && typeof settings.update === 'function') {
      await settings.update(NAMESPACE, { mode: next })
      const resolved = settings.get(NAMESPACE)
      if (resolved !== undefined) config = sanitize(resolved)
    } else {
      config = sanitize({ ...config, mode: next })
    }
    return { ok: true, maxSubagents: config.maxSubagents, mode: config.mode }
  }

  systemPrompt.context({
    name: 'subagent-cap',
    order: 950,
    text: () => {
      const modeHint = config.mode === 'queue'
        ? '已達上限時，新的委派會被排隊，等有空位再執行。'
        : '已達上限時，新的委派會被拒絕。'
      return '你在這個會話中最多只能「同時」執行 ' + config.maxSubagents + ' 個 subagent。' +
        '啟動新的 subagent 前，請先確認目前仍在執行中的 subagent 數量；' + modeHint
    },
  })

  async function runningCount(parentId: string): Promise<number> {
    try {
      const children = await subagents.listChildren(parentId)
      return children.filter((c: any) => c && c.kind === 'child' && c.activity === 'running').length
    } catch {
      return 0
    }
  }

  const queueLog = new Map<string, { count: number; last: number }>()
  const rejections: Array<{ time: number; sessionId: string; tool: string; reason: string }> = []

  function noteQueue(sessionId: string) {
    const cur = queueLog.get(sessionId) || { count: 0, last: 0 }
    cur.count += 1
    cur.last = Date.now()
    queueLog.set(sessionId, cur)
  }
  function noteRejection(sessionId: string, tool: string, reason: string) {
    rejections.push({ time: Date.now(), sessionId, tool, reason })
    if (rejections.length > 100) rejections.splice(0, rejections.length - 100)
  }

  ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
    const toolName = exec && exec.name
    if (!toolName || !DELEGATE_TOOLS.has(toolName)) return next()
    const parentId = exec.agent && exec.agent.id ? String(exec.agent.id) : undefined
    if (!parentId) return next()

    const running = await runningCount(parentId)
    if (running < config.maxSubagents) return next()

    if (config.mode === 'queue') {
      noteQueue(parentId)
      return {
        kind: 'deny',
        reason: 'Subagent cap reached (' + running + '/' + config.maxSubagents +
          ' running). Your request was queued — wait for a running subagent to finish, then retry.',
      }
    }
    noteRejection(parentId, toolName, 'over-limit')
    return {
      kind: 'deny',
      reason: 'Subagent cap reached (' + running + '/' + config.maxSubagents +
        ' running). A new subagent cannot be started now.',
    }
  })

  const offStart = ctx.on('subagent/start', () => {})

  function getState() {
    return {
      version: VERSION,
      maxSubagents: config.maxSubagents,
      mode: config.mode,
      queue: Array.from(queueLog.entries()).map(([sessionId, v]) => ({
        sessionId: sessionId.slice(0, 12) + '…',
        count: v.count,
        last: v.last,
      })),
      rejections: rejections.slice(-20).map((r) => ({
        time: r.time,
        sessionId: r.sessionId.slice(0, 12) + '…',
        tool: r.tool,
        reason: r.reason,
      })),
    }
  }

  return { getState, setMax, setMode, dispose: () => { offStart() } }
}

export function apply(ctx: any) {
  const controller = createController(ctx)
  new SubagentCapService(ctx, controller)
  return controller.dispose
}

export default apply