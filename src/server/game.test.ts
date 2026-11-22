import { describe, expect, it } from 'vitest'
import { parseCmes, parseFlares, parseNeoFeed, planCampaign } from './sky-builder'
import { signRun, verifyRun } from './run-token'
import { checkScore } from '../actions/index'
import { MAX_RUN_SCORE } from '../game/rules'
import { utcDay, WAVE_COUNT, type Asteroid } from '../game/sky'

// Synthetic fixtures shaped like the real NASA responses (the real ones carry
// an upstream api_key in links.self, so they are deliberately not committed).
function neo(id: string, name: string, dmin: number, dmax: number, hazardous = false) {
  return {
    id,
    name,
    is_potentially_hazardous_asteroid: hazardous,
    nasa_jpl_url: `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${id}`,
    links: { self: `http://api.nasa.gov/neo/rest/v1/neo/${id}?api_key=SECRET_UPSTREAM_KEY` },
    estimated_diameter: { meters: { estimated_diameter_min: dmin, estimated_diameter_max: dmax } },
    close_approach_data: [
      { close_approach_date: '2026-11-21', miss_distance: { lunar: '126.2029' }, relative_velocity: { kilometers_per_second: '8.6164' } },
    ],
  }
}

describe('NASA parsing', () => {
  it('trims NEOs to game fields and never keeps the upstream API key', () => {
    const { asteroids, trackedCount } = parseNeoFeed({
      element_count: 3,
      near_earth_objects: { '2026-11-21': [neo('1', '(2009 DC1)', 42, 94), neo('2', '(2020 AB)', 300, 600, true)], '2026-11-22': [neo('3', 'Apophis', 340, 370)] },
    })
    expect(trackedCount).toBe(3)
    expect(asteroids[0]).toMatchObject({ id: '1', name: '2009 DC1', diameterM: 68, speedKms: 8.6, missLunar: 126.2 })
    expect(JSON.stringify(asteroids)).not.toContain('api_key')
    expect(JSON.stringify(asteroids)).not.toContain('SECRET_UPSTREAM_KEY')
  })

  it('drops malformed objects and non-JPL links', () => {
    const bad = { ...neo('9', 'X', 10, 20), nasa_jpl_url: 'javascript:alert(1)' }
    const { asteroids } = parseNeoFeed({ near_earth_objects: { d: [bad, { id: '8' }] } })
    expect(asteroids).toHaveLength(1)
    expect(asteroids[0].jplUrl).toBe('')
  })

  it('scales flares by class and CMEs by speed', () => {
    const flares = parseFlares([
      { classType: 'M1.1', peakTime: '2026-11-19T13:59Z', link: 'https://ccmc.gsfc.nasa.gov/DONKI/view/FLR/1/-1' },
      { classType: 'X2.0', peakTime: '2026-11-18T01:00Z' },
      { classType: '???' },
    ])
    expect(flares.map((f) => f.label)).toEqual(['M1.1 solar flare', 'X2.0 solar flare'])
    expect(flares[1].intensity).toBeGreaterThan(flares[0].intensity)
    const cmes = parseCmes([
      { startTime: '2026-11-20T23:15Z', cmeAnalyses: [{ speed: 298, isMostAccurate: true }] },
      { startTime: '2026-11-20T01:00Z', cmeAnalyses: [{ speed: 1200, isMostAccurate: true }] },
    ])
    expect(cmes).toHaveLength(1)
    expect(cmes[0].label).toBe('CME at 1200 km/s')
  })
})

describe('planCampaign', () => {
  const rocks: Asteroid[] = Array.from({ length: 40 }, (_, i) => ({
    id: String(i), name: `R${i}`, diameterM: 20 + i * 15, speedKms: 10, missLunar: 30, approachDate: '2026-11-21', hazardous: i === 30, jplUrl: '',
  }))

  it('builds 8 waves, escalating, with the biggest hazardous object as boss', () => {
    const c = planCampaign(rocks, [], [])
    expect(c.waves).toHaveLength(WAVE_COUNT)
    expect(c.waves.at(-1)!.boss).toBe('30') // largest *hazardous*, not largest overall
    const sizes = c.waves.slice(0, -1).flatMap((w) => w.headliners.map((id) => rocks[Number(id)].diameterM))
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes)
    // Only objects actually used are shipped to the client.
    expect(c.asteroids.length).toBe(15)
  })

  it('places space weather in later waves and survives a quiet Sun or a tiny feed', () => {
    const flare = { kind: 'flare' as const, label: 'X1 solar flare', date: 'd', intensity: 1, link: '' }
    const c = planCampaign(rocks, [flare], [])
    expect(c.waves[3].event).toBe(0)
    const tiny = planCampaign(rocks.slice(0, 3), [], [])
    expect(tiny.waves).toHaveLength(WAVE_COUNT)
    expect(tiny.waves.at(-1)!.boss).toBeDefined()
  })
})

describe('score validation', () => {
  const now = Date.parse('2026-11-21T12:00:00Z')
  const claims = (secondsAgo: number) => ({ day: utcDay(new Date(now)), startedAt: now - secondsAgo * 1000 })

  it('accepts a plausible run', () => {
    expect(checkScore({ score: 12000, wave: 8 }, claims(400), now)).toMatchObject({ ok: true, score: 12000 })
  })

  it('rejects impossible pace, out-of-range values, and other days', () => {
    expect(checkScore({ score: 90000, wave: 3 }, claims(60), now).ok).toBe(false) // too many points per second
    expect(checkScore({ score: 100, wave: 8 }, claims(30), now).ok).toBe(false) // waves too fast
    expect(checkScore({ score: MAX_RUN_SCORE + 1, wave: 8 }, claims(3 * 3600 - 1), now).ok).toBe(false)
    expect(checkScore({ score: -5, wave: 1 }, claims(60), now).ok).toBe(false)
    expect(checkScore({ score: 10, wave: 99 }, claims(60), now).ok).toBe(false)
    expect(checkScore({ score: 10, wave: 1 }, { day: '2020-01-01', startedAt: now - 60_000 }, now).ok).toBe(false)
    expect(checkScore({ score: 10, wave: 1 }, claims(3), now).ok).toBe(false)
  })
})

describe('run tokens', () => {
  const KEY = 'run-key-for-tests-0123456789abcdefghijklmnop'
  it('round-trips and rejects tampering or a different key', async () => {
    const t = await signRun(KEY, { day: '2026-11-21', startedAt: 1000, nonce: 'n1' })
    expect(await verifyRun(KEY, t)).toEqual({ day: '2026-11-21', startedAt: 1000, nonce: 'n1' })
    // Forge an earlier start time (to look like a longer run) with the old signature.
    const [, sig] = t.split('.')
    const forged = btoa(JSON.stringify({ day: '2026-11-21', startedAt: 1, nonce: 'n1' })).replace(/=+$/, '')
    expect(await verifyRun(KEY, `${forged}.${sig}`)).toBeNull()
    expect(await verifyRun(`${KEY}-x`, t)).toBeNull()
    expect(await verifyRun(KEY, 'garbage')).toBeNull()
  })
  it('fails closed without a secret', async () => {
    await expect(signRun(undefined, { day: 'd', startedAt: 1, nonce: 'n' })).rejects.toThrow(/RUN_KEY/)
  })
})
