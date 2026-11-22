/**
 * Scoring rules shared by the game (browser) and the score validator (worker),
 * so the server's plausibility caps are derived from the same numbers.
 */
import { WAVE_COUNT } from './sky'

export const SCORE = {
  debris: 10,
  splitter: 25,
  armored: 40,
  comet: 60,
  /** Named real asteroid: half a point per meter of diameter, clamped. */
  real: (diameterM: number) => Math.max(50, Math.min(800, Math.round(diameterM / 2))),
  boss: 3000,
  waveClear: (waveIndex: number) => 200 * (waveIndex + 1),
  victory: (earthHp: number) => 2000 + Math.round(earthHp) * 20,
}

/** Highest combo multiplier (see multiplierFor in engine.ts). */
export const MAX_MULTIPLIER = 8

/**
 * Upper bound on a run. Every kill could in principle land at the max
 * multiplier, perfect waves double the clear bonus, and the boss keeps
 * spawning debris, so this is deliberately generous: it exists to reject
 * absurd numbers, not to judge good players.
 */
export const MAX_RUN_SCORE = (() => {
  let kills = SCORE.boss
  let flat = SCORE.victory(100)
  for (let w = 0; w < WAVE_COUNT; w++) {
    kills += (20 + 6 * w) * SCORE.armored + 2 * 800 + (1 + Math.floor(w / 2)) * SCORE.comet
    flat += SCORE.waveClear(w) * 2
  }
  return Math.round((kills * MAX_MULTIPLIER + flat) * 1.5)
})()

/** Fastest plausible pace: a wave can't be cleared faster than this. */
export const MIN_SECONDS_PER_WAVE = 15
/** Points-per-second ceiling for the time-based cap (multiplier-aware). */
export const MAX_POINTS_PER_SECOND = 1000
