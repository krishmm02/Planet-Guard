/**
 * Builds and caches the daily sky.
 *
 * Cost model: NASA (3 calls) + one Claude call + up to 8 ElevenLabs lines,
 * once per UTC day, no matter how many people play. The cron task in
 * src/cron.ts builds it just after midnight; getDailySky() also builds it
 * lazily if the cron hasn't run (first deploy, missed alarm).
 *
 * Stored in the `daily_sky` collection (server-only; no client permissions).
 */

import type { ActionTools } from 'deepspace/worker'
import { SKY_VERSION, utcDay, WAVE_COUNT, type Asteroid, type DailySky, type SpaceEvent, type WavePlan } from '../game/sky'

const CLAUDE_MODEL = 'claude-sonnet-5-5'

// ─── NASA → trimmed game data ───────────────────────────────────────────────

interface RawNeo {
  id?: string
  name?: string
  is_potentially_hazardous_asteroid?: boolean
  nasa_jpl_url?: string
  estimated_diameter?: { meters?: { estimated_diameter_min?: number; estimated_diameter_max?: number } }
  close_approach_data?: Array<{
    close_approach_date?: string
    miss_distance?: { lunar?: string }
    relative_velocity?: { kilometers_per_second?: string }
  }>
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return utcDay(d)
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : fallback
}

export function parseNeoFeed(data: unknown): { asteroids: Asteroid[]; trackedCount: number } {
  const byDate = (data as { near_earth_objects?: Record<string, RawNeo[]> })?.near_earth_objects ?? {}
  const all: Asteroid[] = []
  for (const list of Object.values(byDate)) {
    for (const n of list ?? []) {
      const ca = n.close_approach_data?.[0]
      const dmin = num(n.estimated_diameter?.meters?.estimated_diameter_min)
      const dmax = num(n.estimated_diameter?.meters?.estimated_diameter_max)
      if (!n.id || !n.name || !ca || dmax <= 0) continue
      all.push({
        id: String(n.id),
        // NASA wraps provisional designations in parens: "(2009 DC1)".
        name: String(n.name).replace(/^\((.*)\)$/, '$1').slice(0, 40),
        diameterM: Math.round((dmin + dmax) / 2),
        diameterMinM: Math.round(dmin),
        diameterMaxM: Math.round(dmax),
        speedKms: Math.round(num(ca.relative_velocity?.kilometers_per_second, 10) * 10) / 10,
        missLunar: Math.round(num(ca.miss_distance?.lunar, 50) * 10) / 10,
        approachDate: String(ca.close_approach_date ?? ''),
        hazardous: n.is_potentially_hazardous_asteroid === true,
        // Only keep a JPL link if it really points at JPL (it's rendered as an <a>).
        jplUrl: typeof n.nasa_jpl_url === 'string' && n.nasa_jpl_url.startsWith('https://ssd.jpl.nasa.gov/') ? n.nasa_jpl_url : '',
      })
    }
  }
  return { asteroids: all, trackedCount: all.length }
}

const FLARE_SCALE: Record<string, number> = { A: 0.05, B: 0.1, C: 0.3, M: 0.6, X: 1 }

export function parseFlares(data: unknown): SpaceEvent[] {
  const list = Array.isArray(data) ? data : []
  return list
    .map((f: { classType?: string; peakTime?: string; beginTime?: string; link?: string }): SpaceEvent | null => {
      const cls = String(f.classType ?? '')
      const base = FLARE_SCALE[cls[0]] ?? 0
      if (!base) return null
      const mag = Math.min(9.9, num(cls.slice(1), 1))
      return {
        kind: 'flare' as const,
        label: `${cls} solar flare`,
        date: String(f.peakTime ?? f.beginTime ?? '').slice(0, 10),
        intensity: Math.min(1, base + mag * 0.04),
        link: typeof f.link === 'string' && f.link.startsWith('https://ccmc.gsfc.nasa.gov/') ? f.link : '',
      }
    })
    .filter((x): x is SpaceEvent => x !== null)
}

