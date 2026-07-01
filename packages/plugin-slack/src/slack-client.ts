import { WebClient } from '@slack/web-api';
import type { SlackUnfurls } from './unfurl';

/**
 * Module-scope state ref holding the live `WebClient`. `registerRoutes`
 * initialises it from boot-time config; `reconfigure` rebuilds it when the
 * admin saves a new bot token (the same state-ref pattern as
 * `@crowi/plugin-mail-smtp`). Kept in its own module so the rest of the
 * plugin (signature / manifest / unfurl builders) stays free of the
 * ESM-only `@slack/web-api` import and remains unit-testable.
 */
export interface SlackClientState {
  client: WebClient | null;
}

const state: SlackClientState = {
  client: null,
};

/** Rebuild the WebClient from a (decrypted) bot token, or clear it when unset. */
export function configureSlackClient(botToken: string): void {
  state.client = botToken ? new WebClient(botToken) : null;
}

/** The current WebClient, or null when no bot token is configured. */
export function getSlackClient(): WebClient | null {
  return state.client;
}

/**
 * Call `chat.unfurl` for one channel + message. Thin pass-through to the
 * SDK; the caller has already built the `unfurls` payload via the pure
 * `buildUnfurlAttachment` builder. Throws when the client is unconfigured
 * so the async caller can log it.
 */
export async function postUnfurls(args: { channel: string; ts: string; unfurls: SlackUnfurls }): Promise<void> {
  const client = state.client;
  if (!client) {
    throw new Error('@crowi/plugin-slack: bot token is not configured.');
  }
  await client.chat.unfurl({
    channel: args.channel,
    ts: args.ts,
    unfurls: args.unfurls,
  });
}
