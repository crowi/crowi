import CrowiRenderer from '../CrowiRenderer'
import SectionFixer from './SectionFixer'

const crowi = {
  getConfig: jest.fn().mockReturnValue({ env: {} }),
}
const Renderer = new CrowiRenderer(crowi)
const Processor = new SectionFixer(crowi)

describe('SectionFixer', () => {
  test('Replace paragraph that starts with # with heading', () => {
    expect(Processor.process(Renderer.lex('#test'))[0]).toEqual({ type: 'heading', text: 'test', depth: 1 })
    expect(Processor.process(Renderer.lex('##test'))[0]).toEqual({ type: 'heading', text: 'test', depth: 2 })
    expect(Processor.process(Renderer.lex('###test'))[0]).toEqual({ type: 'heading', text: 'test', depth: 3 })
    expect(Processor.process(Renderer.lex('####test'))[0]).toEqual({ type: 'heading', text: 'test', depth: 4 })
    expect(Processor.process(Renderer.lex('#####test'))[0]).toEqual({ type: 'heading', text: 'test', depth: 5 })
    expect(Processor.process(Renderer.lex('######test'))[0]).toEqual({ type: 'heading', text: 'test', depth: 6 })
  })

  test("Don't replace paragraph that starts with too long hashes", () => {
    expect(Processor.process(Renderer.lex('#######test'))[0]).toEqual({ type: 'paragraph', text: '#######test' })
  })

  test("Don't replace in code block", () => {
    const code = text => '```\n' + text + '```\n'
    expect(Processor.process(Renderer.lex(code('#test')))[0]).toHaveProperty('text', '#test')
  })
})
