/**
 * /play — the game. Deliberately NOT behind sign-in: anyone can play within a
 * second. Signing in is only needed to post a score to the daily leaderboard.
 *
 * Flow: title → (briefing+shop → wave) × 8 → game over. The engine lives for
 * one run; React owns the screens, upgrades and the mission-control audio.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { GameEngine, NO_UPGRADES, type Hud, type RunStats, type Upgrades } from '../../game/engine'
import { Sfx } from '../../game/sfx'
import type { Asteroid, DailySky } from '../../game/sky'
import { REPAIR } from '../../game/upgrades'
import { BriefingScreen, HudBar, LogbookModal, TitleScreen } from '../../game/ui/Screens'
import { emptyLogbook, loadLogbook, recordRun, type Logbook, type RunReport } from '../../game/logbook'
import { GameOver } from '../../game/ui/GameOver'

type Phase = 'title' | 'briefing' | 'playing' | 'over'

const EMPTY_HUD: Hud = { score: 0, credits: 0, wave: 1, earthHp: 100, shield: 50, shieldMax: 50, nova: 1, event: null, kills: 0, combo: 0, multiplier: 1, maxCombo: 0, powers: {} }

function readVoicePref(): boolean {
  try {
    return localStorage.getItem('pg-sound') !== 'off'
  } catch {
    return true
  }
}

export default function PlayPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<GameEngine | null>(null)
  const sfxRef = useRef(new Sfx())
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const [sky, setSky] = useState<DailySky | null>(null)
  const [skyError, setSkyError] = useState(false)
  const [phase, setPhase] = useState<Phase>('title')
  const [wave, setWave] = useState(0)
  const [hud, setHud] = useState<Hud>(EMPTY_HUD)
  const [upgrades, setUpgrades] = useState<Upgrades>(NO_UPGRADES)
  const [won, setWon] = useState(false)
  const [runToken, setRunToken] = useState<string | null>(null)
  const [realKills, setRealKills] = useState<Array<{ a: Asteroid; points: number; boss: boolean }>>([])
  const [sound, setSound] = useState(true)
  const [book, setBook] = useState<Logbook>(emptyLogbook)
  const [showLog, setShowLog] = useState(false)
  const [lastPerfect, setLastPerfect] = useState(false)
  const [stats, setStats] = useState<RunStats | null>(null)
  const [report, setReport] = useState<RunReport | null>(null)
  // The engine reports kills synchronously; keep a ref so game-over sees them all.
  const killsRef = useRef<Array<{ a: Asteroid; points: number; boss: boolean }>>([])
  const hudRef = useRef<Hud>(EMPTY_HUD)

  useEffect(() => {
    setSound(readVoicePref())
    setBook(loadLogbook())
    fetch('/api/sky')
      .then((r) => (r.ok ? (r.json() as Promise<DailySky>) : Promise.reject(new Error(String(r.status)))))
      .then((s: DailySky) => setSky(s))
      .catch(() => setSkyError(true))
  }, [])

  useEffect(() => {
    sfxRef.current.muted = !sound
    if (!sound) audioRef.current?.pause()
    try {
      localStorage.setItem('pg-sound', sound ? 'on' : 'off')
    } catch {
      /* ignore */
    }
  }, [sound])

  /** Plays a mission-control line (cached server-side; one generation per day). */
  const say = useCallback(
    (line: string) => {
      audioRef.current?.pause()
      if (!sound) return
      const el = new Audio(`/api/sky/voice/${line}`)
      audioRef.current = el
      el.play().catch(() => {
        /* voice is a bonus; the text is always on screen */
      })
    },
    [sound],
  )

  // One engine per run. It keeps rendering (stars, Earth) behind every screen.
  const createEngine = useCallback((s: DailySky) => {
    engineRef.current?.destroy()
    if (!canvasRef.current) return null
    const engine = new GameEngine(canvasRef.current, s, {
      onHud: (h) => {
        hudRef.current = h
        setHud(h)
      },
      onWaveCleared: (i, perfect) => {
        setLastPerfect(perfect)
        setWave(i + 1)
        setPhase('briefing')
      },
      onGameOver: (didWin, runStats) => {
        setWon(didWin)
        setStats(runStats)
        // Fold the run into the logbook (localStorage) and show what changed.
        const r = recordRun({
          score: hudRef.current.score,
          won: didWin,
          kills: runStats.kills,
          maxCombo: runStats.maxCombo,
          realKills: killsRef.current.map(({ a, boss }) => ({ a, boss })),
        })
        setReport(r)
        setBook(r.book)
        setPhase('over')
      },
      onRealKill: (a, points, boss) => {
        killsRef.current = [...killsRef.current, { a, points, boss }]
        setRealKills(killsRef.current)
      },
    }, sfxRef.current)
    engineRef.current = engine
    // Dev builds expose the engine for the e2e balance test (autopilot, fast-forward).
    if (import.meta.env.DEV) (window as unknown as { __pg?: GameEngine }).__pg = engine
    return engine
  }, [])

  useEffect(() => {
    if (sky && !engineRef.current) createEngine(sky)
  }, [sky, createEngine])

  useEffect(() => () => {
    engineRef.current?.destroy()
    audioRef.current?.pause()
  }, [])

  // Pause when the tab is hidden so nobody loses a run to a notification.
  useEffect(() => {
    const onVis = () => engineRef.current?.setPaused(document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // Voice the briefing / outro whenever a screen that has one appears.
  useEffect(() => {
    if (!sky) return
    if (phase === 'briefing') say(`w${wave}`)
    if (phase === 'over') say(won ? 'victory' : 'defeat')
  }, [phase, wave, won, sky, say])

  const launchRun = async () => {
    if (!sky) return
    sfxRef.current.unlock()
    createEngine(sky)
    setUpgrades(NO_UPGRADES)
    setRealKills([])
    killsRef.current = []
    hudRef.current = EMPTY_HUD
    setStats(null)
    setReport(null)
    setLastPerfect(false)
    setHud(EMPTY_HUD)
    setWave(0)
    setRunToken(null)
    setPhase('briefing')
    // Server-signed start time for leaderboard validation. A failure only
    // means this run can't be posted, never that it can't be played.
    try {
      const r = await fetch('/api/run/start', { method: 'POST' })
      if (r.ok) setRunToken(((await r.json()) as { token: string }).token)
    } catch {
      /* play on */
    }
  }

  const launchWave = useCallback(() => {
    audioRef.current?.pause()
    engineRef.current?.startWave(wave, upgrades)
    setPhase('playing')
  }, [wave, upgrades])

  const buy = (key: keyof Upgrades, cost: number) => {
    if (hud.credits < cost) return
    engineRef.current?.spend(cost)
    setUpgrades((u) => ({ ...u, [key]: u[key] + 1 }))
  }

  const repair = () => {
    if (hud.credits < REPAIR.cost) return
    engineRef.current?.spend(REPAIR.cost)
    engineRef.current?.repair(REPAIR.amount)
  }

  return (
    <div className="starfield relative h-full min-h-[560px] w-full overflow-hidden select-none" data-testid="play">
      <canvas ref={canvasRef} className="absolute inset-0 touch-none" aria-label="Planet Guard game" />

      {phase === 'title' && (
        skyError ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            <p className="text-muted-foreground">Couldn't reach mission control. Refresh to try again.</p>
          </div>
        ) : (
          <TitleScreen sky={sky} book={book} onLaunch={launchRun} onOpenLog={() => setShowLog(true)} />
        )
      )}
      {phase === 'briefing' && sky && (
        <BriefingScreen
          sky={sky}
          waveIndex={wave}
          hud={hud}
          upgrades={upgrades}
          book={book}
          lastPerfect={lastPerfect}
          onBuy={buy}
          onRepair={repair}
          onLaunch={launchWave}
          voiceOn={sound}
        />
      )}
      {phase === 'playing' && <HudBar hud={hud} onNova={() => engineRef.current?.nova()} />}
      {phase === 'over' && sky && (
        <GameOver sky={sky} won={won} hud={hud} runToken={runToken} realKills={realKills} report={report} stats={stats} onAgain={launchRun} />
      )}
      {showLog && <LogbookModal book={book} onClose={() => setShowLog(false)} />}

      <button
        type="button"
        onClick={() => setSound((s) => !s)}
        className="absolute bottom-4 left-4 z-10 rounded-full border border-border bg-card/70 p-2.5 text-muted-foreground hover:text-foreground"
        aria-label={sound ? 'Mute sound' : 'Unmute sound'}
        aria-pressed={!sound}
      >
        {sound ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
      </button>
    </div>
  )
}
