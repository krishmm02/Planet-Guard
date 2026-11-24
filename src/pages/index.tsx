/**
 * Landing — STATIC and prerendered (top level of src/pages). One job: get
 * people into the game in one click. The live "today's sky" stats load in an
 * effect after hydration so the prerendered HTML stays crawlable.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { seo } from '../seo'
import type { DailySky } from '../game/sky'

export default function Landing() {
  const [sky, setSky] = useState<DailySky | null>(null)
  useEffect(() => {
    fetch('/api/sky')
      .then((r) => (r.ok ? (r.json() as Promise<DailySky>) : null))
      .then(setSky)
      .catch(() => {})
  }, [])
  const boss = sky?.waves.at(-1)?.boss ? sky.asteroids.find((a) => a.id === sky.waves.at(-1)!.boss) : undefined

  return (
    <>
      <Seo {...seo} path="/" />
      <div data-testid="static-landing" className="starfield relative min-h-screen overflow-hidden text-foreground">
        {/* Earth on the horizon */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-[62vw] left-1/2 h-[90vw] w-[90vw] -translate-x-1/2 rounded-full sm:-bottom-[48vw] sm:h-[70vw] sm:w-[70vw]"
          style={{
            background: 'radial-gradient(circle at 50% 30%, #3b82f6 0%, #1e3a8a 45%, #0b1533 70%)',
            boxShadow: '0 0 120px 30px rgba(56,189,248,0.25), inset 0 30px 80px rgba(147,197,253,0.35)',
          }}
        />
        <header className="relative mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
          <span className="font-display text-lg font-bold tracking-wide">Planet Guard</span>
          <nav className="flex items-center gap-5 text-sm text-muted-foreground">
            <Link to="/about" className="hover:text-foreground">How it works</Link>
            <Link to="/play" className="rounded-lg border border-primary/60 px-3 py-1.5 text-primary hover:bg-primary/10">Play</Link>
          </nav>
        </header>

        <main className="relative mx-auto flex max-w-3xl flex-col items-center px-4 pt-8 pb-[45vh] text-center sm:pt-12">
          <p className="rise text-xs font-semibold uppercase tracking-[0.3em] text-shield">An arcade game built on real NASA data</p>
          <h1 className="rise mt-4 font-display text-4xl font-bold leading-[0.95] sm:text-6xl" style={{ animationDelay: '60ms' }}>
            This week&rsquo;s asteroids are <span className="text-primary">real</span>.
            <br />
            Shoot them anyway.
          </h1>
          <p className="rise mt-4 max-w-xl text-base text-muted-foreground" style={{ animationDelay: '120ms' }}>
            Every wave is built from the near-Earth objects NASA is tracking right now. Real solar flares knock out your
            shields. Mission control briefs you between waves. There&rsquo;s a new sky every day.
          </p>
          <Link
            to="/play"
            data-testid="landing-play"
            className="rise pulse-ring mt-6 rounded-xl bg-primary px-9 py-4 font-display text-2xl font-bold text-primary-foreground transition-transform hover:-translate-y-0.5"
            style={{ animationDelay: '180ms' }}
          >
            Play now. No sign-up.
          </Link>
          <p className="mt-4 min-h-[1.25rem] text-sm text-muted-foreground" data-testid="landing-sky">
            {sky?.live
              ? `Today: NASA is tracking ${sky.trackedCount} objects passing Earth this week.${boss ? ` Today's boss is ${boss.name} (about ${boss.diameterM.toLocaleString()} m across).` : ''}`
              : ' '}
          </p>
        </main>
      </div>
    </>
  )
}
