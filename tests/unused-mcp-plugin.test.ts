import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { detectUnusedMcp, detectDuplicatePluginMcp } from '../src/optimize.js'
import type { ToolCall, McpServerCoverage } from '../src/optimize.js'
import type { ProjectSummary } from '../src/types.js'
import {
  loadPluginMcpServers,
  reconcileConfiguredToPlugin,
  matchConfiguredToPlugin,
  canonicalServerName,
  type PluginMcpServer,
} from '../src/plugins.js'

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = []

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'codeburn-plugins-'))
  tmpDirs.push(d)
  return d
}

function writeManifest(dir: string, name: string, servers: string[]): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  const mcpServers: Record<string, unknown> = {}
  for (const s of servers) mcpServers[s] = { command: 'noop' }
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, mcpServers }))
}

afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }) } catch {}
  }
})

// ---------------------------------------------------------------------------
// canonicalServerName
// ---------------------------------------------------------------------------

describe('canonicalServerName', () => {
  it('lowercases and strips separators', () => {
    expect(canonicalServerName('21st-dev')).toBe('21stdev')
    expect(canonicalServerName('nott-peer')).toBe('nottpeer')
    expect(canonicalServerName('SSOT')).toBe('ssot')
  })
})

// ---------------------------------------------------------------------------
// loadPluginMcpServers — discovery
// ---------------------------------------------------------------------------

