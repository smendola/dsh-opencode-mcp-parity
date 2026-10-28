#!/usr/bin/env node
// Generate cordis.patch.yml from an opencode config.
//
//   node generate.mjs
//   node generate.mjs --opencode ~/.config/opencode/opencode.jsonc --out ./cordis.patch.yml
//   OPENCODE_CONFIG=/path/to/opencode.jsonc node generate.mjs
//
// Reads the `mcp` block of the opencode config, applies the DSH-side policy in
// sync.config.json, and writes the DSH bundle patch. Deterministic output (no
// timestamps) so the generated file diffs cleanly.

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { stripJsonc, translateServer, render } from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function flag(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const opencodePath = flag(
  'opencode',
  process.env.OPENCODE_CONFIG || join(homedir(), '.config', 'opencode', 'opencode.jsonc'),
)
const configPath = flag('config', join(here, 'sync.config.json'))
const outPath = flag('out', join(here, 'cordis.patch.yml'))

const opencodeText = readFileSync(opencodePath, 'utf8')
const opencode = JSON.parse(stripJsonc(opencodeText))
const mcp = opencode.mcp ?? opencode.mcpServers ?? {}
if (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp)) {
  console.error(`No mcp block found in ${opencodePath}`)
  process.exit(1)
}

const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
const exclude = new Set(cfg.exclude ?? [])

const entries = []
for (const name of Object.keys(mcp).sort()) {
  if (exclude.has(name)) continue
  entries.push(translateServer(name, mcp[name], cfg))
}

writeFileSync(outPath, render(entries, { source: opencodePath }), 'utf8')

const enabled = entries.filter((e) => !e.disabled).map((e) => e.id).join(', ') || '(none)'
const disabled = entries.filter((e) => e.disabled).map((e) => e.id).join(', ') || '(none)'
console.log(`Wrote ${outPath}`)
console.log(`  servers: ${entries.length}`)
console.log(`  enabled: ${enabled}`)
console.log(`  disabled: ${disabled}`)
