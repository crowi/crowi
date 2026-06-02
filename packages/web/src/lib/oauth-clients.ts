/**
 * RFC-0010 — first-party OAuth client display names. v1 ships only
 * `crowi-cli`; an unknown client_id falls back to its raw id. Shared by the
 * authorize-code consent screen and the device consent screen.
 */
const CLIENT_NAMES: Record<string, string> = {
  'crowi-cli': 'Crowi CLI',
};

export function clientDisplayName(clientId: string): string {
  return CLIENT_NAMES[clientId] ?? clientId;
}
