// dsh-subagent-cap — pre-execute gate integration tests.
//
// Exercises the `tools/pre-execute` waterfall with a fake ctx (no real runtime),
// covering the admission gate, slot-race protection, FIFO queue hold/release,
// queue→reject mode flip, caller abort (queued and admitted), the subagent/end
// free signal, non-delegate passthrough, and missing-agent passthrough.
//
// Needs runtime deps (@deepseek-ai/dsh-typert-protocol + schemastery): run from
// the installed profile copy, or `npm install` then `npm test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as plugin from '../lib/index.js'

// A controllable fake ctx: settable running children, live Config references, and
// captured event listeners. `reflect.provide` satisfies the Cordis Service
// constructor used by TypertRemoteService.
function makeHarness({ maxSubagents = 1, mode = 'queue', withSettings = true } = {}) {
  const listeners = {}
  let running = []
  let stored = { maxSubagents, mode }

  // Config arrives as cordis references, exactly as the Loader passes it. A
  // settings-page edit commits into the reference and dispatches
  // `loader/volatile-update`; that is what `commit()` below replays.
  const refs = {
    maxSubagents: { get: () => stored.maxSubagents },
    mode: { get: () => stored.mode },
  }

  const settings = withSettings ? { configure: () => () => {} } : undefined

  let injected = null
  const ctx = {
    subagents: {
      listChildren: async () => running.slice(),
    },
    reflect: { provide() {} },
    get: (k) => (k === 'systemPrompt' ? { context() {} } : k === 'settings' ? settings : undefined),
    inject: (deps, cb) => { injected = { deps, cb } }, // deferred; call injectNow() to run it
    on: (ev, fn) => { listeners[ev] = fn; return () => { delete listeners[ev] } },
    emit: (ev, ...args) => { if (listeners[ev]) listeners[ev](...args) },
    effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
    fiber: { name: 'dsh-subagent-cap' },
  }

  const dispose = plugin.apply(ctx, refs)

  return {
    dispose,
    listeners,
    settings,
    injected,
    get running() { return running },
    set running(v) { running = v },
    get stored() { return stored },
    /** Commit config the way the Loader does: mutate the reference, then notify. */
    commit(patch) {
      stored = { ...stored, ...patch }
      ctx.emit('loader/volatile-update', [Object.keys(patch)])
    },
    // a standard delegate call + a next() that succeeds
    delegate(callId, extra = {}) {
      return { name: 'subagent', agent: { id: 'sess-000000000000' }, callId, ...extra }
    },
  }
}

const allow = () => Promise.resolve({ kind: 'allow' })
const settle = async (ms = 30) => new Promise((r) => setTimeout(r, ms))

test('admission allows below cap and holds a slot in-flight', async () => {
  const h = makeHarness({ maxSubagents: 2 })
  const pre = h.listeners['tools/pre-execute']
  const r1 = await pre(h.delegate('c1'), allow)
  assert.equal(r1.kind, 'allow')

  // Second concurrent call: running=0 but in-flight=1 -> still below cap 2.
  const r2 = await pre(h.delegate('c2'), allow)
  assert.equal(r2.kind, 'allow')
  h.dispose()
})

test('over-cap in reject mode denies with a count in the reason', async () => {
  const h = makeHarness({ maxSubagents: 1, mode: 'reject' })
  const pre = h.listeners['tools/pre-execute']
  h.running = [{ kind: 'child', activity: 'running' }]
  const r = await pre(h.delegate('c1'), allow)
  assert.equal(r.kind, 'deny')
  assert.match(r.reason, /\(1\/1 running\)/)
  h.dispose()
})

test('over-cap in queue mode HOLDS the decision instead of denying', async () => {
  const h = makeHarness({ maxSubagents: 1, mode: 'queue' })
  const pre = h.listeners['tools/pre-execute']
  // fill the single slot
  await pre(h.delegate('c1'), allow)
  // second call: queued, promise stays pending
  let settled = null
  const p = pre(h.delegate('c2'), allow).then((v) => { settled = v })
  await settle()
  assert.equal(settled, null, 'queued call must not settle while the slot is held')
  h.dispose()
})

test('FIFO: subagent/end frees the slot and admits the queued waiter', async () => {
  const h = makeHarness({ maxSubagents: 1, mode: 'queue' })
  const pre = h.listeners['tools/pre-execute']
  const onResult = h.listeners['tools/result']

  // Model the real delegate lifecycle. Admitting a call only takes an inFlight
  // slot; the child becomes RUNNING when the spawn call settles (tools/result).
  // `subagent/end` frees a running slot — not an inFlight one — so the test has
  // to walk both steps. (Conflating the two is what made an earlier version of
  // this test unpassable: an admitted-but-not-yet-spawned delegate keeps its
  // inFlight slot, so occupancy never drops.)
  await pre(h.delegate('c1'), allow)
  h.running = [{ kind: 'child', activity: 'running' }]   // c1's spawn landed
  onResult({ name: 'subagent', callId: 'c1' })            // -> inFlight 1 -> 0

  let c2 = null
  pre(h.delegate('c2'), allow).then((v) => { c2 = v })
  await settle()
  assert.equal(c2, null, 'cap is full (one child running), so c2 waits')

  // child ends -> deliverAll -> occupancy 0 -> c2 admitted
  h.running = []
  h.listeners['subagent/end']()
  await settle(60)
  assert.deepEqual(c2, { kind: 'allow' })
  h.dispose()
})

