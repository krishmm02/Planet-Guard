/**
 * The Pilot Logbook: what keeps people coming back.
 *
 * Every real NASA asteroid you destroy is collected permanently, so each new
 * day's sky is a fresh set to hunt. Runs earn XP toward a pilot rank, and
 * playing on consecutive days builds a streak.
 *
 * Stored in localStorage on purpose: it's a per-player convenience that
 * needs no account (play stays sign-up free) and no database. The tradeoff,
 * stated in the README, is that it doesn't follow you across devices.
 */

import type { Asteroid } from './sky'
import { utcDay } from './sky'

export interface LogEntry {
  name: string
  diameterM: number
  speedKms: number
  hazardous: boolean
  boss: boolean
  day: string
  jplUrl: string
}

export interface Logbook {
  v: 1
  xp: number
  runs: number
  wins: number
  totalKills: number
  bestScore: number
  bestCombo: number
  days: string[]
  collected: Record<string, LogEntry>
}

const KEY = 'pg-logbook-v1'

export const RANKS = [
  { title: 'Cadet', xp: 0 },
  { title: 'Ensign', xp: 100 },
  { title: 'Lieutenant', xp: 300 },
  { title: 'Commander', xp: 800 },
  { title: 'Captain', xp: 1800 },
  { title: 'Commodore', xp: 3500 },
  { title: 'Admiral', xp: 6000 },
  { title: 'Planet Guardian', xp: 10000 },
] as const

export function emptyLogbook(): Logbook {
  return { v: 1, xp: 0, runs: 0, wins: 0, totalKills: 0, bestScore: 0, bestCombo: 0, days: [], collected: {} }
}

export function loadLogbook(): Logbook {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return emptyLogbook()
    const parsed = JSON.parse(raw) as Logbook
    return parsed.v === 1 ? { ...emptyLogbook(), ...parsed } : emptyLogbook()
  } catch {
    return emptyLogbook()
  }
}

function save(book: Logbook): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(book))
  } catch {
    /* private mode / full storage: the run still counts on screen */
  }
}

export function rankFor(xp: number): { title: string; level: number; next: { title: string; xp: number } | null; progress: number } {
  let level = 0
  for (let i = 0; i < RANKS.length; i++) if (xp >= RANKS[i].xp) level = i
  const next = RANKS[level + 1] ?? null
  const progress = next ? (xp - RANKS[level].xp) / (next.xp - RANKS[level].xp) : 1
  return { title: RANKS[level].title, level, next, progress }
}

/** Consecutive UTC days played, ending today (or yesterday, so it isn't lost before you play). */
export function streak(book: Logbook, today = utcDay()): number {
  const set = new Set(book.days)
  const d = new Date(`${today}T00:00:00Z`)
  if (!set.has(today)) d.setUTCDate(d.getUTCDate() - 1)
  let n = 0
  while (set.has(utcDay(d))) {
    n++
    d.setUTCDate(d.getUTCDate() - 1)
  }
  return n
}

export interface RunResult {
  score: number
  won: boolean
  kills: number
  maxCombo: number
  realKills: Array<{ a: Asteroid; boss: boolean }>
}

export interface RunReport {
  book: Logbook
  xpGained: number
  newEntries: LogEntry[]
  rankedUp: string | null
  newBest: boolean
}

/** Folds a finished run into the logbook and reports what changed. */
export function recordRun(run: RunResult, day = utcDay()): RunReport {
  const book = loadLogbook()
  const before = rankFor(book.xp)
  const newEntries: LogEntry[] = []
  for (const { a, boss } of run.realKills) {
    if (book.collected[a.id]) continue
    const entry: LogEntry = { name: a.name, diameterM: a.diameterM, speedKms: a.speedKms, hazardous: a.hazardous, boss, day, jplUrl: a.jplUrl }
    book.collected[a.id] = entry
    newEntries.push(entry)
  }
  // XP: collecting new real asteroids (a daily habit) outweighs a single big
  // score, so rank reflects days of play rather than one lucky combo run.
  // Tuned after a combo-heavy autopilot run jumped Cadet → Commander in one go.
  const xpGained = Math.round(run.score / 1500) + newEntries.length * 15 + (run.won ? 40 : 0) + 10
  const newBest = run.score > book.bestScore
  book.xp += xpGained
  book.runs++
  if (run.won) book.wins++
  book.totalKills += run.kills
  book.bestScore = Math.max(book.bestScore, run.score)
  book.bestCombo = Math.max(book.bestCombo, run.maxCombo)
  if (!book.days.includes(day)) book.days = [...book.days, day].slice(-120)
  save(book)
  const after = rankFor(book.xp)
  return { book, xpGained, newEntries, rankedUp: after.level > before.level ? after.title : null, newBest }
}

/** How many of today's real asteroids the player has already collected. */
export function todayProgress(book: Logbook, ids: string[]): number {
  return ids.filter((id) => book.collected[id]).length
}
