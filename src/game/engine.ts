/**
 * Planet Guard game engine: a single canvas, a fixed-step-ish update loop,
 * no React, no assets. React drives it through a handful of methods
 * (startWave / nova / pause / destroy) and listens through callbacks.
 *
 * Coordinates are CSS pixels with Earth at the canvas center. The player's
 * ship orbits Earth and auto-fires outward; you aim by pointing (mouse,
 * finger) or with A/D / arrow keys. Space / right-click fires the Nova.
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
  turn: number
  nova: number
}

export const NO_UPGRADES: Upgrades = { fireRate: 0, damage: 0, spread: 0, shield: 0, turn: 0, nova: 0 }

export interface Hud {
  score: number
  credits: number
  wave: number
  earthHp: number
  shield: number
  shieldMax: number
  nova: number // 0..1 charge
  event: string | null
  kills: number
}

export interface EngineCallbacks {
  onHud: (hud: Hud) => void
  onWaveCleared: (waveIndex: number) => void
  onGameOver: (won: boolean) => void
  /** A named, real asteroid was destroyed (for the kill feed). */
  onRealKill: (a: Asteroid, points: number) => void
}

interface Rock {
  x: number; y: number; vx: number; vy: number
  r: number; hp: number; maxHp: number; points: number
  shape: number[]; rot: number; spin: number; flash: number
  real?: Asteroid; boss?: boolean; spawnTimer?: number
}
interface Bullet { x: number; y: number; vx: number; vy: number; life: number; dmg: number }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number }
interface FloatText { x: number; y: number; text: string; life: number; color: string }
interface Spawn { t: number; kind: 'debris' | 'real' | 'boss'; asteroid?: Asteroid }

