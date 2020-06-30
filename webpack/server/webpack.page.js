const path = require('path')
const glob = require('glob')
const nodeExternals = require('webpack-node-externals')
const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin')

const ROOT = path.join(__dirname, '/../../')

const fromEntries = (array) =>
  array.reduce((obj, [key, val]) => {
    obj[key] = val
    return obj
  }, {})

const config = {
  mode: process.env.NODE_ENV,
  target: 'node',
  externals: [nodeExternals()],
  entry: fromEntries(
    glob.sync(path.join(ROOT, 'lib/pages/**/*.tsx')).map((entry) => [entry.replace(path.join(ROOT, 'lib'), '').replace('.tsx', '.js'), entry]),
  ),
  output: {
    path: path.join(ROOT, 'dist/server'),
    filename: '[name]',
    libraryTarget: 'commonjs2',
  },
  resolve: {
    plugins: [new TsconfigPathsPlugin({ configFile: path.join(ROOT, 'tsconfig.server.json') })],
    modules: ['./node_modules'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
  module: {
    rules: [
      {
        test: /.ts$/,
        exclude: /node_modules/,
        loader: 'ts-loader',
        options: {
          configFile: path.join(ROOT, 'tsconfig.server.json'),
        },
      },
      {
        test: /.tsx$/,
        exclude: /node_modules/,
        loader: 'babel-loader',
      },
    ],
  },
  stats: {
    colors: true,
    errorDetails: true,
  },
}

module.exports = config
