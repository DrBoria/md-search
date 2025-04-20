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
  SearchReplaceViewValues,
} from './SearchReplaceViewTypes'
import { AstxRunnerEvents } from '../searchController/SearchRunnerTypes'
import { randomUUID } from 'crypto'

export class SearchReplaceViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mdSearch.SearchReplaceView'

  private _view?: vscode.WebviewView
  private _persistedState: {
    status: SearchReplaceViewStatus;
    params: Params;
    results: any[];
  } = {
    status: {
      running: false,
      completed: 0,
      total: 0,
      numMatches: 0,
      numFilesThatWillChange: 0,
      numFilesWithMatches: 0,
      numFilesWithErrors: 0,
    },
    params: {} as Params,
    results: [],
  }
  private _listenerRegistered = false;

  constructor(
    private extension: AstxExtension,
    private readonly _extensionUri: vscode.Uri = extension.context.extensionUri,
    private readonly runner: AstxRunner = extension.runner
  ) {
    // Восстановление состояния из хранилища при инициализации
    this._restoreStateFromStorage();
    
    // Регистрируем глобальных слушателей событий при создании провайдера
    this._registerGlobalEventListeners();
    
    // Инициализация с параметрами расширения
    this._persistedState.params = { ...extension.getParams() };
  }

  private _registerGlobalEventListeners(): void {
    if (this._listenerRegistered) return;

    const globalListeners = {
      result: (e: TransformResultEvent) => {
        // Обновляем состояние даже если view не активен
        this._updateStatus(e);
        // Сохраняем результат
        this._addResult(e);
      },
      start: () => {
        this._persistedState.status.running = true;
        this._persistedState.status.numMatches = 0;
        this._persistedState.status.numFilesThatWillChange = 0;
        this._persistedState.status.numFilesWithMatches = 0;
        this._persistedState.status.numFilesWithErrors = 0;
        this._saveStateToStorage();
        this._notifyWebviewIfActive('status', { status: this._persistedState.status });
      },
      stop: () => {
        this._persistedState.status.running = false;
        this._persistedState.status.numMatches = 0;
        this._persistedState.status.numFilesThatWillChange = 0;
        this._persistedState.status.numFilesWithMatches = 0;
        this._persistedState.status.numFilesWithErrors = 0;
        this._persistedState.results = [];
        this._saveStateToStorage();
        this._notifyWebviewIfActive('status', { status: this._persistedState.status });
        this._notifyWebviewIfActive('clearResults', {});
      },
      done: () => {
        this._persistedState.status.running = false;
        this._saveStateToStorage();
        this._notifyWebviewIfActive('status', { status: this._persistedState.status });
      },
      progress: ({ completed, total }: ProgressEvent) => {
        this._persistedState.status.completed = completed;
        this._persistedState.status.total = total;
        this._saveStateToStorage();
        this._notifyWebviewIfActive('status', { status: this._persistedState.status });
      },
    };

    for (const [event, listener] of Object.entries(globalListeners)) {
      this.runner.on(event as keyof AstxRunnerEvents, listener);
    }

    // Сохраняем состояние при закрытии VS Code
    this.extension.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(() => {
        this._saveStateToStorage();
      })
    );

    this._listenerRegistered = true;
  }

  private _updateStatus(e: TransformResultEvent): void {
    const status = this._persistedState.status;
    
    if (e.transformed && e.transformed !== e.source) {
      status.numFilesThatWillChange++;
    }
    if (e.matches?.length) {
      status.numMatches += e.matches.length;
      status.numFilesWithMatches++;
    }
    if (e.error) {
      status.numFilesWithErrors++;
    }

    this._saveStateToStorage();
  }

  private _addResult(e: TransformResultEvent): void {
    // Преобразуем результат в сериализуемый объект
    const stringifiedEvent = {
      file: e.file.toString(),
      source: e.source,
      transformed: e.transformed,
      matches: e.matches || [],
      reports: e.reports,
      error: e.error
        ? {
            message: e.error.message,
            name: e.error.name,
            stack: e.error.stack,
          }
        : undefined,
    };

    // Добавляем результат в сохраненный список
    this._persistedState.results.push(stringifiedEvent);
    this._saveStateToStorage();

    // Отправляем в webview, если активен
    this._notifyWebviewIfActive('addResult', { data: stringifiedEvent });
  }

  private _notifyWebviewIfActive(type: string, data: any): void {
    if (this._view?.visible) {
      this._view.webview.postMessage({ type, ...data });
    }
  }

  private _saveStateToStorage(): void {
    try {
      // Сохраняем только необходимые данные, ограничивая размер
      const stateToSave = {
        status: this._persistedState.status,
        params: this._persistedState.params,
        // Ограничиваем количество результатов для сохранения
        resultCount: this._persistedState.results.length,
      };
      this.extension.context.workspaceState.update('searchReplaceViewState', stateToSave);
    } catch (error) {
      this.extension.channel.appendLine(`Error saving state: ${error}`);
    }
  }

  private _restoreStateFromStorage(): void {
    try {
      const savedState = this.extension.context.workspaceState.get('searchReplaceViewState') as { 
        status?: SearchReplaceViewStatus; 
        params?: Params; 
      } | undefined;
      
      if (savedState) {
        if (savedState.status) {
          this._persistedState.status = savedState.status;
        }
        if (savedState.params) {
          this._persistedState.params = savedState.params;
        }
        // Результаты не восстанавливаем полностью из хранилища из-за потенциального размера
      }
    } catch (error) {
      this.extension.channel.appendLine(`Error restoring state: ${error}`);
    }
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,
      // Разрешить доступ к расширению и его медиа-папке
      localResourceRoots: [
        this._extensionUri,
        vscode.Uri.joinPath(this._extensionUri, 'media'),
        vscode.Uri.joinPath(this._extensionUri, 'out'),
      ],
    } as vscode.WebviewOptions & { devToolsEnabled?: boolean }

    // Включаем devTools для отладки в режиме разработки
    if (!this.extension.isProduction) {
      // Добавляем свойство devToolsEnabled напрямую, так как оно может быть недоступно в типах WebviewOptions
      ;(webviewView.webview.options as any).devToolsEnabled = true

      // Выводим информацию для разработчика
      this.extension.channel.appendLine(
        '[Debug] Webview debugging is enabled. You can use the "Debug Webview" launch configuration.'
      )
    }

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)

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
            // Получаем путь к рабочей области
            const workspaceFolders = vscode.workspace.workspaceFolders || []
            const workspacePath =
              workspaceFolders.length > 0
                ? workspaceFolders[0].uri.toString()
                : ''

            // Отправляем initialData с сохраненными значениями
            webviewView.webview.postMessage({
              type: 'initialData',
              values: this._persistedState.params,
              status: this._persistedState.status,
              workspacePath,
            })

            // Отправляем сохраненные результаты, если есть
            if (this._persistedState.results.length > 0) {
              for (const result of this._persistedState.results) {
                webviewView.webview.postMessage({
                  type: 'addResult',
                  data: result,
                });
              }
            }

            break
          }
          case 'values': {
            const newParams = message.values as Params;
            this._persistedState.params = newParams;
            this._saveStateToStorage();
            this.extension.setParams(newParams);
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
          case 'copyMatches': {
            // Выполняем копирование совпадений
            try {
              const count = await this.extension.copyMatches();
              this.notifyCopyMatchesComplete(count);
            } catch (error) {
              this.extension.logError(
                error instanceof Error
                  ? error
                  : new Error(`Failed to copy matches: ${error}`)
              );
            }
            break;
          }
          case 'cutMatches': {
            // Выполняем вырезание совпадений
            try {
              const count = await this.extension.cutMatches();
              this.notifyCutMatchesComplete(count);
            } catch (error) {
              this.extension.logError(
                error instanceof Error
                  ? error
                  : new Error(`Failed to cut matches: ${error}`)
              );
            }
            break;
          }
          case 'pasteToMatches': {
            // Выполняем вставку из буфера
            try {
              const count = await this.extension.pasteToMatches();
              this.notifyPasteToMatchesComplete(count);
            } catch (error) {
              this.extension.logError(
                error instanceof Error
                  ? error
                  : new Error(`Failed to paste to matches: ${error}`)
              );
            }
            break;
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

    webviewView.onDidDispose(() => {
      // При закрытии view не удаляем глобальные слушатели событий
      // чтобы расширение продолжило работу в фоне
      this._view = undefined;
      this._saveStateToStorage();
    })
  }

  setParams(params: Params): void {
    this._persistedState.params = params;
    this._saveStateToStorage();
    
    if (this._view?.webview) {
      this._view.webview.postMessage({
        type: 'values',
        values: params,
      });
    }
  }

  show(): void {
    this._view?.show()
  }

  // New method to show and focus the search input
  showWithSearchFocus(): void {
    this._view?.show(true) // Use 'true' to preserve focus
    // Give the webview time to activate before sending the focus message
    setTimeout(() => {
      this.postMessage({
        type: 'focusSearchInput',
      })
    }, 200)
  }

  // New method to show and focus the replace input
  showWithReplaceFocus(): void {
    this._view?.show(true) // Use 'true' to preserve focus
    // Give the webview time to activate before sending the focus message
    setTimeout(() => {
      this.postMessage({
        type: 'focusReplaceInput',
      })
    }, 200)
  }

  get visible(): boolean {
    return this._view?.visible ?? false
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const isProduction = this.extension.isProduction
    const port = 9099 // Тот же порт, что в webviews.webpack.config.js

    // Используем toWebviewUri для получения правильных URI ресурсов
    const scriptUri = isProduction
      ? webview.asWebviewUri(
          vscode.Uri.joinPath(this._extensionUri, 'out', 'SearchReplaceView.js')
        )
      : `http://localhost:${port}/SearchReplaceView.js`

    const stylesUri = isProduction
      ? webview.asWebviewUri(
          vscode.Uri.joinPath(
            this._extensionUri,
            'out',
            'SearchReplaceView.css'
          )
        )
      : `http://localhost:${port}/SearchReplaceView.css`

    // Обновляем путь к иконкам, используя скопированные в out файлы
    const codiconsUri = isProduction
      ? webview.asWebviewUri(
          vscode.Uri.joinPath(this._extensionUri, 'out', 'codicons')
        )
      : webview.asWebviewUri(
          vscode.Uri.joinPath(
            this._extensionUri,
            'node_modules',
            '@vscode/codicons',
            'dist'
          )
        )

    // Добавляем URI для material-icons
    const materialIconsUri = isProduction
      ? webview.asWebviewUri(
          vscode.Uri.joinPath(this._extensionUri, 'out', 'material-icons')
        )
      : webview.asWebviewUri(
          vscode.Uri.joinPath(
            this._extensionUri,
            'node_modules',
            'vscode-material-icons',
            'generated',
            'icons'
          )
        )

    const nonce = Buffer.from(randomUUID()).toString('base64')

    // CSP полностью удален для разрешения загрузки любых ресурсов

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
  <script ${isProduction ? `nonce="${nonce}"` : ''} src="${scriptUri}"></script>
</body>
</html>`
  }

  postMessage(message: MessageToWebview): void {
    if (this._view) {
      this._view.webview.postMessage(message)
    }
  }

  // Метод для отправки уведомления о завершении замены
  notifyReplacementComplete(
    totalReplacements: number,
    totalFilesChanged: number
  ): void {
    this.postMessage({
      type: 'replacementComplete',
      totalReplacements,
      totalFilesChanged,
    })
  }

  // Метод для отправки уведомления о завершении копирования
  notifyCopyMatchesComplete(count: number): void {
    this.postMessage({
      type: 'copyMatchesComplete',
      count
    })
  }

  // Метод для отправки уведомления о завершении вырезания
  notifyCutMatchesComplete(count: number): void {
    this.postMessage({
      type: 'cutMatchesComplete',
      count
    })
  }

  // Метод для отправки уведомления о завершении вставки
  notifyPasteToMatchesComplete(count: number): void {
    this.postMessage({
      type: 'pasteToMatchesComplete',
      count
    })
  }
}
