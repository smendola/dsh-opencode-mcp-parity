// Translation core for opencode config -> DeepSeek Harness bundle patch.
// Pure functions, no I/O, so the generator and the tests share one code path.

import { homedir } from 'node:os'

const HOME = homedir()

/**
 * Strip `//` and `/* *\/` comments and trailing commas so a `.jsonc` file
 * parses as strict JSON. Handles comments inside string literals correctly.
 */
export function stripJsonc(text) {
  let out = ''
  let i = 0
  const n = text.length
  let inString = false
  let quote = ''
  while (i < n) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === quote) inString = false
      i += 1
      continue
    }
    if (c === '"' || c === "'") {
      inString = true
      quote = c
      out += c
      i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += c
    i += 1
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

const ENV_REF_RE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * Translate one scalar value from opencode into a DSH patch value.
 *
 * Returns `{ plain: value }` for a plain YAML scalar, or `{ raw: '!!js ...' }`
 * for a value that must be evaluated by the DSH loader at runtime.
 *
 * Two rewrites happen here:
 *   1. A leading `$HOME` is replaced with a `!!js` template so the generated
 *      patch is portable across machines.
 *   2. opencode's `{env:NAME}` interpolation becomes a `!!js` expression that
 *      reads `process.env.NAME`.
 */
export function translateValue(value, { portableHome = true } = {}) {
  if (typeof value !== 'string') return { plain: value }

  if (portableHome) {
    if (value === HOME) return { raw: '!!js `process.env.HOME`' }
    if (value.startsWith(HOME + '/')) {
      return { raw: "!!js '`${process.env.HOME}" + value.slice(HOME.length) + "`'" }
    }
  }

  const matches = value.match(ENV_REF_RE)
  if (!matches) return { plain: value }
  if (matches.length === 1 && value.trim() === matches[0]) {
    const name = matches[0].slice('{env:'.length, -1)
    return { raw: `!!js (process.env.${name} || "")` }
  }
  const tpl = value.replace(ENV_REF_RE, '${process.env.$1 || ""}')
  return { raw: "!!js '`" + tpl + "`'" }
}

/**
 * Collapse opencode's `["/usr/bin/env", "-C", DIR, CMD, ...]` form into a
 * `command` + `cwd` pair. Returns `{ command, cwd }`.
 */
function collapseCommand(command, cwd) {
  if (command && (command[0] === 'env' || command[0] === '/usr/bin/env')) {
    let j = 1
    while (j < command.length && typeof command[j] === 'string' && command[j].startsWith('-')) {
      if (command[j] === '-C' || command[j] === '-c') {
        cwd = command[j + 1]
        j += 2
        continue
      }
      j += 1
    }
    command = command.slice(j)
  }
  return { command, cwd }
}

/**
 * Translate one opencode MCP server entry into a DSH patch entry.
 *
 * `cfg` carries the DSH-side policy that is not present in opencode:
 *   - `exclude`: server names to omit entirely
 *   - `disabled`: server name -> reason; force the row `disabled: true`
 *   - `extra`: server name -> { key: value }; config additions not in opencode
 *   - `comments`: server name -> free-text comment above the row
 *   - `failOnStartupError`: server names to flag with `failOnStartupError`
 *   - `portableHome`: rewrite leading `$HOME` (default true)
 */
export function translateServer(name, server, cfg = {}) {
  const disabled = cfg.disabled ?? {}
  const failOnStartupError = cfg.failOnStartupError ?? []
  const extra = cfg.extra ?? {}
  const comments = cfg.comments ?? {}
  const portableHome = cfg.portableHome !== false

  const entry = {
    id: 'mcp-' + name,
    name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: name },
    comment: comments[name] ?? null,
    reason: null,
  }

  const isRemote = server.type === 'remote'
  const forcedDisabled = Object.prototype.hasOwnProperty.call(disabled, name)
  const opencodeDisabled = server.enabled === false

  if (forcedDisabled) entry.reason = disabled[name]
  else if (opencodeDisabled) entry.reason = 'opencode has enabled: false'

  if (forcedDisabled || opencodeDisabled) entry.disabled = true

  if (isRemote) {
    entry.config.transport = 'streamable-http'
    if (server.url) entry.config.url = translateValue(server.url, { portableHome })
    if (server.headers && typeof server.headers === 'object') {
      entry.config.headers = {}
      for (const [k, v] of Object.entries(server.headers)) {
        entry.config.headers[k] = translateValue(v, { portableHome })
      }
    }
  } else if (Array.isArray(server.command) && server.command.length > 0) {
    entry.config.transport = 'stdio'
    const { command, cwd } = collapseCommand(server.command, server.cwd)
    if (command[0]) entry.config.command = translateValue(command[0], { portableHome })
    if (command.length > 1) {
      entry.config.args = command.slice(1).map((v) => translateValue(v, { portableHome }))
    }
    if (cwd) entry.config.cwd = translateValue(cwd, { portableHome })
    if (server.environment && typeof server.environment === 'object') {
      entry.config.env = {}
      for (const [k, v] of Object.entries(server.environment)) {
        entry.config.env[k] = translateValue(v, { portableHome })
      }
    }
  } else {
    // Unrecognized shape: keep a disabled placeholder rather than dropping it.
    entry.disabled = true
    entry.reason = entry.reason || 'unrecognized opencode entry shape (not translated)'
    entry.config.transport = server.url ? 'streamable-http' : 'stdio'
    if (server.url) entry.config.url = String(server.url)
    if (server.command) entry.config.command = String(server.command)
  }

  if (Array.isArray(failOnStartupError) && failOnStartupError.includes(name)) {
    entry.config.failOnStartupError = true
  }

  const extras = extra[name]
  if (extras && typeof extras === 'object') {
    for (const [k, v] of Object.entries(extras)) {
      entry.config[k] = translateValue(v, { portableHome })
    }
  }

  return entry
}

