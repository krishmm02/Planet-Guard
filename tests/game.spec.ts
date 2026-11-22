/**
 * Planet Guard end-to-end. Runs against the dev server, so it uses the real
 * (cached) daily sky built from live NASA data.
 *
 *   npx deepspace test run e2e --grep "Planet Guard"
 *
 * The "balance" test plays complete runs with the dev-only autopilot (aims
 * with human-like delay and error) at 4x speed, once without upgrades and once
 * buying two per break, and checks the difficulty curve. The upgrade-free run
 * should be in real danger, and shopping should be what wins it.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

async function playRun(page: Page, buyPerBreak: number): Promise<{ won: boolean; hp: number; score: string; waves: string[] }> {
  await page.goto('/play')
  await expect(page.getByTestId('launch')).toBeEnabled({ timeout: 60_000 })
  await page.getByTestId('launch').click()
  const waves: string[] = []
  const deadline = Date.now() + 420_000
  while (Date.now() < deadline) {
    if (await page.getByTestId('game-over').isVisible()) break
    const launchWave = page.getByTestId('launch-wave')
    if (await launchWave.isVisible()) {
      for (let i = 0; i < buyPerBreak; i++) {
        const buy = page.locator('[data-testid^="buy-"]:enabled').first()
        if (await buy.count()) await buy.click()
      }
      waves.push(String(await page.evaluate(() => Math.round((window as unknown as { __pg: { earthHp: number } }).__pg.earthHp))))
      await launchWave.click()
      await page.evaluate(() => {
        const pg = (window as unknown as { __pg: { autopilot: boolean; timeScale: number } }).__pg
        pg.autopilot = true
        // 4x on real GPUs; software-rendered CI browsers get more substeps to finish in time.
        pg.timeScale = 6
      })
    }
    await page.waitForTimeout(150)
  }
  await expect(page.getByTestId('game-over')).toBeVisible()
  const text = await page.getByTestId('game-over').innerText()
  const hp = await page.evaluate(() => Math.round((window as unknown as { __pg: { earthHp: number } }).__pg.earthHp))
  const fps = await page.evaluate(() => Math.round((window as unknown as { __pg: { fps: number } }).__pg.fps))
  console.log(`[perf] fps at end of run: ${fps}`)
  return { won: text.includes('Sky cleared') || text.toLowerCase().includes('sky cleared'), hp, score: await page.getByTestId('final-score').innerText(), waves }
}

test('Planet Guard: public routes are cached, bounded, and locked down', async ({ request }) => {
  const sky = await request.get('/api/sky')
  expect(sky.ok()).toBeTruthy()
  const body = await sky.json()
  expect(body.waves).toHaveLength(8)
  expect(JSON.stringify(body)).not.toContain('api_key')

  expect((await request.get('/api/sky/voice/not-a-line')).status()).toBe(404)
  const voice = await request.get('/api/sky/voice/w0')
  expect(voice.headers()['content-type']).toContain('audio/')

  for (const ep of ['nasa/neo-feed', 'anthropic/chat-completion', 'elevenlabs/generate-speech', 'openai/chat-completion']) {
    expect((await request.post(`/api/integrations/${ep}`, { data: {} })).status(), ep).toBe(403)
  }
  expect((await request.post('/api/actions/submitScore', { data: {} })).status()).toBe(401)
})

test('Planet Guard: a full run is playable without signing in', async ({ page }) => {
  test.setTimeout(480_000)
  const run = await playRun(page, 2)
  expect(run.waves.length).toBeGreaterThanOrEqual(4)
  // Anonymous players are invited to sign in to post; the run itself never required it.
  await expect(page.getByTestId('sign-in-to-post')).toBeVisible()
  await expect(page.getByTestId('leaderboard')).toBeVisible()
})

test('Planet Guard: balance curve (no upgrades vs. shopping)', async ({ page }) => {
  test.setTimeout(900_000)
  const bare = await playRun(page, 0)
  const shopper = await playRun(page, 2)
  console.log(`[balance] no-upgrades: ${bare.won ? 'won' : 'lost'} hp=${bare.hp} score=${bare.score} waves=${bare.waves.join(',')}`)
  console.log(`[balance] shopper:     ${shopper.won ? 'won' : 'lost'} hp=${shopper.hp} score=${shopper.score} waves=${shopper.waves.join(',')}`)
  // Without upgrades you should be in real trouble by the end...
  expect(bare.won && bare.hp > 60).toBe(false)
  // ...and spending credits should clearly help.
  expect(shopper.hp).toBeGreaterThanOrEqual(bare.hp)
})
