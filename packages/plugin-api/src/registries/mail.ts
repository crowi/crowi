/**
 * Mail transport abstraction.
 *
 * The core MailService owns *what* an email says — the from address,
 * subject, and rendered body are resolved before a driver is ever
 * called — so every sender produces an identical message. A mail
 * sender driver is a pure transport: it takes a fully-assembled
 * `EmailMessage` and physically delivers it (SMTP, Resend HTTP API,
 * AWS SES, …).
 *
 * Unlike `NotifierDriver` (a fan-out sink that may have several active
 * drivers at once), exactly one mail sender is active, selected by
 * `crowi.config.json:mail.driver` — the same single-active-driver model
 * as storage and search.
 */

/**
 * Runtime-neutral, fully-assembled email. The core builds this; drivers
 * translate it into their provider's request shape (nodemailer
 * `Mail.Options`, SES `SendEmailCommand`, Resend `emails.send`, …).
 *
 * Recipient fields are always arrays — the core normalises them once so
 * every driver receives the same shape and none has to branch on
 * `string | string[]`. This is otherwise a subset of nodemailer's
 * `Mail.Options`, which accepts string arrays directly.
 */
export interface EmailMessage {
  /** Recipient(s), normalised to an array by the core. */
  to: string[];
  /** Sender address, already resolved from `mail:from` by the core. */
  from: string;
  /** Subject line, already resolved by the core. */
  subject: string;
  /** Plain-text body, already rendered by the core. */
  text: string;
  /** Optional HTML body. */
  html?: string;
  /** Optional Reply-To address. */
  replyTo?: string;
  /** Optional CC recipient(s). */
  cc?: string[];
  /** Optional BCC recipient(s). */
  bcc?: string[];
}

/**
 * Mail sender driver — the transport every mail plugin implements. The
 * runtime resolves the single active driver at boot from
 * `crowi.config.json:mail.driver`.
 */
export interface MailSender {
  /**
   * Deliver a fully-assembled message. Should throw on persistent
   * misconfiguration (missing host / API key) so the admin sees it via
   * the test-mail endpoint; the core decides whether a send failure is
   * fatal to the surrounding operation.
   */
  send(message: EmailMessage): Promise<void>;
}

/**
 * Mail sender registry passed to `registerMailSender`. A plugin
 * contributes one or more drivers under string keys (e.g. `'smtp'`,
 * `'resend'`, `'ses'`); the active driver is selected by
 * `crowi.config.json:mail.driver`.
 */
export interface MailSenderRegistry {
  /**
   * Register a driver under a stable name. Names must be unique across
   * all plugins; the PluginManager fails boot on collision.
   */
  register(driverName: string, driver: MailSender): void;
}
