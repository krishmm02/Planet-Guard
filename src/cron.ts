/**
 * Cron: pre-build the day's sky just after midnight UTC so the first player
 * of the day never waits on NASA + Claude. (getDailySky() also builds lazily
 * on a cache miss, so a missed alarm only costs one slower first load.)
 */

import type { CronTask } from 'deepspace/worker'
import type { Env } from '../worker'
import { buildDailySky } from './server/sky-builder'
import { systemTools } from './server/sky-routes'

export const tasks: CronTask[] = [{ name: 'build-daily-sky', schedule: '5 0 * * *', timezone: 'UTC' }]

export async function runTask(name: string, env: Env): Promise<void> {
  if (name !== 'build-daily-sky') return
  const sky = await buildDailySky(systemTools(env))
  console.info(`[cron] built sky ${sky.day}: live=${sky.live} tracked=${sky.trackedCount} waves=${sky.waves.length}`)
}
