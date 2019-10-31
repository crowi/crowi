import renderIcon from 'common/functions/renderIcon'

describe('renderIcon test', () => {
  test('renderIcon', () => {
    expect(renderIcon('AAA')).toEqual('<svg viewBox="0 0 24 24" role="presentation" class="mdi-svg"><path d="AAA"></path></svg>')
    expect(renderIcon('BBB', ['mdi-spin'])).toEqual('<svg viewBox="0 0 24 24" role="presentation" class="mdi-svg mdi-spin"><path d="BBB"></path></svg>')
    expect(renderIcon('CCC', ['mdi-spin', 'text-danger'])).toEqual(
      '<svg viewBox="0 0 24 24" role="presentation" class="mdi-svg mdi-spin text-danger"><path d="CCC"></path></svg>',
    )
    expect(renderIcon('DDD', [], 'style="display: none;"')).toEqual(
      '<svg viewBox="0 0 24 24" role="presentation" class="mdi-svg" style="display: none;"><path d="DDD"></path></svg>',
    )
  })
})
