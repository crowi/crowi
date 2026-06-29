import { expect } from '@playwright/test';
import { E2E_MAILPIT_API_URL, E2E_WEB_URL } from './config';

interface MailpitAddress {
  Address?: string;
  address?: string;
  Email?: string;
  email?: string;
}

interface MailpitSummary {
  ID?: string;
  Id?: string;
  id?: string;
  To?: MailpitAddress[];
  to?: MailpitAddress[];
  Subject?: string;
  subject?: string;
}

interface MailpitMessagesResponse {
  messages?: MailpitSummary[];
  Messages?: MailpitSummary[];
}

export interface MailpitMessageDetail extends MailpitSummary {
  Text?: string;
  text?: string;
  HTML?: string;
  Html?: string;
  html?: string;
  Body?: string;
  body?: string;
}

function messageId(message: MailpitSummary): string | null {
  return message.ID ?? message.Id ?? message.id ?? null;
}

function messageRecipients(message: MailpitSummary): string[] {
  const recipients = message.To ?? message.to ?? [];
  return recipients.map((recipient) => recipient.Address ?? recipient.address ?? recipient.Email ?? recipient.email ?? '').filter((value) => value.length > 0);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Mailpit API ${url} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function clearMailpitMessages(): Promise<void> {
  try {
    const response = await fetch(`${E2E_MAILPIT_API_URL}/messages`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404 && response.status !== 405) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch {
    // Some Mailpit versions expose only message listing/detail APIs. A stale
    // inbox is harmless because waitForLatestMessageTo filters by recipient and
    // the E2E database uses deterministic fresh invite tokens after every drop.
  }
}

export async function waitForLatestMessageTo(email: string, timeoutMs = 15_000): Promise<MailpitMessageDetail> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      const list = await fetchJson<MailpitMessagesResponse>(`${E2E_MAILPIT_API_URL}/messages`);
      const messages = list.messages ?? list.Messages ?? [];
      const summary = messages.find((candidate) => messageRecipients(candidate).some((recipient) => recipient.toLowerCase() === email.toLowerCase()));
      const id = summary ? messageId(summary) : null;
      if (id) {
        return await fetchJson<MailpitMessageDetail>(`${E2E_MAILPIT_API_URL}/message/${encodeURIComponent(id)}`);
      }
    } catch (err) {
      lastError = err as Error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for a Mailpit message to ${email}.${lastError ? ` Last error: ${lastError.message}` : ''}`);
}

export function extractInviteLink(message: MailpitMessageDetail): string {
  const bodyCandidates = [message.Text, message.text, message.HTML, message.Html, message.html, message.Body, message.body, JSON.stringify(message)];
  const body = bodyCandidates.filter((value): value is string => typeof value === 'string').join('\n');
  const escapedBase = E2E_WEB_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(new RegExp(`${escapedBase}/invite/accept\\?token=[^\\s"'<>]+`));
  expect(match, `invite link for ${E2E_WEB_URL}/invite/accept should be present in Mailpit message`).not.toBeNull();
  return match?.[0].replace(/&amp;/g, '&') ?? '';
}