describe('loadPluginMcpServers', () => {
  it('discovers plugin servers via the marketplace scan path (no installed_plugins.json)', () => {
    // This is the load-bearing path: marketplace-installed plugins are often
    // absent from installed_plugins.json, found only by scanning marketplaces/.
    const root = freshDir()
    writeManifest(join(root, 'marketplaces', 'menot-you'), 'nott', ['PEER', 'SSOT'])

    const servers = loadPluginMcpServers(root)
    const ids = servers.map(s => s.runtimeId).sort()
    expect(ids).toEqual(['plugin_nott_PEER', 'plugin_nott_SSOT'])
    expect(servers.find(s => s.runtimeId === 'plugin_nott_PEER')).toMatchObject({
      pluginName: 'nott',
      serverKey: 'PEER',
    })
  })

  it('discovers plugin servers via installed_plugins.json installPath', () => {
    const root = freshDir()
    const installDir = join(root, 'cache', 'menot-you', 'nott', '1.0.0')
    writeManifest(installDir, 'nott', ['LAD'])
    writeFileSync(
      join(root, 'installed_plugins.json'),
      JSON.stringify({ version: 1, plugins: { 'nott@menot-you': [{ installPath: installDir }] } }),
    )

    const ids = loadPluginMcpServers(root).map(s => s.runtimeId)
    expect(ids).toContain('plugin_nott_LAD')
  })

  it('synthesizes runtime ids that match the mcp__ tool prefix verbatim', () => {
    const root = freshDir()
    writeManifest(join(root, 'marketplaces', 'menot-you'), 'nott', ['21st-dev'])
    // Runtime tool is mcp__plugin_nott_21st-dev__... → split('__')[1] === this id.
    expect(loadPluginMcpServers(root).map(s => s.runtimeId)).toContain('plugin_nott_21st-dev')
  })

  it('de-dupes a server discovered via multiple sources', () => {
    const root = freshDir()
    const installDir = join(root, 'marketplaces', 'menot-you')
    writeManifest(installDir, 'nott', ['PEER'])
    writeFileSync(
      join(root, 'installed_plugins.json'),
      JSON.stringify({ version: 1, plugins: { 'nott@menot-you': [{ installPath: installDir }] } }),
    )
    expect(loadPluginMcpServers(root).filter(s => s.runtimeId === 'plugin_nott_PEER')).toHaveLength(1)
  })

  it('returns empty (no throw) when the plugins root is missing or malformed', () => {
    expect(loadPluginMcpServers(join(tmpdir(), 'codeburn-does-not-exist-xyz'))).toEqual([])
    const root = freshDir()
    writeFileSync(join(root, 'installed_plugins.json'), '{ not valid json')
    expect(loadPluginMcpServers(root)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// reconcileConfiguredToPlugin
// ---------------------------------------------------------------------------

describe('reconcileConfiguredToPlugin', () => {
  const servers: PluginMcpServer[] = [
    { runtimeId: 'plugin_nott_PEER', pluginName: 'nott', serverKey: 'PEER' },
    { runtimeId: 'plugin_nott_SSOT', pluginName: 'nott', serverKey: 'SSOT' },
    { runtimeId: 'plugin_nott_exa', pluginName: 'nott', serverKey: 'exa' },
  ]

  it('matches a bare server key (case-insensitive)', () => {
    expect(reconcileConfiguredToPlugin('SSOT', servers)).toBe('plugin_nott_SSOT')
    expect(reconcileConfiguredToPlugin('EXA', servers)).toBe('plugin_nott_exa')
  })

  it('matches a plugin-qualified name', () => {
    expect(reconcileConfiguredToPlugin('nottSSOT', servers)).toBe('plugin_nott_SSOT')
  })

  it('matches a vendor-prefixed alias (prefix=pluginName, suffix=serverKey)', () => {
    // etch registered the peer server as `nott-peer`; the plugin exposes `PEER`.
    expect(reconcileConfiguredToPlugin('nott-peer', servers)).toBe('plugin_nott_PEER')
  })

  it('returns null for a server no plugin provides', () => {
    expect(reconcileConfiguredToPlugin('OPERA', servers)).toBeNull()
    expect(reconcileConfiguredToPlugin('', servers)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// detectUnusedMcp — end-to-end reconciliation
// ---------------------------------------------------------------------------

describe('detectUnusedMcp with plugin awareness', () => {
  // Build a project cwd whose .mcp.json registers bare/standalone servers, aged
  // past the new-config grace window so they are eligible to be flagged.
  function cwdWithMcpJson(servers: string[]): string {
    const dir = freshDir()
    const p = join(dir, '.mcp.json')
    const mcpServers: Record<string, unknown> = {}
    for (const s of servers) mcpServers[s] = { command: 'noop' }
    writeFileSync(p, JSON.stringify({ mcpServers }))
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(p, old, old)
    return dir
  }

  const projects = [
    { project: 'p', projectPath: '/p', sessions: [{ mcpBreakdown: {} }], totalCostUSD: 0, totalApiCalls: 0 },
  ] as unknown as ProjectSummary[]

  const pluginServers: PluginMcpServer[] = [
    { runtimeId: 'plugin_nott_SSOT', pluginName: 'nott', serverKey: 'SSOT' },
    { runtimeId: 'plugin_nott_PEER', pluginName: 'nott', serverKey: 'PEER' },
    { runtimeId: 'plugin_nott_stitch', pluginName: 'nott', serverKey: 'stitch' },
  ]

  function call(name: string): ToolCall {
    return { name, input: {}, sessionId: 's', project: 'p' } as ToolCall
  }

  it('does not flag a plugin-backed server that was invoked under its runtime id', () => {
    const cwd = cwdWithMcpJson(['SSOT', 'nott-peer', 'OPERA'])
    const finding = detectUnusedMcp(
      [call('mcp__plugin_nott_SSOT__task'), call('mcp__plugin_nott_PEER__ask')],
      projects,
      new Set([cwd]),
      [], // mcpCoverage: nothing reported by the coverage detector
      pluginServers,
    )
    // SSOT (called) and nott-peer (alias → plugin_nott_PEER, called) reconcile away.
    expect(finding?.explanation ?? '').not.toContain('SSOT')
    expect(finding?.explanation ?? '').not.toContain('nott-peer')
    // OPERA has no plugin and was never called → still a true positive.
    expect(finding?.explanation ?? '').toContain('OPERA')
  })

  it('collapses an uncalled plugin-backed server onto the coverage detector instead of double-listing it', () => {
    const cwd = cwdWithMcpJson(['STITCH', 'OPERA'])
    const coverage = [
      { server: 'plugin_nott_stitch', toolsAvailable: 14, toolsInvoked: 0, coverageRatio: 0, loadedSessions: 5 },
    ] as unknown as McpServerCoverage[]
    const finding = detectUnusedMcp([], projects, new Set([cwd]), coverage, pluginServers)
    // STITCH → plugin_nott_stitch, which the coverage detector already reports → suppressed here.
    expect(finding?.explanation ?? '').not.toContain('STITCH')
    expect(finding?.explanation ?? '').toContain('OPERA')
  })

  it('still flags genuinely dead standalone configs with no plugin equivalent', () => {
    const cwd = cwdWithMcpJson(['OPERA', 'NEON'])
    const finding = detectUnusedMcp([], projects, new Set([cwd]), [], pluginServers)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('OPERA')
    expect(finding!.explanation).toContain('NEON')
  })
})

// ---------------------------------------------------------------------------
// matchConfiguredToPlugin — returns the matched plugin server object
// ---------------------------------------------------------------------------

describe('matchConfiguredToPlugin', () => {
  const servers: PluginMcpServer[] = [
    { runtimeId: 'plugin_nott_PEER', pluginName: 'nott', serverKey: 'PEER' },
    { runtimeId: 'plugin_nott_SSOT', pluginName: 'nott', serverKey: 'SSOT' },
  ]

  it('returns the full plugin server across bare / qualified / alias spellings', () => {
    expect(matchConfiguredToPlugin('SSOT', servers)).toMatchObject({ pluginName: 'nott', serverKey: 'SSOT' })
    expect(matchConfiguredToPlugin('nottSSOT', servers)?.runtimeId).toBe('plugin_nott_SSOT')
    expect(matchConfiguredToPlugin('nott-peer', servers)?.runtimeId).toBe('plugin_nott_PEER')
  })

  it('returns null for a server no plugin provides', () => {
    expect(matchConfiguredToPlugin('OPERA', servers)).toBeNull()
    expect(matchConfiguredToPlugin('', servers)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// detectDuplicatePluginMcp — standalone config that duplicates a plugin server
// ---------------------------------------------------------------------------

describe('detectDuplicatePluginMcp', () => {
  function cwdWithMcpJson(servers: string[]): string {
    const dir = freshDir()
    const mcpServers: Record<string, unknown> = {}
    for (const s of servers) mcpServers[s] = { command: 'noop' }
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers }))
    return dir
  }

  const projects = [
    { project: 'p', projectPath: '/p', sessions: [{ mcpBreakdown: {} }], totalCostUSD: 0, totalApiCalls: 0 },
  ] as unknown as ProjectSummary[]

  const pluginServers: PluginMcpServer[] = [
    { runtimeId: 'plugin_nott_SSOT', pluginName: 'nott', serverKey: 'SSOT' },
    { runtimeId: 'plugin_nott_PEER', pluginName: 'nott', serverKey: 'PEER' },
    { runtimeId: 'plugin_nott_stitch', pluginName: 'nott', serverKey: 'stitch' },
  ]

  it('flags a standalone .mcp.json entry an installed plugin already provides', () => {
    const cwd = cwdWithMcpJson(['STITCH', 'OPERA'])
    const finding = detectDuplicatePluginMcp(projects, new Set([cwd]), pluginServers)
    expect(finding).not.toBeNull()
    // STITCH → plugin_nott_stitch → redundant, named with its plugin.
    expect(finding!.explanation).toContain('STITCH')
    expect(finding!.explanation).toContain('plugin nott')
    // OPERA has no plugin equivalent → not a duplicate.
    expect(finding!.explanation).not.toContain('OPERA')
  })

  it('flags a vendor-prefixed alias that resolves to a plugin server', () => {
    const cwd = cwdWithMcpJson(['nott-peer'])
    const finding = detectDuplicatePluginMcp(projects, new Set([cwd]), pluginServers)
    expect(finding?.explanation ?? '').toContain('nott-peer')
  })

  it('returns null when no standalone config duplicates a plugin server', () => {
    const cwd = cwdWithMcpJson(['OPERA', 'NEON'])
    expect(detectDuplicatePluginMcp(projects, new Set([cwd]), pluginServers)).toBeNull()
  })

  it('returns null when no plugins are installed', () => {
    const cwd = cwdWithMcpJson(['SSOT'])
    expect(detectDuplicatePluginMcp(projects, new Set([cwd]), [])).toBeNull()
  })

  it('flags every standalone key that resolves to a plugin server, without deduping by target', () => {
    // Both `PEER` and the `nott-peer` alias map to plugin_nott_PEER — two
    // separate redundant registrations, so both must be reported for removal.
    const cwd = cwdWithMcpJson(['PEER', 'nott-peer'])
    const finding = detectDuplicatePluginMcp(projects, new Set([cwd]), pluginServers)
    expect(finding).not.toBeNull()
    expect(finding!.title.startsWith('2 standalone MCP configs')).toBe(true)
    const fix = finding!.fix
    if (fix.type === 'paste') {
      expect(fix.text).toContain('PEER')
      expect(fix.text).toContain('nott-peer')
    }
  })

  it('emits a prompt-destination paste fix that names only the standalone duplicates', () => {
    const cwd = cwdWithMcpJson(['SSOT', 'OPERA'])
    const finding = detectDuplicatePluginMcp(projects, new Set([cwd]), pluginServers)
    const fix = finding!.fix
    expect(fix).toMatchObject({ type: 'paste', destination: 'prompt' })
    if (fix.type === 'paste') {
      expect(fix.text).toContain('SSOT')
      expect(fix.text).not.toContain('OPERA')
    }
  })
})