const CONFIG_ORDER = [
  'serverName',
  'transport',
  'url',
  'command',
  'args',
  'cwd',
  'env',
  'headers',
  'failOnStartupError',
]

function plainScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const s = String(value)
  if (s === '') return "''"
  const needsQuote =
    /^[\s]/.test(s) ||
    /[\s]$/.test(s) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(s) ||
    /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) ||
    /:(\s|$)|#/.test(s)
  return needsQuote ? "'" + s.replace(/'/g, "''") + "'" : s
}

function renderScalar(value) {
  if (value && typeof value === 'object') {
    if ('raw' in value) return value.raw
    if ('plain' in value) return plainScalar(value.plain)
  }
  return plainScalar(value)
}

function renderEntry(entry) {
  const lines = []
  if (entry.comment) lines.push(`  # ${entry.id.slice(4)}: ${entry.comment}`)
  if (entry.reason) lines.push(`  # ${entry.id.slice(4)}: ${entry.reason}`)
  lines.push(`  - id: ${entry.id}`)
  lines.push(`    name: '${entry.name}'`)
  if (entry.disabled) lines.push('    disabled: true')
  lines.push('    config:')
  for (const key of CONFIG_ORDER) {
    if (!(key in entry.config)) continue
    const value = entry.config[key]
    if (key === 'env' || key === 'headers') {
      lines.push(`      ${key}:`)
      for (const [k, v] of Object.entries(value)) {
        lines.push(`        ${k}: ${renderScalar(v)}`)
      }
    } else if (key === 'args') {
      lines.push(`      args: [${value.map(renderScalar).join(', ')}]`)
    } else {
      lines.push(`      ${key}: ${renderScalar(value)}`)
    }
  }
  return lines.join('\n')
}

/** Render translated entries to the final cordis.patch.yml text. */
export function render(entries, { source } = {}) {
  const header = [
    '# Generated by generate.mjs — do not edit by hand.',
    '# Change sync.config.json (or the opencode config) and re-run `node generate.mjs`.',
    source ? `# Source: ${source}` : null,
    '# DSH-side policy (exclusions, forced-disable, failOnStartupError, extras)',
    '# lives in sync.config.json. Further enable/disable overrides belong in',
    '# $DSH_HOME/profiles/<name>/cordis.patch.yml.',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n')

  const body = entries.map(renderEntry).join('\n\n')
  return header + '- insert:\n' + body + '\n'
}
