import { parseQuery } from 'server/service/query'

describe('parseQuery', () => {
  const cases = [
    [
      `test`,
      {
        keywords: {
          positive: ['test'],
          negative: [],
        },
        phrases: {
          positive: [],
          negative: [],
        },
      },
    ],
    [
      `"test"`,
      {
        keywords: {
          positive: [],
          negative: [],
        },
        phrases: {
          positive: ['test'],
          negative: [],
        },
      },
    ],
    [
      `-test`,
      {
        keywords: {
          positive: [],
          negative: ['test'],
        },
        phrases: {
          positive: [],
          negative: [],
        },
      },
    ],
    [
      `-"test"`,
      {
        keywords: {
          positive: [],
          negative: [],
        },
        phrases: {
          positive: [],
          negative: ['test'],
        },
      },
    ],
    [
      `--test`,
      {
        keywords: {
          positive: [],
          negative: ['-test'],
        },
        phrases: {
          positive: [],
          negative: [],
        },
      },
    ],
    [
      `-`,
      {
        keywords: {
          positive: [],
          negative: [],
        },
        phrases: {
          positive: [],
          negative: [],
        },
      },
    ],
    [
      `-""`,
      {
        keywords: {
          positive: [],
          negative: [],
        },
        phrases: {
          positive: [],
          negative: [],
        },
      },
    ],
    [
      `"-"`,
      {
        keywords: {
          positive: [],
          negative: [],
        },
        phrases: {
          positive: ['-'],
          negative: [],
        },
      },
    ],
    [
      `"-test"`,
      {
        keywords: {
          positive: [],
          negative: [],
        },
        phrases: {
          positive: ['-test'],
          negative: [],
        },
      },
    ],
    [
      `test test "crowi markdown" -memo -"user"`,
      {
        keywords: {
          positive: ['test', 'test'],
          negative: ['memo'],
        },
        phrases: {
          positive: ['crowi markdown'],
          negative: ['user'],
        },
      },
    ],
  ] as const
  it('should parse query', () => {
    for (const [input, output] of cases) {
      expect(parseQuery(input)).toEqual(output)
    }
  })
})
