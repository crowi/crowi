const webpack = require('webpack');

module.exports = ({ config }) => {
  config.module.rules.push({
    test: /\.ya?ml$/,
    exclude: /node_modules/,
    use: ['json-loader', 'yaml-loader'],
  })
  config.module.rules.push({
    test: /\.(ts|tsx)$/,
    loader: require.resolve('babel-loader'),
    options: {
      presets: [['react-app', { flow: false, typescript: true }]],
    },
  });
  config.resolve.extensions.push('.ts', '.tsx')
  config.plugins.push(new webpack.ProvidePlugin({
    $: 'jquery',
    jQuery: 'jquery',
  }))

  return config
}
