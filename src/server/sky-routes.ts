/**
 * Public game routes. No sign-in needed: anyone can play instantly.
 *
 *   GET  /api/sky                 today's campaign (cached; built once per day)
 *   GET  /api/sky/voice/:line     mission-control audio for one briefing line
 *   POST /api/run/start           a signed run token (for leaderboard timing)
 *
 * They're safe to leave public because their cost doesn't grow with traffic.
 * The sky is built at most once per day (plus a throttled retry), and voice
 * lines are limited to today's ~11 fixed lines, each generated once and cached.
 * A visitor can't choose the text, the voice, or the day.
 */

import type { Hono } from 'hono'
import type { ActionTools } from 'deepspace/worker'
import type { AppContext, Env } from '../../worker.js'
import { utcDay, type DailySky } from '../game/sky'
import { getDailySky } from './sky-builder'
import { signRun } from './run-token'
import { createActionTools } from './action-routes'

/** Server-identity tools for public routes (no caller; nothing is user-billed here). */
export function systemTools(env: Env): ActionTools {
  return createActionTools(env, env.OWNER_USER_ID || 'system', '')
}

const MC_VOICE = 'onwK4e9ZLuTAKqWW03F9' // ElevenLabs "Daniel": steady, broadcast-style

/** Line ids: "intro", "victory", "defeat", or "w0".."w7". */
function lineText(sky: DailySky, line: string): string | null {
  if (line === 'intro') return sky.intro
  if (line === 'victory') return sky.victory
  if (line === 'defeat') return sky.defeat
  const m = /^w([0-9])$/.exec(line)
  if (m) return sky.briefings[Number(m[1])] ?? null
  return null
}

const voiceInflight = new Map<string, Promise<string | null>>()

async function getVoice(tools: ActionTools, sky: DailySky, line: string, text: string): Promise<string | null> {
  const id = `${sky.day}:v${sky.v ?? 1}:${line}`
  const cached = await tools.get('briefing_audio', id)
  if (cached.success) {
    const audio = (cached.data as { record?: { data?: { audio?: string } } }).record?.data?.audio
    if (audio) return audio
  }
  const existing = voiceInflight.get(id)
  if (existing) return existing
  const job = (async () => {
    const res = await tools.integration<{ audioUrl?: string }>('elevenlabs/generate-speech', {
      text,
      voice_id: MC_VOICE,
      model_id: 'eleven_flash_v2_5',
      output_format: 'mp3_44100_64',
      voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.25 },
    })
    if (!res.success || !res.data?.audioUrl) {
      console.warn(`[voice] ${line} failed: ${res.success ? 'no audio' : res.error}`)
      return null
    }
    // Only cache the live sky's audio (a practice sky changes per build).
    if (sky.live) {
      const saved = await tools.create('briefing_audio', { day: sky.day, line, audio: res.data.audioUrl }, id)
      if (!saved.success) console.warn(`[voice] cache write failed: ${saved.error}`)
    }
    return res.data.audioUrl
  })().finally(() => voiceInflight.delete(id))
  voiceInflight.set(id, job)
  return job
}

export function registerSkyRoutes(app: Hono<AppContext>): void {
  app.get('/api/sky', async (c) => {
    const sky = await getDailySky(systemTools(c.env))
    // Short browser cache; the sky changes once a day.
    c.header('Cache-Control', 'public, max-age=300')
    return c.json(sky)
  })

  app.get('/api/sky/voice/:line', async (c) => {
    const tools = systemTools(c.env)
    const sky = await getDailySky(tools)
    const line = c.req.param('line')
    const text = lineText(sky, line)
    if (!text) return c.json({ error: 'Unknown line' }, 404)
    const dataUrl = await getVoice(tools, sky, line, text)
    if (!dataUrl) return c.json({ error: 'Voice unavailable' }, 503)
    const comma = dataUrl.indexOf(',')
    const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'audio/mpeg'
    const bin = atob(dataUrl.slice(comma + 1))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Response(bytes, {
      headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' },
    })
  })

  app.post('/api/run/start', async (c) => {
    const token = await signRun(c.env.RUN_KEY, { day: utcDay(), startedAt: Date.now(), nonce: crypto.randomUUID() })
    return c.json({ token })
  })
}
