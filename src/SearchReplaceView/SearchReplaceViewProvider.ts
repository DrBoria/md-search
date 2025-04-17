import * as vscode from 'vscode'
import {
  AstxRunner,
  ProgressEvent,
  TransformResultEvent,
} from '../searchController/SearchRunner'
import { AstxExtension, Params } from '../extension'
import { ASTX_RESULT_SCHEME } from '../constants'
import {
  MessageFromWebview,
  SearchReplaceViewStatus,
  MessageToWebview,
} from './SearchReplaceViewTypes'
import { AstxRunnerEvents } from '../searchController/SearchRunnerTypes'
export class SearchReplaceViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'astx.SearchReplaceView'

  private _view?: vscode.WebviewView

  constructor(
    private extension: AstxExtension,
    private readonly _extensionUri: vscode.Uri = extension.context.extensionUri,
    private readonly runner: AstxRunner = extension.runner
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    }

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)

    const status: SearchReplaceViewStatus = {
      running: false,
      completed: 0,
      total: 0,
      numMatches: 0,
      numFilesThatWillChange: 0,
      numFilesWithMatches: 0,
      numFilesWithErrors: 0,
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webviewView.webview.onDidReceiveMessage((_message: any) => {
      const message: MessageFromWebview = _message
      // Log message type only, without full content
      this.extension.channel.appendLine(
        `[Provider] Received message type: ${message.type}`
      )
      // Make the message handler async to allow await for file operations
      const handleMessage = async (message: MessageFromWebview) => {
        switch (message.type) {
          case 'mount': {
            webviewView.webview.postMessage({
              type: 'values',
              values: this.extension.getParams(),
            })
            webviewView.webview.postMessage({
              type: 'status',
              status,
            })

            break
          }
          case 'values': {
            // @ts-expect-error TS2345: Parser type incompatibility
            this.extension.setParams(message.values)
            break
          }
          case 'replace': {
            // Проверяем, есть ли список файлов для замены
            const filePaths = message.filePaths || []
            this.extension.channel.appendLine(
              `Replace request received with ${filePaths.length} files`
            )

            // Если есть список файлов, фильтруем результаты перед заменой
            if (filePaths.length > 0) {
              // Фильтруем ResultProvider, оставляя только файлы из списка filePaths
              const originalResults =
                this.extension.transformResultProvider.results
              const filteredResults = new Map()

              // Копируем только результаты для файлов из filePaths
              for (const filePath of filePaths) {
                if (originalResults.has(filePath)) {
                  filteredResults.set(filePath, originalResults.get(filePath))
                }
              }

              // Временно заменяем результаты на отфильтрованные
              const tempResults = this.extension.transformResultProvider.results
              this.extension.transformResultProvider.results = filteredResults

              // Выполняем замену
              this.extension.replace()

              // Восстанавливаем оригинальные результаты
              this.extension.transformResultProvider.results = tempResults
            } else {
              // Если список файлов не указан, выполняем обычную замену
              this.extension.replace()
            }
            break
          }
          case 'openFile': {
            const uri = vscode.Uri.parse(message.filePath)
            const range = message.range
              ? new vscode.Range(
                  // Placeholder positions - will be recalculated if possible
                  new vscode.Position(0, 0),
                  new vscode.Position(0, 0)
                )
              : undefined

            // Check if there's a transformed version available to show a diff
            const result = this.extension.transformResultProvider.results.get(
              uri.toString()
            )
            if (
              result &&
              result.transformed &&
              result.transformed !== result.source
            ) {
              const transformedUri = uri.with({ scheme: ASTX_RESULT_SCHEME })
              const filename = uri.path.substring(uri.path.lastIndexOf('/') + 1)
              vscode.commands.executeCommand(
                'vscode.diff',
                uri,
                transformedUri,
                `${filename} ↔ Changes`
              )
            } else {
              if (message.range?.start !== undefined) {
                try {
                  const document = await vscode.workspace.openTextDocument(uri)
                  const textUpToStart = document.getText(
                    new vscode.Range(
                      new vscode.Position(0, 0),
                      document.positionAt(message.range.start)
                    )
                  )
                  const lineNumber = textUpToStart.split('\n').length - 1
                  const calculatedRange = new vscode.Range(
                    new vscode.Position(lineNumber, 0),
                    new vscode.Position(lineNumber, 0)
                  )
                  vscode.window.showTextDocument(uri, {
                    selection: calculatedRange,
                  })
                } catch (error) {
                  this.extension.logError(
                    error instanceof Error
                      ? error
                      : new Error(`Failed to calculate position: ${error}`)
                  )
                  vscode.window.showTextDocument(uri)
                }
              } else {
                vscode.window.showTextDocument(uri)
              }
            }
            break
          }
          // Add case to handle logging messages from webview
          case 'log': {
            // Add logging here to confirm message receipt
            this.extension.channel.appendLine(
              '[Provider] Received log message from webview:'
            )
            const level = message.level.toUpperCase()
            const logMessage = `[Webview ${level}] ${message.message}`

            // Safely log the message without logging sensitive content
            this.extension.channel.appendLine(logMessage)

            // If there's data, only log safe metadata about it
            if (message.data) {
              const dataType = typeof message.data
              this.extension.channel.appendLine(
                `Data properties: ${
                  dataType === 'object' && message.data
                    ? Object.keys(message.data).join(', ')
                    : dataType
                }`
              )
            }
            break
          }
        }
      }
      // Execute the async handler
      handleMessage(message).catch((error) => {
        this.extension.logError(
          error instanceof Error
            ? error
            : new Error(`Error handling webview message: ${error}`)
        )
      })
    })

    const listeners = {
      progress: ({ completed, total }: ProgressEvent) => {
        status.completed = completed
        status.total = total
        webviewView.webview.postMessage({
          type: 'status',
          status,
        })
      },
      result: (e: TransformResultEvent) => {
        if (e.transformed && e.transformed !== e.source) {
          status.numFilesThatWillChange++
        }
        if (e.matches?.length) {
          status.numMatches += e.matches.length
          status.numFilesWithMatches++
        }
        if (e.error) {
          status.numFilesWithErrors++
        }
        webviewView.webview.postMessage({
          type: 'status',
          status,
        })
        // Send the result data to the webview
        const stringifiedEvent = {
          file: e.file.toString(), // Convert URI first
          source: e.source,
          transformed: e.transformed,
          matches: e.matches || [], // Ensure matches is always an array
          reports: e.reports,
          // Serialize error properly for postMessage
          error: e.error
            ? {
                message: e.error.message,
                name: e.error.name,
                stack: e.error.stack,
              }
            : undefined,
        }
        webviewView.webview.postMessage({
          type: 'addResult',
          data: stringifiedEvent,
        })
      },
      start: () => {
        status.running = true
        webviewView.webview.postMessage({
          type: 'status',
          status,
        })
      },
      stop: () => {
        status.running = false
        status.numMatches = 0
        status.numFilesThatWillChange = 0
        status.numFilesWithMatches = 0
        status.numFilesWithErrors = 0
        webviewView.webview.postMessage({
          type: 'status',
          status,
        })
        // Clear results in the webview
        webviewView.webview.postMessage({ type: 'clearResults' })
      },
      done: () => {
        status.running = false
        webviewView.webview.postMessage({
          type: 'status',
          status,
        })
      },
    }

    for (const [event, listener] of Object.entries(listeners)) {
      this.runner.on(event as keyof AstxRunnerEvents, listener)
    }

    webviewView.onDidDispose(() => {
      for (const [event, listener] of Object.entries(listeners)) {
        this.runner.removeListener(event as keyof AstxRunnerEvents, listener)
      }
    })
  }

  setParams(params: Params): void {
    this._view?.webview?.postMessage({
      type: 'values',
      values: params,
    })
  }

  show(): void {
    this._view?.show()
  }

  get visible(): boolean {
    return this._view?.visible ?? false
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    // Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'out', 'SearchReplaceView.js')
    )
    const webpackOrigin = '0.0.0.0:8378' // Use a nonce to only allow a specific script to be run.

    const nonce = getNonce()

    const csp = [
      `default-src 'none'`,
      `img-src ${`vscode-file://vscode-app`} ${webview.cspSource} 'self'`,
      ...(this.extension.isProduction
        ? [
            `script-src 'nonce-${nonce}'`,
            `style-src ${webview.cspSource} 'self' 'unsafe-inline'`,
            `font-src ${webview.cspSource} 'self'`,
          ]
        : [
            `script-src 'unsafe-eval' http://${webpackOrigin}`,
            `style-src ${webview.cspSource} 'self' 'unsafe-inline'`,
            `font-src http://${webpackOrigin} ${webview.cspSource} 'self'`,
            `connect-src http://${webpackOrigin} ws://${webpackOrigin}`,
          ]),
    ]

    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'out', 'SearchReplaceView.css')
    )

    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="${csp.join(';')}">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${codiconsUri}" rel="stylesheet" />
				
				<title>Cat Colors</title>
			</head>
			<body>
        ${
          this.extension.isProduction
            ? `<script nonce="${nonce}" src="${scriptUri}"></script>`
            : `<script src="http://${webpackOrigin}/SearchReplaceView.js"></script>`
        }
			</body>
			</html>`
  }

  postMessage(message: MessageToWebview): void {
    // Log the message type for debugging
    this.extension.channel.appendLine(
      `[SearchReplaceView] Sending message of type: ${message.type}`
    )

    try {
      this._view?.webview.postMessage(message)
    } catch (error) {
      this.extension.channel.appendLine(
        `Error posting message to webview: ${error}`
      )
    }
  }
}

function getNonce(): string {
  let text = ''
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}
