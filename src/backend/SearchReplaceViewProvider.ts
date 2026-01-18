import * as vscode from 'vscode'
import {
  SearchRunner,
  TransformResultEvent,
} from './searchController/SearchRunner'
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
  // Set для отслеживания уже обработанных файлов (избежание дублирования)
  private _processedFiles: Set<string> = new Set()

  constructor(
    private extension: IMdSearchExtension,
    private readonly _extensionUri: vscode.Uri = extension.context.extensionUri,
    private readonly runner: SearchRunner = extension.runner
  ) {
    // Регистрируем глобальных слушателей событий при создании провайдера
    this._registerGlobalEventListeners()

    // Инициализация с параметрами расширения
    this._state.params = Object.assign({}, extension.getParams())

    // _processedFiles используется для предотвращения дублирования результатов
    // когда один и тот же файл может поступить из кеша и из текущего поиска
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
        // Очищаем Set обработанных файлов при новом поиске
        this._processedFiles.clear()
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
        // Очищаем Set обработанных файлов при остановке поиска
        this._processedFiles.clear()
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
      this.runner.on(event as keyof SearchRunnerEvents, listener)
    }

    this._listenerRegistered = true
  }

  private _updateStatus(e: TransformResultEvent): void {
    if (!e.file) {
      return
    }

    const fileUri = e.file.toString()

    // Обновляем статус только для новых файлов, чтобы избежать дублирования счетчиков
    if (this._processedFiles.has(fileUri)) {
      return
    }

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

    // Проверяем, не обрабатывался ли уже этот файл
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
      ],
    } as vscode.WebviewOptions & { devToolsEnabled?: boolean }

    // Включаем devTools для отладки в режиме разработки
    if (!this.extension.isProduction) {
      // Добавляем свойство devToolsEnabled напрямую, так как оно может быть недоступно в типах WebviewOptions
      ;(webviewView.webview.options as any).devToolsEnabled = true
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

  postMessage(message: MessageToWebview): void {
    if (this._view?.visible) {
      // Validate outgoing message in development or check for errors
      const validation = MessageToWebviewSchema.safeParse(message)
      if (!validation.success) {
        this.extension.logError(
          new Error(
            `Invalid message sent to webview: ${JSON.stringify(
              validation.error.format()
            )}`
          )
        )
        // We might still want to send it or throw? Let's log and send for now to avoid breaking if schema is too strict vs type.
        // Actually, if it fails schema, it might crash frontend validation.
        return
      }
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
    // Отправляем буферизованные результаты
    this._sendBufferedResults()
  }

  public getStatus(): SearchReplaceViewStatus {
    return this._state.status
  }
}
