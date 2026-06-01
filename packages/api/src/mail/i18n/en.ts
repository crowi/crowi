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
  test: {
    subject: '{{ appTitle }}: test email',
    preheader: 'Your mail settings are working.',
    heading: 'Your mail settings are working',
    intro: 'This is a test message sent from the admin mail settings page. If you received it, outgoing email is configured correctly.',
  },
  passwordChanged: {
    subject: 'Your {{ appTitle }} password was changed',
    preheader: 'Your password was just changed.',
    heading: 'Your password was changed',
    intro: 'This is a confirmation that the password for your account was just changed.',
    ignoreNote: "If you didn't make this change, please reset your password immediately and contact your administrator.",
  },
  adminApprovalPending: {
    subject: 'A new user is awaiting approval on {{ appTitle }}',
    preheader: 'A self-registered user needs your approval.',
    heading: 'A user is awaiting approval',
    intro: 'A new user has registered and is waiting for an administrator to approve their account:',
    cta: 'Review users',
  },
  emailChange: {
    subject: 'Confirm your new email address for {{ appTitle }}',
    preheader: 'Confirm your new email address.',
    heading: 'Confirm your new email address',
    intro: 'A request was made to change the email address for your account to this one. Click the button below to confirm the change.',
    cta: 'Confirm new email',
    expiresNote: 'This confirmation link expires in 24 hours.',
    ignoreNote: "If you didn't request this change, you can safely ignore this email — your address will stay the same.",
  },
  common: {
    footerTagline: 'Empower the team with sharing your knowledge.',
    linkFallback: "If the button above doesn't work, copy and paste this URL into your browser:",
  },
};
