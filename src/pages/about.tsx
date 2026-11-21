/** /about — STATIC explainer for players and reviewers. */

import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { seo } from '../seo'

const ROWS = [
  {
    tag: 'nasa/neo-feed · nasa/flr · nasa/cme',
    title: 'Real asteroids, real solar storms',
    body: "Once a day the server pulls the near-Earth objects NASA is tracking for the coming week, plus the last two weeks of solar flares and coronal mass ejections. The week's objects are spread across 8 waves by size, and the biggest \"potentially hazardous\" one becomes the final boss. A flare's class (C, M, X) sets how hard it blacks out your shields, and a CME's speed sets how hard it shoves the asteroids.",
  },
  {
    tag: 'anthropic/chat-completion',
    title: 'Mission control writes the day',
    body: "Claude gets the day's real numbers and writes a briefing for every wave, plus the win and loss lines, in one structured call. If the call fails, plain template briefings are used and the game still runs.",
  },
  {
    tag: 'elevenlabs/generate-speech',
    title: '…and reads it on air',
    body: "Each briefing is voiced once and cached for the day, so a thousand players cost the same as one. Visitors can only request today's fixed lines, never arbitrary text.",
  },
  {
    tag: 'DeepSpace: cron · records · server actions · auth',
    title: 'Built once a day, played instantly',
    body: "A cron job builds tomorrow's sky just after midnight UTC, so nobody waits on an API. The game itself runs entirely in your browser. Playing needs no account; signing in only posts your score to the live daily leaderboard. Scores are checked against a server-signed start time so impossible runs are rejected.",
  },
]

export default function About() {
  return (
    <>
      <Seo {...seo} title="How it works | Planet Guard" path="/about" />
      <div className="starfield min-h-screen text-foreground">
        <header className="mx-auto flex max-w-4xl items-center justify-between px-4 py-5">
          <Link to="/" className="font-display text-lg font-bold">Planet Guard</Link>
          <Link to="/play" className="rounded-lg border border-primary/60 px-3 py-1.5 text-sm text-primary hover:bg-primary/10">Play</Link>
        </header>
        <main className="mx-auto max-w-4xl px-4 pb-16">
          <h1 className="mt-8 font-display text-4xl font-bold sm:text-5xl">How Planet Guard works</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            An arcade game whose levels come from today&rsquo;s real space data, built on DeepSpace. The app holds no NASA,
            Anthropic or ElevenLabs keys; every call goes through DeepSpace&rsquo;s integration proxy from the server.
          </p>
          <div className="mt-8 space-y-3">
            {ROWS.map((r) => (
              <section key={r.title} className="rounded-xl border border-border bg-card p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-shield">{r.tag}</p>
                <h2 className="mt-1 font-display text-2xl font-bold">{r.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{r.body}</p>
              </section>
            ))}
          </div>
          <p className="mt-6 text-xs text-muted-foreground">
            The asteroids are real; the danger is not. None of today&rsquo;s objects will hit Earth. The game exaggerates them on purpose.
          </p>
        </main>
      </div>
    </>
  )
}
