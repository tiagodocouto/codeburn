import { mkdir, open, readFile, rename, unlink, stat, utimes } from 'fs/promises'
import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { dirname, join } from 'path'
import { homedir } from 'os'

// ============================================================================
// Claude Code statusLine: render codeburn stats + capture rate-limit / effort
// telemetry that transcript parsing never sees.
//
// Claude Code invokes `statusLine.command` on (almost) every render, piping a
// JSON payload on stdin and printing the returned line. So the hook MUST stay
// cheap: a full usage scan takes seconds and would stall the terminal UI on
// every keystroke. The per-session half of the line is rendered straight from
// the stdin payload (zero scan). The cross-session half (today's spend across
// all projects, health grade) comes from a small cached aggregate that a
// detached `claude-statusline-refresh` recomputes out of band — stale-while-
// revalidate: render with whatever aggregate exists, kick a refresh when it is
// older than the TTL, and the next render picks up the fresh value.
// ============================================================================

type StatusLineSettings = {
  type?: string
  command?: string
  padding?: number
}

type Settings = Record<string, unknown> & {
  statusLine?: StatusLineSettings
}

const HOOK_MARKER = 'claude-statusline-hook'
const AGGREGATE_TTL_MS = 90_000
const MAX_STDIN_BYTES = 1024 * 1024

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function claudeSettingsPath(): string {
  return process.env['CLAUDE_SETTINGS_PATH'] ?? join(homedir(), '.claude', 'settings.json')
}

function cacheDir(): string {
  return process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
}

export function claudeStatusLineEventsPath(): string {
  return join(cacheDir(), 'claude-statusline.jsonl')
}

function aggregatePath(): string {
  return join(cacheDir(), 'claude-statusline-aggregate.json')
}

function previousStatusLinePath(): string {
  return join(cacheDir(), 'claude-statusline-previous.json')
}

