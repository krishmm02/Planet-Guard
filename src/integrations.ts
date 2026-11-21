/**
 * Integration billing + exposure config.
 *
 * - billing 'developer': the app owner pays; 'user': the caller pays.
 * - serverOnly (added for this app): closes the generic browser proxy at
 *   /api/integrations/<name>/<endpoint>. The scaffold's proxy otherwise lets
 *   any signed-in user send ANY body to ANY owner-billed integration. Planet
 *   Guard only calls integrations from the server (daily sky build, cached
 *   voice), so the browser never needs the proxy for these.
 * - Integrations not listed here are refused by the proxy (deny by default,
 *   see src/server/http-routes.ts).
 *
 * Per-user connected-account integrations (Google, Composio) must be 'user'.
 */

export const integrations: Record<
  string,
  { billing: 'developer' | 'user'; anonymous?: boolean; serverOnly?: boolean }
> = {
  google: { billing: 'user' },
  composio: { billing: 'user' },
  nasa: { billing: 'developer', serverOnly: true },
  anthropic: { billing: 'developer', serverOnly: true },
  elevenlabs: { billing: 'developer', serverOnly: true },
}
