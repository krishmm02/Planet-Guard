/**
 * Planet Guard game engine: a single canvas and an update loop, with no React
 * and no assets. React drives it through a handful of methods
 * (startWave / nova / spend / repair / setPaused / destroy) and listens
 * through callbacks.
 *
 * Coordinates are CSS pixels with Earth at the canvas center. The player's
 * ship orbits Earth and auto-fires outward. Aim by pointing (mouse/finger)
 * or with A/D / arrow keys; Space or right-click fires the Nova.
 *
 * Design note: aiming is deliberately snappy, so difficulty comes from what
 * you aim at (enemy variety, two-front clusters, space weather) and the skill
 * ceiling comes from the combo multiplier, not from fighting the controls.
 */

import type { Asteroid, DailySky, SpaceEvent } from './sky'
import { WAVE_COUNT } from './sky'
import { SCORE } from './rules'
import type { Sfx } from './sfx'

export interface Upgrades {
  fireRate: number
  damage: number
  spread: number
  shield: number
  pierce: number
  nova: number
}

export const NO_UPGRADES: Upgrades = { fireRate: 0, damage: 0, spread: 0, shield: 0, pierce: 0, nova: 0 }

export type PowerKind = 'overdrive' | 'freeze' | 'surge'

export interface Hud {
  score: number
  credits: number
  wave: number
  earthHp: number
  shield: number
  shieldMax: number
  nova: number // 0..1 charge
  event: { kind: 'flare' | 'cme'; label: string } | null
  kills: number
  combo: number
  multiplier: number
  maxCombo: number
  /** Seconds left on each active timed power-up. */
  powers: Partial<Record<PowerKind, number>>
}

export interface RunStats {
  kills: number
  maxCombo: number
  comets: number
  powerups: number
  perfectWaves: number
}

export interface EngineCallbacks {
  onHud: (hud: Hud) => void
  onWaveCleared: (waveIndex: number, perfect: boolean) => void
  onGameOver: (won: boolean, stats: RunStats) => void
  /** A named, real asteroid was destroyed (for the kill feed + logbook). */
  onRealKill: (a: Asteroid, points: number, boss: boolean) => void
}

type RockKind = 'debris' | 'splitter' | 'armored' | 'comet' | 'real' | 'boss'

interface Rock {
  kind: RockKind
  x: number; y: number; vx: number; vy: number
  r: number; hp: number; maxHp: number; points: number
  shape: number[]; rot: number; spin: number; flash: number
  real?: Asteroid; spawnTimer?: number
}
interface Bullet { x: number; y: number; vx: number; vy: number; life: number; dmg: number; pierce: number; hit: Set<Rock> }
interface Capsule { x: number; y: number; vx: number; vy: number; kind: PowerKind; life: number }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number; streak?: boolean }
interface FloatText { x: number; y: number; text: string; life: number; color: string; big?: boolean }
interface Spawn { t: number; kind: 'debris' | 'real' | 'boss' | 'comet'; asteroid?: Asteroid; side?: number }

const TAU = Math.PI * 2
const EARTH_MAX = 100
const COMBO_WINDOW = 2.2
const POWER_SECONDS: Record<Exclude<PowerKind, 'surge'>, number> = { overdrive: 7, freeze: 5 }
const POWER_COLORS: Record<PowerKind, string> = { overdrive: '#fb923c', freeze: '#93c5fd', surge: '#67e8f9' }
const POWER_LABEL: Record<PowerKind, string> = { overdrive: 'OVERDRIVE', freeze: 'TIME FREEZE', surge: 'SHIELD SURGE' }
const rand = (a: number, b: number) => a + Math.random() * (b - a)

function angleDiff(a: number, b: number): number {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return d
}

function makeShape(n = 11): number[] {
  return Array.from({ length: n }, () => rand(0.72, 1.12))
}

export function multiplierFor(combo: number): number {
  return Math.min(8, 1 + Math.floor(combo / 5))
}

export class GameEngine {
  private ctx: CanvasRenderingContext2D
  private w = 0
  private h = 0
  private raf = 0
  private last = 0
  private running = false
  private destroyed = false

  // world
  private rocks: Rock[] = []
  private bullets: Bullet[] = []
  private capsules: Capsule[] = []
  private particles: Particle[] = []
  private texts: FloatText[] = []
  private stars: Array<{ x: number; y: number; z: number }> = []
  private spawns: Spawn[] = []
  private waveTime = 0
  private waveIndex = -1
  private waveActive = false
  private waveHits = 0

  // player
  private angle = -Math.PI / 2
  private targetAngle = -Math.PI / 2
  private fireCd = 0
  private novaCd = 0
  private muzzle = 0
  private upgrades: Upgrades = { ...NO_UPGRADES }
  private keys = new Set<string>()
  private powers: Partial<Record<PowerKind, number>> = {}

  // planet
  private earthHp = EARTH_MAX
  private shield = 50
  private sinceHit = 99
  private earthSpin = 0

  // events
  private eventPlan: { at: number; ev: SpaceEvent } | null = null
  private eventLeft = 0
  private activeEvent: SpaceEvent | null = null
  private wind = { x: 0, y: 0 }
  private flash = 0

  // fx + score
  private shake = 0
  private hitstop = 0
  private score = 0
  private credits = 0
  private combo = 0
  private comboTimer = 0
  private stats: RunStats = { kills: 0, maxCombo: 0, comets: 0, powerups: 0, perfectWaves: 0 }
  private killsSinceDrop = 0
  private hudTimer = 0

  private byId: Map<string, Asteroid>

