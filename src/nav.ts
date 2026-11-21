/** Navigation Config — one entry per nav item. Routes come from src/pages/. */
import type { Role } from './constants'

export interface NavItem {
  path: string
  label: string
  roles?: Role[]
  devOnly?: boolean
}

export const nav: NavItem[] = [
  { path: '/play', label: 'Play' },
  { path: '/about', label: 'How it works' },
  // ── Features add nav items below this line ──
]
