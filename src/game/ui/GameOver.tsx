import { useEffect, useRef, useState } from 'react'
import { AuthOverlay, getAuthToken, useAuth } from 'deepspace'
import { Check, Loader2, RotateCcw, Trophy } from 'lucide-react'
import type { Asteroid, DailySky } from '../sky'
import type { Hud } from '../engine'
import { Leaderboard } from './Leaderboard'
import { cn } from '@/lib/utils'

type SubmitState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'done'; best: number; improved: boolean } | { kind: 'error'; message: string }

async function submitScore(params: Record<string, unknown>): Promise<{ success: boolean; data?: { best: number; improved: boolean }; error?: string }> {
  try {
    const token = await getAuthToken()
    const res = await fetch('/api/actions/submitScore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params),
    })
    return await res.json()
  } catch {
    return { success: false, error: 'Network error. Try again.' }
  }
}

export function GameOver({
  sky,
  won,
  hud,
  runToken,
  realKills,
  onAgain,
}: {
  sky: DailySky
  won: boolean
  hud: Hud
  runToken: string | null
  realKills: Array<{ a: Asteroid; points: number }>
  onAgain: () => void
}) {
  const { isSignedIn, isLoaded } = useAuth()
  const [showAuth, setShowAuth] = useState(false)
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' })
  const sent = useRef(false)

  // Submit automatically once signed in (immediately, or right after signing in here).
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !runToken || sent.current) return
    sent.current = true
    setShowAuth(false)
    setSubmit({ kind: 'sending' })
    void submitScore({ token: runToken, score: hud.score, wave: hud.wave, won }).then((r) => {
      setSubmit(r.success && r.data ? { kind: 'done', ...r.data } : { kind: 'error', message: r.error ?? 'Could not submit.' })
    })
  }, [isLoaded, isSignedIn, runToken, hud.score, hud.wave, won])

  return (
    <div className="absolute inset-0 overflow-y-auto bg-black/55" data-testid="game-over">
      <div className="mx-auto grid max-w-5xl gap-4 px-4 py-8 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <section className="glass rise rounded-xl border border-border p-6">
          <p className={cn('text-xs font-semibold uppercase tracking-[0.25em]', won ? 'text-emerald-400' : 'text-hazard')}>
            {won ? 'Sky cleared' : 'Earth lost'} · {sky.day}
          </p>
          <p className="mt-2 font-display text-6xl font-bold tabular-nums" data-testid="final-score">{hud.score.toLocaleString()}</p>
          <p className="text-sm text-muted-foreground">
            reached wave {hud.wave} · {hud.kills} rocks destroyed · Earth at {Math.round(hud.earthHp)}%
          </p>
          <p className="mt-4 text-[15px] leading-relaxed text-foreground/90">“{won ? sky.victory : sky.defeat}”</p>

          <div className="mt-5 rounded-lg border border-border bg-secondary/40 p-3">
            {submit.kind === 'done' ? (
              <p className="flex items-center gap-2 text-sm" data-testid="submitted">
                <Check className="h-4 w-4 text-emerald-400" />
                {submit.improved ? 'New personal best posted to today’s board.' : `Posted. Your best today is still ${submit.best.toLocaleString()}.`}
              </p>
            ) : submit.kind === 'sending' ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Posting score…</p>
            ) : submit.kind === 'error' ? (
              <p className="text-sm text-hazard">{submit.message}</p>
            ) : !runToken ? (
              <p className="text-sm text-muted-foreground">This run couldn't be verified, so it can't be posted.</p>
            ) : (
              <button
                type="button"
                onClick={() => setShowAuth(true)}
                data-testid="sign-in-to-post"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                <Trophy className="h-4 w-4" /> Sign in to post your score
              </button>
            )}
          </div>

          {realKills.length > 0 && (
            <div className="mt-5">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Real asteroids you stopped</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {realKills.map(({ a, points }) => (
                  <li key={a.id} className={cn('rounded-full border px-2.5 py-1 text-xs', a.hazardous ? 'border-hazard/50 text-hazard' : 'border-border')}>
                    {a.name} · {a.diameterM} m <span className="text-muted-foreground">+{points}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            type="button"
            onClick={onAgain}
            data-testid="play-again"
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 font-display text-xl font-bold text-primary-foreground"
          >
            <RotateCcw className="h-5 w-5" /> Fly again
          </button>
        </section>
        <div className="rise" style={{ animationDelay: '100ms' }}>
          <Leaderboard />
          <p className="mt-3 text-center text-xs text-muted-foreground">New sky at midnight UTC: new asteroids, new boss.</p>
        </div>
      </div>
      {showAuth && <AuthOverlay onClose={() => setShowAuth(false)} />}
    </div>
  )
}
