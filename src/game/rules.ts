/**
 * Scoring rules shared by the game (browser) and the score validator (worker),
 * so the server's plausibility caps are derived from the same numbers.
 */
import { WAVE_COUNT } from './sky'

export const SCORE = {
  debris: 10,
  /** Named real asteroid: half a point per meter of diameter, clamped. */
  real: (diameterM: number) => Math.max(50, Math.min(800, Math.round(diameterM / 2))),
  boss: 3000,
  waveClear: (waveIndex: number) => 200 * (waveIndex + 1),
  victory: (earthHp: number) => 2000 + Math.round(earthHp) * 20,
}

/** Upper bound on a full perfect run, with generous headroom for split fragments. */
export const MAX_RUN_SCORE = (() => {
  let total = SCORE.boss + SCORE.victory(100)
  for (let w = 0; w < WAVE_COUNT; w++) {
    total += SCORE.waveClear(w) + (20 + 6 * w) * SCORE.debris * 2 + 2 * 800
  }
  // x1.5: the boss keeps spawning debris, so a long boss fight legitimately earns more.
  return Math.round(total * 1.5)
})()

/** Fastest plausible pace: a wave can't be cleared faster than this. */
export const MIN_SECONDS_PER_WAVE = 15
/** Generous points-per-second ceiling for the time-based cap. */
export const MAX_POINTS_PER_SECOND = 150
