import * as vscode from 'vscode'
import {
  SearchRunner,
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
import { randomUUID } from 'crypto'

// Константа для времени буферизации результатов (мс)
const RESULT_BATCH_DELAY = 200

export class SearchReplaceViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mdSearch.SearchReplaceView'

  private _view?: vscode.WebviewView
  private _state: {
    status: SearchReplaceViewStatus
    params: Params
    results: any[]
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
  private _listenerRegistered = false

  // Буфер для накопления результатов
  private _resultBuffer: any[] = []
  // Таймер для батчинга результатов
  private _resultBatchTimer: NodeJS.Timeout | null = null

  constructor(
    private extension: AstxExtension,
    private readonly _extensionUri: vscode.Uri = extension.context.extensionUri,
    private readonly runner: SearchRunner = extension.runner
  ) {
    // Регистрируем глобальных слушателей событий при создании провайдера
    this._registerGlobalEventListeners()

    // Инициализация с параметрами расширения
    this._state.params = Object.assign({}, extension.getParams())
  }
  private isSearchRunning = false
  private _registerGlobalEventListeners(): void {
    if (this._listenerRegistered) return

    const globalListeners = {
      result: (e: TransformResultEvent) => {
        // Обновляем состояние даже если view не активен
        this._updateStatus(e)
        // Сохраняем результат
        this._addResult(e)
      },
      start: () => {
        this._state.status.running = true
        this._state.status.numMatches = 0
        this._state.status.numFilesThatWillChange = 0
        this._state.status.numFilesWithMatches = 0
        this._state.status.numFilesWithErrors = 0
        this._state.status.completed = 0
        this._state.status.total = 0
        this._state.results = []
        this.isSearchRunning = true
      },
      stop: () => {
        // Отправляем оставшиеся буферизованные результаты перед очисткой
        this._flushBufferedResults()

        this._state.status.running = false
        this._state.status.numMatches = 0
        this._state.status.numFilesThatWillChange = 0
        this._state.status.numFilesWithMatches = 0
        this._state.status.numFilesWithErrors = 0
        this._state.status.completed = 0
        this._state.status.total = 0
        this._state.results = []
        this._notifyWebviewIfActive('status', {
          status: this._state.status,
        })
        this._notifyWebviewIfActive('clearResults', {})
        this.isSearchRunning = false
      },
      done: () => {
        // Отправляем оставшиеся буферизованные результаты
        this._flushBufferedResults()

        this._state.status.running = false
        this._notifyWebviewIfActive('status', {
          status: this._state.status,
        })
        this.isSearchRunning = false
      },
      progress: ({ completed, total }: ProgressEvent) => {
        this._state.status.completed = completed
        this._state.status.total = total
        this._notifyWebviewIfActive('status', {
          status: this._state.status,
        })
        const isNoMatches =
          total === completed && !this._state.status.numMatches
        if (isNoMatches) {
          this._notifyWebviewIfActive('clearResults', {})
        }
      },
    }

    for (const [event, listener] of Object.entries(globalListeners)) {
      this.runner.on(event as keyof AstxRunnerEvents, listener)
    }

    this._listenerRegistered = true
  }

  private _updateStatus(e: TransformResultEvent): void {
    const status = this._state.status

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
    }

    // Добавляем результат в список
    this._state.results.push(stringifiedEvent)

    // Добавляем в буфер для батчинга
    this._resultBuffer.push(stringifiedEvent)

    // Планируем отправку буфера результатов
    this._scheduleBatchSend()
  }

  // Метод для планирования отправки буфера результатов
  private _scheduleBatchSend(): void {
    // Если таймер уже запущен, не создаем новый
    if (this._resultBatchTimer !== null) {
      return
    }

    // Создаем таймер для отправки результатов через RESULT_BATCH_DELAY мс
    this._resultBatchTimer = setTimeout(() => {
      this._sendBufferedResults()
      this._resultBatchTimer = null
    }, RESULT_BATCH_DELAY)
  }

  // Метод для отправки буферизованных результатов
  private _sendBufferedResults(): void {
    if (this._resultBuffer.length === 0) {
      return
    }

    // Отправляем весь буфер результатов в webview
    this._notifyWebviewIfActive('addBatchResults', {
      data: this._resultBuffer,
      isSearchRunning: this.isSearchRunning,
    })
    this.isSearchRunning = false
    // Очищаем буфер после отправки
    this._resultBuffer = []
  }

  private _notifyWebviewIfActive(type: string, data: any): void {
    if (this._view?.visible) {
      this._view.webview.postMessage({ type, ...data })
    }
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView

    webviewView.webview.options = {
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
    }

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webviewView.webview.onDidReceiveMessage((_message: any) => {
      const message: MessageFromWebview = _message

      // // --- ДОБАВЛЕНО: Обработка события mount ---
      // if (message.type === 'mount') {
      //   this._isWebviewMounted = true
      //   this._flushEventQueue()
      // }

      // if (message.type === 'unmount') {
      //   this._isWebviewMounted = false
      // }

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

            // Получаем текущие параметры из расширения
            const currentParams = this.extension.getParams()

            // Отправляем initialData с текущими значениями
            webviewView.webview.postMessage({
              type: 'initialData',
              workspacePath,
              values: currentParams, // Добавляем параметры в сообщение
            })

            break
          }
          case 'values': {
            const newParams = message.values as Params
            this._state.params = newParams
            this.extension.setParams(newParams)
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
          case 'abort': {
            this.extension.channel.appendLine(
              'Received stop command from webview, aborting search...'
            )
            this.runner.abort()

            this._state.status.running = false
            this._notifyWebviewIfActive('status', {
              status: this._state.status,
            })
            break
          }
          case 'stop': {
            // Вызываем метод остановки поиска в runner
            this.extension.channel.appendLine(
              'Received stop command from webview, stopping search...'
            )
            this.runner.stop()

            // Отправляем оставшиеся буферизованные результаты перед очисткой
            this._flushBufferedResults()

            this._state.status.running = false
            this._state.status.numMatches = 0
            this._state.status.numFilesThatWillChange = 0
            this._state.status.numFilesWithMatches = 0
            this._state.status.numFilesWithErrors = 0
            this._state.status.completed = 0
            this._state.status.total = 0
            // this._state.results = []
            this._notifyWebviewIfActive('status', {
              status: this._state.status,
            })
            this._notifyWebviewIfActive('clearResults', {})
            break
          }
          case 'copyMatches': {
            // Выполняем копирование совпадений
            try {
              const count = await this.extension.copyMatches()
              this.notifyCopyMatchesComplete(count)
            } catch (error) {
              this.extension.logError(
                error instanceof Error
                  ? error
                  : new Error(`Failed to copy matches: ${error}`)
              )
            }
            break
          }
          case 'cutMatches': {
            // Выполняем вырезание совпадений
            try {
              const count = await this.extension.cutMatches()
              this.notifyCutMatchesComplete(count)
            } catch (error) {
              this.extension.logError(
                error instanceof Error
                  ? error
                  : new Error(`Failed to cut matches: ${error}`)
              )
            }
            break
          }
          case 'pasteToMatches': {
            // Выполняем вставку из буфера
            try {
              const count = await this.extension.pasteToMatches()
              this.notifyPasteToMatchesComplete(count)
            } catch (error) {
              this.extension.logError(
                error instanceof Error
                  ? error
                  : new Error(`Failed to paste to matches: ${error}`)
              )
            }
            break
          }
          case 'copyFileNames': {
            // Выполняем копирование имен файлов
            try {
              const count = await this.extension.copyFileNames()
              this.notifyCopyFileNamesComplete(count)
            } catch (error) {
              this.extension.logError(
                error instanceof Error
                  ? error
                  : new Error(`Failed to copy file names: ${error}`)
              )
            }
            break
          }
          case 'excludeFile': {
            // Исключаем файл из кэша поиска
            try {
              const fileUri = vscode.Uri.parse(message.filePath)
              this.extension.runner.excludeFileFromCache(fileUri)
              
              // Также удаляем файл из TransformResultProvider
              this.extension.transformResultProvider.results.delete(message.filePath)
              
              // Уведомляем webview об обновлении результатов
              this._notifyWebviewIfActive('fileUpdated', {
                filePath: message.filePath,
                newSource: null // null означает удаление
              })

              this.extension.channel.appendLine(
                `File excluded from search: ${message.filePath}`
              )
            } catch (error) {
              this.extension.logError(
                error instanceof Error
                  ? error
                  : new Error(`Failed to exclude file: ${error}`)
              )
            }
            break
          }
          case 'undoLastOperation': {
            // Выполняем отмену последней операции
            try {
              const restored = await this.extension.undoLastOperation()
              this.notifyUndoComplete(restored)
            } catch (error) {
              this.extension.logError(
                error instanceof Error
                  ? error
                  : new Error(`Failed to undo operation: ${error}`)
              )
              this.notifyUndoComplete(false)
            }
            break
          }
          case 'openFile': {
            const uri = vscode.Uri.parse(message.filePath)

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
      this._view = undefined
    })
  }

  show(): void {
    this._view?.show()
  }

  // Updated method to show and focus the search input
  showWithSearchFocus(): void {
    // Если view не инициализирован, активируем через команду
    if (!this._view) {
      this.extension.channel.appendLine(
        'View not initialized, forcing activation via command'
      )
      vscode.commands
        .executeCommand('workbench.view.extension.mdSearch-mdSearch')
        .then(() => {
          this._focusSearchInput()
        })
      return
    }

    // Если view уже доступен, используем стандартный подход
    this._view.show(true)
    this._focusSearchInput()
  }

  // Helper method to focus search input
  private _focusSearchInput(): void {
    // Отправляем несколько команд фокуса с разными задержками
    // для большей надежности срабатывания
    // Get current params
    const currentParams = this.extension.getParams()

    // Send parameters to webview first
    this.postMessage({
      type: 'values',
      values: currentParams,
    })

    // Focus on search input
    this.postMessage({
      type: 'focusSearchInput',
    })
  }

  // Updated method to show and focus the replace input
  showWithReplaceFocus(): void {
    // Если view не инициализирован, активируем через команду
    if (!this._view) {
      this.extension.channel.appendLine(
        'View not initialized, forcing activation via command'
      )
      vscode.commands
        .executeCommand('workbench.view.extension.mdSearch-mdSearch')
        .then(() => {
          setTimeout(() => {
            this._focusReplaceInput()
          }, 0) // Увеличиваем задержку для гарантии загрузки view
        })
      return
    }

    // Если view уже доступен, используем стандартный подход
    this._view.show(true)
    this._focusReplaceInput()
  }

  // Helper method to focus replace input
  private _focusReplaceInput(): void {
    this.extension.channel.appendLine('Sending focus command to replace input')

    // Отправляем несколько команд фокуса с разными задержками
    // для большей надежности срабатывания
    setTimeout(() => {
      // Get current params
      const currentParams = this.extension.getParams()

      // Send parameters to webview first
      this.postMessage({
        type: 'values',
        values: currentParams,
      })

      // Focus on replace input with some delay after params
      this.postMessage({
        type: 'focusReplaceInput',
      })
    }, 100)
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
    this._view?.webview.postMessage(message)
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
      count,
    })
  }

  // Метод для отправки уведомления о завершении вырезания
  notifyCutMatchesComplete(count: number): void {
    this.postMessage({
      type: 'cutMatchesComplete',
      count,
    })
  }

  // Метод для отправки уведомления о завершении вставки
  notifyPasteToMatchesComplete(count: number): void {
    this.postMessage({
      type: 'pasteToMatchesComplete',
      count,
    })
  }

  notifyCopyFileNamesComplete(count: number): void {
    this.postMessage({
      type: 'copyFileNamesComplete',
      count,
    })
  }

  // Метод для отправки уведомления о завершении отката операции
  notifyUndoComplete(restored: boolean): void {
    this.postMessage({
      type: 'undoComplete',
      restored,
    })
  }

  // Метод для немедленной отправки буферизованных результатов без задержки
  private _flushBufferedResults(): void {
    // Отменяем таймер, если он запущен
    if (this._resultBatchTimer !== null) {
      clearTimeout(this._resultBatchTimer)
      this._resultBatchTimer = null
    }

    // Отправляем буферизованные результаты
    this._sendBufferedResults()
  }
}
