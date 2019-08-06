import request from 'supertest'
import { app } from '../../setup'

describe('Routes /_api/versions test', () => {
  describe('/_api/versions.get', () => {
    it('should returns crowi version', done => {
      request(app)
        .get('/_api/versions.get')
        .expect('Content-Type', /json/)
        .expect(200)
        .then(res => {
          const body = res.body

          expect(body.ok).toBe(true)
          expect(body.version).toBe(require('../../../package.json').version)

          done()
        })
    })
  })
})
