import type { MailCatalog } from './index';

export const en: MailCatalog = {
  invite: {
    subject: "You're invited to {{ appTitle }}",
    preheader: 'Accept your invitation and set up your account.',
    heading: "You've been invited",
    intro: 'You have been invited to join the wiki. Click the button below to choose your username and password and activate your account.',
    cta: 'Accept invitation',
    expiresNote: 'This invitation link expires in 7 days.',
    ignoreNote: "If you weren't expecting this invitation, you can safely ignore this email.",
  },
  activation: {
    subject: 'Confirm your email for {{ appTitle }}',
    preheader: 'Confirm your email address to activate your account.',
    heading: 'Confirm your email',
    intro: 'Thanks for registering. Please confirm your email address to activate your account by clicking the button below.',
    cta: 'Confirm email',
    expiresNote: 'This confirmation link expires in 24 hours.',
    ignoreNote: "If you didn't create this account, you can safely ignore this email.",
  },
  passwordReset: {
    subject: 'Reset your password for {{ appTitle }}',
    preheader: 'Reset your password.',
    heading: 'Reset your password',
    intro: 'We received a request to reset your password. Click the button below to choose a new one.',
    cta: 'Reset password',
    expiresNote: 'This password reset link expires in 1 hour.',
    ignoreNote: "If you didn't request a password reset, you can safely ignore this email — your password will stay the same.",
  },
  common: {
    footerTagline: 'Markdown wiki for team knowledge sharing',
    linkFallback: "If the button above doesn't work, copy and paste this URL into your browser:",
  },
};
