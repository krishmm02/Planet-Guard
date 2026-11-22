import { beforeEach, describe, expect, it } from 'vitest'
import { emptyLogbook, loadLogbook, rankFor, recordRun, streak, todayProgress } from './logbook'
import { multiplierFor } from './engine'
import { MAX_RUN_SCORE } from './rules'
import type { Asteroid } from './sky'

// Minimal in-memory localStorage for the node test environment.
const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
}

const rock = (id: string, d = 100): Asteroid => ({ id, name: `R-${id}`, diameterM: d, speedKms: 10, missLunar: 20, approachDate: '2026-11-22', hazardous: false, jplUrl: '' })

describe('combo multiplier', () => {
  it('steps up every 5 kills and caps at x8', () => {
    expect([0, 4, 5, 9, 10, 34, 35, 999].map(multiplierFor)).toEqual([1, 1, 2, 2, 3, 7, 8, 8])
  })
  it('keeps the server score cap above a max-multiplier run', () => {
    expect(MAX_RUN_SCORE).toBeGreaterThan(100_000)
  })
})

describe('logbook', () => {
  beforeEach(() => store.clear())

  it('collects each real asteroid once and awards XP for new finds', () => {
    const first = recordRun({ score: 5000, won: false, kills: 80, maxCombo: 12, realKills: [{ a: rock('1'), boss: false }, { a: rock('2'), boss: false }] }, '2026-11-22')
    expect(first.newEntries).toHaveLength(2)
    expect(first.xpGained).toBe(Math.round(5000 / 1500) + 2 * 15 + 10)
    const again = recordRun({ score: 1000, won: true, kills: 10, maxCombo: 3, realKills: [{ a: rock('1'), boss: false }] }, '2026-11-22')
    expect(again.newEntries).toHaveLength(0)
    expect(again.newBest).toBe(false)
    const book = loadLogbook()
    expect(Object.keys(book.collected)).toEqual(['1', '2'])
    expect(book.runs).toBe(2)
    expect(book.wins).toBe(1)
    expect(book.bestCombo).toBe(12)
    expect(todayProgress(book, ['1', '2', '3'])).toBe(2)
  })

  it('reports promotions', () => {
    // A strong first run (big combo score + a full day's collection) should reach
    // Lieutenant at most, not skip half the ladder.
    const fifteen = Array.from({ length: 15 }, (_, i) => ({ a: rock(String(100 + i)), boss: false }))
    const r = recordRun({ score: 81000, won: true, kills: 500, maxCombo: 101, realKills: fifteen }, '2026-11-22')
    expect(r.rankedUp).toBe('Lieutenant')
  })

  it('counts streaks across UTC days and keeps yesterday’s streak alive until you play', () => {
    const book = { ...emptyLogbook(), days: ['2026-11-19', '2026-11-20', '2026-11-21'] }
    expect(streak(book, '2026-11-22')).toBe(3) // not played yet today
    expect(streak({ ...book, days: [...book.days, '2026-11-22'] }, '2026-11-22')).toBe(4)
    expect(streak(book, '2026-11-24')).toBe(0) // missed a day
  })

  it('survives corrupt storage', () => {
    store.set('pg-logbook-v1', '{not json')
    expect(loadLogbook()).toEqual(emptyLogbook())
  })

  it('ranks by XP thresholds', () => {
    expect(rankFor(0).title).toBe('Cadet')
    expect(rankFor(99).title).toBe('Cadet')
    expect(rankFor(100).title).toBe('Ensign')
    expect(rankFor(999_999).next).toBeNull()
  })
})
