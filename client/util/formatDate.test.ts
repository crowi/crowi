import { formatDistance, formatToLocaleString, defaultEnvironment, Environment } from './formatDate'
import { subDays } from 'date-fns'
import { ja, enUS } from 'date-fns/locale'

// memo(otofune): This requires that process.env.TZ equals to 'UTC'. (;;)

const jaEnvironment: Environment = { getLocale: () => ja }
const enUSEnvironment: Environment = { getLocale: () => enUS }

describe('format-date utility', () => {
  describe('defaultEnvironment', () => {
    let languageSpy: jest.SpyInstance
    beforeAll(() => {
      languageSpy = jest.spyOn(window.navigator, 'language', 'get')
    })
    afterEach(() => {
      languageSpy.mockReset()
    })

    describe('with "ja-JP" locale', () => {
      beforeEach(() => {
        languageSpy.mockReturnValue('ja-JP')
      })
      it('navigaror.language must be ja-JP', () => {
        expect(navigator.language).toBe('ja-JP')
      })
      it('getLocale must return ja locale', () => {
        expect(defaultEnvironment.getLocale()).toBe(ja)
      })
    })
    describe('with "ja" locale', () => {
      beforeEach(() => {
        languageSpy.mockReturnValue('ja')
      })
      it('navigaror.language must be ja', () => {
        expect(navigator.language).toBe('ja')
      })
      it('getLocale must return ja locale', () => {
        expect(defaultEnvironment.getLocale()).toBe(ja)
      })
    })
    describe('with "en" locale', () => {
      beforeEach(() => {
        languageSpy.mockReturnValue('en')
      })
      it('navigaror.language must be en', () => {
        expect(navigator.language).toBe('en')
      })
      it('getLocale must return enUS locale', () => {
        expect(defaultEnvironment.getLocale()).toBe(enUS)
      })
    })
    describe('with "de-DE" locale (unsupported)', () => {
      beforeEach(() => {
        languageSpy.mockReturnValue('de-DE')
      })
      it('navigaror.language must be de-DE', () => {
        expect(navigator.language).toBe('de-DE')
      })
      it('getLocale must return enUS locale', () => {
        expect(defaultEnvironment.getLocale()).toBe(enUS)
      })
    })
  })

  describe('formatToLocaleString', () => {
    it('with ja environment', () => {
      expect(formatToLocaleString('2019-09-29T03:01:21.200Z', jaEnvironment)).toBe('2019/09/29 3:01:21')
    })
    it('with en environment', () => {
      expect(formatToLocaleString('2019-09-29T03:01:21.200Z', enUSEnvironment)).toBe('Sep 29, 2019, 3:01:21 AM')
    })
  })

  describe('formatDistance', () => {
    it('must include suffix (ago)', () => {
      const d = subDays(Date.now(), 3)
      expect(formatDistance(d, Date.now(), enUSEnvironment)).toBe('3 days ago')
    })
    it('must include suffix (前)', () => {
      const d = subDays(Date.now(), 3)
      expect(formatDistance(d, Date.now(), jaEnvironment)).toBe('3日前')
    })
  })
})
