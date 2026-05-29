import { promises as fs } from 'node:fs';
import path from 'node:path';
import Debug from 'debug';
import type { EmailMessage, MailSender } from '@crowi/plugin-api';
import type Crowi from 'src/crowi';

const debug = Debug('crowi:service:mail');

/**
 * High-level send options accepted by the core. The MailService resolves
 * everything sender-independent here — `from`, the default subject, and
 * the rendered body — so every mail sender driver receives an identical
 * `EmailMessage` and produces the same email regardless of transport.
 */
export interface SendMailOptions {
  to: string | string[];
  /** Defaults to "<app:title>からのメール" when omitted. */
  subject?: string;
  /**
   * Template path relative to `views/mail/` (e.g.
   * `'admin/userInvitation.txt'`). When set, the rendered template
   * becomes the body and `text` is ignored.
   */
  template?: string;
  /** Plain-text body, used when `template` is not given. */
  text?: string;
  /** Variables interpolated into the template (`{{ key }}` / `{{ a.b }}`). */
  vars?: Record<string, unknown>;
  html?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
}

/**
 * Render a `{{ key }}` / `{{ nested.key }}` template against `vars`.
 * Intentionally minimal — a full template engine is out of scope; this
 * only replaces the legacy `JSON.stringify(vars)` placeholder so the
 * existing `views/mail/*.txt` templates render properly. Unknown keys
 * resolve to an empty string.
 */
export function renderTemplateString(template: string, vars: Record<string, unknown> = {}): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = key.split('.').reduce<unknown>((acc, part) => {
      if (acc != null && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[part];
      }
      return undefined;
    }, vars);
    return value == null ? '' : String(value);
  });
}

const toArray = (value: string | string[] | undefined): string[] | undefined => {
  if (value == null) return undefined;
  return Array.isArray(value) ? value : [value];
};

/**
 * Core mail service. Owns *what* is sent; delegates *how* to the active
 * mail sender driver (resolved lazily from the plugin registry, since
 * the PluginManager bootstraps after this module is constructed).
 */
export class MailService {
  /** Cache of rendered-template *sources*, keyed by relative path. The
   * files are static after boot, so read each at most once. */
  private templateSourceCache = new Map<string, string>();

  constructor(private readonly crowi: Crowi) {}

  /** The directory holding `views/mail/**` templates. */
  private get templateDir(): string {
    return path.join(this.crowi.rootDir, 'views', 'mail');
  }

  private activeSender(): MailSender {
    const driver = this.crowi.getPlugins().active.mail;
    if (!driver) {
      throw new Error('Mail sender not registered. Install @crowi/plugin-mail-smtp (default) or another @crowi/plugin-mail-* plugin.');
    }
    return driver;
  }

  /** Resolve the configured `mail:from`. Throws when unset. */
  getFrom(): string {
    const config = this.crowi.getConfig();
    const from = config?.crowi?.['mail:from'];
    if (!from) {
      throw new Error('mail:from is not configured. Set it from the admin mail settings.');
    }
    return from;
  }

  private defaultSubject(): string {
    const config = this.crowi.getConfig();
    const appTitle = config?.crowi?.['app:title'] || 'Crowi';
    return `${appTitle}からのメール`;
  }

  async renderTemplate(template: string, vars: Record<string, unknown> = {}): Promise<string> {
    let raw = this.templateSourceCache.get(template);
    if (raw === undefined) {
      raw = await fs.readFile(path.join(this.templateDir, template), 'utf-8');
      this.templateSourceCache.set(template, raw);
    }
    return renderTemplateString(raw, vars);
  }

  /**
   * Assemble and deliver an email through the active sender. Resolves
   * once the driver accepts the message; throws on a missing
   * sender/from or a transport error (the caller decides whether that
   * is fatal to the surrounding operation).
   */
  async send(options: SendMailOptions): Promise<void> {
    const from = this.getFrom();
    const text = options.template ? await this.renderTemplate(options.template, options.vars) : (options.text ?? '');

    const message: EmailMessage = {
      to: toArray(options.to) ?? [],
      from,
      subject: options.subject || this.defaultSubject(),
      text,
      html: options.html,
      replyTo: options.replyTo,
      cc: toArray(options.cc),
      bcc: toArray(options.bcc),
    };

    debug('sending mail to %o (subject=%s)', message.to, message.subject);
    await this.activeSender().send(message);
  }

  /**
   * Send a fixed test message to `to` through the active sender. Used by
   * the admin mail settings page to verify the currently-configured
   * sender end-to-end.
   */
  async sendTest(to: string): Promise<void> {
    await this.activeSender().send({
      to: [to],
      from: this.getFrom(),
      subject: 'Crowi: test mail',
      text: 'This is a test message dispatched from the Crowi admin mail settings page.',
    });
  }
}
