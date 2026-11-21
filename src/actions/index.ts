/**
 * Server actions. Only one is needed: the game itself runs in the browser
 * and the daily sky is served by public, cached routes (src/server/sky-routes.ts).
 */

import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { utcDay, WAVE_COUNT } from '../game/sky'
import { MAX_POINTS_PER_SECOND, MAX_RUN_SCORE, MIN_SECONDS_PER_WAVE } from '../game/rules'
import { verifyRun } from '../server/run-token'

export interface ScoreSubmission {
  token: string
  score: number
  wave: number
  won: boolean
}

/**
 * Plausibility check, as a pure function so it can be unit-tested. The run's
 * duration comes from the server-signed start time, never from the client.
 */
export function checkScore(
  input: { score: unknown; wave: unknown },
  claims: { day: string; startedAt: number },
  now: number,
): { ok: true; score: number; wave: number } | { ok: false; error: string } {
  const score = Math.floor(Number(input.score))
  const wave = Math.floor(Number(input.wave))
  if (!Number.isFinite(score) || score < 0) return { ok: false, error: 'Invalid score.' }
  if (!Number.isFinite(wave) || wave < 1 || wave > WAVE_COUNT) return { ok: false, error: 'Invalid wave.' }
  if (claims.day !== utcDay(new Date(now))) return { ok: false, error: "That run was on a different day's sky." }
  const seconds = (now - claims.startedAt) / 1000
  if (seconds < 10) return { ok: false, error: 'That run was suspiciously short.' }
  if (seconds > 3 * 3600) return { ok: false, error: 'That run token has expired.' }
  if ((wave - 1) * MIN_SECONDS_PER_WAVE > seconds) return { ok: false, error: 'Nobody clears waves that fast.' }
  if (score > MAX_RUN_SCORE || score > seconds * MAX_POINTS_PER_SECOND + 2000) {
    return { ok: false, error: 'That score is not possible in that much time.' }
  }
  return { ok: true, score, wave }
}

const submitScore: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const claims = await verifyRun(env.RUN_KEY, params.token)
  if (!claims) return { success: false, error: 'This run was not started by the server.' }

  const check = checkScore({ score: params.score, wave: params.wave }, claims, Date.now())
  if (!check.ok) {
    console.warn(`[score] rejected for ${userId}: ${check.error}`)
    return { success: false, error: check.error }
  }

  const id = `${claims.day}:${userId}`
  const existing = await tools.get('scores', id)
  const prev = existing.success
    ? (existing.data as { record?: { data?: { score?: number; nonce?: string } } }).record?.data
    : undefined
  if (prev?.nonce === claims.nonce) return { success: false, error: 'This run was already submitted.' }
  if (prev && Number(prev.score ?? 0) >= check.score) {
    return { success: true, data: { best: Number(prev.score), improved: false } }
  }

  const user = await tools.get('users', userId)
  const rawName = user.success
    ? (user.data as { record?: { data?: { name?: string } } }).record?.data?.name
    : undefined
  const name = (rawName || 'Unnamed pilot').trim().slice(0, 24)

  const saved = await tools.create(
    'scores',
    { day: claims.day, userId, name, score: check.score, wave: check.wave, won: params.won === true ? 1 : 0, nonce: claims.nonce },
    id,
  )
  if (!saved.success) return { success: false, error: 'Could not save your score. Try again.' }
  return { success: true, data: { best: check.score, improved: true } }
}

export const actions: Record<string, ActionHandler<Env>> = { submitScore }
