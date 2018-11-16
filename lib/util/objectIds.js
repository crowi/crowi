module.exports = {
  unique(objectIds) {
    return Object.values(objectIds.reduce((objects, object) => ({ ...objects, [object.toString()]: object }), {}))
  },
  difference(objectIds, pull) {
    const ids = pull.map(object => object.toString())

    return objectIds.filter(object => !ids.includes(object.toString()))
  },
}
