import * as vscode from 'vscode'
import { IMdSearchExtension } from '../types'
import { randomUUID } from 'crypto'

export class HtmlTemplate {
  public static getWebviewHtml(
    extension: IMdSearchExtension,
    webview: vscode.Webview
  ): string {
    const isProduction = extension.isProduction
    const port = 9099 // Updated to match vite config
    const extensionUri = extension.context.extensionUri

    const nonce = Buffer.from(randomUUID()).toString('base64')

    // Generate URI for the entry point
    const scriptUri = isProduction
      ? webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'SearchReplaceView.js')
      )
      : `http://localhost:${port}/src/frontend/views/SearchReplaceViewEntry.tsx`

    const stylesUri = isProduction
      ? webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'SearchReplaceView.css')
      )
      : `http://localhost:${port}/src/frontend/views/SearchReplaceView.css`

    // Icon paths
    const codiconsUri = isProduction
      ? webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'codicons')
      )
      : webview.asWebviewUri(
        vscode.Uri.joinPath(
          extensionUri,
          'node_modules',
          '@vscode/codicons',
          'dist'
        )
      )

    const materialIconsUri = isProduction
      ? webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'icons'))
      : webview.asWebviewUri(
        vscode.Uri.joinPath(
          extensionUri,
          'node_modules',
          'vscode-material-icons',
          'generated',
          'icons'
        )
      )

    const scriptTag = isProduction
      ? `<script nonce="${nonce}" src="${scriptUri}"></script>`
      : `<script type="module" src="${scriptUri}"></script>`

    // In Vite dev mode, we need to inject the vite client and react refresh preamble
    const viteHead = !isProduction
      ? `
    <script type="module">
      import RefreshRuntime from "http://localhost:${port}/@react-refresh"
      RefreshRuntime.injectIntoGlobalHook(window)
      window.$RefreshReg$ = () => {}
      window.$RefreshSig$ = () => (type) => type
      window.__vite_plugin_react_preamble_installed__ = true
    </script>
    <script type="module" src="http://localhost:${port}/@vite/client"></script>
    `
      : ''

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${viteHead}
  ${isProduction
        ? `<link rel="stylesheet" type="text/css" href="${stylesUri}">`
        : ''
      } 
  <link rel="stylesheet" type="text/css" href="${codiconsUri}/codicon.css">
  <title>Search & Replace</title>
</head>
<body style="padding: 0;">
  <div id="root"></div>
  <script>
    window.codiconsPath = "${codiconsUri}";
    window.materialIconsPath = "${materialIconsUri}";
  </script>
  ${scriptTag}
</body>
</html>`
  }
}
