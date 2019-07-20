'use strict'

import '@babel/polyfill'

const testDBUtil = {
  async generateFixture(conn, model, fixture) {
    if (conn.readyState === 0) {
      throw new Error()
    }
    const Model = conn.model(model)
    return Promise.all(fixture.map(entity => new Model(entity).save()))
  },
}
global.testDBUtil = testDBUtil
