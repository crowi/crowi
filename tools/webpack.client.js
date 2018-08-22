const path = require('path')
const webpack = require('webpack')
const CopyWebpackPlugin = require('copy-webpack-plugin')

const ROOT = path.join(__dirname, '/../')

const config = {
  mode: process.env.NODE_ENV,
  entry: {
    bundled: ['jquery', 'bootstrap-sass', 'inline-attachment/src/inline-attachment.js', 'jquery.cookie', 'jquery.selection.js', 'babel-polyfill'],
    app: path.join(ROOT, 'client/app.js'),
    crowi: path.join(ROOT, 'client/crowi.js'),
    presentation: path.join(ROOT, 'client/crowi-presentation.js'),
    form: path.join(ROOT, 'client/crowi-form.js'),
    admin: path.join(ROOT, 'client/crowi-admin.js'),
    installer: path.join(ROOT, 'client/crowi-installer.js'),
  },
  output: {
    path: path.join(ROOT, 'public/js'),
    filename: '[name].js',
  },
  devtool: 'source-map',
  resolve: {
    modules: ['./node_modules', './client/thirdparty-js'],
  },
  module: {
    rules: [
      {
        test: /\.ya?ml$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'json-loader',
          },
          {
            loader: 'yaml-loader',
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
  optimization: {
    runtimeChunk: 'single',
  },
  plugins: [
    new webpack.ProvidePlugin({
      $: 'jquery',
      jQuery: 'jquery',
    }),
    new CopyWebpackPlugin([
      { from: path.join(ROOT, 'node_modules/reveal.js/css'), to: path.join(ROOT, 'public/css/reveal/css') },
      { from: path.join(ROOT, 'node_modules/reveal.js/lib/css'), to: path.join(ROOT, 'public/js/reveal/lib/css') },
      { from: path.join(ROOT, 'node_modules/reveal.js/lib/js'), to: path.join(ROOT, 'public/js/reveal/lib/js') },
      { from: path.join(ROOT, 'node_modules/reveal.js/plugin'), to: path.join(ROOT, 'public/js/reveal/plugin/') },
    ]),
  ],
}

module.exports = config
