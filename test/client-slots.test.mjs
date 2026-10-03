// dsh-subagent-cap — browser-half registration tests.
//
// Why this file exists
// --------------------
// The plugin registered its settings page ONLY on `settings.section` (the main
// Settings navigation list). The Plugins settings section does not read that
// slot: it renders the selected plugin's page with
//
//     renderSlot("settings.plugins.tab", {}, { only: single.id })
//
// i.e. it looks the page up on `settings.plugins.tab` keyed by the plugin's
// profile entry id. So picking the plugin in Settings -> Plugins showed
// nothing. It stayed invisible because we also declare
// `settings.configure({ auto: false })`, which tells DSH NOT to auto-generate a
// page to fill the gap.
//
// Neither the host tests nor a visual check caught it — the page really was
// registered, just on a surface nobody was looking at. So these tests assert the
// registration itself: both slots, keyed by the plugin's entry id.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

import { NAMESPACE } from '../lib/config.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// Minimal DOM: the bundle only needs createElement/head/body to inject CSS and
// the diagnostic banner.
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.attrs = {}
    this._text = ''
    this.style = {}
  }
  setAttribute(k, v) { this.attrs[k] = v }
  getAttribute(k) { return this.attrs[k] }
  appendChild(c) { this.children.push(c); return c }
  remove() {}
  set textContent(v) { this._text = v; this.children = [] }
  get textContent() { return this._text }
  querySelector() { return null }
  querySelectorAll() { return [] }
  addEventListener() {}
}

const React = {
  createElement: (type, props) => ({ type, props }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}

/**
 * Load lib/client.js in a sandbox and run `apply` against a fake context,
 * returning every slot registration it made.
 */
function mountClient({ configForm } = {}) {
  const head = new El('head')
  const body = new El('body')
  globalThis.document = { createElement: (t) => new El(t), head, body, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }

  let registration = null
  globalThis.window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  vm.runInThisContext(readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8'), { filename: 'client.js' })
  assert.ok(registration, 'client.js must call window.__ModuleLoader__.load')

  const ex = registration.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })

  const slots = []
  const services = {
    slots: {
      // The real service defers the callback until the slot is declared; the
      // bundle registers through `slots.inject` either way.
      inject(name, cb) { cb() },
      register(opts, comp) { slots.push({ slot: opts.name, opts, comp }); return () => {} },
    },
    connection: {
      rpc: { call: async () => ({ ok: true, value: { version: 'test', maxSubagents: 1, mode: 'reject', rejections: [] } }) },
    },
    remote: {},
    configForms: {
      get: () => configForm === null ? undefined : (configForm || {
        getSnapshot: () => ({ status: 'ready', value: { maxSubagents: 1, mode: 'reject' }, writable: true, mode: 'host', revision: 0 }),
        subscribe: () => () => {},
        set: async () => true,
      }),
    },
  }

  // A tiny stand-in for the cordis ctx the factory receives.
  const ctx = {
    get: (k) => services[k],
    effect: (cb) => { cb(); return () => {} },
  }
  try { ex.apply(ctx) } catch (e) { throw new Error('client apply threw: ' + e.message) }

  return { slots, body, ex }
}

test('the settings page registers on settings.plugins.tab, keyed by the entry id', () => {
  // THE regression: the Plugins section resolves the page through this slot
  // with `{ only: <entry id> }`, so a page registered only on
  // `settings.section` is invisible there.
  const { slots } = mountClient()
  const tabs = slots.filter((s) => s.slot === 'settings.plugins.tab')
  assert.equal(tabs.length, 1, 'expected exactly one settings.plugins.tab registration')
  assert.equal(tabs[0].opts.id, NAMESPACE, 'tab id must equal the profile entry id so `{ only }` matches')
  assert.ok(tabs[0].opts.label, 'a tab needs display text')
  assert.equal(typeof tabs[0].comp, 'function', 'a component must be registered')
})

test('the settings page is also reachable from the main Settings nav', () => {
  const { slots } = mountClient()
  const sections = slots.filter((s) => s.slot === 'settings.section')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].opts.id, NAMESPACE)
})

test('both surfaces render the SAME component instance', () => {
  // Two different components would mean two different polling loops and two
  // independent drafts of the same settings.
  const { slots } = mountClient()
  const tab = slots.find((s) => s.slot === 'settings.plugins.tab')
  const section = slots.find((s) => s.slot === 'settings.section')
  assert.equal(tab.comp, section.comp, 'both slots must render one shared component')
})

test('the bundle asks for the services it actually uses', () => {
  const { ex } = mountClient()
  // `configForms` carries configuration; `connection` carries runtime state.
  // Both are required, so both belong in the cordis inject list.
  assert.ok(ex.inject.includes('configForms'), 'configForms is required to persist settings')
  assert.ok(ex.inject.includes('connection'), 'connection is required to read runtime state')
  assert.ok(ex.inject.includes('slots'), 'slots is required to register the page at all')
})

test('an unexposed settings namespace still mounts the page instead of vanishing', () => {
  // configForms present but with no form for this namespace: the page must
  // still register (read-only) and must report why it cannot save.
  const { slots, body } = mountClient({ configForm: null })
  assert.ok(slots.some((s) => s.slot === 'settings.plugins.tab'), 'page must still register')
  assert.ok(slots.some((s) => s.slot === 'settings.section'), 'page must still register')
  const banner = body.children.find((c) => c.className === 'scap-diag-banner')
  assert.ok(banner, 'a diagnostic banner must be rendered so the cause is visible')
  assert.equal(banner.style.display, 'block')
  assert.match(banner.textContent, new RegExp(NAMESPACE))
})

test('a form reporting status=unavailable surfaces a diagnostic', () => {
  const { body } = mountClient({
    configForm: {
      getSnapshot: () => ({ status: 'unavailable', value: undefined, writable: false, mode: 'memory' }),
      subscribe: () => () => {},
      set: async () => true,
    },
  })
  const banner = body.children.find((c) => c.className === 'scap-diag-banner')
  assert.ok(banner && banner.style.display === 'block')
  assert.match(banner.textContent, /NAMESPACE|namespace/i)
})