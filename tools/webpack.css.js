const path = require('path')
const ExtractTextPlugin = require('extract-text-webpack-plugin')
const OptimizeCssAssetsPlugin = require('optimize-css-assets-webpack-plugin')

const isProduction = process.env.NODE_ENV === 'production'

const extractSass = new ExtractTextPlugin({
  filename: '[name].css',
})

const config = {
  mode: process.env.NODE_ENV,
  entry: {
    crowi: './resource/css/crowi.scss',
    'crowi-reveal': './resource/css/crowi-reveal.scss',
  },
  output: {
    path: path.join(__dirname, '/../public/css'),
    filename: '[name].css',
  },
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.scss$/,
        use: extractSass.extract({
          use: [
            {
              loader: 'css-loader',
              options: { url: false },
            },
            {
              loader: 'sass-loader',
              options: {
                includePaths: ['./node_modules/bootstrap/scss', './node_modules/@fortawesome/fontawesome-free-webfonts/scss', './node_modules/reveal.js/css'],
              },
            },
          ],
          fallback: 'style-loader',
        }),
      },
      {
        test: /\.woff2?$|\.ttf$|\.eot$|\.svg$/,
        use: [
          {
            loader: 'file-loader',
          },
        ],
      },
    ],
  },
  plugins: [extractSass, ...(isProduction ? [new OptimizeCssAssetsPlugin()] : [])],
}

module.exports = config