  /** Dev/test only: aims at the most threatening rock (used by e2e + balance checks). */
  autopilot = false
  /** Smoothed frames per second (diagnostics). */
  fps = 60
  /** Dev/test only: simulation substeps per frame (fast-forward without tunnelling). */
  timeScale = 1

  constructor(
    private canvas: HTMLCanvasElement,
    private sky: DailySky,
    private cb: EngineCallbacks,
    private sfx: Sfx,
  ) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D not supported')
    this.ctx = ctx
    this.byId = new Map(sky.asteroids.map((a) => [a.id, a]))
    this.resize()
    for (let i = 0; i < 160; i++) this.stars.push({ x: Math.random(), y: Math.random(), z: rand(0.2, 1) })
    this.bindInput()
    this.running = true
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  // ─── public API ──────────────────────────────────────────────────────────

  get shieldMax(): number {
    return 50 + this.upgrades.shield * 25
  }

  get multiplier(): number {
    return multiplierFor(this.combo)
  }

  startWave(index: number, upgrades: Upgrades): void {
    this.upgrades = { ...upgrades }
    this.waveIndex = index
    this.waveTime = 0
    this.waveActive = true
    this.waveHits = 0
    this.shield = this.shieldMax
    this.bullets = []
    this.capsules = []
    this.powers = {}
    const plan = this.sky.waves[index]
    const isBoss = index === WAVE_COUNT - 1
    const duration = 26 + index * 3
    const debris = 12 + index * 6 + (isBoss ? 8 : 0)
    const spawns: Spawn[] = []
    // From wave 3, debris arrives in clusters from one side so you have to swing around.
    const cluster = index >= 2 ? 3 : 1
    for (let i = 0; i < debris; i += cluster) {
      const t = 1.2 + (i / debris) * duration + rand(-0.4, 0.4)
      const side = rand(0, TAU)
      // From wave 4 every other cluster lands on the opposite side at the same moment.
      const twoFront = index >= 3 && (i / cluster) % 2 === 1
      for (let k = 0; k < cluster && i + k < debris; k++) {
        spawns.push({ t: t + k * 0.18, kind: 'debris', side: twoFront && k % 2 ? side + Math.PI : side })
      }
    }
    // Comets from wave 3: fast, fragile, worth a lot. Miss one and your combo dies.
    if (index >= 2) {
      const comets = 1 + Math.floor(index / 2)
      for (let i = 0; i < comets; i++) spawns.push({ t: duration * ((i + 1) / (comets + 1)) + rand(-2, 2), kind: 'comet' })
    }
    plan?.headliners.forEach((id, i) => {
      const a = this.byId.get(id)
      if (a) spawns.push({ t: duration * (0.25 + i * 0.35), kind: 'real', asteroid: a })
    })
    if (isBoss) {
      const boss = plan?.boss ? this.byId.get(plan.boss) : undefined
      spawns.push({ t: 2.5, kind: 'boss', asteroid: boss })
    }
    this.spawns = spawns.sort((a, b) => a.t - b.t)
    const ev = plan?.event !== undefined ? this.sky.events[plan.event] : undefined
    this.eventPlan = ev ? { at: duration * 0.4, ev } : null
    this.activeEvent = null
    this.eventLeft = 0
  }

  repair(amount: number): void {
    this.earthHp = Math.min(EARTH_MAX, this.earthHp + amount)
    this.emitHud()
  }

  /** Credits are spent in the shop (React), so React tells the engine. */
  spend(amount: number): void {
    this.credits = Math.max(0, this.credits - amount)
    this.emitHud()
  }

  nova(): void {
    if (!this.waveActive || this.novaCd > 0) return
    this.novaCd = this.novaCooldown()
    this.sfx.nova()
    this.shake = Math.max(this.shake, 10)
    this.flash = Math.max(this.flash, 0.18)
    const R = 240
    for (const r of this.rocks) {
      const dx = r.x - this.w / 2
      const dy = r.y - this.h / 2
      const d = Math.hypot(dx, dy) || 1
      if (d < R + r.r) {
        this.damageRock(r, r.kind === 'boss' ? 25 : 8)
        r.vx += (dx / d) * 120
        r.vy += (dy / d) * 120
      }
    }
    for (let i = 0; i < 70; i++) {
      const a = (i / 70) * TAU
      this.particles.push({ x: this.w / 2, y: this.h / 2, vx: Math.cos(a) * 520, vy: Math.sin(a) * 520, life: 0.45, max: 0.45, color: '#7dd3fc', size: 3 })
    }
  }

  setPaused(paused: boolean): void {
    if (this.destroyed) return
    if (paused && this.running) {
      this.running = false
      cancelAnimationFrame(this.raf)
    } else if (!paused && !this.running) {
      this.running = true
      this.last = performance.now()
      this.raf = requestAnimationFrame(this.frame)
    }
  }

  destroy(): void {
    this.destroyed = true
    this.running = false
    cancelAnimationFrame(this.raf)
    this.unbindInput()
  }

  resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect() ?? this.canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.w = Math.max(320, rect.width)
    this.h = Math.max(320, rect.height)
    this.canvas.width = Math.round(this.w * dpr)
    this.canvas.height = Math.round(this.h * dpr)
    this.canvas.style.width = `${this.w}px`
    this.canvas.style.height = `${this.h}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  // ─── geometry ────────────────────────────────────────────────────────────

  private get orbitR(): number {
    return Math.max(64, Math.min(110, Math.min(this.w, this.h) * 0.14))
  }
  private get earthR(): number {
    return this.orbitR * 0.55
  }
  private novaCooldown(): number {
    return 18 * Math.pow(0.8, this.upgrades.nova)
  }

  // ─── input ───────────────────────────────────────────────────────────────

  private onPointer = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect()
    const x = e.clientX - rect.left - this.w / 2
    const y = e.clientY - rect.top - this.h / 2
    if (Math.hypot(x, y) > 8) this.targetAngle = Math.atan2(y, x)
  }
  private onPointerDown = (e: PointerEvent) => {
    this.sfx.unlock()
    if (e.button === 2) {
      e.preventDefault()
      this.nova()
      return
    }
    this.onPointer(e)
  }
  private onContext = (e: Event) => e.preventDefault()
  private onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase()
    if (k === ' ') {
      e.preventDefault()
      this.nova()
    }
    if (['a', 'd', 'arrowleft', 'arrowright'].includes(k)) {
      e.preventDefault()
      this.keys.add(k)
    }
  }
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase())
  private onResize = () => this.resize()

  private bindInput(): void {
    this.canvas.addEventListener('pointermove', this.onPointer)
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('contextmenu', this.onContext)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('resize', this.onResize)
  }
  private unbindInput(): void {
    this.canvas.removeEventListener('pointermove', this.onPointer)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('contextmenu', this.onContext)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('resize', this.onResize)
  }

  // ─── loop ────────────────────────────────────────────────────────────────

  private frame = (now: number) => {
    if (!this.running) return
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    if (dt > 0) this.fps = this.fps * 0.95 + (1 / dt) * 0.05
    for (let i = 0; i < this.timeScale && this.running; i++) {
      // Hitstop: a few frozen frames on big kills sell the impact.
      if (this.hitstop > 0) {
        this.hitstop -= dt
        continue
      }
      this.update(dt)
    }
    this.draw()
    this.raf = requestAnimationFrame(this.frame)
  }

  private update(dt: number): void {
    const cx = this.w / 2
    const cy = this.h / 2
    this.earthSpin += dt * 0.15
    this.shake = Math.max(0, this.shake - dt * 30)
    this.flash = Math.max(0, this.flash - dt * 2.5)
    this.muzzle = Math.max(0, this.muzzle - dt * 18)
    for (const s of this.stars) {
      s.x -= dt * 0.004 * s.z
      if (s.x < 0) s.x += 1
    }

    // Aim: snappy exponential follow (settles in ~100ms), capped so a flick still reads as motion.
    // A solar flare scrambles the controls; that's the space weather's bite.
    const flare = this.activeEvent?.kind === 'flare'
    const dir = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0)
    if (dir) this.targetAngle = this.angle + dir * 0.5
    if (this.autopilot) this.autoAim(cx, cy)
    const diff = angleDiff(this.angle, this.targetAngle)
    const follow = Math.min(1, dt * (flare ? 7 : 22))
    const maxStep = (flare ? 6 : 16) * dt
    const gap = Math.abs(diff)
    this.angle += Math.sign(diff) * Math.min(gap, maxStep, Math.max(gap * follow, 0.4 * dt))

    if (this.waveActive) this.updateWave(dt, cx, cy)

    // bullets
    for (const b of this.bullets) {
      b.x += b.vx * dt
      b.y += b.vy * dt
      b.life -= dt
    }
    this.bullets = this.bullets.filter((b) => b.life > 0)

    // rocks (Time Freeze slows everything but you)
    const cme = this.activeEvent?.kind === 'cme'
    const slow = this.powers.freeze ? 0.35 : 1
    for (const r of this.rocks) {
      if (cme) {
        r.vx += this.wind.x * dt
        r.vy += this.wind.y * dt
      }
      // gentle gravity so near-misses curve in
      const dx = cx - r.x
      const dy = cy - r.y
      const d = Math.max(40, Math.hypot(dx, dy))
      const g = 2600 / d
      r.vx += (dx / d) * g * dt
      r.vy += (dy / d) * g * dt
      r.x += r.vx * dt * slow
      r.y += r.vy * dt * slow
      r.rot += r.spin * dt * slow
      r.flash = Math.max(0, r.flash - dt * 6)
      if (r.kind === 'comet' && Math.random() < 0.8) {
        this.particles.push({ x: r.x, y: r.y, vx: -r.vx * 0.15 + rand(-15, 15), vy: -r.vy * 0.15 + rand(-15, 15), life: 0.5, max: 0.5, color: '#bae6fd', size: 2 })
      }
      if (r.kind === 'boss' && r.spawnTimer !== undefined) {
        r.spawnTimer -= dt * slow
        if (r.spawnTimer <= 0) {
          r.spawnTimer = 1.3
          this.spawnDebrisAt(r.x, r.y, 3)
        }
      }
    }

    // capsules drift and pulse
    for (const c of this.capsules) {
      c.x += c.vx * dt
      c.y += c.vy * dt
      c.life -= dt
    }

    // bullet ↔ capsule, bullet ↔ rock
    for (const b of this.bullets) {
      for (const c of this.capsules) {
        if (c.life > 0 && (b.x - c.x) ** 2 + (b.y - c.y) ** 2 < 16 * 16) {
          c.life = 0
          b.life = 0
          this.activatePower(c.kind, c.x, c.y)
        }
      }
      if (b.life <= 0) continue
      for (const r of this.rocks) {
        if (r.hp <= 0 || b.hit.has(r)) continue
        const dx = b.x - r.x
        const dy = b.y - r.y
        if (dx * dx + dy * dy < r.r * r.r) {
          b.hit.add(r)
          this.spark(b.x, b.y, r.kind === 'armored' ? '#e2e8f0' : '#fde68a')
          this.damageRock(r, b.dmg)
          if (b.pierce > 0) b.pierce--
          else {
            b.life = 0
            break
          }
        }
      }
    }
    this.capsules = this.capsules.filter((c) => c.life > 0)

    // rock ↔ earth (+ shield)
    const hitR = this.earthR + 10
    for (const r of this.rocks) {
      if (r.hp <= 0) continue
      if (Math.hypot(r.x - cx, r.y - cy) < hitR + r.r * 0.6) {
        r.hp = 0
        const dmg = r.kind === 'boss' ? 70 : r.kind === 'real' ? 14 + r.r * 0.6 : r.kind === 'armored' ? 10 : 6
        this.hitEarth(dmg, r.x, r.y)
      }
    }

    // cleanup
    const far = Math.hypot(this.w, this.h) / 2 + 160
    this.rocks = this.rocks.filter((r) => r.hp > 0 && Math.hypot(r.x - cx, r.y - cy) < far)

    for (const p of this.particles) {
      p.x += p.vx * dt
      p.y += p.vy * dt
      if (!p.streak) {
        p.vx *= 0.97
        p.vy *= 0.97
      }
      p.life -= dt
    }
    this.particles = this.particles.filter((p) => p.life > 0)
    // Bound the particle budget so a big Nova + explosions can't spike frame time.
    if (this.particles.length > 700) this.particles.splice(0, this.particles.length - 700)
    for (const t of this.texts) {
      t.y -= (t.big ? 18 : 30) * dt
      t.life -= dt
    }
    this.texts = this.texts.filter((t) => t.life > 0)

    this.hudTimer -= dt
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1
      this.emitHud()
    }
  }

  private updateWave(dt: number, cx: number, cy: number): void {
    this.waveTime += dt
    this.novaCd = Math.max(0, this.novaCd - dt)

    // combo decays if you stop killing
    if (this.combo > 0) {
      this.comboTimer -= dt
      if (this.comboTimer <= 0) this.combo = 0
    }
    // timed power-ups
    for (const k of Object.keys(this.powers) as PowerKind[]) {
      const left = (this.powers[k] ?? 0) - dt
      if (left <= 0) delete this.powers[k]
      else this.powers[k] = left
    }

    while (this.spawns.length && this.spawns[0].t <= this.waveTime) {
      const s = this.spawns.shift()!
      if (s.kind === 'debris') this.spawnDebris(s.side)
      else if (s.kind === 'comet') this.spawnComet()
      else if (s.kind === 'real' && s.asteroid) this.spawnReal(s.asteroid)
      else if (s.kind === 'boss') this.spawnBoss(s.asteroid)
    }

    // space weather
    if (this.eventPlan && this.waveTime >= this.eventPlan.at) {
      const ev = this.eventPlan.ev
      this.eventPlan = null
      this.activeEvent = ev
      this.eventLeft = 9 + ev.intensity * 4
      this.sfx.alarm()
      if (ev.kind === 'cme') {
        const a = rand(0, TAU)
        const strength = 30 + ev.intensity * 70
        this.wind = { x: Math.cos(a) * strength, y: Math.sin(a) * strength }
      }
    }
    if (this.activeEvent) {
      this.eventLeft -= dt
      if (this.activeEvent.kind === 'flare' && Math.random() < dt * (1.2 + this.activeEvent.intensity * 2)) {
        this.flash = 0.35 + this.activeEvent.intensity * 0.45
      }
      if (this.activeEvent.kind === 'cme') {
        const len = Math.hypot(this.wind.x, this.wind.y)
        const nx = this.wind.x / len
        const ny = this.wind.y / len
        const R = Math.max(this.w, this.h) * 0.75
        for (let i = 0; i < 3; i++) {
          const off = rand(-1, 1) * R
          this.particles.push({ x: cx - nx * R - ny * off, y: cy - ny * R + nx * off, vx: nx * rand(700, 1100), vy: ny * rand(700, 1100), life: 1.6, max: 1.6, color: 'rgba(232,121,249,0.8)', size: 2, streak: true })
        }
      }
      if (this.eventLeft <= 0) this.activeEvent = null
    }

    // shield regen (a flare knocks it out)
    this.sinceHit += dt
    if (this.sinceHit > 3 && this.activeEvent?.kind !== 'flare') this.shield = Math.min(this.shieldMax, this.shield + 3 * dt)

    // firing (Overdrive doubles the rate and adds a barrel)
    this.fireCd -= dt
    if (this.fireCd <= 0) {
      const od = !!this.powers.overdrive
      this.fireCd = 0.16 * Math.pow(0.88, this.upgrades.fireRate) * (od ? 0.5 : 1)
      const shots = Math.min(5, ([1, 2, 3, 4][this.upgrades.spread] ?? 1) + (od ? 1 : 0))
      const sx = cx + Math.cos(this.angle) * this.orbitR
      const sy = cy + Math.sin(this.angle) * this.orbitR
      for (let i = 0; i < shots; i++) {
        const a = this.angle + (i - (shots - 1) / 2) * 0.085
        this.bullets.push({ x: sx, y: sy, vx: Math.cos(a) * 760, vy: Math.sin(a) * 760, life: 1.1, dmg: 1 + this.upgrades.damage, pierce: this.upgrades.pierce, hit: new Set() })
      }
      this.muzzle = 1
      this.sfx.shoot()
    }

    if (this.earthHp <= 0) {
      this.waveActive = false
      this.boom(cx, cy, '#60a5fa', 140, 2)
      this.shake = 24
      this.sfx.explode(true)
      this.emitHud()
      this.cb.onGameOver(false, { ...this.stats })
      return
    }

    if (!this.spawns.length && this.rocks.length === 0) {
      this.waveActive = false
      this.activeEvent = null
      const perfect = this.waveHits === 0
      const bonus = SCORE.waveClear(this.waveIndex) * (perfect ? 2 : 1)
      if (perfect) {
        this.stats.perfectWaves++
        this.texts.push({ x: cx, y: cy - this.orbitR - 40, text: 'PERFECT WAVE ×2', life: 2, color: '#67e8f9', big: true })
      }
      this.score += bonus
      this.credits += bonus
      this.sfx.waveClear()
      if (this.waveIndex === WAVE_COUNT - 1) {
        this.score += SCORE.victory(this.earthHp)
        this.emitHud()
        this.cb.onGameOver(true, { ...this.stats })
      } else {
        this.emitHud()
        this.cb.onWaveCleared(this.waveIndex, perfect)
      }
    }
  }

  private aimTimer = 0
  private autoAim(cx: number, cy: number): void {
    // Retarget ~3x/second with some error, like a person, not an aimbot.
    this.aimTimer -= 1 / 60
    if (this.aimTimer > 0) return
    this.aimTimer = 0.3
    let best: { x: number; y: number } | null = null
    let bestD = Infinity
    for (const r of this.rocks) {
      const d = Math.hypot(r.x - cx, r.y - cy) - (r.kind === 'real' ? 60 : r.kind === 'comet' ? 80 : 0)
      if (d < bestD && d < Math.hypot(this.w, this.h) / 2) {
        bestD = d
        best = r
      }
    }
    if (best) this.targetAngle = Math.atan2(best.y - cy, best.x - cx) + rand(-0.12, 0.12)
    if (this.novaCd <= 0 && this.rocks.filter((r) => Math.hypot(r.x - cx, r.y - cy) < 200).length >= 4) this.nova()
  }

  // ─── spawning ────────────────────────────────────────────────────────────

  private edgePoint(side?: number): { x: number; y: number; a: number } {
    const a = side === undefined ? rand(0, TAU) : side + rand(-0.25, 0.25)
    const R = Math.hypot(this.w, this.h) / 2 + 30
    return { x: this.w / 2 + Math.cos(a) * R, y: this.h / 2 + Math.sin(a) * R, a }
  }

  private aimAtEarth(x: number, y: number, speed: number, spread = 0.18): { vx: number; vy: number } {
    const a = Math.atan2(this.h / 2 - y, this.w / 2 - x) + rand(-spread, spread)
    return { vx: Math.cos(a) * speed, vy: Math.sin(a) * speed }
  }

  private spawnDebris(side?: number): void {
    const p = this.edgePoint(side)
    const w = this.waveIndex
    // Variety: splitters from wave 2, armored rocks from wave 4.
    const roll = Math.random()
    const kind: RockKind = w >= 3 && roll < 0.15 ? 'armored' : w >= 1 && roll < 0.33 ? 'splitter' : 'debris'
    const speed = (kind === 'armored' ? 38 : 48) + w * (kind === 'armored' ? 6 : 9) + rand(0, 30)
    const v = this.aimAtEarth(p.x, p.y, speed)
    const r = kind === 'armored' ? rand(10, 12) : kind === 'splitter' ? rand(11, 13) : rand(5, 9)
    const hp = kind === 'armored' ? 5 : kind === 'splitter' ? 2 : 1
    const points = kind === 'armored' ? SCORE.armored : kind === 'splitter' ? SCORE.splitter : SCORE.debris
    this.rocks.push({ kind, x: p.x, y: p.y, ...v, r, hp, maxHp: hp, points, shape: makeShape(kind === 'armored' ? 7 : 9), rot: 0, spin: rand(-2, 2), flash: 0 })
  }

  private spawnDebrisAt(x: number, y: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const v = this.aimAtEarth(x, y, rand(50, 80), 0.6)
      this.rocks.push({ kind: 'debris', x: x + rand(-10, 10), y: y + rand(-10, 10), ...v, r: rand(5, 8), hp: 1, maxHp: 1, points: SCORE.debris, shape: makeShape(8), rot: 0, spin: rand(-3, 3), flash: 0 })
    }
  }

  private spawnComet(): void {
    const p = this.edgePoint()
    const v = this.aimAtEarth(p.x, p.y, rand(170, 220), 0.05)
    this.rocks.push({ kind: 'comet', x: p.x, y: p.y, ...v, r: 7, hp: 1, maxHp: 1, points: SCORE.comet, shape: makeShape(7), rot: 0, spin: 4, flash: 0 })
    this.texts.push({ x: this.w / 2, y: 70, text: 'COMET!', life: 1.2, color: '#bae6fd' })
  }

  private spawnReal(a: Asteroid): void {
    const p = this.edgePoint()
    const r = Math.max(14, Math.min(40, 14 + 9 * Math.log10(Math.max(20, a.diameterM) / 20)))
    const hp = Math.ceil(2 + Math.sqrt(a.diameterM) / 3)
    const v = this.aimAtEarth(p.x, p.y, 26 + Math.min(30, a.speedKms) * 2.1, 0.08)
    this.rocks.push({ kind: 'real', x: p.x, y: p.y, ...v, r, hp, maxHp: hp, points: SCORE.real(a.diameterM), shape: makeShape(13), rot: 0, spin: rand(-0.8, 0.8), flash: 0, real: a })
    this.texts.push({ x: this.w / 2, y: 70, text: `INBOUND: ${a.name}`, life: 2.4, color: a.hazardous ? '#f87171' : '#fbbf24' })
    this.sfx.alarm()
  }

  private spawnBoss(a?: Asteroid): void {
    const p = this.edgePoint()
    const hp = 380
    const v = this.aimAtEarth(p.x, p.y, 15, 0)
    this.rocks.push({ kind: 'boss', x: p.x, y: p.y, ...v, r: 58, hp, maxHp: hp, points: SCORE.boss, shape: makeShape(18), rot: 0, spin: 0.25, flash: 0, real: a, spawnTimer: 3 })
    this.texts.push({ x: this.w / 2, y: 70, text: a ? `BOSS: ${a.name}` : 'BOSS INBOUND', life: 3, color: '#f87171' })
    this.sfx.alarm()
  }

  private dropCapsule(x: number, y: number): void {
    const kinds: PowerKind[] = ['overdrive', 'freeze', 'surge']
    const kind = kinds[Math.floor(Math.random() * kinds.length)]
    // Drift away from Earth so you have to go get it.
    const a = Math.atan2(y - this.h / 2, x - this.w / 2) + rand(-0.6, 0.6)
    this.capsules.push({ x, y, vx: Math.cos(a) * 22, vy: Math.sin(a) * 22, kind, life: 9 })
  }

  private activatePower(kind: PowerKind, x: number, y: number): void {
    this.stats.powerups++
    this.sfx.waveClear()
    this.boom(x, y, POWER_COLORS[kind], 24, 1)
    this.texts.push({ x, y: y - 16, text: POWER_LABEL[kind], life: 1.4, color: POWER_COLORS[kind], big: true })
    if (kind === 'surge') {
      this.shield = this.shieldMax
      this.earthHp = Math.min(EARTH_MAX, this.earthHp + 10)
    } else {
      this.powers[kind] = POWER_SECONDS[kind]
    }
  }

  // ─── damage ──────────────────────────────────────────────────────────────

  private damageRock(r: Rock, dmg: number): void {
    if (r.hp <= 0) return
    r.hp -= dmg
    r.flash = 1
    this.sfx.hit()
    if (r.hp > 0) return

    this.stats.kills++
    this.combo++
    this.comboTimer = COMBO_WINDOW
    this.stats.maxCombo = Math.max(this.stats.maxCombo, this.combo)
    const mult = this.multiplier
    const gained = r.points * mult
    this.score += gained
    this.credits += Math.round(r.points * 0.6)
    if (this.combo > 0 && this.combo % 5 === 0 && mult > 1) {
      this.texts.push({ x: this.w / 2, y: this.h / 2 - this.orbitR - 30, text: `×${mult} COMBO`, life: 1.1, color: '#fbbf24', big: true })
    }

    const big = r.kind === 'real' || r.kind === 'boss' || r.r > 12
    const color = r.kind === 'boss' ? '#f87171' : r.kind === 'real' ? '#fbbf24' : r.kind === 'comet' ? '#bae6fd' : r.kind === 'armored' ? '#cbd5e1' : '#d6d3d1'
    this.boom(r.x, r.y, color, big ? 40 : 12, big ? 1.4 : 0.8)
    this.sfx.explode(big)
    if (big) {
      this.shake = Math.max(this.shake, r.kind === 'boss' ? 22 : 6)
      this.hitstop = r.kind === 'boss' ? 0.18 : 0.05
    }
    this.texts.push({ x: r.x, y: r.y - r.r, text: mult > 1 ? `+${gained} ×${mult}` : `+${gained}`, life: 0.9, color: r.kind === 'real' ? '#fbbf24' : '#e7e5e4' })

    if (r.kind === 'comet') this.stats.comets++
    if (r.kind === 'splitter') this.spawnDebrisAt(r.x, r.y, 3)
    if (r.kind === 'real' && r.real && r.real.diameterM > 120) this.spawnDebrisAt(r.x, r.y, 3)

    // Power-up drops: most real asteroids, plus a steady trickle from everything else.
    this.killsSinceDrop++
    if (r.kind === 'real' ? Math.random() < 0.7 : this.killsSinceDrop >= 22) {
      this.killsSinceDrop = 0
      this.dropCapsule(r.x, r.y)
    }
    if (r.real) this.cb.onRealKill(r.real, gained, r.kind === 'boss')
  }

  private hitEarth(dmg: number, x: number, y: number): void {
    this.sinceHit = 0
    this.waveHits++
    if (this.combo >= 5) this.texts.push({ x: this.w / 2, y: this.h / 2 - this.orbitR - 30, text: 'COMBO BROKEN', life: 1.1, color: '#f87171', big: true })
    this.combo = 0
    const absorbed = Math.min(this.shield, dmg)
    this.shield -= absorbed
    this.earthHp = Math.max(0, this.earthHp - (dmg - absorbed))
    this.shake = Math.max(this.shake, 8 + dmg * 0.2)
    this.boom(x, y, absorbed >= dmg ? '#67e8f9' : '#fb923c', 18, 1)
    this.sfx.earthHit()
  }

  private spark(x: number, y: number, color: string): void {
    for (let i = 0; i < 4; i++) {
      const a = rand(0, TAU)
      this.particles.push({ x, y, vx: Math.cos(a) * rand(80, 200), vy: Math.sin(a) * rand(80, 200), life: 0.18, max: 0.18, color, size: 1.5 })
    }
  }

  private boom(x: number, y: number, color: string, n: number, scale: number): void {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU)
      const s = rand(40, 260) * scale
      const life = rand(0.3, 0.9)
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, color, size: rand(1, 3) * scale })
    }
  }

  private emitHud(): void {
    this.cb.onHud({
      score: this.score,
      credits: this.credits,
      wave: this.waveIndex + 1,
      earthHp: this.earthHp,
      shield: this.shield,
      shieldMax: this.shieldMax,
      nova: this.novaCd <= 0 ? 1 : 1 - this.novaCd / this.novaCooldown(),
      event: this.activeEvent ? { kind: this.activeEvent.kind, label: this.activeEvent.label } : null,
      kills: this.stats.kills,
      combo: this.combo,
      multiplier: this.multiplier,
      maxCombo: this.stats.maxCombo,
      powers: { ...this.powers },
    })
  }

  // ─── rendering ───────────────────────────────────────────────────────────

  private draw(): void {
    const { ctx, w, h } = this
    const cx = w / 2
    const cy = h / 2
    ctx.save()
    ctx.fillStyle = '#04050b'
    ctx.fillRect(0, 0, w, h)
    if (this.shake > 0) ctx.translate(rand(-1, 1) * this.shake, rand(-1, 1) * this.shake)

    // stars
    for (const s of this.stars) {
      ctx.globalAlpha = 0.25 + s.z * 0.6
      ctx.fillStyle = '#e2e8f0'
      ctx.fillRect(s.x * w, s.y * h, s.z * 1.6, s.z * 1.6)
    }
    ctx.globalAlpha = 1

    // freeze tint
    if (this.powers.freeze) {
      ctx.fillStyle = 'rgba(147,197,253,0.06)'
      ctx.fillRect(0, 0, w, h)
    }

    // orbit path
    ctx.strokeStyle = 'rgba(148,163,184,0.12)'
    ctx.setLineDash([3, 7])
    ctx.beginPath()
    ctx.arc(cx, cy, this.orbitR, 0, TAU)
    ctx.stroke()
    ctx.setLineDash([])

    this.drawEarth(cx, cy)
    for (const r of this.rocks) this.drawRock(r)
    for (const c of this.capsules) this.drawCapsule(c)

    // bullets
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = this.powers.overdrive ? '#fdba74' : '#a5f3fc'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (const b of this.bullets) {
      ctx.moveTo(b.x, b.y)
      ctx.lineTo(b.x - b.vx * 0.02, b.y - b.vy * 0.02)
    }
    ctx.stroke()

    // particles
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max)
      if (p.streak) {
        ctx.strokeStyle = p.color
        ctx.lineWidth = p.size
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(p.x - p.vx * 0.06, p.y - p.vy * 0.06)
        ctx.stroke()
      } else {
        ctx.fillStyle = p.color
        ctx.fillRect(p.x, p.y, p.size, p.size)
      }
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'

    this.drawShip(cx, cy)

    // floating text
    ctx.textAlign = 'center'
    for (const t of this.texts) {
      ctx.globalAlpha = Math.min(1, t.life * 2)
      ctx.fillStyle = t.color
      ctx.font = t.big ? '700 20px "Space Grotesk", Inter, sans-serif' : t.text.startsWith('+') ? '600 12px Inter, sans-serif' : '700 15px "Space Grotesk", Inter, sans-serif'
      ctx.fillText(t.text, t.x, t.y)
    }
    ctx.globalAlpha = 1
    ctx.restore()

    // flare whiteout
    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255, 237, 200, ${this.flash})`
      ctx.fillRect(0, 0, w, h)
    }
  }

  private drawEarth(cx: number, cy: number): void {
    const { ctx } = this
    const R = this.earthR
    const glow = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.7)
    glow.addColorStop(0, 'rgba(56,189,248,0.35)')
    glow.addColorStop(1, 'rgba(56,189,248,0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(cx, cy, R * 1.7, 0, TAU)
    ctx.fill()

    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, TAU)
    ctx.clip()
    const ocean = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R)
    ocean.addColorStop(0, '#3b82f6')
    ocean.addColorStop(1, '#1e3a8a')
    ctx.fillStyle = ocean
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2)
    ctx.fillStyle = 'rgba(74, 222, 128, 0.75)'
    const blobs = [[0, -0.3, 0.45, 0.28], [1.6, 0.25, 0.35, 0.22], [3.1, -0.05, 0.5, 0.3], [4.4, 0.45, 0.3, 0.18]]
    for (const [off, lat, rw, rh] of blobs) {
      const x = cx + Math.sin(this.earthSpin + off) * R * 1.1
      ctx.beginPath()
      ctx.ellipse(x, cy + lat * R, rw * R, rh * R, 0.3, 0, TAU)
      ctx.fill()
    }
    const shade = ctx.createLinearGradient(cx - R, cy, cx + R, cy)
    shade.addColorStop(0.55, 'rgba(0,0,0,0)')
    shade.addColorStop(1, 'rgba(0,0,0,0.55)')
    ctx.fillStyle = shade
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2)
    ctx.restore()

    if (this.earthHp < 50) {
      ctx.fillStyle = `rgba(239,68,68,${(1 - this.earthHp / 50) * 0.35})`
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, TAU)
      ctx.fill()
    }

    const frac = this.shield / this.shieldMax
    if (frac > 0.01) {
      const flicker = this.activeEvent?.kind === 'flare' ? (Math.random() < 0.3 ? 0.2 : 1) : 1
      ctx.strokeStyle = `rgba(103,232,249,${(0.15 + frac * 0.55) * flicker})`
      ctx.lineWidth = 2 + frac * 2
      ctx.beginPath()
      ctx.arc(cx, cy, R + 10, 0, TAU)
      ctx.stroke()
    }
  }

  private drawShip(cx: number, cy: number): void {
    const { ctx } = this
    // tiny recoil toward Earth when firing
    const rad = this.orbitR - this.muzzle * 2
    const x = cx + Math.cos(this.angle) * rad
    const y = cy + Math.sin(this.angle) * rad
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(this.angle)
    // aim line
    ctx.strokeStyle = this.powers.overdrive ? 'rgba(251,146,60,0.3)' : 'rgba(251,191,36,0.18)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(14, 0)
    ctx.lineTo(200, 0)
    ctx.stroke()
    ctx.globalCompositeOperation = 'lighter'
    // engine glow
    ctx.fillStyle = 'rgba(251,146,60,0.7)'
    ctx.beginPath()
    ctx.arc(-9, 0, 4 + Math.random() * 2, 0, TAU)
    ctx.fill()
    // muzzle flash
    if (this.muzzle > 0) {
      ctx.fillStyle = `rgba(254,240,138,${this.muzzle * 0.9})`
      ctx.beginPath()
      ctx.arc(17, 0, 3 + this.muzzle * 4, 0, TAU)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = this.powers.overdrive ? '#fb923c' : '#fbbf24'
    ctx.strokeStyle = '#fff7ed'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.moveTo(14, 0)
    ctx.lineTo(-8, -9)
    ctx.lineTo(-4, 0)
    ctx.lineTo(-8, 9)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  private drawCapsule(c: Capsule): void {
    const { ctx } = this
    const pulse = 1 + Math.sin(performance.now() / 120) * 0.15
    const color = POWER_COLORS[c.kind]
    ctx.save()
    ctx.translate(c.x, c.y)
    ctx.globalAlpha = c.life < 2 ? (Math.sin(performance.now() / 60) > 0 ? 1 : 0.3) : 1
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(0, 0, 11 * pulse, 0, TAU)
    ctx.stroke()
    ctx.fillStyle = color
    ctx.globalAlpha *= 0.25
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.fillStyle = color
    ctx.font = '700 11px Inter, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(c.kind === 'overdrive' ? 'O' : c.kind === 'freeze' ? 'F' : 'S', 0, 0.5)
    ctx.restore()
  }

  private drawRock(r: Rock): void {
    const { ctx } = this
    ctx.save()
    ctx.translate(r.x, r.y)
    ctx.rotate(r.rot)
    ctx.beginPath()
    r.shape.forEach((m, i) => {
      const a = (i / r.shape.length) * TAU
      const px = Math.cos(a) * r.r * m
      const py = Math.sin(a) * r.r * m
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    })
    ctx.closePath()
    const hazard = r.kind === 'boss' || r.real?.hazardous
    const fill = r.flash > 0 ? '#fef3c7'
      : r.kind === 'real' || r.kind === 'boss' ? '#57483a'
      : r.kind === 'armored' ? '#475569'
      : r.kind === 'splitter' ? '#5b3a29'
      : r.kind === 'comet' ? '#e0f2fe'
      : '#3f3b38'
    ctx.fillStyle = fill
    ctx.fill()
    // Glow as a wide translucent stroke: shadowBlur is one of the most expensive
    // canvas ops and tanked frame rate on software-rendered (GPU-less) browsers.
    if (hazard) {
      ctx.lineWidth = r.kind === 'boss' ? 10 : 6
      ctx.strokeStyle = 'rgba(239,68,68,0.25)'
      ctx.stroke()
    }
    ctx.lineWidth = r.kind === 'real' || r.kind === 'armored' ? 2 : 1
    ctx.strokeStyle = hazard ? '#f87171'
      : r.kind === 'real' ? '#fbbf24'
      : r.kind === 'armored' ? '#e2e8f0'
      : r.kind === 'splitter' ? '#fb923c'
      : r.kind === 'comet' ? '#7dd3fc'
      : '#a8a29e'
    ctx.stroke()
    // splitter crack
    if (r.kind === 'splitter') {
      ctx.strokeStyle = 'rgba(251,146,60,0.8)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(-r.r * 0.6, -r.r * 0.2)
      ctx.lineTo(0, r.r * 0.1)
      ctx.lineTo(r.r * 0.5, -r.r * 0.4)
      ctx.stroke()
    }
    ctx.restore()

    if (r.real) {
      ctx.textAlign = 'center'
      ctx.font = '600 11px Inter, sans-serif'
      ctx.fillStyle = hazard ? '#fca5a5' : '#fde68a'
      ctx.fillText(r.real.name, r.x, r.y - r.r - 16)
      ctx.font = '10px Inter, sans-serif'
      ctx.fillStyle = 'rgba(226,232,240,0.75)'
      ctx.fillText(`${r.real.diameterM} m · ${r.real.speedKms} km/s`, r.x, r.y - r.r - 4)
    }
    if (r.real || r.maxHp > 2) {
      const wBar = Math.max(20, r.r * 1.6)
      ctx.fillStyle = 'rgba(255,255,255,0.12)'
      ctx.fillRect(r.x - wBar / 2, r.y + r.r + 6, wBar, 3)
      ctx.fillStyle = r.kind === 'boss' ? '#f87171' : r.kind === 'armored' ? '#e2e8f0' : '#fbbf24'
      ctx.fillRect(r.x - wBar / 2, r.y + r.r + 6, wBar * Math.max(0, r.hp / r.maxHp), 3)
    }
  }
}
