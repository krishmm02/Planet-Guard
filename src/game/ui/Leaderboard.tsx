import { useAuth, useQuery } from 'deepspace'
import { Crown, Radio } from 'lucide-react'
import { utcDay } from '../sky'
import { cn } from '@/lib/utils'

interface ScoreRow {
  userId: string
  name: string
  score: number
  wave: number
  won: number
}

/**
 * Today's top pilots. Live: a DeepSpace realtime query, so a new high score
 * appears on every open screen the moment the server action writes it.
 */
export function Leaderboard({ compact = false }: { compact?: boolean }) {
  const { userId } = useAuth()
  const { records, status } = useQuery<ScoreRow>('scores', {
    where: { day: utcDay() },
    orderBy: 'score',
    orderDir: 'desc',
    limit: compact ? 5 : 10,
  })

  return (
    <div className="rounded-xl border border-border bg-card/80 p-4" data-testid="leaderboard">
      <div className="flex items-center justify-between">
        <p className="font-display text-sm font-bold uppercase tracking-[0.18em] text-muted-foreground">Today's top pilots</p>
        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
          <Radio className="h-3 w-3 blink" /> live
        </span>
      </div>
      {status === 'loading' ? (
        <div className="mt-3 space-y-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-7 animate-pulse rounded bg-secondary" />)}
        </div>
      ) : records.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No scores yet today. The top spot is open.</p>
      ) : (
        <ol className="mt-3 space-y-1">
          {records.map((r, i) => (
            <li
              key={r.recordId}
              className={cn(
                'flex items-center gap-3 rounded-md px-2 py-1.5 text-sm',
                r.data.userId === userId ? 'bg-primary/15 text-foreground' : 'text-foreground/90',
              )}
            >
              <span className={cn('w-5 text-right font-display font-bold', i === 0 ? 'text-primary' : 'text-muted-foreground')}>
                {i === 0 ? <Crown className="ml-auto h-4 w-4" /> : i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{r.data.name}</span>
              <span className="text-xs text-muted-foreground">{r.data.won ? 'cleared' : `wave ${r.data.wave}`}</span>
              <span className="w-16 text-right font-display font-bold tabular-nums">{r.data.score.toLocaleString()}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
