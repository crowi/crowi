/**
 * OPINIONED date formatter to use browser locale by default
 */

import { format as dateFnsFormat, Locale, parseISO, formatDistance as dateFnsFormatDistance } from 'date-fns'
import { enUS, ja } from 'date-fns/locale'

const locales = { enUS, ja } as const

type ISO8601String = string
type DateInput = Date | ISO8601String | number

let locale: Locale | undefined
/**
 * selectLocale: Select date-fns locale by user setting. (currently from browser locale)
 *
 * If there are no apporopriate locale to match user setting, use en-US locale.
 */
function selectLocale(): Locale {
  // currently, the locale is uniquely determined at first run. so we can cache it.
  if (locale) return locale

  // TODO: choose language locale by crowi setting
  const [language, region] = (navigator.userLanguage || navigator.language || '').split('-')
  return (locale = locales[language + region] || locales[language] || locales.enUS)
}

function sanitizeDateInputForDateFns(input: DateInput) {
  return typeof input === 'string' ? parseISO(input) : input
}

export default function format(date: DateInput, format: string, locale = selectLocale()) {
  return dateFnsFormat(sanitizeDateInputForDateFns(date), format, { locale })
}

export function formatToLocaleString(date: DateInput) {
  return format(date, 'PPpp')
}

export function formatDistance(date: DateInput | number, base: DateInput, locale = selectLocale()) {
  return dateFnsFormatDistance(sanitizeDateInputForDateFns(date), sanitizeDateInputForDateFns(base), { locale, addSuffix: true })
}

export function formatDistanceFromNow(date: DateInput) {
  return formatDistance(date, Date.now())
}
