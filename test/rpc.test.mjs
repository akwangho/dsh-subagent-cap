// dsh-subagent-cap — RPC surface and volatile-Config regression tests.
//
// Drives the controller through the `subagentCap` Typert Remote service
// (getState) with a fake ctx, covering the live-Config contract, value clamping,
// mode coercion, the settings page policy, and the loader inject mirror on apply.
//
// Configuration is ordinary volatile plugin Config now, so these tests feed it
// the way the Loader does — one reference per field, read with `.get()`, changed
// by committing into the reference and dispatching `loader/volatile-update` —
// instead of the removed `setMax` / `setMode` write RPC.
//
// Needs runtime deps: `npm install` then `npm test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as plugin from '../lib/index.js'

function harness({ values = {}, withSettings = true } = {}) {
  const services = new Map()
  const listeners = {}
  const disposers = []

  const state = {
    maxSubagents: 1,
    mode: 'reject',
    ...values,
  }
  // Config arrives as cordis references, exactly as the Loader passes it.
  const refs = {
    maxSubagents: { get: () => state.maxSubagents },
    mode: { get: () => state.mode },
  }

  let configured = false
  const settingsSvc = withSettings ? {
    configure(presentation) {
      configured = true
      assert.deepEqual(presentation, { auto: false }, 'must tell DSH this plugin ships its own page')
      return () => {}
    },
  } : undefined

  const ctx = {
    on(ev, fn) {
      if (!listeners[ev]) listeners[ev] = []
      listeners[ev].push(fn)
    },
    emit(ev, ...args) {
      for (const fn of listeners[ev] || []) fn(...args)
    },
    get: (k) => (k === 'settings' ? settingsSvc : undefined),
    inject: (deps, cb) => {
      // A real `ctx.inject` child is a full Context; the plugin registers its
      // settings page policy as an effect on it.
      if (deps.includes('settings') && settingsSvc) cb({ settings: settingsSvc, effect: ctx.effect, fiber: ctx })
    },
    subagents: { listChildren: async () => [] },
    effect(cb) {
      const dispose = cb()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose || (() => {})
    },
    reflect: { provide: (name, instance) => services.set(name, instance) },
  }

  plugin.apply(ctx, refs)
  const svc = services.get('subagentCap')
  assert.ok(svc, 'subagentCap service must be registered via reflect.provide')

  return {
    svc,
    listeners,
    values: state,
    /** Commit config the way the Loader does: mutate the reference, then notify. */
    commit(patch) {
      Object.assign(state, patch)
      ctx.emit('loader/volatile-update', [Object.keys(patch)])
    },
    settingsConfigured: () => configured,
    dispose() {
      while (disposers.length > 0) {
        const d = disposers.pop()
        try { d() } catch { /* noop */ }
      }
    },
  }
}

test('getState reports defaults on a fresh mount', () => {
  const h = harness()
  const s = h.svc.getState()
  assert.equal(s.maxSubagents, 1)
  assert.equal(s.mode, 'reject')
  assert.equal(typeof s.version, 'string')
  assert.deepEqual(s.rejections, [])
})

test('a live Config commit changes the cap without a remount', () => {
  const h = harness()
  assert.equal(h.svc.getState().maxSubagents, 1)
  h.commit({ maxSubagents: 5 })
  assert.equal(h.svc.getState().maxSubagents, 5)
  h.commit({ mode: 'queue' })
  const s = h.svc.getState()
  assert.equal(s.maxSubagents, 5, 'a mode-only commit must not disturb the cap')
  assert.equal(s.mode, 'queue')
})

test('an out-of-range or invalid committed value is clamped, never trusted', () => {
  const h = harness()
  h.commit({ maxSubagents: 999 })
  assert.equal(h.svc.getState().maxSubagents, 100, 'over-range clamps to 100')
  h.commit({ maxSubagents: -2 })
  assert.equal(h.svc.getState().maxSubagents, 0, 'negative clamps to 0')
  h.commit({ maxSubagents: 'abc' })
  assert.equal(h.svc.getState().maxSubagents, 1, 'invalid -> default 1')
  h.commit({ mode: 'bogus' })
  assert.equal(h.svc.getState().mode, 'reject', 'unknown mode -> reject')
})

