import type { Upgrades } from './engine'

export interface UpgradeDef {
  key: keyof Upgrades
  label: string
  blurb: string
  max: number
  base: number
}

export const UPGRADES: UpgradeDef[] = [
  { key: 'fireRate', label: 'Rapid fire', blurb: '+14% fire rate', max: 5, base: 140 },
  { key: 'spread', label: 'Spread cannon', blurb: '+1 shot per volley', max: 3, base: 260 },
  { key: 'damage', label: 'Heavy rounds', blurb: '+1 damage per shot', max: 4, base: 220 },
  { key: 'shield', label: 'Shield capacity', blurb: '+25 shield', max: 4, base: 150 },
  { key: 'pierce', label: 'Piercing rounds', blurb: 'Shots pass through +1 rock', max: 2, base: 320 },
  { key: 'nova', label: 'Nova capacitor', blurb: '−20% Nova cooldown', max: 3, base: 240 },
]

export const REPAIR = { cost: 150, amount: 25 }

export function upgradeCost(def: UpgradeDef, level: number): number {
  return Math.round(def.base * Math.pow(1.75, level))
}
