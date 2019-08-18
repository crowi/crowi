const path = require('path')
const webpack = require('webpack')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin')

const ROOT = path.join(__dirname, '/../../')

const config = {
  mode: process.env.NODE_ENV,
  entry: {
    bundled: [
      'jquery',
      'bootstrap/dist/js/bootstrap.bundle.min.js',
      'inline-attachment/src/inline-attachment.js',
      'jquery.cookie',
      'jquery.selection.js',
      '@babel/polyfill',
    ],
    app: path.join(ROOT, 'client/app.tsx'),
    crowi: path.join(ROOT, 'client/crowi.ts'),
    presentation: path.join(ROOT, 'client/crowi-presentation.ts'),
    form: path.join(ROOT, 'client/crowi-form.ts'),
    installer: path.join(ROOT, 'client/crowi-installer.ts'),
  },
  output: {
    path: path.join(ROOT, 'public/js'),
    filename: '[name].js',
  },
  devtool: 'source-map',
  resolve: {
    modules: ['./node_modules', './client/thirdparty-js'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
  module: {
    rules: [
      {
        test: /\.ya?ml$/,
        exclude: /node_modules/,
        use: ['json-loader', 'yaml-loader'],
      },
      {
        test: /.(ts|js)x?$/,
        exclude: /node_modules/,
        loader: 'babel-loader',
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
      { from: path.join(ROOT, 'node_modules/reveal.js/lib/font'), to: path.join(ROOT, 'public/css/reveal/lib/font') },
      { from: path.join(ROOT, 'node_modules/reveal.js/lib/css'), to: path.join(ROOT, 'public/js/reveal/lib/css') },
      { from: path.join(ROOT, 'node_modules/reveal.js/lib/js'), to: path.join(ROOT, 'public/js/reveal/lib/js') },
      { from: path.join(ROOT, 'node_modules/reveal.js/plugin'), to: path.join(ROOT, 'public/js/reveal/plugin/') },
    ]),
    new ForkTsCheckerWebpackPlugin(),
  ],
  stats: {
    colors: true,
    errorDetails: true,
  },
}

module.exports = config
