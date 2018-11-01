import CrowiRenderer from '../CrowiRenderer'
import ImageExpander from './ImageExpander'

const crowi = {
  getConfig: jest.fn().mockReturnValue({ env: {} }),
}
const Renderer = new CrowiRenderer(crowi)
const Processor = new ImageExpander(crowi)

describe('ImageExpander', () => {
  test('Expand image urls', () => {
    const url = 'https://localhost/test.jpg'
    const expanded = `<a href="${url}"><img src="${url}" class="auto-expanded-image"></a>`
    expect(Processor.process(Renderer.lex(url))[0]).toHaveProperty('text', expanded)
    expect(Processor.process(Renderer.lex(`test ${url}`))[0]).toHaveProperty('text', `test ${expanded}`)
  })

  test("Don't link in code block", () => {
    const code = text => '```\n' + text + '```\n'
    expect(Processor.process(Renderer.lex(code('https://localhost/test.jpg')))[0]).toHaveProperty('text', 'https://localhost/test.jpg')
  })
})
