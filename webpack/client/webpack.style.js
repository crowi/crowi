const path = require('path')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const OptimizeCssAssetsPlugin = require('optimize-css-assets-webpack-plugin')

const isProduction = process.env.NODE_ENV === 'production'

const ROOT = path.join(__dirname, '/../../')

const config = {
  mode: process.env.NODE_ENV,
  entry: {
    crowi: './resource/css/crowi.scss',
    'crowi-reveal': './resource/css/crowi-reveal.scss',
  },
  output: {
    path: path.join(ROOT, 'public/css'),
    filename: '[name].css',
  },
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.s[ac]ss$/,
        use: [
          'style-loader',
          'css-loader',
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
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
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
  plugins: [
    new MiniCssExtractPlugin({
      filename: '[name].css',
    }),
  ],
  // optimization: {
  //  minimizer: [...(isProduction ? [new OptimizeCssAssetsPlugin()] : [])],
  // },
  stats: {
    colors: true,
    errorDetails: true,
  },
}

// if (isProduction) {
//  config.optimization = {
//    minimizer: [new OptimizeCssAssetsPlugin({
//      filename: '[name].min.css',
//    })],
//  }
// }

module.exports = config
