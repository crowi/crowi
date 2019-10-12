const proxy = require('http-proxy-middleware')

module.exports = router => router.use('/_api', proxy({ target: 'http://0.0.0.0:3000', changeOrigin: true }))
