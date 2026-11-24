/**
 * "Today's sky": the daily, real-data campaign shared by the worker and the
 * browser. Built once per UTC day from NASA's near-Earth-object feed and the
 * DONKI space-weather feeds, with briefings written by Claude.
 *
 * Only these trimmed fields ever reach the browser; raw NASA responses are
 * dropped on the server (they carry upstream API keys in their `links`).
 */

export interface Asteroid {
  id: string
  name: string
  /** Midpoint of NASA's estimate; sizes come from brightness, so it is a range. */
  diameterM: number
  diameterMinM?: number
  diameterMaxM?: number
  speedKms: number
  missLunar: number
  approachDate: string
  hazardous: boolean
  jplUrl: string
}

export interface SpaceEvent {
  kind: 'flare' | 'cme'
  /** e.g. "M2.4 solar flare" or "CME at 860 km/s" */
  label: string
  date: string
  /** 0..1, drives how hard the event hits in-game */
  intensity: number
  link: string
}

export interface WavePlan {
  index: number
  /** Real asteroids that appear by name this wave. */
  headliners: string[]
  /** Optional space-weather event that strikes mid-wave (index into events). */
  event?: number
  /** Final wave: the biggest object of the week, as a boss. */
  boss?: string
}

export interface DailySky {
  day: string
  /** false when NASA was unreachable and this is the offline practice sky. */
  live: boolean
  trackedCount: number
  asteroids: Asteroid[]
  events: SpaceEvent[]
  waves: WavePlan[]
  /** briefings[i] is read before wave i; plus an intro and two outros. */
  briefings: string[]
  intro: string
  victory: string
  defeat: string
  generatedAt: number
  /** Bumped when the build changes in a way that should replace a cached day. */
  v?: number
}

export const SKY_VERSION = 3

export const WAVE_COUNT = 8

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}
