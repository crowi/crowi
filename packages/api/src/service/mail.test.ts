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
    getConfig: () => ({ crowi: { 'mail:from': opts.from ?? '', 'app:title': opts.appTitle ?? '', 'app:url': 'https://wiki.example.com' } }),
    getBaseUrl: () => 'https://wiki.example.com',
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

  it('sendTest dispatches the branded HTML test mail to the given address', async () => {
    const sender = fakeSender();
    const svc = new MailService(makeCrowi({ from: 'f@example.com', appTitle: 'W', mail: sender, rootDir: path.join(__dirname, '..', '..') }));
    await svc.sendTest('admin@example.com');
    const msg = sender.sent[0];
    expect(msg).toEqual(expect.objectContaining({ to: ['admin@example.com'], from: 'f@example.com' }));
    expect(msg.html).toContain('Your mail settings are working');
    expect(msg.text.length).toBeGreaterThan(0);
  });
});

describe('MailService HTML (MJML) templates', () => {
  // Real MJML templates live under packages/api/views/mail; point rootDir there.
  const apiRoot = path.join(__dirname, '..', '..');

  it('renders the invite html with the CTA link, app title, and English copy', async () => {
    const sender = fakeSender();
    const svc = new MailService(makeCrowi({ from: 'noreply@example.com', appTitle: 'MyWiki', mail: sender, rootDir: apiRoot }));

    await svc.send({
      to: 'invitee@example.com',
      htmlTemplate: 'invite',
      vars: {
        inviteUrl: 'https://wiki.example.com/invite/accept?token=abc',
        appTitle: 'MyWiki',
        appUrl: 'https://wiki.example.com',
        logoUrl: 'https://wiki.example.com/logo.png',
      },
    });

    const msg = sender.sent[0];
    expect(msg.html).toBeDefined();
    expect(msg.html).toContain('https://wiki.example.com/invite/accept?token=abc');
    expect(msg.html).toContain("You've been invited");
    expect(msg.html).toContain('MyWiki');
    // text part is non-empty and carries the URL
    expect(msg.text).toContain('https://wiki.example.com/invite/accept?token=abc');
    // subject pulled from the catalog with appTitle interpolated
    expect(msg.subject).toBe("You're invited to MyWiki");
  });

  it('localizes to Japanese when lang=ja', async () => {
    const sender = fakeSender();
    const svc = new MailService(makeCrowi({ from: 'f@example.com', appTitle: 'MyWiki', mail: sender, rootDir: apiRoot }));
    await svc.send({ to: 'x@example.com', htmlTemplate: 'invite', lang: 'ja', vars: { inviteUrl: 'https://w/i', appTitle: 'MyWiki', appUrl: 'https://w' } });
    const msg = sender.sent[0];
    expect(msg.html).toContain('招待が届いています');
    expect(msg.subject).toBe('MyWiki への招待');
  });

  it("falls back to English for regional variants ('en-US')", async () => {
    const sender = fakeSender();
    const svc = new MailService(makeCrowi({ from: 'f@example.com', appTitle: 'W', mail: sender, rootDir: apiRoot }));
    await svc.send({ to: 'x@example.com', htmlTemplate: 'invite', lang: 'en-US', vars: { inviteUrl: 'https://w/i', appTitle: 'W', appUrl: 'https://w' } });
    expect(sender.sent[0].html).toContain("You've been invited");
  });

  it.each([
    ['test', {}, 'Your mail settings are working'],
    ['passwordChanged', {}, 'Your password was changed'],
    ['adminApprovalPending', { createdUserName: 'New User', createdUserEmail: 'new@example.com', adminUsersUrl: 'https://w/admin/users' }, 'awaiting approval'],
    ['emailChange', { confirmUrl: 'https://w/confirm-email?token=abc' }, 'Confirm your new email'],
  ])('renders the %s template to html + text', async (template, extraVars, needle) => {
    const sender = fakeSender();
    const svc = new MailService(makeCrowi({ from: 'f@example.com', appTitle: 'W', mail: sender, rootDir: apiRoot }));
    // biome-ignore lint/suspicious/noExplicitAny: template name is parameterized in the test
    await svc.send({ to: 'x@example.com', htmlTemplate: template as any, vars: { appTitle: 'W', appUrl: 'https://w', ...extraVars } });
    const msg = sender.sent[0];
    expect(msg.html).toContain(needle);
    expect(msg.text.length).toBeGreaterThan(0);
    expect(msg.subject.length).toBeGreaterThan(0);
  });

  it('embeds the link in the adminApprovalPending and emailChange templates', async () => {
    const sender = fakeSender();
    const svc = new MailService(makeCrowi({ from: 'f@example.com', appTitle: 'W', mail: sender, rootDir: apiRoot }));
    await svc.send({
      to: 'admin@example.com',
      htmlTemplate: 'adminApprovalPending',
      vars: { appTitle: 'W', appUrl: 'https://w', createdUserName: 'New User', createdUserEmail: 'new@example.com', adminUsersUrl: 'https://w/admin/users' },
    });
    expect(sender.sent[0].html).toContain('https://w/admin/users');
    expect(sender.sent[0].html).toContain('new@example.com');
  });
});