export function parseCmes(data: unknown): SpaceEvent[] {
  const list = Array.isArray(data) ? data : []
  return list
    .map((c: { startTime?: string; link?: string; cmeAnalyses?: Array<{ speed?: number; isMostAccurate?: boolean }> | null }): SpaceEvent | null => {
      const analyses = c.cmeAnalyses ?? []
      const best = analyses.find((a) => a.isMostAccurate) ?? analyses[0]
      const speed = num(best?.speed)
      if (speed < 300) return null
      return {
        kind: 'cme' as const,
        label: `CME at ${Math.round(speed)} km/s`,
        date: String(c.startTime ?? '').slice(0, 10),
        intensity: Math.min(1, speed / 2000),
        link: typeof c.link === 'string' && c.link.startsWith('https://ccmc.gsfc.nasa.gov/') ? c.link : '',
      }
    })
    .filter((x): x is SpaceEvent => x !== null)
}

// ─── Campaign design ────────────────────────────────────────────────────────

/**
 * Picks the week's most interesting objects and spreads them across waves so
 * difficulty escalates: small headliners early, the biggest object (preferring
 * a "potentially hazardous" one) as the final boss. Pure and deterministic.
 */
export function planCampaign(asteroids: Asteroid[], flares: SpaceEvent[], cmes: SpaceEvent[]) {
  const sorted = [...asteroids].sort((a, b) => a.diameterM - b.diameterM)
  const hazardous = sorted.filter((a) => a.hazardous)
  const boss = hazardous.at(-1) ?? sorted.at(-1)
  const pool = sorted.filter((a) => a.id !== boss?.id)

  // Up to 2 headliners per regular wave, sampled evenly through the size range.
  const need = Math.min(pool.length, (WAVE_COUNT - 1) * 2)
  const picks: Asteroid[] = []
  for (let i = 0; i < need; i++) picks.push(pool[Math.floor((i * pool.length) / need)])

  const events: SpaceEvent[] = []
  const strongestFlare = [...flares].sort((a, b) => b.intensity - a.intensity)[0]
  const strongestCme = [...cmes].sort((a, b) => b.intensity - a.intensity)[0]
  const secondFlare = [...flares].sort((a, b) => b.intensity - a.intensity)[1]
  if (strongestFlare) events.push(strongestFlare)
  if (strongestCme) events.push(strongestCme)
  if (secondFlare) events.push(secondFlare)

  // Weather strikes in the back half, where it hurts.
  const eventWave: Record<number, number> = {}
  if (events[0]) eventWave[3] = 0
  if (events[1]) eventWave[5] = 1
  if (events[2]) eventWave[6] = 2

  const waves: WavePlan[] = []
  for (let w = 0; w < WAVE_COUNT; w++) {
    const isBoss = w === WAVE_COUNT - 1
    waves.push({
      index: w,
      headliners: isBoss ? [] : picks.slice(w * 2, w * 2 + 2).map((a) => a.id),
      ...(eventWave[w] !== undefined ? { event: eventWave[w] } : {}),
      ...(isBoss && boss ? { boss: boss.id } : {}),
    })
  }

  const used = new Set([...picks.map((a) => a.id), ...(boss ? [boss.id] : [])])
  return { asteroids: asteroids.filter((a) => used.has(a.id)), events, waves }
}

// ─── Briefings (Claude) ─────────────────────────────────────────────────────

const BRIEFING_SYSTEM = `You are MISSION CONTROL for "Planet Guard", an arcade game where the player orbits Earth in a defense ship and shoots down asteroids.
The data you're given is REAL, and every line must stay true to it:
- The asteroids are NASA-tracked objects making their closest approach to Earth in the coming week. None of them will hit Earth; the game pretends they might, and you can wink at that.
- Sizes are NASA estimates from brightness, given as a range. Always say "about" or "roughly" with a size. Never state a size as exact.
- Space-weather events ALREADY HAPPENED on the date given (up to two weeks ago) and are over. Always talk about them in the past tense ("last week's M2.4 flare", "the CME recorded on November 15th"). The game replays them in that wave. Never say they are happening now or coming.
- A lunar distance is 384,400 kilometers. Don't call a pass "close", "near" or "just" X lunar distances unless it is under 1 lunar distance.
- Only use numbers that appear in the data, written as digits. You may round them. Don't invent facts, nicknames or comparisons.
Voice: calm, dry, slightly funny NASA flight director over the radio. Second person ("Pilot,"). These lines are read aloud by a text-to-speech voice, so write plain spoken sentences: no emojis, no markdown, no lists. Spell out units ("meters", "kilometers per second").
Each briefing: 2 short sentences, at most 38 words. Mention the named asteroids with one real stat each, and mention the space-weather event if the wave has one. Escalate tension toward the boss wave.
Respond with ONLY JSON: {"intro": "...", "briefings": ["wave 1", ... exactly N strings], "victory": "...", "defeat": "..."}`

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

