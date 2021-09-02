const path = require('path')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const RemoveEmptyScriptsPlugin = require('webpack-remove-empty-scripts')
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin')

const isProduction = process.env.NODE_ENV === 'production'

const ROOT = path.join(__dirname, '/../../')

const config = {
  mode: process.env.NODE_ENV,
  entry: {
    'crowi-style': './resource/css/crowi.scss',
    'crowi-reveal': './resource/css/crowi-reveal.scss',
  },
  output: {
    path: path.resolve(ROOT, 'public/css'),
  },
  devtool: 'source-map',
  plugins: [
    new MiniCssExtractPlugin({
      filename: '[name].css',
    }),
    new RemoveEmptyScriptsPlugin(),
  ],
  module: {
    rules: [
      {
        test: /\.scss$/,
        use: [
          {
            loader: MiniCssExtractPlugin.loader,
          },
          {
            loader: 'css-loader',
            options: {
              url: false,
              importLoaders: 2,
            },
          },
          {
            loader: 'sass-loader',
            options: {
              sassOptions: {
                includePaths: ['./node_modules/bootstrap/scss', './node_modules/reveal.js/css'],
              },
            },
          },
        ],
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
  optimization: {
    minimizer: [new CssMinimizerPlugin()],
  },
  stats: {
    colors: true,
    errorDetails: true,
  },
}

module.exports = config
