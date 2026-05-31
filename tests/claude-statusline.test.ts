import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import stripAnsi from 'strip-ansi'

import {
  installClaudeStatusLineHook,
  uninstallClaudeStatusLineHook,
  extractTelemetry,
  renderStatusLine,
  type StatusLineAggregate,
} from '../src/claude-statusline.js'

// ---------------------------------------------------------------------------
// install / uninstall — back up and restore the user's existing statusLine
// ---------------------------------------------------------------------------

describe('Claude Code statusLine installer', () => {
  async function withTempSettings(run: (dir: string, settingsPath: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-claude-hook-'))
    const settingsPath = join(dir, 'settings.json')
    const oldSettingsPath = process.env['CLAUDE_SETTINGS_PATH']
    const oldCacheDir = process.env['CODEBURN_CACHE_DIR']
    process.env['CLAUDE_SETTINGS_PATH'] = settingsPath
    process.env['CODEBURN_CACHE_DIR'] = join(dir, 'cache')

    try {
      await run(dir, settingsPath)
    } finally {
      if (oldSettingsPath === undefined) delete process.env['CLAUDE_SETTINGS_PATH']
      else process.env['CLAUDE_SETTINGS_PATH'] = oldSettingsPath
      if (oldCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
      else process.env['CODEBURN_CACHE_DIR'] = oldCacheDir
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('backs up and restores an existing custom statusLine when forced', async () => {
    await withTempSettings(async (dir, settingsPath) => {
      // The real-world case: a user already runs their own statusline.sh.
      const custom = { type: 'command', command: 'bash ~/.claude/statusline.sh', padding: 1 }
      await writeFile(settingsPath, `${JSON.stringify({ statusLine: custom }, null, 2)}\n`)

      await expect(installClaudeStatusLineHook(false)).rejects.toThrow('already has a custom statusLine')
      expect(await installClaudeStatusLineHook(true)).toBe('installed')

      const installed = JSON.parse(await readFile(settingsPath, 'utf-8'))
      expect(installed.statusLine.command).toContain('claude-statusline-hook')

      const backup = JSON.parse(await readFile(join(dir, 'cache', 'claude-statusline-previous.json'), 'utf-8'))
      expect(backup.statusLine).toEqual(custom)

      expect(await uninstallClaudeStatusLineHook()).toBe('restored')
      const restored = JSON.parse(await readFile(settingsPath, 'utf-8'))
      expect(restored.statusLine).toEqual(custom)
    })
  })

  it('installs when no statusLine exists and is idempotent', async () => {
    await withTempSettings(async (_dir, settingsPath) => {
      expect(await installClaudeStatusLineHook(false)).toBe('installed')
      expect(await installClaudeStatusLineHook(false)).toBe('already-installed')

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'))
      expect(settings.statusLine).toMatchObject({ type: 'command', padding: 0 })
      expect(settings.statusLine.command).toContain('claude-statusline-hook')
    })
  })

  it('preserves unrelated settings keys on install and uninstall', async () => {
    await withTempSettings(async (_dir, settingsPath) => {
      await writeFile(settingsPath, JSON.stringify({ theme: 'dark', model: 'opus' }))
      await installClaudeStatusLineHook(false)
      let settings = JSON.parse(await readFile(settingsPath, 'utf-8'))
      expect(settings).toMatchObject({ theme: 'dark', model: 'opus' })

      expect(await uninstallClaudeStatusLineHook()).toBe('removed')
      settings = JSON.parse(await readFile(settingsPath, 'utf-8'))
      expect(settings).toMatchObject({ theme: 'dark', model: 'opus' })
      expect(settings).not.toHaveProperty('statusLine')
    })
  })

  it('uninstall is a no-op when our hook is not installed', async () => {
    await withTempSettings(async (_dir, settingsPath) => {
      await writeFile(settingsPath, JSON.stringify({ statusLine: { command: 'something-else' } }))
      expect(await uninstallClaudeStatusLineHook()).toBe('not-installed')
    })
  })
})

// ---------------------------------------------------------------------------
// extractTelemetry — persist only rate-limit / effort signal (not in transcript)
// ---------------------------------------------------------------------------

describe('extractTelemetry', () => {
  const at = '2026-05-31T00:00:00.000Z'

  it('extracts rate limits, effort, cost, and context usage', () => {
    const t = extractTelemetry({
      model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
      context_window: { used_percentage: 42, total_input_tokens: 1000, current_usage: { cache_read_input_tokens: 800 } },
      cost: { total_cost_usd: 1.23 },
      rate_limits: { five_hour: { used_percentage: 55 }, seven_day: { used_percentage: 12 } },
      effort: { level: 'xhigh' },
    }, at)
    expect(t).toMatchObject({
      at,
      model: 'Opus 4.8',
      costUsd: 1.23,
      ctxUsedPct: 42,
      cacheReadTokens: 800,
      fiveHourPct: 55,
      sevenDayPct: 12,
      effort: 'xhigh',
    })
  })

  it('returns null when no rate-limit or effort signal is present', () => {
    // cost + model alone are already in the transcript; nothing new to log.
    expect(extractTelemetry({ model: { id: 'x' }, cost: { total_cost_usd: 1 } }, at)).toBeNull()
  })

  it('returns null for a non-object payload', () => {
    expect(extractTelemetry(null, at)).toBeNull()
    expect(extractTelemetry('garbage', at)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// renderStatusLine — per-session from stdin + cross-session from the aggregate
// ---------------------------------------------------------------------------

describe('renderStatusLine', () => {
  const payload = {
    model: { display_name: 'Opus 4.8' },
    context_window: { used_percentage: 60, current_usage: { cache_read_input_tokens: 900, cache_creation_input_tokens: 100 } },
    cost: { total_cost_usd: 2.5 },
  }
  const agg: StatusLineAggregate = { generatedAt: 'x', todayCostUsd: 12.34, healthGrade: 'B', topFinding: 'whatever' }

  it('renders per-session and cross-session fields when both are present', () => {
    const line = stripAnsi(renderStatusLine(payload, agg))
    expect(line).toContain('Opus 4.8')
    expect(line).toContain('$2.50')      // session cost
    expect(line).toContain('ctx 60%')
    expect(line).toContain('cache 90%')  // 900 / (900+100)
    expect(line).toContain('today $12.34')
    expect(line).toContain('B')          // health grade
  })

  it('omits the cross-session fields when no aggregate is available', () => {
    const line = stripAnsi(renderStatusLine(payload, null))
    expect(line).toContain('Opus 4.8')
    expect(line).toContain('ctx 60%')
    expect(line).not.toContain('today')
  })

  it('returns a string (no throw) for an empty or malformed payload', () => {
    expect(typeof renderStatusLine(null, null)).toBe('string')
    expect(typeof renderStatusLine({ junk: true }, null)).toBe('string')
    expect(stripAnsi(renderStatusLine({}, null))).toBe('')
  })

  it('suppresses the cross-session fields while the aggregate is a pending placeholder', () => {
    const pending: StatusLineAggregate = { generatedAt: 'x', todayCostUsd: 0, healthGrade: '', pending: true }
    const line = stripAnsi(renderStatusLine(payload, pending))
    expect(line).toContain('Opus 4.8') // per-session fields still render
    expect(line).not.toContain('today') // cross-session suppressed until real data lands
  })
})

// ---------------------------------------------------------------------------
// refresh storm guard — the refresh marks the aggregate fresh before scanning,
// so a burst of renders does not fan out into concurrent scans. The detached
// spawn + multi-second scan are exercised by the e2e smoke, not a unit test.
// ---------------------------------------------------------------------------
