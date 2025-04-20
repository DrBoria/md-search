/* eslint-disable */

const path = require('path')
const webpack = require('webpack')
const isProduction = process.env.NODE_ENV === 'production'
const port = 9098
const CopyPlugin = require('copy-webpack-plugin')

module.exports = {
  mode: isProduction ? 'production' : 'development',
  target: 'node', // vscode extensions run in webworker context for VS Code web 📖 -> https://webpack.js.org/configuration/target/#target
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },
  devtool: 'source-map',
  externals: [
    {
      'astx/node': 'commonjs astx/node',
      prettier: 'commonjs prettier',
      vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    },
  ],
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    mainFields: ['browser', 'module', 'main'], // look for `browser` entry point in imported node modules
    extensions: ['.ts', '.js'],
    alias: {
      'ts-node$': path.resolve(__dirname, 'src', 'ts-node-alias.ts'),
      '@vscode/codicons': path.resolve(
        __dirname,
        'node_modules/@vscode/codicons'
      ),
      'vscode-icons-js': path.resolve(
        __dirname,
        'node_modules/vscode-icons-js'
      ),
    },
    conditionNames: ['import', 'require', 'node'],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'media', to: 'media' },
        {
          from: 'node_modules/@vscode/codicons/dist/codicon.ttf',
          to: 'fonts/',
        },
      ],
    }),
  ],
  module: {
    parser: {
      javascript: {
        commonjsMagicComments: true,
      },
    },
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              transpileOnly: true,
            },
          },
        ],
      },
      {
        test: /\.(woff|woff2|ttf|eot)$/i,
        type: 'asset/resource',
        generator: {
          filename: 'fonts/[name][ext]',
        },
      },
      {
        test: /\.(svg|png|jpg|gif)$/i,
        type: 'asset/resource',
        generator: {
          filename: 'images/[name][ext]',
        },
      },
    ],
  },
}
