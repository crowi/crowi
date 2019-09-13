/**
 * OPINIONED date formatter to use browser locale by default
 */

import { format as dateFnsFormat, Locale, parseISO, formatDistance as dateFnsFormatDistance } from 'date-fns'
import { enGB, enUS, ja } from 'date-fns/locale'

const locales = { enGB, enUS, ja }

type DateInput = Date | string | number

const locale: Locale = (() => {
  // memo: may not region, but date-fns/locale has only pair of those
  const [language, region] = (navigator.userLanguage || navigator.language || '').split('-')
  return ja || locales[language + region] || locales[language] || locales.enUS
})()

function sanitizeDateInputForDateFns(input: DateInput) {
  return typeof input === 'string' ? parseISO(input) : input
}

export default function format(date: DateInput, format: string) {
  return dateFnsFormat(sanitizeDateInputForDateFns(date), format, { locale })
}

export function formatToLocaleString(date: DateInput) {
  return format(date, 'PPpp')
}

export function formatDistance(date: DateInput | number, base: DateInput) {
  return dateFnsFormatDistance(sanitizeDateInputForDateFns(date), sanitizeDateInputForDateFns(base), { locale, addSuffix: true })
}

export function formatDistanceFromNow(date: DateInput) {
  return formatDistance(date, Date.now())
}
