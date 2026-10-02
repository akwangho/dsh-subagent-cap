// dsh-subagent-cap — manifest compatibility and Config tests.
//
// Why the peer-range tests exist
// -----------------------------
// DSH runs a "compatibility preflight" before it mounts any profile plugin row
// (dsh-app-boot: `prepareProfileEntries` -> `evaluatePluginCompatibility`). It
// reads our `peerDependencies` WITHOUT importing plugin code and checks every
// peer whose name is `@deepseek-ai/dsh` or starts with `@deepseek-ai/dsh-`
// against the running DSH version. A single non-matching range DISABLES the
// whole row, prints one stderr line, and the plugin silently disappears:
//
//   dsh: disabling profile plugin row "subagent-cap": Plugin
//   dsh-subagent-cap@1.2.2 is incompatible with dsh 0.2.0-rc.2: ...
//
// That is exactly what happened on the 0.1 -> 0.2 upgrade: the peers were pinned
// `^0.1.2-rc.1` / `^0.1.0-rc.6`, and a caret on a 0.x version only admits 0.1.x.
//
// The preflight is DSH-side code we cannot import here, so these tests encode
// the same rule directly against our own package.json.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { configSchema, CONFIG_FIELDS, NAMESPACE } from '../lib/config.js'
import { DEFAULTS } from '../lib/pure.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// DSH runtimes this plugin must keep loading on.
const SUPPORTED_DSH = ['0.1.2-rc.1', '0.1.2-rc.8', '0.2.0-rc.2', '0.2.0', '0.3.0-rc.1', '0.9.9']
// A 1.0 DSH is a real breaking release; a plugin must NOT silently claim it.
const UNSUPPORTED_DSH = ['1.0.0', '2.0.0']

// ------------------------------------------------------------------ comparator

// Minimal semver range check for the shapes our peers use: `*`, and comparator
// sets of `>=X` / `<X`. Enough to prove the property that matters without adding
// a semver dependency to a package that ships none.
const parseVersion = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim())
  assert.ok(m, `test bug: unparseable version ${JSON.stringify(v)}`)
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] }
}

const compare = (a, b) => {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1
  }
  if (x.pre === undefined && y.pre === undefined) return 0
  if (x.pre === undefined) return 1
  if (y.pre === undefined) return -1
  return x.pre < y.pre ? -1 : x.pre > y.pre ? 1 : 0
}

const satisfies = (version, range) => {
  const r = String(range).trim()
  if (r === '' || r === '*') return true
  for (const clause of r.split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?\s*(\S+)$/.exec(clause)
    assert.ok(m, `test bug: unparseable range clause ${JSON.stringify(clause)} in ${JSON.stringify(range)}`)
    const [, op, target] = m
    const cmp = compare(version, target)
    if (op === '>=' && !(cmp >= 0)) return false
    if (op === '>' && !(cmp > 0)) return false
    if (op === '<=' && !(cmp <= 0)) return false
    if (op === '<' && !(cmp < 0)) return false
    if ((op === '=' || op === undefined) && cmp !== 0) return false
  }
  return true
}

// ------------------------------------------------------------- the DSH rule

const isCheckedPeer = (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
const dshPeers = Object.entries(manifest.peerDependencies || {}).filter(([name]) => isCheckedPeer(name))

// --------------------------------------------------------------------- tests

test('the manifest declares DSH peer dependencies for the preflight to check', () => {
  assert.ok(dshPeers.length > 0, 'no @deepseek-ai/dsh-* peerDependencies found')
  for (const [name, range] of dshPeers) {
    assert.equal(typeof range, 'string', `${name} range must be a string`)
  }
})

test('every DSH peer range accepts every supported dsh runtime', () => {
  for (const [name, range] of dshPeers) {
    for (const runtime of SUPPORTED_DSH) {
      assert.equal(
        satisfies(runtime, range), true,
        `${name}@${range} would DISABLE this plugin on dsh ${runtime}`,
      )
    }
  }
})

test('DSH peer ranges do not silently claim dsh 1.x', () => {
  for (const [name, range] of dshPeers) {
    for (const runtime of UNSUPPORTED_DSH) {
      assert.equal(
        satisfies(runtime, range), false,
        `${name}@${range} claims dsh ${runtime}; a 1.x DSH needs an explicit audit`,
      )
    }
  }
})

test('no DSH peer uses a caret/tilde pin, which breaks on the next 0.x minor', () => {
  // The original bug: `^0.1.2-rc.1` admits only 0.1.x, so upgrading DSH to
  // 0.2.x disabled the row. Any caret/tilde on a 0.x version has this shape.
  for (const [name, range] of dshPeers) {
    assert.doesNotMatch(
      range, /[\^~]/,
      `${name}@${range} pins a single 0.x minor; use an explicit range such as ">=0.1.2-rc.1 <1.0.0" instead`,
    )
  }
})

test('engines.dsh agrees with the DSH peer floor', () => {
  assert.equal(typeof manifest.engines.dsh, 'string', 'engines.dsh should document the supported DSH line')
  for (const [name, range] of dshPeers) {
    const floor = />=\s*(\S+)/.exec(range)
    assert.ok(floor, `${name}@${range} should declare an explicit lower bound`)
    assert.equal(
      satisfies(floor[1], manifest.engines.dsh), true,
      `engines.dsh ${manifest.engines.dsh} excludes this plugin's own floor ${floor[1]} (${name})`,
    )
  }
})

// ---------------------------------------------------------- client declaration

test('dsh.client.inject names only packages that still exist in DSH', () => {
  // `@deepseek-ai/dsh-client-runtime` was removed in the 0.2 line. Naming a
  // package that cannot be resolved makes the boot graph carry a dead edge.
  const inject = (manifest.dsh && manifest.dsh.client && manifest.dsh.client.inject) || []
  assert.ok(Array.isArray(inject), 'dsh.client.inject must be an array')
  assert.deepEqual(
    inject.filter((name) => name === '@deepseek-ai/dsh-client-runtime'),
    [],
    '@deepseek-ai/dsh-client-runtime no longer exists; drop it from dsh.client.inject',
  )
})

test('dsh.client declares the web platform and a ./client export', () => {
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './lib/client.js')
})

