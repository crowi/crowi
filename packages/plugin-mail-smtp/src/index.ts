import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod/v3';
import type { CrowiPlugin, EmailMessage, MailSender, StateCell } from '@crowi/plugin-api';

const SmtpConfigSchema = z
  .object({
    /** SMTP server hostname. Empty disables the sender (send() throws). */
    host: z.string().trim().default(''),
    /** SMTP server port. 465 implies an implicit TLS connection. */
    port: z.coerce.number().int().min(1).max(65535).default(587),
    /** SMTP auth username. Leave empty for unauthenticated relays. */
    user: z.string().trim().default(''),
    /** SMTP auth password. */
    password: z.string().describe('@sensitive SMTP password').default(''),
    /**
     * Use an implicit TLS connection from the start. Leave false for
     * STARTTLS on 587 / 25; the runtime also forces this on for port
     * 465 regardless of this flag.
     */
    secure: z.boolean().default(false),
  })
  .strict();

type SmtpConfig = z.infer<typeof SmtpConfigSchema>;

export interface SmtpDriverState {
  transport: Transporter | null;
}

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-mail-smtp',
  version: '0.1.0-dev',
  configSchema: SmtpConfigSchema,
  adminPlacement: {
    label: 'SMTP',
    icon: 'mail',
    // section omitted: derived from registerMailSender → 'mail'
  },
  // `host` defaults to '' (a valid Zod value) but `send()` throws until
  // it's set — see feature-core-config-readiness-and-mail. `user` /
  // `password` are intentionally NOT declared here: an unauthenticated
  // relay (no auth) is a legitimate configuration. `port` / `secure` both
  // have working defaults.
  readiness: {
    registry: 'mail',
    driver: 'smtp',
    requiredConfigFields: ['host'],
  },

  registerMailSender: (registry, ctx) => {
    const config = ctx.config<SmtpConfig>();
    const cell = ctx.state<SmtpDriverState>({ transport: buildTransport(config) });
    registry.register('smtp', createSmtpSender(cell));
    ctx.log.debug('registered smtp mail sender (host=%s)', config.host || '<unset>');
  },

  reconfigure: (ctx) => {
    const config = ctx.config<SmtpConfig>();
    const next: SmtpDriverState = { transport: buildTransport(config) };
    const cell = ctx.state<SmtpDriverState>(next);
    cell.set(next, { dispose: (prev) => prev.transport?.close() });
    ctx.log.debug('reconfigured smtp mail sender (host=%s)', config.host || '<unset>');
  },
};

export default plugin;

/**
 * Build a nodemailer transport from config, or `null` when no host is
 * configured (so the sender reports a clear "not configured" error
 * rather than failing deep inside nodemailer).
 */
export function buildTransport(config: SmtpConfig): Transporter | null {
  if (!config.host) {
    return null;
  }
  const secure = config.secure || config.port === 465;
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure,
    auth:
      config.user && config.password
        ? {
            user: config.user,
            pass: config.password,
          }
        : undefined,
    tls: { rejectUnauthorized: false },
  });
}

/**
 * Build the mail sender around a hot-reload {@link StateCell}. `send`
 * reads the cell through `withValue()`, which snapshots the transport
 * for the duration of the call so a concurrent `reconfigure` cannot
 * swap it out mid-send; the `EmailMessage` is a subset of nodemailer's
 * `Mail.Options`, so it is passed through verbatim.
 */
export function createSmtpSender(cell: StateCell<SmtpDriverState>): MailSender {
  return {
    async send(message: EmailMessage) {
      return cell.withValue(async ({ transport }) => {
        if (!transport) {
          throw new Error('@crowi/plugin-mail-smtp: SMTP host is not configured.');
        }
        await transport.sendMail({
          to: message.to,
          from: message.from,
          subject: message.subject,
          text: message.text,
          html: message.html,
          replyTo: message.replyTo,
          cc: message.cc,
          bcc: message.bcc,
        });
      });
    },
  };
}
