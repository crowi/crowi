import { promises as fs } from 'node:fs';
import path from 'node:path';
import Debug from 'debug';
import type { EmailMessage, MailSender } from '@crowi/plugin-api';
import type Crowi from 'src/crowi';
import { type MailCatalog, getMailCatalog } from 'src/mail/i18n';

const debug = Debug('crowi:service:mail');

/**
 * Thrown by `MailService.getFrom()` when `mail:from` is unset —
 * distinguished from any other send failure (e.g. a transport error) so
 * the hono handler (`hono/handlers/admin/mail.ts`) can map it to the
 * dedicated `MAIL_FROM_NOT_CONFIGURED` wire error code instead of the
 * generic `MAIL_TEST_FAILED` (feature-core-config-readiness-and-mail).
 */
export class MailFromNotConfiguredError extends Error {
  constructor() {
    super('mail:from is not configured. Set it from the admin mail settings.');
    this.name = 'MailFromNotConfiguredError';
  }
}

/**
 * HTML email types. Each maps 1:1 to a MJML body template
 * (`views/mail/<name>.mjml` + `<name>.text`) AND to a catalog section
 * (`MailCatalog[<name>]`), so the name alone resolves both the template
 * files and the i18n strings — no mapping table. Derived from the catalog
 * keys so a new section automatically extends this union.
 */
export type MailTemplateName = Exclude<keyof MailCatalog, 'common'>;

/**
 * High-level send options accepted by the core. The MailService resolves
 * everything sender-independent here — `from`, the subject, and the
 * rendered body (text + optional html) — so every mail sender driver
 * receives an identical `EmailMessage` and produces the same email
 * regardless of transport.
 */
export interface SendMailOptions {
  to: string | string[];
  /**
   * Subject. When omitted: for `htmlTemplate` the localized
   * `MailCatalog[name].subject` is used, otherwise "<app:title>からのメール".
   */
  subject?: string;
  /**
   * MJML HTML email. Renders `views/mail/<name>.mjml` (wrapped in
   * `layout.mjml`) to html plus `<name>.text` to the text part, and
   * auto-injects the localized catalog as `vars.t`. Takes precedence
   * over `template` / `text`.
   */
  htmlTemplate?: MailTemplateName;
  /** Recipient language for `htmlTemplate` i18n (falls back to English). */
  lang?: string;
  /**
   * Legacy plain-text template path relative to `views/mail/` (e.g.
   * `'admin/userInvitation.txt'`). When set (and `htmlTemplate` is not),
   * the rendered template becomes the text body.
   */
  template?: string;
  /** Plain-text body, used when neither `htmlTemplate` nor `template` is given. */
  text?: string;
  /** Variables interpolated into the template (`{{ key }}` / `{{ a.b }}`). */
  vars?: Record<string, unknown>;
  html?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
}

/**
 * `mjml2html` as actually shipped by mjml v5: asynchronous, returning a
 * `Promise<{ html, errors }>` (it was synchronous in v4). Typed locally
 * because `@types/mjml` models the signature differently across versions;
 * this matches the runtime.
 */
type Mjml2Html = (
  input: string,
  options?: { validationLevel?: 'strict' | 'soft' | 'skip' },
) => Promise<{ html: string; errors: Array<{ message?: string; formattedMessage?: string }> }>;

/**
 * Lazily-loaded `mjml`. It pulls in a large dependency tree, so we defer
 * the require to the first HTML render rather than paying it at module
 * load (which happens during api boot and in every jest file touching
 * the model layer). The CJS module default-exports the function.
 */
