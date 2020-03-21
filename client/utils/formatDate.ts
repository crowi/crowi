/**
 * OPINIONED date formatter to use browser locale by default.
 * Also this treats given string as ISO8601 datetime input. date-fns reduced its function.
 */

import { format as dateFnsFormat, Locale, parseISO, formatDistance as dateFnsFormatDistance } from 'date-fns'
import { enUS, ja } from 'date-fns/locale'

const locales = { enUS, ja } as const

type ISO8601String = string
type DateInput = Date | ISO8601String | number

export interface Environment {
  getLocale(): Locale
}

/**
 * defaultEnvironment: Suggest user environment by browser setting.
 * In the future may use environment that accepts set locale value from crowi instance.
 */
export const defaultEnvironment: Environment = {
  /**
   * getLocale: Select date-fns locale.
   * If there are no apporopriate locale to match user setting, use en-US locale.
   */
  getLocale() {
    // TODO: choose language locale by crowi setting
    const [language, region] = (navigator.userLanguage || navigator.language || '').split('-')
    return locales[language + region] || locales[language] || locales.enUS
  },
}

function sanitizeDateInputForDateFns(input: DateInput) {
  return typeof input === 'string' ? parseISO(input) : input
}

export default function format(date: DateInput, format: string, environment: Environment = defaultEnvironment) {
  return dateFnsFormat(sanitizeDateInputForDateFns(date), format, { locale: environment.getLocale() })
}
export function formatToLocaleString(date: DateInput, environment: Environment = defaultEnvironment) {
  return format(date, 'PPpp', environment)
}

export function formatDistance(date: DateInput | number, base: DateInput, environment: Environment = defaultEnvironment) {
  return dateFnsFormatDistance(sanitizeDateInputForDateFns(date), sanitizeDateInputForDateFns(base), { locale: environment.getLocale(), addSuffix: true })
}
export function formatDistanceFromNow(date: DateInput, environment: Environment = defaultEnvironment) {
  return formatDistance(date, Date.now(), environment)
}
