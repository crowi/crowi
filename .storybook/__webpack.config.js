const webpack = require('webpack');

module.exports = ({ config }) => {
  return config;
/* 
  return { ...config, 
    module: {
      rules: [
        {
          test: /\.ya?ml$/,
          exclude: /node_modules/,
          use: ['json-loader', 'yaml-loader'],
        },
        {
          test: /\.(ts|tsx)$/,
          loader: require.resolve('babel-loader'),
          options: {
            presets: [['react-app', { flow: false, typescript: true }]],
          },
        }
      ],
    },
    resolve: {
      extensions: ['.ts', '.tsx'],
    },
    plugins: [
      new webpack.ProvidePlugin({
        $: 'jquery',
        jQuery: 'jquery',
      }),
    ]
  }; */

}
