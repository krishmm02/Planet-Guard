import type { CollectionSchema } from 'deepspace/schema'

const closed = { read: false, create: false, update: false, delete: false }

/** Cached daily campaign (src/server/sky-builder.ts). Server-only. */
export const dailySkySchema: CollectionSchema = {
  name: 'daily_sky',
  columns: [
    { name: 'day', storage: 'text', interpretation: 'plain' },
    { name: 'payload', storage: 'text', interpretation: { kind: 'json' } },
  ],
  permissions: { viewer: closed, member: closed, admin: { ...closed, read: true, delete: true } },
}

/** Cached mission-control voice lines, one per briefing per day. Server-only. */
export const briefingAudioSchema: CollectionSchema = {
  name: 'briefing_audio',
  columns: [
    { name: 'day', storage: 'text', interpretation: 'plain' },
    { name: 'line', storage: 'text', interpretation: 'plain' },
    { name: 'audio', storage: 'text', interpretation: 'plain' },
  ],
  permissions: { viewer: closed, member: closed, admin: { ...closed, read: true, delete: true } },
}

/**
 * Daily leaderboard: one row per pilot per day, id `${day}:${userId}`.
 * Everyone (including signed-out visitors) can read it live; nobody can write
 * it from the client. Rows are written only by the `submitScore` server action,
 * which validates the run against a server-signed start time.
 */
const publicRead = { read: true, create: false, update: false, delete: false }
export const scoresSchema: CollectionSchema = {
  name: 'scores',
  columns: [
    { name: 'day', storage: 'text', interpretation: 'plain' },
    { name: 'userId', storage: 'text', interpretation: 'plain' },
    { name: 'name', storage: 'text', interpretation: 'plain' },
    { name: 'score', storage: 'number', interpretation: 'plain' },
    { name: 'wave', storage: 'number', interpretation: 'plain' },
    { name: 'won', storage: 'number', interpretation: 'plain' },
    { name: 'nonce', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    '*': publicRead,
    viewer: publicRead,
    member: publicRead,
    admin: { ...publicRead, delete: true },
  },
}
