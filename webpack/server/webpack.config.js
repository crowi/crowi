const path = require('path')
const nodeExternals = require('webpack-node-externals')
const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin')

const ROOT = path.join(__dirname, '/../../')

const config = {
  mode: process.env.NODE_ENV,
  target: 'node',
  node: {
    __dirname: true,
    __filename: true,
  },
  externals: [nodeExternals()],
  entry: path.join(ROOT, 'lib/app.ts'),
  output: {
    path: path.join(ROOT, 'dist/server'),
    filename: 'app.js',
  },
  resolve: {
    plugins: [new TsconfigPathsPlugin({ configFile: path.join(ROOT, 'tsconfig.server.json') })],
    modules: ['./node_modules'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
  module: {
    rules: [
      {
        test: /.(ts|js)x?$/,
        exclude: /node_modules/,
        loader: 'ts-loader',
        options: {
          configFile: path.join(ROOT, 'tsconfig.server.json'),
        },
      },
    ],
  },
  // plugins: [new webpack.ContextReplacementPlugin(/local_modules/, (context) => {
  //   console.log(context)
  // })],
  stats: {
    colors: true,
    errorDetails: true,
  },
}

module.exports = config
