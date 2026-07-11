/**
 * Tests for `@crowi/plugin-mail-smtp`'s driver + hot-reload. The driver
 * implementation lives in the package; we test from here because the
 * package is a leaf workspace with no jest setup of its own (matches
 * `storage-aws-s3.test.ts` under this same dir).
 *
 * nodemailer is mocked at the module boundary so we can observe the
 * transport options and `sendMail` payloads without opening sockets.
 */
import type { MailSender, PluginContext } from '@crowi/plugin-api';

const sendMailSpy = jest.fn(async () => ({ messageId: 'fake' }));
let createdTransports: Array<{ host?: string; port?: number; secure?: boolean; auth?: unknown }> = [];

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: (opts: { host?: string; port?: number; secure?: boolean; auth?: unknown }) => {
      createdTransports.push(opts);
      return { sendMail: sendMailSpy };
    },
  },
}));

function makeCtx(own: { host?: string; port?: number; user?: string; password?: string; secure?: boolean }): PluginContext {
  return {
    config: () => ({ host: '', port: 587, user: '', password: '', secure: false, ...own }) as any,
    dependencyConfig: () => ({}) as any,
    setConfig: jest.fn(),
    pageMetadata: { get: jest.fn(), set: jest.fn(), remove: jest.fn() } as any,
    model: () => ({}),
    log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

describe('@crowi/plugin-mail-smtp', () => {
  let plugin: typeof import('@crowi/plugin-mail-smtp').default;
  let registered: MailSender | null = null;

  beforeEach(() => {
    jest.resetModules();
    sendMailSpy.mockClear();
    createdTransports = [];
    plugin = require('@crowi/plugin-mail-smtp').default;
    registered = null;
  });

  function register(ctx: PluginContext): MailSender {
    const fakeRegistry = {
      register: (_name: string, driver: MailSender) => {
        registered = driver;
      },
    } as any;
    plugin.registerMailSender!(fakeRegistry, ctx);
    if (!registered) throw new Error('registerMailSender did not register a driver');
    return registered;
  }

  it('passes the assembled message straight through to sendMail', async () => {
    const driver = register(makeCtx({ host: 'smtp.example.com', port: 587 }));
    await driver.send({
      to: ['a@example.com'],
      from: 'noreply@example.com',
      subject: 'Hi',
      text: 'body',
      html: '<p>body</p>',
      replyTo: 'reply@example.com',
    });
    expect(sendMailSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['a@example.com'],
        from: 'noreply@example.com',
        subject: 'Hi',
        text: 'body',
        html: '<p>body</p>',
        replyTo: 'reply@example.com',
      }),
    );
  });

  it('builds auth only when both user and password are set', async () => {
    register(makeCtx({ host: 'smtp.example.com', port: 587, user: 'u', password: 'p' }));
    expect(createdTransports.at(-1)).toEqual(expect.objectContaining({ auth: { user: 'u', pass: 'p' } }));

    register(makeCtx({ host: 'smtp.example.com', port: 587, user: 'u', password: '' }));
    expect(createdTransports.at(-1)?.auth).toBeUndefined();
  });

  it('forces secure transport on port 465', async () => {
    register(makeCtx({ host: 'smtp.example.com', port: 465 }));
    expect(createdTransports.at(-1)).toEqual(expect.objectContaining({ secure: true }));
  });

  it('throws on send when host is not configured', async () => {
    const driver = register(makeCtx({ host: '', port: 587 }));
    await expect(driver.send({ to: ['a@example.com'], from: 'f@example.com', subject: 's', text: 't' })).rejects.toThrow(/host is not configured/);
  });

  it('reconfigure rebuilds the transport with the new host', async () => {
    const driver = register(makeCtx({ host: 'old.example.com', port: 587 }));
    await plugin.reconfigure!(makeCtx({ host: 'new.example.com', port: 587 }));
    await driver.send({ to: ['a@example.com'], from: 'f@example.com', subject: 's', text: 't' });
    // Latest constructed transport targets the new host.
    expect(createdTransports.at(-1)).toEqual(expect.objectContaining({ host: 'new.example.com' }));
  });
});
