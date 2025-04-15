/* eslint-disable */

const path = require('path')
const isProduction = process.env.NODE_ENV === 'production'
const port = 8378
const MiniCssExtractPlugin = require('mini-css-extract-plugin')

module.exports = {
  mode: isProduction ? 'production' : 'development',
  entry: {
    SearchReplaceView: './src/SearchReplaceView/SearchReplaceViewEntry.tsx',
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'out'),
    ...(isProduction ? {} : { publicPath: `http://0.0.0.0:${port}/` }),
  },
  devtool: 'inline-source-map',
  devServer: {
    hot: true,
    port,
    allowedHosts: 'all',
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  },
  resolve: {
    mainFields: ['browser', 'module', 'main'], // look for `browser` entry point in imported node modules
    importsFields: ['browser', 'module', 'main'],
    extensions: ['.js', '.ts', '.tsx'],
  },
  plugins: [new MiniCssExtractPlugin()],
  module: {
    rules: [
      {
        test: /\.tsx?$/,
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
        test: /\.css$/i,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
      {
        test: /\.(woff|woff2|ttf)$/i,
        type: 'asset/resource',
        generator: {
          filename: 'fonts/[name][ext]' // Output fonts to a subdirectory
        }
      },
    ],
  },
}
