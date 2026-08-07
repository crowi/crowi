import { Resend } from 'resend';
import { z } from 'zod/v3';
import type { CrowiPlugin, EmailMessage, MailSender, PluginContext } from '@crowi/plugin-api';

const ResendConfigSchema = z
  .object({
    /** Resend API key (https://resend.com/api-keys). Empty disables the sender. */
    apiKey: z.string().trim().describe('@sensitive Resend API key').default(''),
  })
  .strict();

type ResendConfig = z.infer<typeof ResendConfigSchema>;

export interface ResendDriverState {
  client: Resend | null;
}

const state: ResendDriverState = {
  client: null,
};

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-mail-resend',
  version: '0.1.0-dev',
  configSchema: ResendConfigSchema,
  adminPlacement: {
    label: 'Resend',
    icon: 'mail',
    // section omitted: derived from registerMailSender → 'mail'
  },
  // `apiKey` defaults to '' (a valid Zod value) but `send()` throws until
  // it's set — see feature-core-config-readiness-and-mail.
  readiness: {
    registry: 'mail',
    driver: 'resend',
    requiredConfigFields: ['apiKey'],
  },

  registerMailSender: (registry, ctx) => {
    applyConfigToState(ctx, state);
    registry.register('resend', createResendSender(state));
    ctx.log.debug('registered resend mail sender');
  },

  reconfigure: (ctx) => {
    applyConfigToState(ctx, state);
    ctx.log.debug('reconfigured resend mail sender');
  },
};

export default plugin;

function applyConfigToState(ctx: PluginContext, target: ResendDriverState): void {
  const config = ctx.config<ResendConfig>();
  target.client = config.apiKey ? new Resend(config.apiKey) : null;
}

/**
 * Build the mail sender. Reads `state.client` once per send so a
 * concurrent reconfigure swaps the key only for subsequent sends.
 */
export function createResendSender(driverState: ResendDriverState): MailSender {
  return {
    async send(message: EmailMessage) {
      const client = driverState.client;
      if (!client) {
        throw new Error('@crowi/plugin-mail-resend: apiKey is not configured.');
      }
      const { error } = await client.emails.send({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: message.replyTo,
        cc: message.cc,
        bcc: message.bcc,
      });
      if (error) {
        throw new Error(`@crowi/plugin-mail-resend: ${error.name}: ${error.message}`);
      }
    },
  };
}