const sizeRange = (a: Asteroid) => (a.diameterMinM && a.diameterMaxM ? `${a.diameterMinM}-${a.diameterMaxM} m` : `${a.diameterM} m`)

function describeWave(w: WavePlan, byId: Map<string, Asteroid>, events: SpaceEvent[], day: string): string {
  const rocks = [...w.headliners, ...(w.boss ? [w.boss] : [])]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((a) => `${a!.name} (about ${a!.diameterM} m wide, NASA estimate ${sizeRange(a!)}; ${a!.speedKms} km/s; closest approach ${a!.approachDate} at ${a!.missLunar} lunar distances${a!.hazardous ? '; NASA-flagged potentially hazardous' : ''})`)
  const ev = w.event !== undefined ? events[w.event] : undefined
  const evText = ev ? `. Space weather (PAST event, replayed this wave): ${ev.label} recorded ${ev.date}, ${daysBetween(ev.date, day)} days before today` : ''
  return `Wave ${w.index + 1}${w.boss ? ' (FINAL BOSS)' : ''}: ${rocks.join('; ') || 'debris field only'}${evText}.`
}

function templateBriefings(waves: WavePlan[], byId: Map<string, Asteroid>, events: SpaceEvent[]) {
  return waves.map((w) => {
    const first = byId.get(w.boss ?? w.headliners[0] ?? '')
    const ev = w.event !== undefined ? events[w.event] : undefined
    const rock = first ? `Inbound: ${first.name}, about ${first.diameterM} meters across at ${first.speedKms} kilometers per second.` : 'Debris field inbound.'
    return `${w.boss ? 'Pilot, this is the big one. ' : `Wave ${w.index + 1}, pilot. `}${rock}${ev ? ` We're replaying the real ${ev.label} recorded on ${ev.date}, so expect your shields to suffer.` : ''}`
  })
}

const PAST_CUE = /\b(last|ago|earlier|recorded|observed|was|were|back on|replay\w*|on (january|february|march|april|may|june|july|august|september|october|november|december))\b/i

/**
 * Backstop for the prompt: Claude's lines are spoken as fact, so reject any
 * line with a number that isn't in the source data (rounding allowed), or a
 * space-weather mention with no past-tense cue. Returns why a line fails.
 */
export function briefingProblems(text: string, facts: number[], opts: { pastEvent?: boolean } = {}): string[] {
  const problems: string[] = []
  const found = text.replace(/(\d),(?=\d{3})/g, '$1').match(/\d+(?:\.\d+)?/g) ?? []
  for (const s of found) {
    const n = Number(s)
    const ok = facts.some((v) => n === v || Math.abs(n - v) <= Math.max(0.5, Math.abs(v) * 0.06))
    if (!ok) problems.push(`number ${s} is not in the data`)
  }
  if (opts.pastEvent && !PAST_CUE.test(text)) problems.push('space-weather event not described as past')
  return problems
}