test('queue→reject mode flip DENIES held waiters instead of hanging them', async () => {
  const h = makeHarness({ maxSubagents: 1, mode: 'queue' })
  const pre = h.listeners['tools/pre-execute']
  await pre(h.delegate('c1'), allow)          // fill slot
  let c2 = null
  pre(h.delegate('c2'), allow).then((v) => { c2 = v })
  await settle()
  assert.equal(c2, null)

  h.commit({ mode: 'reject' }) // -> loader/volatile-update -> deliverAll
  await settle(60)
  assert.equal(c2 && c2.kind, 'deny', 'waiter must be denied after mode flip, not hang')
  h.dispose()
})

test('caller abort of a QUEUED waiter denies it and removes it', async () => {
  const h = makeHarness({ maxSubagents: 1, mode: 'queue' })
  const pre = h.listeners['tools/pre-execute']
  await pre(h.delegate('c1'), allow)
  const ac = new AbortController()
  let c2 = null
  pre(h.delegate('c2', { signal: ac.signal }), allow).then((v) => { c2 = v })
  await settle()
  assert.equal(c2, null)
  ac.abort()
  await settle(60)
  assert.equal(c2 && c2.kind, 'deny')
  assert.match(c2.reason, /cancelled/i)
  h.dispose()
})

test('admitted slot is released on tools/result of that exact call', async () => {
  const h = makeHarness({ maxSubagents: 1, mode: 'queue' })
  const pre = h.listeners['tools/pre-execute']
  const onResult = h.listeners['tools/result']
  await pre(h.delegate('c1'), allow)
  let c2 = null
  pre(h.delegate('c2'), allow).then((v) => { c2 = v })
  await settle()
  assert.equal(c2, null, 'still held before result')

  onResult({ name: 'subagent', callId: 'c1' }) // c1 settles, frees the slot
  await settle(60)
  assert.deepEqual(c2, { kind: 'allow' }, 'c2 admitted after c1 result')
  h.dispose()
})

test('slot-race (bounded): exactly one of 5 parallel calls admits', async () => {
  const h = makeHarness({ maxSubagents: 1, mode: 'queue' })
  const pre = h.listeners['tools/pre-execute']
  const settled = []
  for (const id of ['p0', 'p1', 'p2', 'p3', 'p4']) {
    pre(h.delegate(id), allow).then((v) => settled.push({ id, v }))
  }
  await settle(60)
  // One admitted (allow); the other four still queued → only 1 settled.
  assert.equal(settled.length, 1, 'exactly one immediate admission')
  assert.equal(settled[0].v.kind, 'allow')
  h.dispose()
})

test('non-delegate tools pass through untouched', async () => {
  const h = makeHarness({ maxSubagents: 1, mode: 'reject' })
  const pre = h.listeners['tools/pre-execute']
  const r = await pre({ name: 'bash', agent: { id: 's' }, callId: 'c9' }, allow)
  assert.deepEqual(r, { kind: 'allow' })
  h.dispose()
})

test('missing agent/id passes through without counting', async () => {
  const h = makeHarness({ maxSubagents: 1, mode: 'reject' })
  const pre = h.listeners['tools/pre-execute']
  assert.deepEqual(await pre({ name: 'subagent', callId: 'c9' }, allow), { kind: 'allow' })
  assert.deepEqual(await pre({ name: 'subagent', agent: {}, callId: 'c10' }, allow), { kind: 'allow' })
  h.dispose()
})

test('different parents are capped independently', async () => {
  const h = makeHarness({ maxSubagents: 1, mode: 'reject' })
  const pre = h.listeners['tools/pre-execute']
  h.running = [{ kind: 'child', activity: 'running' }]
  // parent A is full -> deny
  const ra = await pre({ name: 'subagent', agent: { id: 'AAAA' }, callId: 'a1' }, allow)
  assert.equal(ra.kind, 'deny')
  // parent B has no running children -> allow
  h.running = []
  const rb = await pre({ name: 'subagent', agent: { id: 'BBBB' }, callId: 'b1' }, allow)
  assert.equal(rb.kind, 'allow')
  h.dispose()
})

test('dispose denies any still-queued waiters (no wedge on plugin stop)', async () => {
  const h = makeHarness({ maxSubagents: 1, mode: 'queue' })
  const pre = h.listeners['tools/pre-execute']
  await pre(h.delegate('c1'), allow)
  let c2 = null
  pre(h.delegate('c2'), allow).then((v) => { c2 = v })
  await settle()
  assert.equal(c2, null)
  h.dispose()
  await settle(30)
  assert.equal(c2 && c2.kind, 'deny')
  assert.match(c2.reason, /stopped/i)
})