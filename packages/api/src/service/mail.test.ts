/**
 * Unit tests for the core MailService. The active mail sender is a fake
 * driver injected via a stub Crowi, so these tests exercise the
 * sender-independent assembly (from / subject / template) without any
 * real transport.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EmailMessage, MailSender } from '@crowi/plugin-api';
import { MailService, renderTemplateString } from './mail';

function fakeSender(): MailSender & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

function makeCrowi(opts: { from?: string; appTitle?: string; mail: MailSender | null; rootDir?: string }): any {
  return {
    rootDir: opts.rootDir ?? '/tmp',
    getConfig: () => ({ crowi: { 'mail:from': opts.from ?? '', 'app:title': opts.appTitle ?? '' } }),
    getPlugins: () => ({ active: { mail: opts.mail } }),
  };
}

describe('renderTemplateString', () => {
  it('interpolates flat and nested keys, trims whitespace inside braces', () => {
    const out = renderTemplateString('Hi {{ name }} <{{ user.email }}>', { name: 'Bob', user: { email: 'b@x.io' } });
    expect(out).toBe('Hi Bob <b@x.io>');
  });

  it('renders unknown keys as empty string', () => {
    expect(renderTemplateString('a={{ missing }}b', {})).toBe('a=b');
  });
});

describe('MailService', () => {
  it('assembles an EmailMessage with the configured from and default subject', async () => {
    const sender = fakeSender();
    const svc = new MailService(makeCrowi({ from: 'noreply@example.com', appTitle: 'MyWiki', mail: sender }));

    await svc.send({ to: 'u@example.com', text: 'hello' });

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toEqual(
      expect.objectContaining({
        to: ['u@example.com'],
        from: 'noreply@example.com',
        subject: 'MyWikiからのメール',
        text: 'hello',
      }),
    );
  });

  it('uses an explicit subject over the default', async () => {
    const sender = fakeSender();
    const svc = new MailService(makeCrowi({ from: 'f@example.com', mail: sender }));
    await svc.send({ to: 'u@example.com', subject: 'Custom', text: 'x' });
    expect(sender.sent[0].subject).toBe('Custom');
  });

  it('renders a template file into the body', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crowi-mail-'));
    await fs.mkdir(path.join(tmpDir, 'views', 'mail'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'views', 'mail', 'greet.txt'), 'Hello {{ name }}', 'utf-8');

    const sender = fakeSender();
    const svc = new MailService(makeCrowi({ from: 'f@example.com', mail: sender, rootDir: tmpDir }));
    await svc.send({ to: 'u@example.com', template: 'greet.txt', vars: { name: 'World' } });

    expect(sender.sent[0].text).toBe('Hello World');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when from is not configured', async () => {
    const svc = new MailService(makeCrowi({ from: '', mail: fakeSender() }));
    await expect(svc.send({ to: 'u@example.com', text: 'x' })).rejects.toThrow(/mail:from is not configured/);
  });

  it('throws when no mail sender is active', async () => {
    const svc = new MailService(makeCrowi({ from: 'f@example.com', mail: null }));
    await expect(svc.send({ to: 'u@example.com', text: 'x' })).rejects.toThrow(/Mail sender not registered/);
  });

  it('sendTest dispatches a fixed message to the given address', async () => {
    const sender = fakeSender();
    const svc = new MailService(makeCrowi({ from: 'f@example.com', mail: sender }));
    await svc.sendTest('admin@example.com');
    expect(sender.sent[0]).toEqual(expect.objectContaining({ to: ['admin@example.com'], from: 'f@example.com' }));
  });
});