/** Every number a line about this wave (or, with w=null, the whole day) may contain. */
export function waveFacts(w: WavePlan | null, byId: Map<string, Asteroid>, events: SpaceEvent[], day: string, extra: number[] = []): number[] {
  const out = [...extra, WAVE_COUNT, 384400]
  const rocks = w ? [...w.headliners, ...(w.boss ? [w.boss] : [])].map((id) => byId.get(id)).filter((a): a is Asteroid => !!a) : [...byId.values()]
  for (const a of rocks) {
    out.push(a.diameterM, a.speedKms, a.missLunar)
    if (a.diameterMinM) out.push(a.diameterMinM)
    if (a.diameterMaxM) out.push(a.diameterMaxM)
    out.push(...(a.name.match(/\d+/g) ?? []).map(Number), ...a.approachDate.split('-').map(Number))
  }
  const evs = w ? (w.event !== undefined ? [events[w.event]] : []) : events
  for (const e of evs.filter(Boolean)) out.push(...(e.label.match(/\d+(?:\.\d+)?/g) ?? []).map(Number), ...e.date.split('-').map(Number), daysBetween(e.date, day))
  if (w) out.push(w.index + 1)
  return out
}

function extractText(data: unknown): string {
  const content = (data as { content?: Array<{ type?: string; text?: string }> })?.content
  return Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') : ''
}

const clip = (s: unknown, max: number) => (typeof s === 'string' ? s.trim().slice(0, max) : '')

async function writeBriefings(tools: ActionTools, waves: WavePlan[], byId: Map<string, Asteroid>, events: SpaceEvent[], day: string, trackedCount: number) {
  const fallback = {
    intro: "Pilot, this is Mission Control. These are this week's real near-Earth objects, slightly more hostile than NASA says. Keep them off the planet.",
    briefings: templateBriefings(waves, byId, events),
    victory: "Sky's clear, pilot. Every rock on today's list is accounted for. Take the rest of the day off. Tomorrow's sky is already moving.",
    defeat: 'We lost the planet, pilot. On the bright side, the real ones are still millions of kilometers away. Run it again.',
  }
  const res = await tools.integration('anthropic/chat-completion', {
    model: CLAUDE_MODEL,
    max_tokens: 3000,
    // Structured output; thinking would just add latency (and has truncated JSON before).
    thinking: { type: 'disabled' },
    temperature: 0.9,
    system: BRIEFING_SYSTEM.replace('exactly N strings', `exactly ${waves.length} strings`),
    messages: [{ role: 'user', content: waves.map((w) => describeWave(w, byId, events, day)).join('\n') }],
  })
  if (!res.success) {
    console.warn(`[sky] briefing generation failed: ${res.error}`)
    return fallback
  }
  try {
    const text = extractText(res.data)
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, unknown>
    const briefings = Array.isArray(j.briefings) ? j.briefings.map((b) => clip(b, 320)) : []
    // Any missing, empty or ungrounded line falls back to the template for that line.
    const all = waveFacts(null, byId, events, day, [trackedCount])
    const checked = (line: string, fb: string, facts: number[], label: string, pastEvent = false) => {
      if (!line) return fb
      const problems = briefingProblems(line, facts, { pastEvent })
      if (problems.length) console.warn(`[sky] ${label} rejected (${problems.join('; ')}): ${line}`)
      return problems.length ? fb : line
    }
    return {
      intro: checked(clip(j.intro, 320), fallback.intro, all, 'intro'),
      briefings: waves.map((w, i) => checked(briefings[i] ?? '', fallback.briefings[i], waveFacts(w, byId, events, day), `wave ${i + 1}`, w.event !== undefined)),
      victory: checked(clip(j.victory, 320), fallback.victory, all, 'victory'),
      defeat: checked(clip(j.defeat, 320), fallback.defeat, all, 'defeat'),
    }
  } catch {
    console.warn('[sky] briefing JSON unparseable; using templates. Reply began: ' + extractText(res.data).slice(0, 400))
    return fallback
  }
}

// ─── Offline practice sky ───────────────────────────────────────────────────

/** If NASA is unreachable the game still starts, honestly labelled as practice. */
function practiceSky(day: string): Omit<DailySky, 'briefings' | 'intro' | 'victory' | 'defeat' | 'generatedAt'> {
  const asteroids: Asteroid[] = Array.from({ length: 15 }, (_, i) => ({
    id: `practice-${i}`,
    name: `Training target ${i + 1}`,
    diameterM: Math.round(30 + i * i * 6),
    speedKms: 6 + (i % 5) * 3,
    missLunar: 20 + i * 4,
    approachDate: day,
    hazardous: i === 14,
    jplUrl: '',
  }))
  const flare: SpaceEvent = { kind: 'flare', label: 'Simulated M5.0 flare', date: day, intensity: 0.8, link: '' }
  const cme: SpaceEvent = { kind: 'cme', label: 'Simulated CME at 900 km/s', date: day, intensity: 0.45, link: '' }
  return { day, live: false, trackedCount: 0, ...planCampaign(asteroids, [flare], [cme]) }
}

