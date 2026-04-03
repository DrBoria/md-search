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

    // Force production mode (bundled files) to ensure webview loads without running dev server
    // const scriptUri = isProduction
    //   ? webview.asWebviewUri(
    //     vscode.Uri.joinPath(extensionUri, 'out', 'SearchReplaceView.js')
    //   )
    //   : `http://localhost:${port}/src/frontend/views/SearchReplaceViewEntry.tsx`

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'out', 'SearchReplaceView.js')
    )

    // const stylesUri = isProduction
    //   ? webview.asWebviewUri(
    //     vscode.Uri.joinPath(extensionUri, 'out', 'SearchReplaceView.css')
    //   )
    //   : `http://localhost:${port}/src/frontend/views/SearchReplaceView.css`

    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'out', 'SearchReplaceView.css')
    )

    // Icon paths
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'out', 'codicons')
    )

    const materialIconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'out', 'icons')
    )

    const scriptTag = `<script nonce="${nonce}" src="${scriptUri}"></script>`

    // In Vite dev mode, we need to inject the vite client and react refresh preamble
    // const viteHead = !isProduction
    //   ? `
    // <script type="module">
    //   import RefreshRuntime from "http://localhost:${port}/@react-refresh"
    //   RefreshRuntime.injectIntoGlobalHook(window)
    //   window.$RefreshReg$ = () => {}
    //   window.$RefreshSig$ = () => (type) => type
    //   window.__vite_plugin_react_preamble_installed__ = true
    // </script>
    // <script type="module" src="http://localhost:${port}/@vite/client"></script>
    // `
    //   : ''
    const viteHead = ''

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${viteHead}
  <link rel="stylesheet" type="text/css" href="${stylesUri}">
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