test('a settings/document-updated event for our namespace re-reads config', () => {
  const h = harness()
  // Mutate the reference WITHOUT the Loader event, so the only thing that can
  // make the controller notice is the settings-service notification.
  h.values.maxSubagents = 7
  assert.equal(h.svc.getState().maxSubagents, 1, 'not observed yet')

  // Another plugin's namespace must not be mistaken for ours.
  h.listeners['settings/document-updated'][0]('some-other-plugin', 3)
  assert.equal(h.svc.getState().maxSubagents, 1, 'foreign namespace ignored')

  h.listeners['settings/document-updated'][0]('subagent-cap', 4)
  assert.equal(h.svc.getState().maxSubagents, 7, 'our namespace re-reads config')
})

test('the plugin declares its own settings page so DSH does not auto-generate one', () => {
  const h = harness()
  assert.equal(h.settingsConfigured(), true, 'settings.configure({auto:false}) must be registered')
})

test('a missing settings service still boots on defaults', () => {
  const h = harness({ withSettings: false })
  const s = h.svc.getState()
  assert.equal(s.maxSubagents, 1)
  assert.equal(s.mode, 'reject')
  assert.equal(h.settingsConfigured(), false)
})

test('plain-value config (no references) is accepted, keeping the controller testable', () => {
  const services = new Map()
  const ctx = {
    on: () => {},
    get: () => undefined,
    inject: () => {},
    subagents: { listChildren: async () => [] },
    effect: () => () => {},
    reflect: { provide: (n, i) => services.set(n, i) },
  }
  plugin.apply(ctx, { maxSubagents: 4, mode: 'queue' })
  const s = services.get('subagentCap').getState()
  assert.equal(s.maxSubagents, 4)
  assert.equal(s.mode, 'queue')
})

test('a throwing config reference degrades to the default instead of crashing', () => {
  const services = new Map()
  const ctx = {
    on: () => {},
    get: () => undefined,
    inject: () => {},
    subagents: { listChildren: async () => [] },
    effect: () => () => {},
    reflect: { provide: (n, i) => services.set(n, i) },
  }
  plugin.apply(ctx, {
    maxSubagents: { get() { throw new Error('ref exploded') } },
    mode: { get() { throw new Error('ref exploded') } },
  })
  const s = services.get('subagentCap').getState()
  assert.equal(s.maxSubagents, 1)
  assert.equal(s.mode, 'reject')
})

test('the removed write RPCs are gone; getState is the only Remote method', () => {
  const h = harness()
  assert.equal(typeof h.svc.getState, 'function')
  assert.equal(h.svc.setMax, undefined, 'setMax must no longer be exposed')
  assert.equal(h.svc.setMode, undefined, 'setMode must no longer be exposed')
})

test('the module exports the plugin identity the Loader reads', () => {
  assert.deepEqual(plugin.inject, ['subagents'])
  assert.equal(plugin.name, 'dsh-subagent-cap')
  assert.equal(typeof plugin.apply, 'function')
  // A schemastery Schema is a callable object, so check for the schema surface
  // rather than a bare `typeof` (the volatile/default contract itself is pinned
  // in test/manifest.test.mjs).
  assert.ok(plugin.Config, 'Config must be a named export so the Loader can see it')
  assert.equal(typeof plugin.Config.toJSON, 'function')
})

test('the module has NO default export, or the Loader discards Config', async () => {
  // The Loader normalizes a module with `exports = exports.default ?? exports`.
  // A default export REPLACES the module namespace, so `Config` / `inject` /
  // `name` become invisible and DSH silently falls back to `unknownConfig` —
  // no volatile form, so the settings section cannot save. This asserts the
  // shape rather than the symptom, because the symptom is invisible in tests.
  const mod = await import('../lib/index.js')
  assert.equal(
    mod.default, undefined,
    'a default export hides Config/inject/name from the Loader; remove it',
  )
})
