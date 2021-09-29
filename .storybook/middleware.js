const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = router => router.use('/_api', createProxyMiddleware({ target: 'http://0.0.0.0:3000', changeOrigin: true }))
