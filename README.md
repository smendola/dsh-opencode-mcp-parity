# dsh-opencode-mcp-parity

Generate a DeepSeek Harness (DSH) MCP bundle patch from an opencode config, so
one list of MCP servers serves both tools instead of two drifting lists.

`~/.config/opencode/opencode.jsonc` is the source of truth. `generate.mjs` reads
its `mcp` block, applies the DSH-side policy in `sync.config.json`, and writes
`cordis.patch.yml` — the bundle patch that DSH loads.

```
opencode.jsonc ──► generate.mjs ──► cordis.patch.yml ──► DSH bundle
                     ▲
                     └─ sync.config.json   (DSH-only policy: disable, extra, comments)
```

## The three layers

| Layer | File | What it decides |
|---|---|---|
| Source of truth | `~/.config/opencode/opencode.jsonc` | which servers exist, transport, command, env, headers, `enabled` |
| Translation + DSH policy | `generate.mjs` + `sync.config.json` | field mapping, OAuth-impossible rows, forced-disable, extras, portability |
| Profile overrides | `$DSH_HOME/profiles/<name>/cordis.patch.yml` | anything you want to flip per-machine *after* the bundle (e.g. `disabled: true` on a row) |

`cordis.patch.yml` is generated and committed. It is also a working
configuration-only bundle, so you can install this repo directly into a DSH
profile without ever running the generator.

## Usage

Regenerate from the live opencode config:

```bash
node generate.mjs                 # reads ~/.config/opencode/opencode.jsonc
node generate.mjs --out /tmp/x.yml --opencode ~/.config/opencode/opencode.jsonc
```

The output is deterministic (no timestamps), so it diffs cleanly in git. After
changing `sync.config.json` or the opencode config, re-run and review the diff.

Install as a bundle:

```bash
cd "$DSH_HOME/profiles/<name>"
pnpm add github:<you>/dsh-opencode-mcp-parity
# or, to also expose the generator's bin script:
dsh plugin --profile <name> add github:<you>/dsh-opencode-mcp-parity
```

## Field mapping

| opencode | DSH (`dsh-mcp-client`) |
|---|---|
| `type: "remote"` + `url` | `transport: streamable-http` + `url` |
| `type: "local"` + `command: [...]` | `transport: stdio`, `command` + `args` |
| `command: ["/usr/bin/env", "-C", DIR, CMD, ...]` | `command` + `cwd: DIR` |
| `environment` | `env` |
| `headers` | `headers` |
| `{env:NAME}` (exact) | `!!js (process.env.NAME \|\| "")` |
| `"Bearer {env:NAME}"` (embedded) | `!!js` template literal |
| `enabled: false` | `disabled: true` |
| `oauth: {...}` | not supported — row forced `disabled` (see `sync.config.json`) |

## `sync.config.json`

DSH-side decisions that opencode does not express:

```jsonc
{
  "exclude": [],                    // server names to omit entirely
  "disabled": {                     // force disabled: true (with a reason comment)
    "asana": "opencode uses OAuth; dsh-mcp-client has no OAuth support"
  },
  "failOnStartupError": ["context7"],
  "extra": {                        // config keys not present in opencode
    "solidcraft": { "cwd": "/home/sal/Documents/SolidCraft" }
  },
  "comments": { "solidcraft": "..." },
  "portableHome": true              // rewrite leading $HOME as ${process.env.HOME}
}
```

`extra` is the right place for DSH-side additions. The current `solidcraft.cwd`
is one: opencode has no `cwd` for solidcraft, but DSH needs the process to start
in the SolidCraft project directory.

## Portability

With `portableHome: true` (default), any path under your home directory is
emitted as a `!!js` expression, so the committed patch works on any machine:

```yaml
command: !!js '`${process.env.HOME}/.local/bin/solidcraft-cli`'
cwd:     !!js '`${process.env.HOME}/Documents/SolidCraft`'
```

`!!js` values are evaluated by the DSH loader when it delivers config to the
plugin (the loader runs `interpolate()` over the whole config on
`internal/config`), so `command`/`cwd`/`headers`/`env` all resolve at runtime.

## Known decisions

- **`asana` is forced disabled.** opencode authorizes it via OAuth
  (`clientId`/`clientSecret`/`redirectUri`); `dsh-mcp-client` implements no OAuth,
  so a faithful row would fail to connect.
- **`sentry`, `postman`, `sendgrid` are forced disabled** in `sync.config.json`
  even though opencode enables them. Remove them from `disabled` to enable.
- **`chrome-devtools` is included and enabled.** It was absent from the previous
  hand-authored bundle; this generator mirrors it faithfully.
- **`freecad` is disabled** because opencode has `enabled: false`. Its command
  is portable (`$HOME/miniconda3/bin/freecad-mcp`) but still depends on a
  miniconda install at that exact path, which is a per-machine fact.

## Development

```bash
node --test      # unit tests for the translation core
node generate.mjs
```