// ---------------------------------------------------------------------------
// settings.json read / write (atomic, 0600)
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/(["\\])/g, '\\$1')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function isCodeBurnHook(command: unknown): boolean {
  return typeof command === 'string' && command.includes(HOOK_MARKER)
}

function hookCommand(): string {
  const script = process.argv[1] || 'codeburn'
  if (script === 'codeburn') return 'codeburn claude-statusline-hook'
  return `${shellQuote(process.execPath)} ${shellQuote(script)} claude-statusline-hook`
}

async function readSettings(): Promise<Settings> {
  try {
    const raw = await readFile(claudeSettingsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return isObject(parsed) ? parsed as Settings : {}
  } catch {
    return {}
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(tempPath, 'w', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tempPath, path)
  } catch (err) {
    try { await unlink(tempPath) } catch { /* cleanup */ }
    throw err
  }
}

async function writeSettings(settings: Settings): Promise<void> {
  await writeJsonAtomic(claudeSettingsPath(), settings)
}

async function savePreviousStatusLine(statusLine: StatusLineSettings): Promise<void> {
  await writeJsonAtomic(previousStatusLinePath(), {
    savedAt: new Date().toISOString(),
    statusLine,
  })
}

async function readPreviousStatusLine(): Promise<StatusLineSettings | null> {
  try {
    const raw = await readFile(previousStatusLinePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!isObject(parsed) || !isObject(parsed.statusLine)) return null
    return parsed.statusLine as StatusLineSettings
  } catch {
    return null
  }
}

async function clearPreviousStatusLine(): Promise<void> {
  try {
    await unlink(previousStatusLinePath())
  } catch { /* no previous statusLine backup */ }
}

// ---------------------------------------------------------------------------
// install / uninstall — back up and restore any pre-existing statusLine
// ---------------------------------------------------------------------------

export async function installClaudeStatusLineHook(force = false): Promise<'installed' | 'already-installed'> {
  const settings = await readSettings()
  const existing = settings.statusLine
  if (existing && !isCodeBurnHook(existing.command) && !force) {
    throw new Error(
      'Claude Code already has a custom statusLine command. Re-run with --force to replace it.',
    )
  }

  if (isCodeBurnHook(existing?.command)) return 'already-installed'
  if (existing && !isCodeBurnHook(existing.command)) await savePreviousStatusLine(existing)

  settings.statusLine = {
    type: 'command',
    command: hookCommand(),
    padding: 0,
  }
  await writeSettings(settings)
  return 'installed'
}

export async function uninstallClaudeStatusLineHook(): Promise<'removed' | 'restored' | 'not-installed'> {
  const settings = await readSettings()
  if (!isCodeBurnHook(settings.statusLine?.command)) return 'not-installed'

  const previous = await readPreviousStatusLine()
  if (previous) settings.statusLine = previous
  else delete settings.statusLine

  await writeSettings(settings)
  await clearPreviousStatusLine()
  return previous ? 'restored' : 'removed'
}

// ---------------------------------------------------------------------------
// telemetry capture — the rate-limit / effort signal the transcript lacks
// ---------------------------------------------------------------------------

export type ClaudeTelemetry = {
  at: string
  model?: string
  costUsd?: number
  ctxUsedPct?: number
  inputTokens?: number
  cacheReadTokens?: number
  fiveHourPct?: number
  sevenDayPct?: number
  effort?: string
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function extractTelemetry(payload: unknown, at: string): ClaudeTelemetry | null {
  if (!isObject(payload)) return null
  const model = isObject(payload.model) ? payload.model : {}
  const ctx = isObject(payload.context_window) ? payload.context_window : {}
  const usage = isObject(ctx.current_usage) ? ctx.current_usage : {}
  const cost = isObject(payload.cost) ? payload.cost : {}
  const rate = isObject(payload.rate_limits) ? payload.rate_limits : {}
  const fiveHour = isObject(rate.five_hour) ? rate.five_hour : {}
  const sevenDay = isObject(rate.seven_day) ? rate.seven_day : {}
  const effort = isObject(payload.effort) ? payload.effort : {}

  const t: ClaudeTelemetry = {
    at,
    model: str(model.display_name) ?? str(model.id),
    costUsd: num(cost.total_cost_usd),
    ctxUsedPct: num(ctx.used_percentage),
    inputTokens: num(ctx.total_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    fiveHourPct: num(fiveHour.used_percentage),
    sevenDayPct: num(sevenDay.used_percentage),
    effort: str(effort.level),
  }

  // Only persist a row that carries at least one signal the transcript cannot
  // reconstruct on its own (rate limits / effort), so the JSONL stays a
  // telemetry log rather than a redundant copy of per-turn usage.
  if (t.fiveHourPct === undefined && t.sevenDayPct === undefined && t.effort === undefined) {
    return null
  }
  return t
}

async function captureTelemetry(payload: unknown, at: string): Promise<void> {
  const t = extractTelemetry(payload, at)
  if (!t) return
  await mkdir(cacheDir(), { recursive: true, mode: 0o700 })
  const fd = await open(claudeStatusLineEventsPath(), 'a', 0o600)
  try {
    await fd.appendFile(`${JSON.stringify(t)}\n`, { encoding: 'utf-8' })
  } finally {
    await fd.close()
  }
}

// ---------------------------------------------------------------------------
// cross-session aggregate — read (render) + refresh (heavy, detached)
// ---------------------------------------------------------------------------

export type StatusLineAggregate = {
  generatedAt: string
  todayCostUsd: number
  healthGrade: string
  topFinding?: string
  // Set on the placeholder written when a refresh starts with no prior
  // aggregate, so the render shows per-session fields only until real data lands.
  pending?: boolean
}

async function readAggregate(): Promise<{ agg: StatusLineAggregate | null; ageMs: number }> {
  try {
    const path = aggregatePath()
    const s = await stat(path)
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!isObject(parsed) || typeof parsed.todayCostUsd !== 'number') return { agg: null, ageMs: Infinity }
    return { agg: parsed as StatusLineAggregate, ageMs: Date.now() - s.mtimeMs }
  } catch {
    return { agg: null, ageMs: Infinity }
  }
}

// Refresh-storm guard, without a lock file. The aggregate's own freshness is
// the signal the render keys on (spawn only when it is older than the TTL), so
// the refresh's first act is to mark the aggregate fresh — bump the mtime of an
// existing one (keeping its data for stale-while-revalidate) or drop a `pending`
// placeholder when none exists. From that point renders see a fresh aggregate
// and stop spawning, so the window in which a burst can double-spawn is bounded
// by the spawn latency (~one process start), not the whole multi-second scan.
// This deliberately trades strict single-flight (which would need a native lock
// dependency) for a simple, race-free, self-recovering bound: a crashed refresh
// leaves a stale aggregate that the next render simply refreshes again.
async function markRefreshStarted(): Promise<void> {
  const path = aggregatePath()
  await mkdir(cacheDir(), { recursive: true })
  try {
    await stat(path)
    const now = new Date()
    await utimes(path, now, now)
  } catch {
    await writeJsonAtomic(path, {
      generatedAt: new Date().toISOString(),
      todayCostUsd: 0,
      healthGrade: '',
      pending: true,
    } satisfies StatusLineAggregate)
  }
}

function spawnRefreshDetached(): void {
  const script = process.argv[1]
  if (!script) return
  const child = spawn(process.execPath, [script, 'claude-statusline-refresh'], {
    detached: true,
    stdio: 'ignore',
  })
  child.on('error', () => { /* refresh is best-effort; never surface in the status line */ })
  child.unref()
}

export async function refreshClaudeAggregate(): Promise<void> {
  // Mark the aggregate fresh before the multi-second scan so concurrent renders
  // stop spawning their own refresh.
  await markRefreshStarted()

  const [{ getDateRange }, { parseAllSessions }, { scanAndDetect }, { loadPricing }] = await Promise.all([
    import('./cli-date.js'),
    import('./parser.js'),
    import('./optimize.js'),
    import('./models.js'),
  ])
  await loadPricing()

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayProjects = await parseAllSessions({ start: todayStart, end: now }, 'all')
  const todayCostUsd = todayProjects.reduce((sum, p) => sum + p.totalCostUSD, 0)

  const { range } = getDateRange('30days')
  const projects = await parseAllSessions(range, 'all')
  const optimize = await scanAndDetect(projects, range)

  await writeJsonAtomic(aggregatePath(), {
    generatedAt: now.toISOString(),
    todayCostUsd,
    healthGrade: optimize.healthGrade,
    topFinding: optimize.findings[0]?.title,
  } satisfies StatusLineAggregate)
}

// ---------------------------------------------------------------------------
// render — per-session from stdin (instant) + cross-session from the aggregate
// ---------------------------------------------------------------------------

// Raw ANSI (not chalk): Claude Code captures the hook's stdout, which is not a
// TTY, so a TTY-detecting colorizer would strip every color.
const C = {
  reset: '\x1b[0m',
  model: '\x1b[38;5;207m',
  cost: '\x1b[38;5;221m',
  today: '\x1b[38;5;215m',
  ctxOk: '\x1b[38;5;42m',
  ctxWarn: '\x1b[38;5;220m',
  ctxHot: '\x1b[38;5;203m',
  cache: '\x1b[38;5;120m',
  dim: '\x1b[38;5;244m',
  sep: '\x1b[38;5;238m',
  gradeGood: '\x1b[38;5;120m',
  gradeMid: '\x1b[38;5;220m',
  gradeBad: '\x1b[38;5;203m',
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

function ctxColor(pct: number): string {
  if (pct >= 80) return C.ctxHot
  if (pct >= 55) return C.ctxWarn
  return C.ctxOk
}

function gradeColor(grade: string): string {
  if (grade === 'A' || grade === 'B') return C.gradeGood
  if (grade === 'C' || grade === 'D') return C.gradeMid
  return C.gradeBad
}

export function renderStatusLine(payload: unknown, agg: StatusLineAggregate | null): string {
  const p = isObject(payload) ? payload : {}
  const model = isObject(p.model) ? p.model : {}
  const ctx = isObject(p.context_window) ? p.context_window : {}
  const usage = isObject(ctx.current_usage) ? ctx.current_usage : {}
  const cost = isObject(p.cost) ? p.cost : {}

  const sep = `${C.sep} · ${C.reset}`
  const parts: string[] = []

  const modelLabel = str(model.display_name) ?? str(model.id)
  if (modelLabel) parts.push(`${C.model}${modelLabel}${C.reset}`)

  const costUsd = num(cost.total_cost_usd)
  if (costUsd !== undefined) parts.push(`${C.cost}${fmtUsd(costUsd)}${C.reset}`)

  const usedPct = num(ctx.used_percentage)
  if (usedPct !== undefined) {
    const pct = Math.max(0, Math.min(100, Math.round(usedPct)))
    parts.push(`${ctxColor(pct)}ctx ${pct}%${C.reset}`)
  }

  const cacheRead = num(usage.cache_read_input_tokens) ?? 0
  const cacheWrite = num(usage.cache_creation_input_tokens) ?? 0
  if (cacheRead + cacheWrite > 0) {
    const cachePct = Math.round((cacheRead / (cacheRead + cacheWrite)) * 100)
    parts.push(`${C.cache}cache ${cachePct}%${C.reset}`)
  }

  if (agg && !agg.pending) {
    parts.push(`${C.today}today ${fmtUsd(agg.todayCostUsd)}${C.reset}`)
    if (agg.healthGrade) parts.push(`${gradeColor(agg.healthGrade)}${agg.healthGrade}${C.reset}`)
  }

  return parts.join(sep)
}

// ---------------------------------------------------------------------------
// the hook entrypoint — wired to `codeburn claude-statusline-hook`
// ---------------------------------------------------------------------------

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let input = ''
    let bytes = 0
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_STDIN_BYTES) { process.stdin.destroy(); reject(new Error('stdin too large')); return }
      input += chunk
    })
    process.stdin.on('end', () => resolve(input))
    process.stdin.on('error', reject)
  })
}

export async function runClaudeStatusLineHook(): Promise<void> {
  let payload: unknown = null
  try {
    const input = await readStdin()
    payload = input.trim() ? JSON.parse(input) : null
  } catch {
    // A malformed payload still yields an empty status line below rather than a
    // stack trace in the terminal UI.
  }

  // Capture is best-effort and must never block or break the render.
  try {
    if (payload) await captureTelemetry(payload, new Date().toISOString())
  } catch { /* telemetry capture is non-critical */ }

  let agg: StatusLineAggregate | null = null
  let ageMs = Infinity
  try {
    const r = await readAggregate()
    agg = r.agg
    ageMs = r.ageMs
  } catch { /* no aggregate yet → per-session line only */ }

  // Stale (or missing) → kick a detached refresh for the NEXT render; never wait
  // on it here. The refresh marks the aggregate fresh the moment it starts, so
  // subsequent renders stop spawning almost immediately.
  try {
    if (ageMs >= AGGREGATE_TTL_MS) spawnRefreshDetached()
  } catch { /* spawn failure must not break the render */ }

  try {
    process.stdout.write(`${renderStatusLine(payload, agg)}\n`)
  } catch { /* nothing to do if stdout is gone */ }
}