let mjml2htmlFn: Mjml2Html | null = null;
async function loadMjml(): Promise<Mjml2Html> {
  if (!mjml2htmlFn) {
    const mod = (await import('mjml')) as unknown as Mjml2Html | { default: Mjml2Html };
    mjml2htmlFn = typeof mod === 'function' ? mod : mod.default;
  }
  return mjml2htmlFn;
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

  /** Resolve the configured `mail:from`. Throws {@link MailFromNotConfiguredError} when unset. */
  getFrom(): string {
    const config = this.crowi.getConfig();
    const from = config?.crowi?.['mail:from'];
    if (!from) {
      throw new MailFromNotConfiguredError();
    }
    return from;
  }

  private defaultSubject(): string {
    const config = this.crowi.getConfig();
    const appTitle = config?.crowi?.['app:title'] || 'Crowi';
    return `${appTitle}からのメール`;
  }

  /** Read a template file (relative to `views/mail/`), caching the source. */
  private async loadTemplateSource(relativePath: string): Promise<string> {
    let raw = this.templateSourceCache.get(relativePath);
    if (raw === undefined) {
      raw = await fs.readFile(path.join(this.templateDir, relativePath), 'utf-8');
      this.templateSourceCache.set(relativePath, raw);
    }
    return raw;
  }

  async renderTemplate(template: string, vars: Record<string, unknown> = {}): Promise<string> {
    return renderTemplateString(await this.loadTemplateSource(template), vars);
  }

  /**
   * Render a MJML email to `{ html, text }`. Order is strict: inject the
   * body template into the layout (plain marker replace) → expand
   * `{{ vars }}` over the merged source → `mjml2html`. Variable expansion
   * must happen on the MJML *source* (not the output HTML) so `mjml`
   * sees only valid markup. The `.text` sibling is expanded separately.
   */
  private async renderMjml(name: MailTemplateName, vars: Record<string, unknown>): Promise<{ html: string; text: string }> {
    const [layout, body, textSource] = await Promise.all([
      this.loadTemplateSource('layout.mjml'),
      this.loadTemplateSource(`${name}.mjml`),
      this.loadTemplateSource(`${name}.text`),
    ]);
    const mergedSource = renderTemplateString(layout.replace('<!--BODY-->', body), vars);
    const mjml2html = await loadMjml();
    const { html, errors } = await mjml2html(mergedSource, { validationLevel: 'soft' });
    if (errors && errors.length > 0) {
      debug(
        'mjml warnings for %s: %o',
        name,
        errors.map((e) => e.formattedMessage ?? e.message),
      );
    }
    return { html, text: renderTemplateString(textSource, vars) };
  }

  /**
   * Assemble and deliver an email through the active sender. Resolves
   * once the driver accepts the message; throws on a missing
   * sender/from or a transport error (the caller decides whether that
   * is fatal to the surrounding operation).
   */
  async send(options: SendMailOptions): Promise<void> {
    const from = this.getFrom();

    let subject = options.subject;
    let text: string;
    let html = options.html;

    if (options.htmlTemplate) {
      const catalog = getMailCatalog(options.lang);
      const vars = { ...(options.vars ?? {}), t: catalog };
      const rendered = await this.renderMjml(options.htmlTemplate, vars);
      html = rendered.html;
      text = rendered.text;
      // Subject lives in the catalog and may itself reference {{ appTitle }},
      // so render it standalone against the same vars.
      subject = subject ?? renderTemplateString(catalog[options.htmlTemplate].subject, vars);
    } else {
      text = options.template ? await this.renderTemplate(options.template, options.vars) : (options.text ?? '');
    }

    const message: EmailMessage = {
      to: toArray(options.to) ?? [],
      from,
      subject: subject || this.defaultSubject(),
      text,
      html,
      replyTo: options.replyTo,
      cc: toArray(options.cc),
      bcc: toArray(options.bcc),
    };

    debug('sending mail to %o (subject=%s)', message.to, message.subject);
    await this.activeSender().send(message);
  }

  /**
   * Send the branded HTML test message to `to` through the active
   * sender. Used by the admin mail settings page to verify the
   * currently-configured sender — and that every sender renders the
   * same template — end-to-end.
   */
  async sendTest(to: string, lang?: string): Promise<void> {
    await this.send({ to, htmlTemplate: 'test', lang, vars: this.brandVars() });
  }

  /**
   * Security notification that the recipient's password was changed.
   * Fire-and-forget at the call site (a notification failure must not
   * fail the password change itself).
   */
  async sendPasswordChangedNotice(to: string, lang?: string): Promise<void> {
    await this.send({ to, htmlTemplate: 'passwordChanged', lang, vars: this.brandVars() });
  }

  /** Brand vars (appTitle / appUrl / logoUrl) shared by every template. */
  brandVars(): Record<string, unknown> {
    const config = this.crowi.getConfig();
    const appUrl = this.crowi.getBaseUrl() || '';
    return {
      appTitle: config?.crowi?.['app:title'] || 'Crowi',
      appUrl,
      logoUrl: appUrl ? `${appUrl}/logo/500w.png` : '',
    };
  }
}
