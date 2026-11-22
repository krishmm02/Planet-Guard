import { useEffect, useState } from 'react'
import { AlertTriangle, BookOpen, ExternalLink, Flame, Rocket, ShieldAlert, Snowflake, Sun, Wind, Wrench, X, Zap } from 'lucide-react'
import type { Asteroid, DailySky } from '../sky'
import { WAVE_COUNT } from '../sky'
import type { Hud, PowerKind, Upgrades } from '../engine'
import { REPAIR, UPGRADES, upgradeCost } from '../upgrades'
import { rankFor, streak, todayProgress, type Logbook } from '../logbook'
import { Leaderboard } from './Leaderboard'
import { cn } from '@/lib/utils'

/** Typewriter for mission-control lines. */
function useTyped(text: string, speed = 18): string {
  const [n, setN] = useState(0)
  useEffect(() => {
    setN(0)
    const t = setInterval(() => setN((v) => (v >= text.length ? v : v + 2)), speed)
    return () => clearInterval(t)
  }, [text, speed])
  return text.slice(0, n)
}

export function skyAsteroidIds(sky: DailySky): string[] {
  return sky.waves.flatMap((w) => [...w.headliners, ...(w.boss ? [w.boss] : [])])
}

function AsteroidCard({ a, boss, isNew }: { a: Asteroid; boss?: boolean; isNew?: boolean }) {
  return (
    <div className={cn('rounded-lg border bg-secondary/60 p-3', a.hazardous || boss ? 'border-hazard/50' : 'border-border')}>
      <div className="flex items-start justify-between gap-2">
        <p className="font-display font-bold leading-tight">{a.name}</p>
        <span className="flex shrink-0 gap-1">
          {isNew && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">New</span>}
          {(a.hazardous || boss) && (
            <span className="rounded bg-hazard/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-hazard">{boss ? 'Boss' : 'Hazardous'}</span>
          )}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div><dt className="text-muted-foreground">Size</dt><dd className="font-semibold">{a.diameterM} m</dd></div>
        <div><dt className="text-muted-foreground">Speed</dt><dd className="font-semibold">{a.speedKms} km/s</dd></div>
        <div><dt className="text-muted-foreground">Closest</dt><dd className="font-semibold">{a.missLunar} LD</dd></div>
      </dl>
      <p className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Real flyby: {a.approachDate}</span>
        {a.jplUrl && (
          <a href={a.jplUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-primary">
            NASA JPL <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </p>
    </div>
  )
}

// ─── Pilot card + logbook ───────────────────────────────────────────────────

export function PilotCard({ book, sky, onOpenLog }: { book: Logbook; sky: DailySky | null; onOpenLog: () => void }) {
  const rank = rankFor(book.xp)
  const s = streak(book)
  const ids = sky ? skyAsteroidIds(sky) : []
  const got = sky ? todayProgress(book, ids) : 0
  return (
    <div className="rounded-xl border border-border bg-card/80 p-4" data-testid="pilot-card">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Pilot rank</p>
          <p className="font-display text-xl font-bold">{rank.title}</p>
        </div>
        {s > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2.5 py-1 text-xs font-semibold text-primary" title="Days in a row">
            <Flame className="h-3.5 w-3.5" /> {s}-day streak
          </span>
        )}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(rank.progress * 100)}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {rank.next ? `${book.xp} / ${rank.next.xp} XP to ${rank.next.title}` : `${book.xp} XP · max rank`}
      </p>
      {sky && (
        <div className="mt-3">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Today&rsquo;s real asteroids collected</span>
            <span className="font-semibold tabular-nums" data-testid="today-progress">{got}/{ids.length}</span>
          </div>
          <div className="mt-1 flex gap-0.5">
            {ids.map((id) => (
              <span key={id} className={cn('h-1.5 flex-1 rounded-sm', book.collected[id] ? 'bg-shield' : 'bg-secondary')} />
            ))}
          </div>
        </div>
      )}
      <button type="button" onClick={onOpenLog} className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-shield hover:underline" data-testid="open-logbook">
        <BookOpen className="h-3.5 w-3.5" /> Logbook · {Object.keys(book.collected).length} asteroids
      </button>
    </div>
  )
}

export function LogbookModal({ book, onClose }: { book: Logbook; onClose: () => void }) {
  const entries = Object.entries(book.collected).sort((a, b) => b[1].day.localeCompare(a[1].day) || b[1].diameterM - a[1].diameterM)
  return (
    <div className="absolute inset-0 z-20 flex items-end justify-center bg-black/70 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="logbook-title">
      <div className="glass rise flex max-h-[88vh] w-full max-w-2xl flex-col rounded-t-xl border border-border sm:rounded-xl">
        <div className="flex items-start justify-between border-b border-border p-5">
          <div>
            <h2 id="logbook-title" className="font-display text-2xl font-bold">Pilot Logbook</h2>
            <p className="text-sm text-muted-foreground">
              Every real NASA asteroid you&rsquo;ve stopped. {book.runs} runs · {book.wins} skies cleared · best {book.bestScore.toLocaleString()} · best combo {book.bestCombo}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close logbook">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto p-5">
          {entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Empty for now. Destroy a named asteroid to log it. Every day brings new ones.</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {entries.map(([id, e]) => (
                <li key={id} className={cn('rounded-lg border bg-secondary/50 p-3', e.boss ? 'border-hazard/60' : e.hazardous ? 'border-hazard/30' : 'border-border')}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-display font-bold leading-tight">{e.name}</p>
                    {e.boss && <span className="rounded bg-hazard/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-hazard">Boss</span>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {e.diameterM} m · {e.speedKms} km/s · logged {e.day}
                    {e.jplUrl && (
                      <a href={e.jplUrl} target="_blank" rel="noreferrer" className="ml-1 hover:text-primary">· JPL ↗</a>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Title ──────────────────────────────────────────────────────────────────

export function TitleScreen({ sky, book, onLaunch, onOpenLog }: { sky: DailySky | null; book: Logbook; onLaunch: () => void; onOpenLog: () => void }) {
  const boss = sky?.waves.at(-1)?.boss ? sky.asteroids.find((a) => a.id === sky.waves.at(-1)!.boss) : undefined
  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto grid min-h-full max-w-5xl items-center gap-6 px-4 py-8 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="rise">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-shield">
            {sky ? (sky.live ? `Live from NASA · ${sky.day}` : `Training sky · ${sky.day}`) : 'Contacting NASA…'}
          </p>
          <h1 className="mt-3 font-display text-5xl font-bold leading-[0.95] sm:text-7xl">
            Planet <span className="text-primary">Guard</span>
          </h1>
          <p className="mt-4 max-w-md text-base text-muted-foreground">
            Orbit Earth and shoot down <strong className="text-foreground">this week&rsquo;s real asteroids</strong>, pulled live
            from NASA. Chain kills for up to ×8, collect every real rock in your logbook, and climb today&rsquo;s board.
          </p>

          {sky && (
            <div className="mt-5 grid max-w-md grid-cols-3 gap-2 text-center" data-testid="sky-stats">
              <div className="rounded-lg border border-border bg-card/70 p-3">
                <p className="font-display text-2xl font-bold">{sky.live ? sky.trackedCount : '—'}</p>
                <p className="text-[11px] text-muted-foreground">objects NASA is tracking</p>
              </div>
              <div className="rounded-lg border border-border bg-card/70 p-3">
                <p className="font-display text-2xl font-bold">{sky.events.length}</p>
                <p className="text-[11px] text-muted-foreground">solar storms this run</p>
              </div>
              <div className="rounded-lg border border-hazard/40 bg-card/70 p-3">
                <p className="truncate font-display text-sm font-bold text-hazard">{boss?.name ?? '???'}</p>
                <p className="text-[11px] text-muted-foreground">today&rsquo;s boss{boss ? ` · ${boss.diameterM} m` : ''}</p>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={onLaunch}
            disabled={!sky}
            data-testid="launch"
            className="pulse-ring mt-7 inline-flex items-center gap-3 rounded-xl bg-primary px-8 py-4 font-display text-2xl font-bold text-primary-foreground transition-transform hover:-translate-y-0.5 disabled:opacity-50"
          >
            <Rocket className="h-6 w-6" /> Launch
          </button>
          <p className="mt-4 text-xs text-muted-foreground">
            <kbd className="rounded border border-border px-1">Mouse</kbd> / drag to aim · auto-fire ·{' '}
            <kbd className="rounded border border-border px-1">Space</kbd> or right-click for Nova · shoot glowing capsules for power-ups
          </p>
        </div>
        <div className="rise space-y-3" style={{ animationDelay: '100ms' }}>
          <PilotCard book={book} sky={sky} onOpenLog={onOpenLog} />
          <Leaderboard compact />
        </div>
      </div>
    </div>
  )
}

// ─── Between waves: briefing + shop ─────────────────────────────────────────

export function BriefingScreen({
  sky,
  waveIndex,
  hud,
  upgrades,
  book,
  lastPerfect,
  onBuy,
  onRepair,
  onLaunch,
  voiceOn,
}: {
  sky: DailySky
  waveIndex: number
  hud: Hud
  upgrades: Upgrades
  book: Logbook
  lastPerfect: boolean
  onBuy: (key: keyof Upgrades, cost: number) => void
  onRepair: () => void
  onLaunch: () => void
  voiceOn: boolean
}) {
  const plan = sky.waves[waveIndex]
  const text = sky.briefings[waveIndex] ?? ''
  const typed = useTyped(text)
  const rocks = [...plan.headliners, ...(plan.boss ? [plan.boss] : [])]
    .map((id) => sky.asteroids.find((a) => a.id === id))
    .filter((a): a is Asteroid => !!a)
  const ev = plan.event !== undefined ? sky.events[plan.event] : undefined
  const isBoss = waveIndex === WAVE_COUNT - 1
  // Nothing to buy before the first wave, so don't show an all-disabled shop.
  const showShop = waveIndex > 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') onLaunch()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onLaunch])

  return (
    <div className="absolute inset-0 overflow-y-auto bg-black/40" data-testid="briefing">
      <div className={cn('mx-auto grid gap-4 px-4 py-6', showShop ? 'max-w-5xl md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]' : 'max-w-xl')}>
        <section className="glass rise rounded-xl border border-border p-5">
          {waveIndex > 0 && (
            <p className={cn('mb-3 rounded-lg px-3 py-2 text-sm', lastPerfect ? 'bg-shield/15 text-shield' : 'bg-secondary text-muted-foreground')}>
              {lastPerfect ? `Perfect wave ${waveIndex}: nothing touched Earth. Clear bonus doubled.` : `Wave ${waveIndex} cleared. Score ${hud.score.toLocaleString()} · best combo ${hud.maxCombo}.`}
            </p>
          )}
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-shield">
            <span className="h-2 w-2 rounded-full bg-shield blink" /> Mission control {voiceOn ? '· on air' : ''}
          </p>
          <h2 className={cn('mt-2 font-display text-3xl font-bold', isBoss && 'text-hazard')}>
            {isBoss ? 'Final wave' : `Wave ${waveIndex + 1}`} <span className="text-muted-foreground">/ {WAVE_COUNT}</span>
          </h2>
          <p className="mt-3 min-h-[4.5rem] text-[15px] leading-relaxed text-foreground/90">{typed}</p>

          {ev && (
            <div className="mt-3 flex items-center gap-3 rounded-lg border border-hazard/40 bg-hazard/10 p-3 text-sm">
              {ev.kind === 'flare' ? <Sun className="h-5 w-5 shrink-0 text-hazard" /> : <Wind className="h-5 w-5 shrink-0 text-fuchsia-400" />}
              <div>
                <p className="font-semibold">Space weather: {ev.label}</p>
                <p className="text-xs text-muted-foreground">
                  Real event, observed {ev.date}. {ev.kind === 'flare' ? 'Shields stop recharging and your aim gets sluggish.' : 'A plasma wave shoves everything sideways.'}
                  {ev.link && (
                    <a href={ev.link} target="_blank" rel="noreferrer" className="ml-1 underline hover:text-primary">NASA DONKI</a>
                  )}
                </p>
              </div>
            </div>
          )}

          {rocks.length > 0 && (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {rocks.map((a) => <AsteroidCard key={a.id} a={a} boss={a.id === plan.boss} isNew={!book.collected[a.id]} />)}
            </div>
          )}

          <button
            type="button"
            onClick={onLaunch}
            data-testid="launch-wave"
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 font-display text-xl font-bold text-primary-foreground transition-transform hover:-translate-y-0.5"
          >
            <Rocket className="h-5 w-5" /> Launch wave {waveIndex + 1}
            <span className="ml-2 text-xs font-normal opacity-60">Enter</span>
          </button>
        </section>

        {showShop && (
          <section className="glass rise rounded-xl border border-border p-5" style={{ animationDelay: '80ms' }} data-testid="shop">
            <div className="flex items-center justify-between">
              <p className="font-display text-lg font-bold">Hangar</p>
              <p className="font-display text-lg font-bold text-primary tabular-nums" data-testid="credits">
                {hud.credits.toLocaleString()} cr
              </p>
            </div>
            <div className="mt-3 space-y-2">
              {UPGRADES.map((u) => {
                const level = upgrades[u.key]
                const maxed = level >= u.max
                const cost = upgradeCost(u, level)
                const afford = hud.credits >= cost
                return (
                  <button
                    key={u.key}
                    type="button"
                    disabled={maxed || !afford}
                    onClick={() => onBuy(u.key, cost)}
                    data-testid={`buy-${u.key}`}
                    className="flex w-full items-center gap-3 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-left transition-colors enabled:hover:border-primary/60 disabled:opacity-45"
                  >
                    <Zap className="h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">{u.label}</span>
                      <span className="block text-xs text-muted-foreground">{u.blurb}</span>
                    </span>
                    <span className="flex gap-0.5">
                      {Array.from({ length: u.max }, (_, i) => (
                        <span key={i} className={cn('h-2.5 w-1.5 rounded-sm', i < level ? 'bg-primary' : 'bg-border')} />
                      ))}
                    </span>
                    <span className="w-14 text-right text-sm font-semibold tabular-nums">{maxed ? 'MAX' : cost}</span>
                  </button>
                )
              })}
              <button
                type="button"
                disabled={hud.credits < REPAIR.cost || hud.earthHp >= 100}
                onClick={onRepair}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-left transition-colors enabled:hover:border-shield/60 disabled:opacity-45"
              >
                <Wrench className="h-4 w-4 shrink-0 text-shield" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">Repair Earth</span>
                  <span className="block text-xs text-muted-foreground">+{REPAIR.amount} HP (now {Math.round(hud.earthHp)})</span>
                </span>
                <span className="w-14 text-right text-sm font-semibold tabular-nums">{REPAIR.cost}</span>
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

// ─── HUD ────────────────────────────────────────────────────────────────────

const POWER_UI: Record<Exclude<PowerKind, 'surge'>, { label: string; icon: typeof Zap; cls: string }> = {
  overdrive: { label: 'Overdrive', icon: Zap, cls: 'border-orange-400/60 text-orange-300' },
  freeze: { label: 'Time freeze', icon: Snowflake, cls: 'border-blue-300/60 text-blue-200' },
}

export function HudBar({ hud, onNova }: { hud: Hud; onNova: () => void }) {
  const hpColor = hud.earthHp > 50 ? 'bg-emerald-400' : hud.earthHp > 25 ? 'bg-primary' : 'bg-hazard'
  const comboFrac = hud.multiplier >= 8 ? 1 : (hud.combo % 5) / 5
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3" data-testid="hud">
        <div className="glass rounded-lg border border-border px-3 py-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Score</p>
          <p className="font-display text-2xl font-bold tabular-nums" data-testid="score">{hud.score.toLocaleString()}</p>
        </div>

        {/* Combo meter: the skill ceiling. */}
        <div className={cn('glass flex min-w-[80px] flex-col items-center rounded-lg border px-2 py-1.5 sm:min-w-[96px] sm:px-3 transition-colors', hud.multiplier > 1 ? 'border-primary/70' : 'border-border')} data-testid="combo">
          <p className={cn('font-display font-bold leading-none tabular-nums transition-all', hud.multiplier > 1 ? 'text-3xl text-primary' : 'text-2xl text-muted-foreground')}>
            ×{hud.multiplier}
          </p>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-secondary">
            <div className="h-full bg-primary transition-all" style={{ width: `${comboFrac * 100}%` }} />
          </div>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">{hud.combo} chain</p>
        </div>

        <div className="glass w-32 rounded-lg border border-border px-3 py-2 sm:w-56">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-muted-foreground">
            <span>Earth</span><span>Wave {hud.wave}/{WAVE_COUNT}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-secondary">
            <div className={cn('h-full transition-all', hpColor)} style={{ width: `${hud.earthHp}%` }} />
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-secondary">
            <div className="h-full bg-shield transition-all" style={{ width: `${(hud.shield / hud.shieldMax) * 100}%` }} />
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-24 flex flex-col items-center gap-2">
        {hud.event && (
          <div className="flex items-center gap-2 rounded-full border border-hazard/60 bg-hazard/20 px-4 py-1.5 text-sm font-semibold text-hazard blink">
            <AlertTriangle className="h-4 w-4" /> {hud.event.label}: {hud.event.kind === 'flare' ? 'shields offline, aim scrambled' : 'plasma wave incoming'}
          </div>
        )}
        <div className="flex gap-2">
          {(Object.keys(POWER_UI) as Array<keyof typeof POWER_UI>).map((k) => {
            const left = hud.powers[k]
            if (!left) return null
            const { label, icon: Icon, cls } = POWER_UI[k]
            return (
              <span key={k} className={cn('glass inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold', cls)}>
                <Icon className="h-3.5 w-3.5" /> {label} {left.toFixed(1)}s
              </span>
            )
          })}
        </div>
      </div>

      <button
        type="button"
        onClick={onNova}
        disabled={hud.nova < 1}
        data-testid="nova"
        className={cn(
          'absolute bottom-4 right-4 flex h-16 w-16 flex-col items-center justify-center rounded-full border-2 font-display text-xs font-bold transition-all',
          hud.nova >= 1 ? 'border-shield bg-shield/20 text-shield shadow-[0_0_24px_rgba(103,232,249,0.5)]' : 'border-border bg-card/70 text-muted-foreground',
        )}
        style={hud.nova < 1 ? { background: `conic-gradient(rgba(103,232,249,0.25) ${hud.nova * 360}deg, transparent 0)` } : undefined}
        aria-label="Nova pulse"
      >
        <ShieldAlert className="h-5 w-5" />
        NOVA
      </button>
    </>
  )
}
