const ObjectIdsUtil = require(`${ROOT_DIR}/lib/util/objectIds`)
const { unique, difference } = ObjectIdsUtil
const utils = require('../utils.js')
const mongoose = utils.mongoose
const ObjectId = mongoose.Types.ObjectId

describe('ObjectIdsUtil', () => {
  const ids = Array.from(Array(5)).map(() => ObjectId())

  describe('unique', () => {
    test('elements is unique', () => {
      const a = [ids[0], ids[3]]
      expect(unique(a)).toHaveLength(2)
      expect(unique(a)).toContain(ids[0])
      expect(unique(a)).toContain(ids[3])
    })

    test('duplicate elements is exists', () => {
      const a = [ids[0], ids[1], ids[1], ids[0]]
      expect(unique(a)).toHaveLength(2)
      expect(unique(a)).toContain(ids[0])
      expect(unique(a)).toContain(ids[1])
    })
  })

  describe('difference', () => {
    it('pull no elements', () => {
      const a = [ids[1], ids[2]]
      const b = [ids[0], ids[4]]
      expect(difference(a, b)).toHaveLength(2)
      expect(difference(a, b)).toContain(ids[1])
      expect(difference(a, b)).toContain(ids[2])
    })

    it('pull some elements', () => {
      const a = [ids[0], ids[1], ids[2]]
      const b = [ids[1], ids[2], ids[3]]
      expect(difference(a, b)).toHaveLength(1)
      expect(difference(a, b)).toContain(ids[0])
    })
  })
})
