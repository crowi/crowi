const path = require('path')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const OptimizeCssAssetsPlugin = require('optimize-css-assets-webpack-plugin')

const isProduction = process.env.NODE_ENV === 'production'

const ROOT = path.join(__dirname, '/../../')

const extractSass = new MiniCssExtractPlugin({
  filename: '[name].css',
})

const config = {
  mode: process.env.NODE_ENV,
  entry: {
    crowi: './resource/css/crowi.scss',
  },
  output: {
    path: path.join(ROOT, 'public/css'),
    filename: '[name].css',
  },
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.scss$/,
        use: extractSass.loader,
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
  stats: {
    colors: true,
    errorDetails: true,
  },
}

module.exports = config
