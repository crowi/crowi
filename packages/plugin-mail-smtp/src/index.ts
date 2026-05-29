import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod/v3';
import type { CrowiPlugin, EmailMessage, MailSender, PluginContext } from '@crowi/plugin-api';

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

/**
 * Module-scope state ref. `registerMailSender` initialises it from the
 * boot-time config; `send` snapshots the transport on each call;
 * `reconfigure` rebuilds it when the admin saves new values.
 */
const state: SmtpDriverState = {
  transport: null,
};

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-mail-smtp',
  version: '0.1.0-dev',
  configSchema: SmtpConfigSchema,
  adminPlacement: {
    label: 'SMTP',
    icon: 'mail',
    // section omitted: derived from registerMailSender → 'mail'
  },

  registerMailSender: (registry, ctx) => {
    const host = applyConfigToState(ctx, state);
    registry.register('smtp', createSmtpSender(state));
    ctx.log.debug('registered smtp mail sender (host=%s)', host || '<unset>');
  },

  reconfigure: (ctx) => {
    const host = applyConfigToState(ctx, state);
    ctx.log.debug('reconfigured smtp mail sender (host=%s)', host || '<unset>');
  },
};

export default plugin;

/** Apply config to `target` and return the configured host (for logging). */
function applyConfigToState(ctx: PluginContext, target: SmtpDriverState): string {
  const config = ctx.config<SmtpConfig>();
  target.transport = buildTransport(config);
  return config.host;
}

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
 * Build the mail sender. `send` reads `state.transport` once at the top
 * so a concurrent `reconfigure` cannot swap the transport mid-send; the
 * `EmailMessage` is a subset of nodemailer's `Mail.Options`, so it is
 * passed through verbatim.
 */
export function createSmtpSender(driverState: SmtpDriverState): MailSender {
  return {
    async send(message: EmailMessage) {
      const transport = driverState.transport;
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
    },
  };
}
