module.exports = ({ config }) => {
  config.module.rules.push({
    test: /\.(ts|tsx)$/,
    loader: require.resolve('babel-loader'),
    options: {
      presets: [['react-app', { flow: false, typescript: true }]],
    },
  }, {
    test: /\.ya?ml$/,
    exclude: /node_modules/,
    use: ['json-loader', 'yaml-loader'],
  }
  );
  config.resolve.extensions.push('.ts', '.tsx')
  return config
};
