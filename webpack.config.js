const path = require('path');
const webpack = require('webpack');
const CleanWebpackPlugin = require('clean-webpack-plugin');
const ExtractTextPlugin = require("extract-text-webpack-plugin");
const WebpackManifestPlugin = require('webpack-manifest-plugin');

const webpackConfig = [];
const config = {
  entry: {
    bundled:       [
      'jquery',
      'bootstrap-sass',
      'inline-attachment/src/inline-attachment.js',
      'jquery.cookie',
      './resource/thirdparty-js/jquery.selection.js',
      'babel-polyfill',
    ],
    app:          './resource/js/app.js',
    crowi:        './resource/js/crowi.js',
    presentation: './resource/js/crowi-presentation.js',
    form:         './resource/js/crowi-form.js',
    admin:        './resource/js/crowi-admin.js',
  },
  output: {
    path: path.join(__dirname + "/public/js"),
    filename: "[name].[hash].js"
  },
  devtool: 'inline-source-map',
  resolve: {
    modules: [
      './node_modules', './resource/thirdparty-js',
    ],
  },
  module: {
    rules: [
      {
        test: /.jsx?$/,
        exclude: /node_modules/,
        use: [{
          loader: 'babel-loader',
        }]
      },
    ]
  },
  plugins: [
    new CleanWebpackPlugin(['./public/js']),
    new webpack.optimize.CommonsChunkPlugin({
      name: "bundled",
      minChunks: Infinity,
    }),
    new webpack.ProvidePlugin({
      $: 'jquery',
      jQuery: 'jquery'
    })
  ],
};

if (process.env && process.env.NODE_ENV !== 'development') {
  config.plugins.push(
    new webpack.DefinePlugin({
      'process.env':{
        'NODE_ENV': JSON.stringify('production')
      }
    }),
    new webpack.optimize.UglifyJsPlugin({
      compress:{
        warnings: false
      }
    })
  );
}

config.plugins.push(new WebpackManifestPlugin());

const extractSass = new ExtractTextPlugin({
  filename: "[name].css",
});
const cssConfig = {
  entry: {
    crowi: './resource/css/crowi.scss',
  },
  output: {
    path: path.join(__dirname + "/public/css"),
    filename: "[name].css"
  },
  devtool: "source-map",
  module: {
    rules: [
      {
        test: /\.scss$/,
        use: extractSass.extract({
          use: [{
            loader: "css-loader",
            options: {
              url: false,
              minimize: process.env.NODE_ENV !== 'development',
            }
          }, {
            loader: "sass-loader",
            options: {
              includePaths: [
                './node_modules/bootstrap-sass/assets/stylesheets',
                './node_modules/font-awesome/scss',
                './node_modules/reveal.js/css',
              ]
            }
          }],
          fallback: "style-loader"
        })
      },
      {
        test: /\.woff2?$|\.ttf$|\.eot$|\.svg$/,
        use: [{
          loader: "file-loader"
        }]
      }
    ]
  },
  plugins: [
    //new CleanWebpackPlugin(['./public/css']),
    extractSass,
    //new ExtractTextPlugin(
    //  './node_modules/highlight.js/styles/tomorrow-night.css'
    //),
    //new ExtractTextPlugin([
    //  './node_modules/highlight.js/styles/tomorrow-night.css',
    //  './node_modules/diff2html/dist/diff2html.css',
    //]),
  ],
};

module.exports = [config, cssConfig];