// ─── Cache + build ──────────────────────────────────────────────────────────

const inflight = new Map<string, Promise<DailySky>>()
let lastFailureAt = 0

async function readCached(tools: ActionTools, day: string): Promise<DailySky | null> {
  const got = await tools.get('daily_sky', day)
  if (!got.success) return null
  const payload = (got.data as { record?: { data?: { payload?: unknown } } }).record?.data?.payload
  if (!payload) return null
  const sky = (typeof payload === 'string' ? JSON.parse(payload) : payload) as DailySky
  // A build from an older version of the briefing rules is rebuilt, not served.
  return sky.v === SKY_VERSION ? sky : null
}

export async function buildDailySky(tools: ActionTools, day = utcDay()): Promise<DailySky> {
  const window = { startDate: day, endDate: addDays(day, 6) }
  const weather = { startDate: addDays(day, -14), endDate: day }
  const [neo, flr, cme] = await Promise.all([
    tools.integration('nasa/neo-feed', window),
    tools.integration('nasa/flr', weather),
    tools.integration('nasa/cme', weather),
  ])

  let base: Omit<DailySky, 'briefings' | 'intro' | 'victory' | 'defeat' | 'generatedAt'>
  const parsed = neo.success ? parseNeoFeed(neo.data) : { asteroids: [], trackedCount: 0 }
  if (parsed.asteroids.length >= 3) {
    // Space weather is optional: a quiet Sun just means fewer hazards.
    const flares = flr.success ? parseFlares(flr.data) : []
    const cmes = cme.success ? parseCmes(cme.data) : []
    base = { day, live: true, trackedCount: parsed.trackedCount, ...planCampaign(parsed.asteroids, flares, cmes) }
  } else {
    console.warn(`[sky] NASA NEO feed unavailable (${neo.success ? 'too few objects' : neo.error}); practice sky`)
    base = practiceSky(day)
  }

  const byId = new Map(base.asteroids.map((a) => [a.id, a]))
  const words = await writeBriefings(tools, base.waves, byId, base.events, day, base.trackedCount)
  const sky: DailySky = { ...base, ...words, generatedAt: Date.now(), v: SKY_VERSION }

  // Only cache a live sky; a practice sky is retried on the next request window.
  if (sky.live) {
    const saved = await tools.create('daily_sky', { day, payload: sky }, day)
    if (!saved.success) console.warn(`[sky] cache write failed: ${saved.error}`)
  }
  return sky
}

/**
 * Cached read with build-on-miss. Concurrent misses in one isolate share a
 * single build, and after a failed (practice) build we wait 10 minutes before
 * paying for another attempt.
 */
export async function getDailySky(tools: ActionTools, day = utcDay()): Promise<DailySky> {
  const cached = await readCached(tools, day)
  if (cached) return cached
  const existing = inflight.get(day)
  if (existing) return existing
  if (Date.now() - lastFailureAt < 10 * 60_000) {
    const p = practiceSky(day)
    const byId = new Map(p.asteroids.map((a) => [a.id, a]))
    return {
      ...p,
      intro: 'Pilot, NASA feeds are down, so this is a training sky. Same physics, fake rocks.',
      briefings: templateBriefings(p.waves, byId, p.events),
      victory: 'Training complete, pilot.',
      defeat: 'Training failed, pilot. Good thing it was a drill.',
      generatedAt: Date.now(),
    }
  }
  const build = buildDailySky(tools, day)
    .then((sky) => {
      if (!sky.live) lastFailureAt = Date.now()
      return sky
    })
    .finally(() => inflight.delete(day))
  inflight.set(day, build)
  return build
}