test('locale metadata is exported so the Plugins list can name the plugin', () => {
  // readPluginMeta resolves `<pkg>/locale/en.json` through the package `exports`
  // map; without the `./locale/*` entry the subpath is blocked and the plugin
  // falls back to showing its raw npm name.
  assert.equal(manifest.exports['./locale/*'], './locale/*', 'exports must expose ./locale/* for readPluginMeta')
  assert.ok(manifest.files.includes('locale'), 'files must ship locale/')

  const en = JSON.parse(readFileSync(join(ROOT, 'locale', 'en.json'), 'utf8'))
  assert.equal(typeof en.meta.title, 'string')
  assert.ok(en.meta.title.length > 0, 'meta.title must be a non-empty string')
  assert.equal(typeof en.meta.description, 'string')
  assert.ok(en.meta.description.length > 0, 'meta.description must be a non-empty string')
})

test('package.json version and lib/index.js VERSION agree', () => {
  // A mismatch shows a stale number in the settings footer.
  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const match = /const VERSION = '([^']+)'/.exec(src)
  assert.ok(match, 'lib/index.js must declare a VERSION')
  assert.equal(match[1], manifest.version, 'lib/index.js VERSION is out of sync with package.json')
})

// -------------------------------------------------------- volatile Config

test('Config declares every field volatile', async () => {
  // dsh-settings projects ONLY volatile fields into an editable form
  // (`volatileForm`), and the Loader commits a volatile change into the running
  // references instead of remounting. A non-volatile field could not be edited
  // from this plugin's section, and an ordinary change would remount the plugin
  // — dropping the allocator's inFlight counters and stranding held waiters.
  const z = (await import('@deepseek-ai/schemastery')).default
  const json = configSchema(z).toJSON()
  const dict = json.refs[json.uid].dict
  assert.deepEqual(Object.keys(dict), CONFIG_FIELDS, 'Config fields drifted from CONFIG_FIELDS')
  for (const field of CONFIG_FIELDS) {
    const ref = json.refs[dict[field]]
    assert.ok(ref, `Config is missing the ${field} field`)
    assert.equal(ref.meta.volatile, true, `Config.${field} must be .volatile()`)
    assert.ok(ref.meta.default !== undefined, `Config.${field} must declare a default`)
  }
})

test('Config defaults match the pure DEFAULTS, so the schema cannot drift', async () => {
  const z = (await import('@deepseek-ai/schemastery')).default
  const json = configSchema(z).toJSON()
  const dict = json.refs[json.uid].dict
  const read = (field) => json.refs[dict[field]].meta.default
  assert.equal(read('maxSubagents'), DEFAULTS.maxSubagents)
  assert.equal(read('mode'), DEFAULTS.mode)
})

test('the settings namespace matches the documented profile entry id', () => {
  // DSH keys every settings form by the profile entry id, and the browser half
  // addresses the same string. Both must agree with what the README documents.
  assert.equal(NAMESPACE, 'subagent-cap')

  const clientSrc = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const match = /const NAMESPACE = '([^']+)'/.exec(clientSrc)
  assert.ok(match, 'lib/client.js must declare NAMESPACE')
  assert.equal(match[1], NAMESPACE, 'client and host namespaces must match')
})

test('the removed settings API is not referenced any more', () => {
  // `settings.installSection` and `settings.replace` no longer exist in DSH 0.2.
  // `updateSetting` also went away with them, since the Host no longer owns the
  // write path — the browser half writes through `configForms`.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  for (const file of ['lib/index.js', 'lib/config.js', 'lib/client.js']) {
    const src = stripComments(readFileSync(join(ROOT, file), 'utf8'))
    assert.doesNotMatch(src, /installSection/, `${file} still calls the removed settings.installSection`)
    assert.doesNotMatch(src, /settings\.replace\(/, `${file} still calls the removed settings.replace`)
  }
  const indexSrc = stripComments(readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8'))
  assert.doesNotMatch(indexSrc, /declareRemote\('setMax'\)/, 'setMax must no longer be a Remote method')
  assert.doesNotMatch(indexSrc, /declareRemote\('setMode'\)/, 'setMode must no longer be a Remote method')
})
