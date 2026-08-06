import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { z } from 'zod/v3';
import type { AwsConfig } from '@crowi/plugin-aws';
import type { CrowiPlugin, EmailMessage, MailSender, PluginContext } from '@crowi/plugin-api';

// No own config — region / credentials come from @crowi/plugin-aws.
//
// Deliberately no `readiness` declaration (feature-core-config-readiness-
// and-mail): SES has no own required config field, and its AWS
// `region`/`accessKeyId`/`secretAccessKey` are intentionally excluded from
// readiness — an empty value there is the SDK default credential chain, a
// legitimate configuration, not a missing one.
const SesConfigSchema = z.object({}).strict();

type SesConfig = z.infer<typeof SesConfigSchema>;

export interface SesDriverState {
  client: SESv2Client;
}

const state: SesDriverState = {
  client: new SESv2Client({}),
};

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-mail-aws-ses',
  version: '0.1.0-dev',
  requires: ['@crowi/plugin-aws'],
  configSchema: SesConfigSchema,
  adminPlacement: {
    label: 'AWS SES',
    icon: 'mail',
    // section omitted: derived from registerMailSender → 'mail'
  },

  registerMailSender: (registry, ctx) => {
    applyConfigToState(ctx, state);
    registry.register('ses', createSesSender(state));
    ctx.log.debug('registered aws ses mail sender');
  },

  reconfigure: (ctx) => {
    applyConfigToState(ctx, state);
    ctx.log.debug('reconfigured aws ses mail sender');
  },
};

export default plugin;

function applyConfigToState(ctx: PluginContext, target: SesDriverState): void {
  const aws = ctx.dependencyConfig<AwsConfig>('@crowi/plugin-aws');
  target.client = new SESv2Client({
    region: aws.region || undefined,
    credentials:
      aws.accessKeyId && aws.secretAccessKey
        ? {
            accessKeyId: aws.accessKeyId,
            secretAccessKey: aws.secretAccessKey,
          }
        : undefined,
  });
}

/**
 * Build the mail sender. `send` snapshots `state.client` once so a
 * concurrent reconfigure cannot swap the client mid-call. Recipient
 * fields arrive pre-normalised to arrays by the core.
 */
export function createSesSender(driverState: SesDriverState): MailSender {
  return {
    async send(message: EmailMessage) {
      const client = driverState.client;
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: message.from,
          Destination: {
            ToAddresses: message.to,
            CcAddresses: message.cc,
            BccAddresses: message.bcc,
          },
          ReplyToAddresses: message.replyTo ? [message.replyTo] : undefined,
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: message.text, Charset: 'UTF-8' },
                ...(message.html ? { Html: { Data: message.html, Charset: 'UTF-8' } } : {}),
              },
            },
          },
        }),
      );
    },
  };
}
