import * as vscode from 'vscode'
import {
  SearchRunner,
  TransformResultEvent,
} from './searchController/SearchRunner'
import { debounce } from 'lodash'
import type { IMdSearchExtension, ProgressEvent } from './types'
import { Params } from './types'
import {
  SearchReplaceViewStatus,
  MessageToWebview,
  MessageToWebviewSchema,
} from '../model/SearchReplaceViewTypes'
import { SearchRunnerEvents } from '../model/SearchRunnerTypes'
import { HtmlTemplate } from './views/HtmlTemplate'
import { MessageHandler } from './views/MessageHandler'

// Constant for result buffering time (ms)
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

  // Buffer for accumulating results
  private _resultBuffer: any[] = []
  // Timer for result batching
  private _resultBatchTimer: NodeJS.Timeout | null = null
  // Set to track processed files (avoid duplication)
  private _processedFiles: Set<string> = new Set()
  // Webview readiness flag (after receiving mount message)
  private _isWebviewMounted = false
  // Queue of messages to send after mount
  private _pendingMessages: MessageToWebview[] = []

  constructor(
    private extension: IMdSearchExtension,
    private readonly _extensionUri: vscode.Uri = extension.context.extensionUri,
    private readonly runner: SearchRunner = extension.runner
  ) {
    // Register global event listeners when creating the provider
    this._registerGlobalEventListeners()

    // Initialize with extension parameters
    this._state.params = Object.assign({}, extension.getParams())

    // _processedFiles is used to prevent result duplication
    // when the same file might come from cache and current search
  }
  private isSearchRunning = false
  private _registerGlobalEventListeners(): void {
    if (this._listenerRegistered) return

    const globalListeners = {
      result: (e: TransformResultEvent) => {
        // Update status even if view is not active
        this._updateStatus(e)
        // Save result
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
        // Clear processed files Set on new search
        this._processedFiles.clear()
        this.isSearchRunning = true
      },
      stop: () => {
        // Send remaining buffered results before clearing
        this._flushBufferedResults()

        this._state.status.running = false
        this._state.status.numMatches = 0
        this._state.status.numFilesThatWillChange = 0
        this._state.status.numFilesWithMatches = 0
        this._state.status.numFilesWithErrors = 0
        this._state.status.completed = 0
        this._state.status.total = 0
        this._state.results = []
        // Clear processed files Set on stop search
        this._processedFiles.clear()
        this._notifyWebviewIfActive('status', {
          status: this._state.status,
        })
        this._notifyWebviewIfActive('clearResults', {})
        this.isSearchRunning = false
      },
      done: () => {
        // Send remaining buffered results
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
      'search-paused': (data: { limit: number; count: number }) => {
        this._notifyWebviewIfActive('search-paused', data)
      },
      'skipped-large-files': (count: number) => {
        this._notifyWebviewIfActive('skipped-large-files', { count })
      },
    }

    // Live Update Listener
    vscode.workspace.onDidChangeTextDocument(debounce((e) => {
      if (e.document.uri.scheme === 'file' && this.visible && !this.isSearchRunning) {
        // Only scan if search is not currently running to avoid conflicts
        // And only if view is visible (optimization)
        this.runner.scanFile(e.document);
      }
    }, 500))

    for (const [event, listener] of Object.entries(globalListeners)) {
      this.runner.on(event as keyof SearchRunnerEvents, listener)
    }

    this._listenerRegistered = true
  }

  private _updateStatus(e: TransformResultEvent): void {
    if (!e.file) {
      return
    }

    const fileUri = e.file.toString()

    // We allow status updates even if file processed, because _addResult will subtract old stats.
    // if (this._processedFiles.has(fileUri)) {
    //   return
    // }

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
    if (!e.file) {
      return
    }

    const fileUri = e.file.toString()

    // Live update check: If file exists in results, we are updating it.
    const existingIndex = this._state.results.findIndex(r => r.file === fileUri)
    if (existingIndex !== -1) {
      // Remove old result from stats before adding new one
      const oldResult = this._state.results[existingIndex]
      if (oldResult.matches) {
        this._state.status.numMatches = Math.max(0, this._state.status.numMatches - oldResult.matches.length)
      }
      if (oldResult.transformed && oldResult.transformed !== oldResult.source) {
        this._state.status.numFilesThatWillChange = Math.max(0, this._state.status.numFilesThatWillChange - 1)
      }
      if (oldResult.error) {
        this._state.status.numFilesWithErrors = Math.max(0, this._state.status.numFilesWithErrors - 1)
      }
      // Note: numFilesWithMatches is decremented only if new result has 0 matches, 
      // but simple way is to decrement here and increment in _updateStatus if applies?
      // Actually best to remove old contribution entirely.
      this._state.status.numFilesWithMatches = Math.max(0, this._state.status.numFilesWithMatches - 1)

      // Remove from results array
      this._state.results.splice(existingIndex, 1)

      // Remove from _processedFiles to allow re-adding stats in _updateStatus
      this._processedFiles.delete(fileUri)
    }

    // Проверяем, не обрабатывался ли уже этот файл (после удаления выше, если это обновление - его там нет)
    if (this._processedFiles.has(fileUri)) {
      return
    }

    // Отмечаем файл как обработанный
    this._processedFiles.add(fileUri)

    // Преобразуем результат в сериализуемый объект
    const stringifiedEvent = {
      file: fileUri,
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
    // Каждый файл в буфере уже проверен на дублирование в _addResult
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
        vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
      ],
    } as vscode.WebviewOptions & { devToolsEnabled?: boolean }

    // Включаем devTools для отладки в режиме разработки
    if (!this.extension.isProduction) {
      // Добавляем свойство devToolsEnabled напрямую, так как оно может быть недоступно в типах WebviewOptions
      ; (webviewView.webview.options as any).devToolsEnabled = true
    }

    webviewView.webview.html = HtmlTemplate.getWebviewHtml(
      this.extension,
      webviewView.webview
    )

    // Create message handler
    const messageHandler = new MessageHandler(this.extension, this)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webviewView.webview.onDidReceiveMessage((message) => {
      messageHandler.handle(message)
    })

    webviewView.onDidDispose(() => {
      this._view = undefined
      this._isWebviewMounted = false
      this._pendingMessages = []
    })
  }

  show(): void {
    this._view?.show()
  }

  // Updated method to show and focus the search input
  showWithSearchFocus(selectedText?: string): void {
    if (selectedText) {
      const current = this.extension.getParams()
      if (current.find !== selectedText) {
        this.extension.setParams({ ...current, find: selectedText })
      }
    }

    if (!this._view) {
      this.extension.channel.appendLine(
        'View not initialized, forcing activation via command'
      )
      vscode.commands
        .executeCommand('workbench.view.extension.mdSearch-mdSearch')
        .then(() => {
          this._focusSearchInput(selectedText)
        })
      return
    }

    this._view.show(true)
    this._focusSearchInput(selectedText)
  }

  private _focusSearchInput(selectedText?: string): void {
    const currentParams = this.extension.getParams()

    this.postMessage({
      type: 'values',
      values: currentParams,
    })

    this.postMessage({
      type: 'focusSearchInput',
      selectedText,
      triggerSearch: !!selectedText,
    })
  }

  // Updated method to show and focus the replace input
  showWithReplaceFocus(selectedText?: string): void {
    if (selectedText) {
      const current = this.extension.getParams()
      if (current.find !== selectedText) {
        this.extension.setParams({ ...current, find: selectedText })
      }
    }

    if (!this._view) {
      this.extension.channel.appendLine(
        'View not initialized, forcing activation via command'
      )
      vscode.commands
        .executeCommand('workbench.view.extension.mdSearch-mdSearch')
        .then(() => {
          setTimeout(() => {
            this._focusReplaceInput(selectedText)
          }, 0)
        })
      return
    }

    this._view.show(true)
    this._focusReplaceInput(selectedText)
  }

  private _focusReplaceInput(selectedText?: string): void {
    setTimeout(() => {
      const currentParams = this.extension.getParams()

      this.postMessage({
        type: 'values',
        values: currentParams,
      })

      this.postMessage({
        type: 'focusReplaceInput',
        selectedText,
      })
    }, 100)
  }

  get visible(): boolean {
    return this._view?.visible ?? false
  }

  postMessage(message: MessageToWebview): void {
    if (this._view) {
      // Validate outgoing message
      const validation = MessageToWebviewSchema.safeParse(message)
      if (!validation.success) {
        this.extension.logError(
          new Error(
            `Invalid message sent to webview: ${JSON.stringify(
              validation.error.format()
            )}`
          )
        )
        return
      }

      // Webview not yet mounted - queue the message
      if (!this._isWebviewMounted) {
        this._pendingMessages.push(message)
        return
      }

      this._view.webview.postMessage(message)
    }
  }

  // Called by MessageHandler when webview sends 'mount' message
  onWebviewMounted(): void {
    this._isWebviewMounted = true

    // Flush pending messages
    for (const message of this._pendingMessages) {
      if (this._view?.visible) {
        this._view.webview.postMessage(message)
      }
    }
    this._pendingMessages = []
  }

  // Method to send notification about replacement completion
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

  // Method to send notification about copy completion
  notifyCopyMatchesComplete(count: number): void {
    this.postMessage({
      type: 'copyMatchesComplete',
      count,
    })
  }

  // Method to send notification about cut completion
  notifyCutMatchesComplete(count: number): void {
    this.postMessage({
      type: 'cutMatchesComplete',
      count,
    })
  }

  // Method to send notification about paste completion
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

  // Method to send notification about undo completion
  notifyUndoComplete(restored: boolean): void {
    this.postMessage({
      type: 'undoComplete',
      restored,
    })
  }

  // Method to immediately send buffered results without delay
  private _flushBufferedResults(): void {
    // Cancel timer if it is running
    if (this._resultBatchTimer !== null) {
      clearTimeout(this._resultBatchTimer)
      this._resultBatchTimer = null
    }

    // Send buffered results
    this._sendBufferedResults()
    // Send buffered results
    this._sendBufferedResults()
  }

  public getStatus(): SearchReplaceViewStatus {
    return this._state.status
  }
}
