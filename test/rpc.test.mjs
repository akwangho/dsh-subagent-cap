// dsh-subagent-cap — RPC surface regression tests.
//
// Drives the controller through the `subagentCap` Typert Remote service
// (getState / setMax / setMode) with a fake ctx, covering persistence
// round-trip (merge semantics), value clamping on write, mode coercion, live
// settings edits propagating into state, and the loader inject mirror on apply.
//
// Needs runtime deps: run from the installed profile copy, or `npm install`
// then `npm test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as plugin from '../lib/index.js'

function harness({ withSettings = true } = {}) {
  const services = new Map()
  const listeners = {}
  let live = null
  let onChange = null

  const settingsSvc = withSettings ? {
    installSection(_ctx, _ns, _schema, defaults, hooks) {
      live = { ...defaults }
      hooks.setSource(() => live)
      onChange = hooks.onChange
    },
    async update(_ns, patch) {
      Object.assign(live, patch) // merge, mirroring the real settings service
      if (onChange) onChange()
    },
  } : undefined

  const ctx = {
    on: (ev, fn) => { listeners[ev] = fn },
    get: (k) => (k === 'settings' ? settingsSvc : undefined),
    inject: (deps, cb) => {
      if (deps.includes('settings') && settingsSvc) cb({ settings: settingsSvc })
    },
    subagents: { listChildren: async () => [] },
    effect: () => () => {},
    reflect: { provide: (name, instance) => services.set(name, instance) },
  }

  plugin.apply(ctx)
  const svc = services.get('subagentCap')
  assert.ok(svc, 'subagentCap service must be registered via reflect.provide')

  return {
    svc,
    listeners,
    pushConfig(cfg) { live = cfg; if (onChange) onChange() },
  }
}

const settled = async (ms = 20) => new Promise((r) => setTimeout(r, ms))

test('getState reports defaults on a fresh mount', () => {
  const h = harness()
  const s = h.svc.getState()
  assert.equal(s.maxSubagents, 1)
  assert.equal(s.mode, 'reject')
  assert.equal(typeof s.version, 'string')
  assert.deepEqual(s.rejections, [])
})

test('setMax clamps into [0,100] and persists (merge keeps mode)', async () => {
  const h = harness()
  await h.svc.setMode('queue')
  const r = await h.svc.setMax(5)
  assert.equal(r.ok, true)
  assert.equal(r.maxSubagents, 5)
  assert.equal(r.mode, 'queue', 'merge must NOT wipe mode on a max-only write')
  assert.equal(h.svc.getState().maxSubagents, 5)

  await h.svc.setMax(999)
  assert.equal(h.svc.getState().maxSubagents, 100, 'over-range clamps to 100')
  await h.svc.setMax(-2)
  assert.equal(h.svc.getState().maxSubagents, 0, 'negative clamps to 0')
  await h.svc.setMax('abc')
  assert.equal(h.svc.getState().maxSubagents, 1, 'invalid -> default 1')
})

test('setMode coerces non-queue to reject and persists', async () => {
  const h = harness()
  assert.deepEqual(await h.svc.setMode('queue'), { ok: true, maxSubagents: 1, mode: 'queue' })
  assert.equal(h.svc.getState().mode, 'queue')
  assert.deepEqual(await h.svc.setMode('bogus'), { ok: true, maxSubagents: 1, mode: 'reject' })
  assert.equal(h.svc.getState().mode, 'reject')
})

test('live settings edit (settings UI / yaml) propagates into state', async () => {
  const h = harness()
  assert.equal(h.svc.getState().maxSubagents, 1)
  h.pushConfig({ maxSubagents: 7, mode: 'queue' }) // simulates a provider write + onChange
  await settled()
  assert.equal(h.svc.getState().maxSubagents, 7, 'live edit must re-read the source getter')
  assert.equal(h.svc.getState().mode, 'queue')
})

test('settings missing: controller still boots with in-memory defaults', () => {
  const h = harness({ withSettings: false })
  const s = h.svc.getState()
  assert.equal(s.maxSubagents, 1)
  assert.equal(s.mode, 'reject')
})

test('loader inject mirror: apply.inject exposes the required services', () => {
  assert.deepEqual(plugin.inject, ['subagents'])
  assert.deepEqual(plugin.apply.inject, ['subagents'], 'apply must mirror inject for the default-export loader')
  assert.equal(plugin.name, 'dsh-subagent-cap')
})