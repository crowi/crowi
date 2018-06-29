const path = require('path')
const webpack = require('webpack')
const CopyWebpackPlugin = require('copy-webpack-plugin')

const isProduction = process.env.NODE_ENV === 'production'

const ROOT = path.join(__dirname, '/../')

const config = {
  entry: {
    bundled: [
      'jquery',
      'bootstrap-sass',
      'inline-attachment/src/inline-attachment.js',
      'jquery.cookie',
      './client/thirdparty-js/jquery.selection.js',
      'babel-polyfill',
    ],
    app: path.join(ROOT, 'client/app.js'),
    crowi: path.join(ROOT, 'client/crowi.js'),
    presentation: path.join(ROOT, 'client/crowi-presentation.js'),
    form: path.join(ROOT, 'client/crowi-form.js'),
    admin: path.join(ROOT, 'client/crowi-admin.js'),
  },
  output: {
    path: path.join(ROOT, 'public/js'),
    filename: '[name].js',
  },
  devtool: 'inline-source-map',
  resolve: {
    modules: ['./node_modules', './client/thirdparty-js'],
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        enforce: 'pre',
        use: [
          {
            loader: 'eslint-loader',
            options: {
              fix: true,
              failOnError: true,
            },
          },
        ],
      },
      {
        test: /.jsx?$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'babel-loader',
          },
        ],
      },
    ],
  },
  plugins: [
    new webpack.optimize.CommonsChunkPlugin({
      name: 'bundled',
      minChunks: Infinity,
    }),
    new webpack.ProvidePlugin({
      $: 'jquery',
      jQuery: 'jquery',
    }),
    new CopyWebpackPlugin([
      { from: path.join(ROOT, 'node_modules/reveal.js/css'), to: path.join(ROOT, 'public/css/reveal/css') },
      { from: path.join(ROOT, 'node_modules/reveal.js/lib/css'), to: path.join(ROOT, 'public/js/reveal/lib/css') },
      { from: path.join(ROOT, 'node_modules/reveal.js/lib/js'), to: path.join(ROOT, 'public/js/reveal/lib/js') },
      { from: path.join(ROOT, 'node_modules/reveal.js/plugin'), to: path.join(ROOT, 'public/js/reveal/plugin/') },
    ])
  ],
}

if (isProduction) {
  config.plugins.push(
    new webpack.DefinePlugin({
      'process.env': {
        NODE_ENV: JSON.stringify('production'),
      },
    }),
    new webpack.optimize.UglifyJsPlugin({
      compress: {
        warnings: false,
      },
    }),
  )
}

module.exports = config