const TAU = Math.PI * 2
const EARTH_MAX = 100
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
  private particles: Particle[] = []
  private texts: FloatText[] = []
  private stars: Array<{ x: number; y: number; z: number }> = []
  private spawns: Spawn[] = []
  private waveTime = 0
  private waveIndex = -1
  private waveActive = false

  // player
  private angle = -Math.PI / 2
  private targetAngle = -Math.PI / 2
  private fireCd = 0
  private novaCd = 0
  private upgrades: Upgrades = { ...NO_UPGRADES }
  private keys = new Set<string>()

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
  private score = 0
  private credits = 0
  private kills = 0
  private hudTimer = 0

  private byId: Map<string, Asteroid>

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

  startWave(index: number, upgrades: Upgrades): void {
    this.upgrades = { ...upgrades }
    this.waveIndex = index
    this.waveTime = 0
    this.waveActive = true
    this.shield = this.shieldMax
    this.bullets = []
    const plan = this.sky.waves[index]
    const isBoss = index === WAVE_COUNT - 1
    const duration = 26 + index * 3
    const debris = 10 + index * 4 + (isBoss ? 6 : 0)
    const spawns: Spawn[] = []
    for (let i = 0; i < debris; i++) spawns.push({ t: 1.2 + (i / debris) * duration + rand(-0.4, 0.4), kind: 'debris' })
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
    this.novaCd = 18 * Math.pow(0.8, this.upgrades.nova)
    this.sfx.nova()
    this.shake = Math.max(this.shake, 10)
    const R = 240
    for (const r of this.rocks) {
      const dx = r.x - this.w / 2
      const dy = r.y - this.h / 2
      const d = Math.hypot(dx, dy)
      if (d < R + r.r) {
        this.damageRock(r, r.boss ? 25 : 8)
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
    this.update(dt)
    this.draw()
    this.raf = requestAnimationFrame(this.frame)
  }

  private update(dt: number): void {
    const cx = this.w / 2
    const cy = this.h / 2
    this.earthSpin += dt * 0.15
    this.shake = Math.max(0, this.shake - dt * 30)
    this.flash = Math.max(0, this.flash - dt * 2.5)
    for (const s of this.stars) {
      s.x -= dt * 0.004 * s.z
      if (s.x < 0) s.x += 1
    }

    // aim
    const flare = this.activeEvent?.kind === 'flare'
    const turn = 5.5 * (1 + this.upgrades.turn * 0.3) * (flare ? 0.55 : 1)
    const dir = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0)
    if (dir) this.targetAngle = this.angle + dir * 0.6
    const diff = angleDiff(this.angle, this.targetAngle)
    this.angle += Math.sign(diff) * Math.min(Math.abs(diff), turn * dt)

    if (this.waveActive) this.updateWave(dt, cx, cy)

    // bullets
    for (const b of this.bullets) {
      b.x += b.vx * dt
      b.y += b.vy * dt
      b.life -= dt
    }
    this.bullets = this.bullets.filter((b) => b.life > 0)

    // rocks
    const cme = this.activeEvent?.kind === 'cme'
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
      r.x += r.vx * dt
      r.y += r.vy * dt
      r.rot += r.spin * dt
      r.flash = Math.max(0, r.flash - dt * 6)
      if (r.boss && r.spawnTimer !== undefined) {
        r.spawnTimer -= dt
        if (r.spawnTimer <= 0) {
          r.spawnTimer = 2.2
          this.spawnDebrisAt(r.x, r.y, 2)
        }
      }
    }

    // bullet ↔ rock
    for (const b of this.bullets) {
      for (const r of this.rocks) {
        if (r.hp <= 0) continue
        const dx = b.x - r.x
        const dy = b.y - r.y
        if (dx * dx + dy * dy < r.r * r.r) {
          b.life = 0
          this.damageRock(r, b.dmg)
          break
        }
      }
    }

    // rock ↔ earth (+ shield)
    const hitR = this.earthR + 10
    for (const r of this.rocks) {
      if (r.hp <= 0) continue
      if (Math.hypot(r.x - cx, r.y - cy) < hitR + r.r * 0.6) {
        r.hp = 0
        const dmg = r.boss ? 70 : r.real ? 8 + r.r * 0.4 : 4
        this.hitEarth(dmg, r.x, r.y)
      }
    }

    // cleanup
    const far = Math.hypot(this.w, this.h) / 2 + 160
    this.rocks = this.rocks.filter((r) => r.hp > 0 && Math.hypot(r.x - cx, r.y - cy) < far)

    for (const p of this.particles) {
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vx *= 0.97
      p.vy *= 0.97
      p.life -= dt
    }
    this.particles = this.particles.filter((p) => p.life > 0)
    for (const t of this.texts) {
      t.y -= 30 * dt
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

    while (this.spawns.length && this.spawns[0].t <= this.waveTime) {
      const s = this.spawns.shift()!
      if (s.kind === 'debris') this.spawnDebris()
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
      if (this.activeEvent.kind === 'cme' && Math.random() < dt * 40) {
        const len = Math.hypot(this.wind.x, this.wind.y)
        const nx = this.wind.x / len
        const ny = this.wind.y / len
        const off = rand(-1, 1) * Math.max(this.w, this.h)
        this.particles.push({ x: cx - nx * this.w + -ny * off, y: cy - ny * this.h + nx * off, vx: nx * 900, vy: ny * 900, life: 1.4, max: 1.4, color: '#e879f9', size: 1.5 })
      }
      if (this.eventLeft <= 0) this.activeEvent = null
    }

    // shield regen (a flare knocks it out)
    this.sinceHit += dt
    if (this.sinceHit > 2 && this.activeEvent?.kind !== 'flare') this.shield = Math.min(this.shieldMax, this.shield + 7 * dt)

    // firing
    this.fireCd -= dt
    if (this.fireCd <= 0) {
      this.fireCd = 0.17 * Math.pow(0.84, this.upgrades.fireRate)
      const shots = [1, 2, 3, 4, 5][this.upgrades.spread] ?? 1
      const sx = cx + Math.cos(this.angle) * this.orbitR
      const sy = cy + Math.sin(this.angle) * this.orbitR
      for (let i = 0; i < shots; i++) {
        const a = this.angle + (i - (shots - 1) / 2) * 0.085
        this.bullets.push({ x: sx, y: sy, vx: Math.cos(a) * 580, vy: Math.sin(a) * 580, life: 1.3, dmg: 1 + this.upgrades.damage })
      }
      this.sfx.shoot()
    }

    if (this.earthHp <= 0) {
      this.waveActive = false
      this.boom(cx, cy, '#60a5fa', 140, 2)
      this.shake = 24
      this.sfx.explode(true)
      this.emitHud()
      this.cb.onGameOver(false)
      return
    }

    if (!this.spawns.length && this.rocks.length === 0) {
      this.waveActive = false
      this.activeEvent = null
      const bonus = SCORE.waveClear(this.waveIndex)
      this.score += bonus
      this.credits += bonus
      this.sfx.waveClear()
      if (this.waveIndex === WAVE_COUNT - 1) {
        this.score += SCORE.victory(this.earthHp)
        this.emitHud()
        this.cb.onGameOver(true)
      } else {
        this.emitHud()
        this.cb.onWaveCleared(this.waveIndex)
      }
    }
  }

  // ─── spawning ────────────────────────────────────────────────────────────

  private edgePoint(): { x: number; y: number; a: number } {
    const a = rand(0, TAU)
    const R = Math.hypot(this.w, this.h) / 2 + 30
    return { x: this.w / 2 + Math.cos(a) * R, y: this.h / 2 + Math.sin(a) * R, a }
  }

  private aimAtEarth(x: number, y: number, speed: number, spread = 0.18): { vx: number; vy: number } {
    const a = Math.atan2(this.h / 2 - y, this.w / 2 - x) + rand(-spread, spread)
    return { vx: Math.cos(a) * speed, vy: Math.sin(a) * speed }
  }

  private spawnDebris(): void {
    const p = this.edgePoint()
    const w = this.waveIndex
    const tough = w >= 4 && Math.random() < 0.25
    const v = this.aimAtEarth(p.x, p.y, 42 + w * 4 + rand(0, 28))
    this.rocks.push({ x: p.x, y: p.y, ...v, r: tough ? rand(9, 12) : rand(5, 9), hp: tough ? 3 : 1, maxHp: tough ? 3 : 1, points: SCORE.debris * (tough ? 2 : 1), shape: makeShape(8), rot: 0, spin: rand(-2, 2), flash: 0 })
  }

  private spawnDebrisAt(x: number, y: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const v = this.aimAtEarth(x, y, rand(50, 80), 0.6)
      this.rocks.push({ x: x + rand(-10, 10), y: y + rand(-10, 10), ...v, r: rand(5, 8), hp: 1, maxHp: 1, points: SCORE.debris, shape: makeShape(8), rot: 0, spin: rand(-3, 3), flash: 0 })
    }
  }

  private spawnReal(a: Asteroid): void {
    const p = this.edgePoint()
    const r = Math.max(14, Math.min(40, 14 + 9 * Math.log10(Math.max(20, a.diameterM) / 20)))
    const hp = Math.ceil(2 + Math.sqrt(a.diameterM) / 3)
    const v = this.aimAtEarth(p.x, p.y, 26 + Math.min(30, a.speedKms) * 2.1, 0.08)
    this.rocks.push({ x: p.x, y: p.y, ...v, r, hp, maxHp: hp, points: SCORE.real(a.diameterM), shape: makeShape(13), rot: 0, spin: rand(-0.8, 0.8), flash: 0, real: a })
    this.texts.push({ x: this.w / 2, y: 70, text: `INBOUND: ${a.name}`, life: 2.4, color: a.hazardous ? '#f87171' : '#fbbf24' })
    this.sfx.alarm()
  }

  private spawnBoss(a?: Asteroid): void {
    const p = this.edgePoint()
    const hp = 160
    const v = this.aimAtEarth(p.x, p.y, 15, 0)
    this.rocks.push({ x: p.x, y: p.y, ...v, r: 58, hp, maxHp: hp, points: SCORE.boss, shape: makeShape(18), rot: 0, spin: 0.25, flash: 0, real: a, boss: true, spawnTimer: 3 })
    this.texts.push({ x: this.w / 2, y: 70, text: a ? `BOSS: ${a.name}` : 'BOSS INBOUND', life: 3, color: '#f87171' })
    this.sfx.alarm()
  }

  // ─── damage ──────────────────────────────────────────────────────────────

  private damageRock(r: Rock, dmg: number): void {
    if (r.hp <= 0) return
    r.hp -= dmg
    r.flash = 1
    this.sfx.hit()
    if (r.hp > 0) return
    this.kills++
    this.score += r.points
    this.credits += r.points
    const big = !!r.real || r.r > 12
    this.boom(r.x, r.y, r.boss ? '#f87171' : r.real ? '#fbbf24' : '#d6d3d1', big ? 40 : 10, big ? 1.4 : 0.8)
    this.sfx.explode(big)
    if (big) this.shake = Math.max(this.shake, r.boss ? 22 : 6)
    this.texts.push({ x: r.x, y: r.y - r.r, text: `+${r.points}`, life: 0.9, color: r.real ? '#fbbf24' : '#e7e5e4' })
    if (r.real && !r.boss && r.real.diameterM > 120) this.spawnDebrisAt(r.x, r.y, 3)
    if (r.real) this.cb.onRealKill(r.real, r.points)
  }

  private hitEarth(dmg: number, x: number, y: number): void {
    this.sinceHit = 0
    const absorbed = Math.min(this.shield, dmg)
    this.shield -= absorbed
    this.earthHp = Math.max(0, this.earthHp - (dmg - absorbed))
    this.shake = Math.max(this.shake, 8 + dmg * 0.2)
    this.boom(x, y, absorbed >= dmg ? '#67e8f9' : '#fb923c', 18, 1)
    this.sfx.earthHit()
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
      nova: this.novaCd <= 0 ? 1 : 1 - this.novaCd / (18 * Math.pow(0.8, this.upgrades.nova)),
      event: this.activeEvent?.label ?? null,
      kills: this.kills,
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

    // orbit path
    ctx.strokeStyle = 'rgba(148,163,184,0.12)'
    ctx.setLineDash([3, 7])
    ctx.beginPath()
    ctx.arc(cx, cy, this.orbitR, 0, TAU)
    ctx.stroke()
    ctx.setLineDash([])

    this.drawEarth(cx, cy)

    // rocks
    for (const r of this.rocks) this.drawRock(r)

    // bullets
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = '#a5f3fc'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (const b of this.bullets) {
      ctx.moveTo(b.x, b.y)
      ctx.lineTo(b.x - b.vx * 0.018, b.y - b.vy * 0.018)
    }
    ctx.stroke()

    // particles
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max)
      ctx.fillStyle = p.color
      ctx.fillRect(p.x, p.y, p.size, p.size)
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'

    this.drawShip(cx, cy)

    // floating text
    ctx.textAlign = 'center'
    for (const t of this.texts) {
      ctx.globalAlpha = Math.min(1, t.life * 2)
      ctx.fillStyle = t.color
      ctx.font = t.text.startsWith('+') ? '600 12px Inter, sans-serif' : '700 15px "Space Grotesk", Inter, sans-serif'
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
    // drifting continents
    ctx.fillStyle = 'rgba(74, 222, 128, 0.75)'
    const blobs = [[0, -0.3, 0.45, 0.28], [1.6, 0.25, 0.35, 0.22], [3.1, -0.05, 0.5, 0.3], [4.4, 0.45, 0.3, 0.18]]
    for (const [off, lat, rw, rh] of blobs) {
      const x = cx + Math.sin(this.earthSpin + off) * R * 1.1
      ctx.beginPath()
      ctx.ellipse(x, cy + lat * R, rw * R, rh * R, 0.3, 0, TAU)
      ctx.fill()
    }
    // terminator shadow
    const shade = ctx.createLinearGradient(cx - R, cy, cx + R, cy)
    shade.addColorStop(0.55, 'rgba(0,0,0,0)')
    shade.addColorStop(1, 'rgba(0,0,0,0.55)')
    ctx.fillStyle = shade
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2)
    ctx.restore()

    // damage tint
    if (this.earthHp < 50) {
      ctx.fillStyle = `rgba(239,68,68,${(1 - this.earthHp / 50) * 0.35})`
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, TAU)
      ctx.fill()
    }

    // shield
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
    const x = cx + Math.cos(this.angle) * this.orbitR
    const y = cy + Math.sin(this.angle) * this.orbitR
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(this.angle)
    // aim line
    ctx.strokeStyle = 'rgba(251,191,36,0.18)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(14, 0)
    ctx.lineTo(160, 0)
    ctx.stroke()
    // engine glow
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = 'rgba(251,146,60,0.7)'
    ctx.beginPath()
    ctx.arc(-9, 0, 4 + Math.random() * 2, 0, TAU)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
    // hull
    ctx.fillStyle = '#fbbf24'
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
    const hazard = r.boss || r.real?.hazardous
    ctx.fillStyle = r.flash > 0 ? '#fef3c7' : r.real ? '#57483a' : '#3f3b38'
    ctx.fill()
    ctx.lineWidth = r.real ? 2 : 1
    ctx.strokeStyle = hazard ? '#f87171' : r.real ? '#fbbf24' : '#a8a29e'
    if (hazard) {
      ctx.shadowColor = '#ef4444'
      ctx.shadowBlur = r.boss ? 24 : 12
    }
    ctx.stroke()
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
    if (r.real || r.maxHp > 3) {
      const wBar = Math.max(24, r.r * 1.6)
      ctx.fillStyle = 'rgba(255,255,255,0.12)'
      ctx.fillRect(r.x - wBar / 2, r.y + r.r + 6, wBar, 3)
      ctx.fillStyle = r.boss ? '#f87171' : '#fbbf24'
      ctx.fillRect(r.x - wBar / 2, r.y + r.r + 6, wBar * Math.max(0, r.hp / r.maxHp), 3)
    }
  }
}
