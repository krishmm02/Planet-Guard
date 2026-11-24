# Planet Guard

**An arcade game built on live NASA data, running on [DeepSpace](https://docs.deep.space).** You orbit Earth and shoot down *this week's real near-Earth asteroids*: real names, real sizes, real speeds, pulled from NASA's feed. Real solar flares black out your shields and real coronal mass ejections shove the asteroids sideways. An AI mission-control voice briefs you between waves using the day's real numbers. There's a new sky every day and a live daily leaderboard.

You can play within a second, with no sign-up. A run is 8 waves, roughly 5–8 minutes.

## How a run works

1. **Title**: today's stats load from cache in about 0.25s: how many objects NASA is tracking, the number of solar storms, and today's boss (the week's biggest "potentially hazardous" object).
2. **Briefing**: Claude-written, ElevenLabs-voiced mission control introduces the wave's named asteroids, with cards linking to NASA JPL and DONKI.
3. **Wave**: aim with the mouse, a finger or A/D. Firing is automatic. Space or right-click triggers a Nova pulse. Debris arrives in clusters, and from wave 4 from two sides at once. Named asteroids carry their real designation and stats.
4. **Hangar**: spend credits on rapid fire, a spread cannon, heavier rounds, shield, thrusters, a faster Nova, or Earth repairs.
5. **Wave 8**: the boss, which keeps spawning debris until it's destroyed.
6. **Game over**: score, the real asteroids you stopped, and the leaderboard. Signing in posts your score; playing never required it.

## What keeps people playing

- **Snappy aiming, varied threats.** The ship snaps to your pointer, bullets are fast, and there's a muzzle flash, hit sparks and a short freeze-frame on big kills. Because aiming is easy, difficulty comes from *what* you aim at: splitters (break into three), armored rocks (5 hits), fast comets with tails, two-sided debris clusters, and real space weather.
- **Combo multiplier up to ×8.** Every 5 chained kills raise the multiplier, and anything touching Earth resets it. A wave with no hits doubles the clear bonus. This is the skill ceiling: in testing, a run that just survived scored about 7.6k while a high-combo run scored about 71–81k on the same sky.
- **Power-up capsules** (Overdrive, Time Freeze, Shield Surge) drift *away* from Earth after big kills, so you have to choose between the chain and the pickup.
- **Pilot Logbook.** Every real NASA asteroid you destroy is collected permanently, so each day's new sky is a fresh set to hunt ("Today's real asteroids: 7/15"). XP mostly comes from collecting, and feeds an 8-rank ladder (Cadet → Planet Guardian). There's a daily streak, and "NEW" badges mark asteroids you haven't logged yet.

**Tradeoff:** the logbook lives in `localStorage`. That keeps play anonymous and instant with no database, but it doesn't follow you across devices. Syncing it to a per-user DeepSpace record for signed-in players is the obvious next step.

## DeepSpace integrations and primitives

| Used | For | Why it belongs |
|---|---|---|
| `nasa/neo-feed`, `nasa/flr`, `nasa/cme` | Asteroids and space weather | This data is the whole idea: the levels change every day because space does |
| `anthropic/chat-completion` | One structured call per day for all briefings | Turns raw numbers into tension and character; falls back to template text if it fails |
| `elevenlabs/generate-speech` | Mission-control voice | The radio voice makes it feel like a mission; each line is generated once per day and cached |
| **Cron** (`src/cron.ts`) | Builds the day's sky at 00:05 UTC | The day's first player doesn't wait on three APIs plus an LLM |
| **Records** (`daily_sky`, `briefing_audio`, `scores`) | Daily cache, voice cache, leaderboard | The cache is server-only; the leaderboard is publicly readable and updates live through a realtime `useQuery` |
| **Server action** (`submitScore`) | The only write path to the leaderboard | Clients can't write `scores` at all |
| **Auth** | Posting scores only | Play is anonymous so people can start instantly; identity is needed only to put a name on the board |
| **Secrets** (`RUN_KEY`) | HMAC-signed run tokens | Lets the server measure run duration without a database |

The app holds **no** NASA, Anthropic or ElevenLabs keys; every call goes through DeepSpace's integration proxy from the worker.

## The main tradeoff: a client-side game with a server-validated leaderboard

The game runs entirely in the browser (a canvas engine, no assets, synthesized sound). That's what makes it start instantly and feel smooth, but it means a score is ultimately a **claim** from the client. Making scores fully cheat-proof would require running the game simulation on the server and streaming inputs, which would bring latency, server cost and much more complexity to a 6-minute arcade game.

So I chose **plausibility checking instead of authority**:
- When a run starts, the server issues an HMAC-signed `{day, startedAt, nonce}` token (`src/server/run-token.ts`). It's signed with an app secret and needs no database.
- On submit, the server measures the run's duration itself and rejects scores that are impossible for that time: a points-per-second ceiling, a minimum time per wave, a hard cap derived from the same scoring constants the game uses (`src/game/rules.ts`), and the same-day sky only. A token can't be reused for the same user, and only a user's best score per day is kept.

**What this doesn't stop:** a determined cheater who scripts the client and waits out the real run time. For a daily-arcade leaderboard that's an acceptable risk, and it's stated plainly here rather than hidden.

## Spend control (the public URL can't run up the bill)

- **Cost doesn't grow with players.** NASA (3 calls), Claude (1 call) and ElevenLabs (about 11 short lines) each run **once per day**, then everything is served from records. Concurrent cache misses in an isolate share one build, and a failed build backs off for 10 minutes before trying again.
- **Public routes take no free input.** `/api/sky/voice/:line` accepts only today's fixed line ids (`intro`, `w0`–`w7`, `victory`, `defeat`), never text or a voice choice.
- **The generic integration proxy is closed.** The scaffold's `/api/integrations/:name/:endpoint` lets any signed-in user send any request body to any owner-billed integration, including unlisted ones. I made it deny-by-default and marked NASA, Anthropic and ElevenLabs `serverOnly` (`src/integrations.ts`, `src/server/http-routes.ts`).
- **No upstream keys leak.** The raw proxied NASA NEO response includes the upstream NASA API key inside `links.self`. The server keeps only the fields the game needs (with link allow-listing), and a unit test asserts that `api_key` never reaches the client payload. *(Worth flagging to DeepSpace: the proxy passes it through.)*

## Things I left out, and why

- **Image generation** (Gemini/OpenAI): procedural vector rocks read better at 60fps than generated sprites, and there's no per-asteroid art worth waiting for.
- **Web search / news**: the NASA feeds are the authoritative source; summarizing news about asteroids adds latency without adding gameplay.
- **Multiplayer co-op** (presence, realtime rooms): an obvious next step, but the brief asked for something one person can demo. The live leaderboard already shows the realtime side.
- **Server-authoritative simulation**: see the tradeoff above.

## How I verified it

- **Unit tests** (`npx vitest run`, 19 passing; this includes the combo multiplier, rank thresholds, streaks across UTC days, logbook de-duplication and corrupt-storage recovery): NASA parsing (including the `api_key` leak and non-JPL links), flare/CME intensity, campaign planning (escalating sizes, hazardous boss, quiet-Sun and tiny-feed fallbacks), score plausibility, and run tokens (tampering, forged start times, wrong key, missing secret).
- **E2E** (`npx deepspace test run e2e --grep "Planet Guard"`): routes are cached and locked down; a full run is playable without signing in; and a **balance test** plays complete runs with a dev-only autopilot that aims with human-like reaction delay and error.
- **Balance was measured, not guessed.** The first build was far too easy: the bot finished with Earth at 100% and took zero hits in the boss wave. Instrumenting impacts showed the shield absorbed every hit (42 impacts by wave 7, no HP lost). After rebalancing (stronger impacts, slower shield regen, slower base turning, clustered two-sided debris, a tighter economy), the run with no upgrades loses Earth in the late waves. After the combo/power-up update made aiming snappier, I added splitters, armored rocks and comets to keep that true: the latest no-upgrade run fell in wave 5 (7,616 points) while the upgrading run cleared all 8 waves (71,565 points). The shop became the deciding factor. One caveat: the upgraded bot still finishes at or near full health, so a strong human player may find the late game easy. That is the first thing I would tune with real players.
- **Combo/XP tuning was measured too.** After combos landed, one autopilot run jumped from Cadet to Commander in a single game, so I made XP depend on collecting real asteroids (a daily habit) more than on raw score. A strong first run now reaches Lieutenant.
- **Fact-checked the briefings against NASA, independently of the app.** For the 2026-11-24 sky I pulled ground truth straight from NASA NeoWs, JPL's close-approach API and DONKI/NOAA. All 117 stored fields (sizes, speeds, miss distances, dates, hazard flags) matched. All 3 space-weather events matched too: the M2.4 flare on Nov 19, the M1.7 flare on Nov 11 and the CME at 981 km/s on Nov 15. Every number Claude spoke was correct, but the framing wasn't. Because the prompt said the events were "from this week", Claude described up-to-two-week-old storms in the present tense ("an M2.4 flare is flickering on the radar") and stated estimated sizes as exact. I fixed this at the source: the prompt now says storms are past events being replayed and passes how many days ago they happened, and sizes come with NASA's min-max range and must be hedged. I also added a backstop, `briefingProblems` (`src/server/sky-builder.ts`). It rejects any line with a number that isn't in the data, or a storm mention with no past-tense cue, and falls back to an accurate template. It is unit-tested on the real bad line. After the fix, a fresh build had 0 false claims and all 3 storms in the past tense. The tradeoff is that the guard is conservative: it rejected one true line ("over 100 lunar distances") because 100 isn't a data value.
- **Daily rollover** was exercised live: the session crossed midnight UTC and the next load built a new sky (new objects, new briefings, a 2 km boss).

## What I'd do next

- **Co-op mode**: two pilots orbiting the same Earth through a DeepSpace realtime room.
- **Personal history**: a streak calendar of days you've cleared.
- **Sound design**: replace the synthesized blips with a small sample set.
- **Stronger leaderboard integrity**: record input traces and replay suspicious top scores server-side.

## Run it

```bash
npm install
npx deepspace auth login
npx deepspace secrets set RUN_KEY=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
npx deepspace dev start
npx vitest run
npx deepspace test run e2e --grep "Planet Guard"
npx deepspace deploy
```
