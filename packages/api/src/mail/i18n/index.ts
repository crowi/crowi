/**
 * Lightweight i18n for transactional emails. The api has no general
 * i18n runtime (the web uses paraglide), so mail strings live here as
 * typed TS catalogs — one per language, structurally identical (the
 * `MailCatalog` type guarantees no key drifts between en and ja).
 *
 * Catalog strings are brand-neutral and contain NO `{{ }}` placeholders
 * (except `subject`, which the MailService renders standalone). Dynamic
 * brand values (appTitle / appUrl / logoUrl / link URLs) come from
 * `vars` and are placed by the MJML template structure, because a string
 * injected via `{{ t.invite.intro }}` is not re-scanned for further
 * placeholders.
 */
import { en } from './en';
import { ja } from './ja';

/** Strings for one email type. */
export interface MailMessageStrings {
  /** Subject line. MAY contain `{{ appTitle }}` (rendered standalone). */
  subject: string;
  /** Hidden inbox-preview text. */
  preheader: string;
  /** Main heading. */
  heading: string;
  /** Lead paragraph. */
  intro: string;
  /** Call-to-action button label. */
  cta: string;
  /** Note about the link's expiry. */
  expiresNote: string;
  /** "If you didn't expect this, ignore it" note. */
  ignoreNote: string;
}

export interface MailCatalog {
  invite: MailMessageStrings;
  activation: MailMessageStrings;
  passwordReset: MailMessageStrings;
  common: {
    /** Small line under the footer logo. */
    footerTagline: string;
    /** Fallback line: "If the button doesn't work, copy this URL". */
    linkFallback: string;
  };
}

const CATALOGS: Record<'en' | 'ja', MailCatalog> = { en, ja };

/**
 * Resolve a `MailCatalog` for a user language. Normalises regional
 * variants (`en-US` / `en-GB` → `en`) and falls back to English for
 * unknown / missing languages.
 */
export function getMailCatalog(lang?: string): MailCatalog {
  if (lang && lang.toLowerCase().startsWith('ja')) {
    return CATALOGS.ja;
  }
  return CATALOGS.en;
}
