
const webpack = require('webpack');

const custom = require('../webpack/client/webpack.script.js');

module.exports = {
  core: {
    builder: "webpack5",
  },
  stories: ['../client/components/**/*.stories.tsx'],
  addons: [
    {
      name: '@storybook/addon-postcss',
      options: {
        postcssLoaderOptions: {
          implementation: require('postcss'),
        },
      },
    },
  ],
  webpackFinal: async (config, { configType }) => {
    config.plugins.push(
      new webpack.ProvidePlugin({
        $: 'jquery',
        jQuery: 'jquery',
      }),
    );
    return { ...config, module: { ...config.module, rules: custom.module.rules } };
  },
}