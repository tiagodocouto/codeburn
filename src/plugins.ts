import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ============================================================================
// Plugin-provided MCP server discovery
// ============================================================================
//
// Claude Code plugins ship their own MCP servers. A server `<server>` from a
// plugin named `<name>` is exposed at runtime under the tool prefix
// `plugin_<name>_<server>` (the tool fqn is `mcp__plugin_<name>_<server>__<tool>`,
// so `fqn.split('__')[1]` === `plugin_<name>_<server>`).
//
// These servers never appear in `.mcp.json` / `settings.json` — they live only
// in each plugin's `.claude-plugin/plugin.json`. Without reading them, the
// unused-MCP detector compares a plugin server's runtime name against bare
// config keys and never reconciles the two, so a daily-driver plugin server
// (PEER, SSOT, …) gets falsely reported as "configured but never used".

export type PluginMcpServer = {
  /** Runtime identity — matches `mcp__<runtimeId>__<tool>`. e.g. `plugin_nott_PEER`. */
  runtimeId: string
  /** Plugin name from the manifest `.name`. e.g. `nott`. */
  pluginName: string
  /** Server key from the manifest `.mcpServers`. e.g. `PEER`. */
  serverKey: string
}

const MAX_SCAN_DEPTH = 4

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

// Recursively collect `<dir>/**/.claude-plugin/plugin.json` paths, bounded in
// depth and skipping noisy subtrees. Fully defensive — unreadable dirs are
// silently skipped.
function collectManifestsUnder(dir: string, out: Set<string>, depth: number): void {
  if (depth > MAX_SCAN_DEPTH || !existsSync(dir)) return
  const direct = join(dir, '.claude-plugin', 'plugin.json')
  if (existsSync(direct)) out.add(direct)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name === '.claude-plugin' || e.name === 'node_modules' || e.name.startsWith('.git')) continue
    collectManifestsUnder(join(dir, e.name), out, depth + 1)
  }
}

// Union of the three on-disk sources where plugin manifests live, de-duped.
function manifestPaths(pluginsRoot: string): Set<string> {
  const paths = new Set<string>()

  // 1) installed_plugins.json → each entry's installPath/.claude-plugin/plugin.json
  const installed = readJson(join(pluginsRoot, 'installed_plugins.json'))
  const plugins = installed?.plugins
  if (plugins && typeof plugins === 'object') {
    for (const entries of Object.values(plugins as Record<string, unknown>)) {
      const list = Array.isArray(entries) ? entries : [entries]
      for (const entry of list) {
        const installPath = (entry as { installPath?: unknown })?.installPath
        if (typeof installPath === 'string' && installPath) {
          paths.add(join(installPath, '.claude-plugin', 'plugin.json'))
        }
      }
    }
  }

  // 2) marketplaces/** and 3) cache/** — load-bearing for marketplace-installed
  // plugins, which are frequently absent from installed_plugins.json.
  for (const sub of ['marketplaces', 'cache']) {
    collectManifestsUnder(join(pluginsRoot, sub), paths, 0)
  }

  return paths
}

/**
 * Enumerate MCP servers provided by installed Claude Code plugins.
 *
 * `pluginsRoot` is injectable for tests; it defaults to `~/.claude/plugins`.
 * Any FS/parse failure degrades to an empty result so callers fall back to
 * pre-existing behavior with no regression.
 */
export function loadPluginMcpServers(
  pluginsRoot: string = join(homedir(), '.claude', 'plugins'),
): PluginMcpServer[] {
  if (!existsSync(pluginsRoot)) return []
  const byRuntimeId = new Map<string, PluginMcpServer>()
  for (const manifestPath of manifestPaths(pluginsRoot)) {
    const manifest = readJson(manifestPath)
    const name = manifest?.name
    const servers = manifest?.mcpServers
    if (typeof name !== 'string' || !name) continue
    if (!servers || typeof servers !== 'object') continue
    for (const serverKey of Object.keys(servers as Record<string, unknown>)) {
      const runtimeId = `plugin_${name}_${serverKey}`
      if (!byRuntimeId.has(runtimeId)) {
        byRuntimeId.set(runtimeId, { runtimeId, pluginName: name, serverKey })
      }
    }
  }
  return [...byRuntimeId.values()]
}

/** Normalize a server name for cross-namespace matching. */
export function canonicalServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Reconcile a configured (config-file) server name to a plugin-provided server,
 * returning the plugin server's `runtimeId` when they denote the same server,
 * else null. Covers the three real-world spellings of the same server:
 *   - bare server key:      `SSOT`      ↔ plugin nott/SSOT
 *   - plugin-qualified:     `nottSSOT`  ↔ plugin nott/SSOT
 *   - vendor-prefixed alias: `nott-peer` ↔ plugin nott/PEER
 *     (canonical starts with the plugin name and ends with the server key)
 */
export function reconcileConfiguredToPlugin(
  configuredName: string,
  pluginServers: PluginMcpServer[],
): string | null {
  const c = canonicalServerName(configuredName)
  if (!c) return null
  for (const p of pluginServers) {
    const key = canonicalServerName(p.serverKey)
    if (!key) continue
    if (c === key || c === canonicalServerName(p.pluginName) + key) return p.runtimeId
    const pn = canonicalServerName(p.pluginName)
    if (pn && c.startsWith(pn) && c.endsWith(key)) return p.runtimeId
  }
  return null
}
