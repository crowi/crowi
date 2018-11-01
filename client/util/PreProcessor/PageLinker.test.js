import CrowiRenderer from '../CrowiRenderer'
import PageLinker from './PageLinker'

const crowi = {
  getConfig: jest.fn().mockReturnValue({ env: {} }),
}
const Renderer = new CrowiRenderer(crowi)
const Processor = new PageLinker(crowi)

describe('PageLinker', () => {
  test('Link urls', () => {
    const url = '[/test]'
    const linked = `<a href="/test">/test</a>`
    expect(Processor.process(Renderer.lex(url))[0]).toHaveProperty('text', linked)
    expect(Processor.process(Renderer.lex(`test ${url}`))[0]).toHaveProperty('text', `test ${linked}`)
  })

  test("Don't link in code block", () => {
    const code = text => '```\n' + text + '```\n'
    expect(Processor.process(Renderer.lex(code('[/test]')))[0]).toHaveProperty('text', '[/test]')
  })
})
