/* eslint-disable */

const path = require('path')
const isProduction = process.env.NODE_ENV === 'production'
// Порт для webpack-dev-server webview компонентов
const port = 9099
const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const CopyPlugin = require('copy-webpack-plugin')

module.exports = {
  mode: isProduction ? 'production' : 'development',
  entry: {
    SearchReplaceView: './src/SearchReplaceView/SearchReplaceViewEntry.tsx',
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'out'),
    ...(isProduction
      ? {}
      : {
          publicPath: `http://0.0.0.0:${port}/`,
          devtoolModuleFilenameTemplate: 'webpack:///[resource-path]',
        }),
  },
  devtool: isProduction ? 'source-map' : 'eval-source-map',
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
    alias: {
      // Убедимся, что все иконки будут корректно загружены
      '@vscode/codicons': path.resolve(
        __dirname,
        'node_modules/@vscode/codicons'
      ),
      'vscode-icons-js': path.resolve(
        __dirname,
        'node_modules/vscode-icons-js'
      ),
      'vscode-material-icons': path.resolve(
        __dirname,
        'node_modules/vscode-material-icons'
      ),
    },
  },
  plugins: [
    new MiniCssExtractPlugin(),
    new CopyPlugin({
      patterns: [
        // Копируем шрифты иконок
        {
          from: 'node_modules/vscode-icons-js/dist',
          to: 'icons/'
        },
        // Копируем vscode-material-icons файлы
        {
          from: 'node_modules/vscode-material-icons/generated/icons',
          to: 'material-icons/'
        },
        // Копируем шрифты иконок
        {
          from: 'node_modules/@vscode/codicons/dist/codicon.ttf',
          to: 'fonts/',
        },
        // Копируем CSS иконок
        {
          from: 'node_modules/@vscode/codicons/dist/codicon.css',
          to: 'css/',
        },
      ],
    }),
  ],
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
              compilerOptions: {
                sourceMap: true,
              },
            },
          },
        ],
      },
      {
        test: /\.css$/i,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
      {
        test: /\.(woff|woff2|ttf|eot)$/i,
        type: 'asset/resource',
        generator: {
          filename: 'fonts/[name][ext]', // Output fonts to a subdirectory
        },
      },
      {
        test: /\.(svg|png|jpg|gif)$/i,
        type: 'asset/resource',
        generator: {
          filename: 'images/[name][ext]', // Output images to a subdirectory
        },
      },
    ],
  },
}
