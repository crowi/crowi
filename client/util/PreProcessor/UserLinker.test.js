import CrowiRenderer from '../CrowiRenderer'
import UserLinker from './UserLinker'

const userNames = ['test', 'te-st', 'te.st', 'te_st']
const crowi = {
  getConfig: jest.fn().mockReturnValue({ env: {} }),
  findUser: jest.fn(username => ({ _id: userNames.indexOf(username) })),
}
const Renderer = new CrowiRenderer(crowi)
const Processor = new UserLinker(crowi)

describe('UserLinker', () => {
  test('Replace user names', () => {
    expect(Processor.process(Renderer.lex('test @test'))[0]).toHaveProperty('text', 'test <a class="mention" data-id="0" href="/user/test">@test</a>')
    expect(Processor.process(Renderer.lex('test @te-st'))[0]).toHaveProperty('text', 'test <a class="mention" data-id="1" href="/user/te-st">@te-st</a>')
    expect(Processor.process(Renderer.lex('test @te.st'))[0]).toHaveProperty('text', 'test <a class="mention" data-id="2" href="/user/te.st">@te.st</a>')
    expect(Processor.process(Renderer.lex('test @te_st'))[0]).toHaveProperty('text', 'test <a class="mention" data-id="3" href="/user/te_st">@te_st</a>')
  })

  test("Don't replace in code block", () => {
    const code = text => '```\n' + text + '```\n'
    expect(Processor.process(Renderer.lex(code('@test')))[0]).toHaveProperty('text', '@test')
    expect(Processor.process(Renderer.lex(code('@te-st')))[0]).toHaveProperty('text', '@te-st')
    expect(Processor.process(Renderer.lex(code('@te.st')))[0]).toHaveProperty('text', '@te.st')
    expect(Processor.process(Renderer.lex(code('@te_st')))[0]).toHaveProperty('text', '@te_st')
  })
})
