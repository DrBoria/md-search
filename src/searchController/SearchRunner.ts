import { AstxConfig } from 'astx'
import { TypedEmitter } from 'tiny-typed-emitter'
import * as vscode from 'vscode'
import { debounce, isEqual } from 'lodash'
import { convertGlobPattern } from '../glob/convertGlobPattern'
import { AstxExtension, Params } from '../extension'
import { Fs } from 'astx/node/runTransformOnFile'
import { TextDecoder } from 'util'
import { TextSearchRunner } from './TextSearchRunner'
import { AstxSearchRunner } from './AstxSearchRunner'
import { AstxRunnerEvents } from './SearchRunnerTypes'

export type { TransformResultEvent } from './SearchRunnerTypes'

// Константа с шаблонами игнорируемых файлов
const DEFAULT_IGNORED_PATTERNS = [
  // Git директории
  '**/.git/**',
  // Картинки
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.ico',
  '**/*.svg',
  '**/*.webp',
  '**/*.bmp',
  '**/*.tiff',
  '**/*.psd',
  // Видео
  '**/*.mp4',
  '**/*.webm',
  '**/*.avi',
  '**/*.mov',
  '**/*.wmv',
  '**/*.flv',
  '**/*.mkv',
  // Аудио
  '**/*.mp3',
  '**/*.wav',
  '**/*.ogg',
  '**/*.aac',
  '**/*.flac',
  // Документы и архивы
  '**/*.pdf',
  '**/*.doc',
  '**/*.docx',
  '**/*.xls',
  '**/*.xlsx',
  '**/*.ppt',
  '**/*.pptx',
  '**/*.zip',
  '**/*.rar',
  '**/*.7z',
  '**/*.tar',
  '**/*.gz',
  // Шрифты
  '**/*.ttf',
  '**/*.otf',
  '**/*.woff',
  '**/*.woff2',
  '**/*.eot',
  // Другие бинарные файлы
  '**/*.exe',
  '**/*.dll',
  '**/*.so',
  '**/*.dylib',
  '**/*.class',
  '**/*.jar',
]

export type ProgressEvent = {
  completed: number
  total: number
}

export class SearchRunner extends TypedEmitter<AstxRunnerEvents> {
  private params: Params
  private pausedRestart = false
  private abortController: AbortController | undefined
  private processedFiles: Set<string> = new Set()
  private previousSearchFiles: Set<string> = new Set()
  private transformResults: Map<
    string,
    {
      source: string
      transformed: string
    }
  > = new Map()
  private fileDocs: Map<string, vscode.TextDocument> = new Map()
  private fs: Fs | undefined
  private config: AstxConfig | undefined
  private startupPromise: Promise<void> = Promise.reject(
    new Error('Not initialized')
  )
  private textSearchRunner: TextSearchRunner
  private astxSearchRunner: AstxSearchRunner
  private fileIndexCache: Map<string, Set<string>> = new Map()
  private fileIndexPromise: Promise<void> | null = null
  private isIndexing = false
  private includeGlob: string | null = null
  private previousInclude: string | undefined
  private previousExclude: string | undefined

  constructor(private extension: AstxExtension) {
    super()
    this.params = extension.getParams()

    // First create runner instances
    this.textSearchRunner = new TextSearchRunner(extension)
    this.astxSearchRunner = new AstxSearchRunner(extension)

    // Then setup event forwarding
    this.setupEventForwarding(this.textSearchRunner)
    this.setupEventForwarding(this.astxSearchRunner)

    // Finally initialize the startup promise
    this.startupPromise = this.startup().catch((err) => {
      this.extension.logError(
        new Error(`SearchRunner initial startup failed: ${err}`)
      )
      throw err
    })

    // Запускаем индексацию в фоне после инициализации
    this.startBackgroundFileIndexing()
      .then(() => {
        // Передаем индекс файлов в TextSearchRunner после индексации
        this.textSearchRunner.setFileIndex(this.fileIndexCache)
      })
      .catch((err) => {
        this.extension.channel.appendLine(`Ошибка индексации: ${err}`)
      })
  }

  private setupEventForwarding(runner: TypedEmitter<AstxRunnerEvents>): void {
    runner.on('result', (event) => this.emit('result', event))
    runner.on('stop', () => this.emit('stop'))
    runner.on('start', () => this.emit('start'))
    runner.on('progress', (event) => this.emit('progress', event))
    runner.on('done', () => this.emit('done'))
    runner.on('error', (error) => this.emit('error', error))
    runner.on('replaceDone', () => this.emit('replaceDone'))
  }

  async startup(): Promise<void> {
    this.extension.channel.appendLine(
      'Starting SearchRunner startup sequence...'
    )

    try {
      await this.astxSearchRunner.setupWorkerPool()
      this.extension.channel.appendLine(
        'SearchRunner startup sequence completed successfully.'
      )
    } catch (error) {
      this.extension.channel.appendLine(
        `SearchRunner startup sequence failed: ${error}`
      )
      throw error
    }
  }

  // Фоновая индексация файлов для ускорения последующих поисков
  private async startBackgroundFileIndexing(): Promise<void> {
    if (this.isIndexing || this.fileIndexPromise) return

    this.isIndexing = true
    this.extension.channel.appendLine('Starting background file indexing...')

    this.fileIndexPromise = this.indexWorkspaceFolders()
      .then(() => {
        this.extension.channel.appendLine(
          `Background file indexing completed with ${this.fileIndexCache.size} file type groups.`
        )
        // Сразу после завершения индексации передаем индекс в TextSearchRunner
        this.textSearchRunner.setFileIndex(this.fileIndexCache)
        this.isIndexing = false
        this.fileIndexPromise = null
      })
      .catch((err) => {
        this.extension.channel.appendLine(
          `Background file indexing error: ${err}`
        )
        this.isIndexing = false
        this.fileIndexPromise = null
      })

    return this.fileIndexPromise
  }

  // Получает паттерны исключения из настроек VS Code Search: Exclude
  private getSearchExcludePatterns(): string[] {
    // Получаем настройки исключений для поиска
    const exclude = vscode.workspace
      .getConfiguration('search')
      .get<{ [key: string]: boolean }>('exclude')

    if (!exclude) {
      return []
    }

    // Преобразуем объект настроек в массив шаблонов
    const excludePatterns = Object.entries(exclude)
      .filter(([, value]) => value === true)
      .map(([key]) => key)

    return excludePatterns
  }

  // Добавляем метод для получения include patterns из настроек
  private getSearchIncludePatterns(): string[] {
    // Получаем настройки включений для поиска
    const include = vscode.workspace
      .getConfiguration('search')
      .get<string>('include')

    if (!include) {
      return []
    }

    // Разделяем строку с шаблонами по запятой и удаляем пробелы
    return include.split(',').map(pattern => pattern.trim()).filter(pattern => pattern !== '')
  }

  // Индексирует файлы в рабочем пространстве по типам
  private async indexWorkspaceFolders(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders) return

    // Расширенный список типов файлов для индексации
    const indexedFileTypes = [
      // JavaScript/TypeScript
      '**/*.js',
      '**/*.jsx',
      '**/*.ts',
      '**/*.tsx',
      // Web
      '**/*.html',
      '**/*.css',
      '**/*.scss',
      '**/*.less',
      '**/*.sass',
      '**/*.svg',
      // Документы
      '**/*.md',
      '**/*.txt',
      '**/*.rtf',
      // Данные
      '**/*.json',
      '**/*.xml',
      '**/*.yml',
      '**/*.yaml',
      // Другие языки программирования
      '**/*.py',
      '**/*.go',
      '**/*.rs',
      '**/*.java',
      '**/*.c',
      '**/*.cpp',
      '**/*.h',
      '**/*.hpp',
      '**/*.cs',
      '**/*.php',
      '**/*.rb',
      '**/*.swift',
      '**/*.kt',
      // Конфигурационные файлы
      '**/*.config',
      '**/*.conf',
      '**/*.ini',
      '**/*.properties',
      '**/*.env',
    ]

    // Получаем паттерны исключения ТОЛЬКО из настроек Search: Exclude
    const excludePatterns = this.getSearchExcludePatterns()

    // Дополнительно обрабатываем простые имена папок и разделяем шаблоны, указанные через запятую
    const processedExcludePatterns = excludePatterns.flatMap(pattern => {
      // Разделяем шаблон, если он содержит запятые
      const splitPatterns = pattern.split(',').map(p => p.trim()).filter(p => p !== '');
      
      return splitPatterns.map(subPattern => {
        // Проверяем, является ли шаблон простым именем папки
        if (!subPattern.includes('*') && !subPattern.includes('?') && !subPattern.includes('[')) {
          // Удаляем слеш в конце, если есть
          const cleanPattern = subPattern.endsWith('/') ? subPattern.slice(0, -1) : subPattern;
          // Преобразуем в формат исключения папки с разными вариантами шаблонов
          return `${cleanPattern}/**,**/${cleanPattern}/**,**/${cleanPattern}`;
        }
        return subPattern;
      });
    });

    let excludeGlob = null
    if (processedExcludePatterns.length > 0) {
      excludeGlob = `{${processedExcludePatterns.join(',')}}`
    }

    // Получаем шаблоны включения из настроек Search: Include
    const includePatterns = this.getSearchIncludePatterns()
    
    // Обрабатываем шаблоны включения так же, как и исключения
    const processedIncludePatterns = includePatterns.flatMap(pattern => {
      // Разделяем шаблон, если он содержит запятые
      const splitPatterns = pattern.split(',').map(p => p.trim()).filter(p => p !== '');
      
      return splitPatterns.map(subPattern => {
        // Проверяем, является ли шаблон простым именем папки
        if (!subPattern.includes('*') && !subPattern.includes('?') && !subPattern.includes('[')) {
          // Удаляем слеш в конце, если есть
          const cleanPattern = subPattern.endsWith('/') ? subPattern.slice(0, -1) : subPattern;
          // Преобразуем в формат включения папки с разными вариантами шаблонов
          return `${cleanPattern}/**,**/${cleanPattern}/**,**/${cleanPattern}`;
        }
        return subPattern;
      });
    });

    // Используем includePatterns для ограничения поиска
    this.includeGlob = null
    if (processedIncludePatterns.length > 0) {
      this.includeGlob = `{${processedIncludePatterns.join(',')}}`
      this.extension.channel.appendLine(
        `[DEBUG] Using include glob: ${this.includeGlob}`
      )
    }

    // Также создаем индекс для общих групп файлов для более быстрого поиска
    const commonPatterns = [
      '**/*.{js,jsx,ts,tsx}', // JavaScript/TypeScript
      '**/*.{html,css,scss,less}', // Web
      '**/*.{json,xml,yml,yaml}', // Data
      '**/*.{c,cpp,h,hpp}', // C/C++
    ]

    // Параллельно индексируем все типы файлов + общие группы
    const allPatterns = [...indexedFileTypes, ...commonPatterns]

    // Обновляем общий индекс для всех файлов для более быстрого последующего доступа
    const allFilesSet = new Set<string>()
    this.fileIndexCache.set('**/*', allFilesSet)

    // Создаем логирование прогресса
    const total = allPatterns.length
    let completed = 0
    this.extension.channel.appendLine(`Индексирую ${total} шаблонов файлов...`)

    // Индексируем в пакетах для снижения нагрузки
    const batchSize = 5
    for (let i = 0; i < allPatterns.length; i += batchSize) {
      const batch = allPatterns.slice(i, i + batchSize)

      await Promise.all(
        batch.map(async (fileType) => {
          try {
            const files = await vscode.workspace.findFiles(
              fileType,
              excludeGlob,
            )

            const fileSet = new Set<string>(files.map((f) => f.fsPath))
            this.fileIndexCache.set(fileType, fileSet)

            // Добавляем в общий индекс всех файлов
            files.forEach((f) => allFilesSet.add(f.fsPath))

            completed++
            this.extension.channel.appendLine(
              `Индексировано [${completed}/${total}]: ${fileSet.size} ${fileType} файлов`
            )
          } catch (error) {
            this.extension.channel.appendLine(
              `Ошибка индексации ${fileType}: ${error}`
            )
          }
        })
      )
    }

    this.extension.channel.appendLine(
      `Индексация завершена: всего ${allFilesSet.size} уникальных файлов`
    )
  }

  setParams(params: Params): void {
    // Add logging to see if setParams is called and compare params
    this.extension.channel.appendLine(`[Debug] setParams called.`)
    this.extension.channel.appendLine(
      `[Debug]   Params changing: searchMode=${params.searchMode}, searchInResults=${params.searchInResults}, paused=${params.paused}`
    )
    const areEqual = isEqual(this.params, params)
    this.extension.channel.appendLine(`[Debug]   isEqual result: ${areEqual}`)

    if (!areEqual) {
      this.extension.channel.appendLine(`[Debug] Params changed (not equal).`)
      
      // Проверяем изменения include/exclude для сброса кеша
      if (this.params.include !== params.include || this.params.exclude !== params.exclude) {
        this.extension.channel.appendLine(`[ВАЖНО] Изменились параметры include/exclude, очищаем кеш.`);
        // Сбрасываем кеш перед сменой параметров
        this.clearCache();
      }
      
      this.params = params
      if (!this.params.paused && this.pausedRestart) {
        this.extension.channel.appendLine('[Debug] Resuming paused restart.')
        this.pausedRestart = false
        this.restartSoon()
      } else if (this.params.paused) {
        this.extension.channel.appendLine(
          '[Debug] Params changed, but runner is paused. Skipping runSoon.'
        )
      } else {
        this.extension.channel.appendLine(
          '[Debug] Params changed, calling runSoon.'
        )
        this.runSoon()
      }
    } else {
      this.extension.channel.appendLine(
        '[Debug] Params are equal, no action taken in setParams.'
      )
    }
  }

  stop(): void {
    if (this.abortController) {
      this.extension.channel.appendLine('Aborting current run...')
      this.abortController.abort()
      this.abortController = undefined
    }
    // this.transformResults.clear()
    // this.processedFiles.clear()
    // this.previousSearchFiles.clear()
    this.textSearchRunner.stop()
    this.astxSearchRunner.stop()
    this.emit('stop')
    this.extension.channel.appendLine(
      'Run stopped, results cleared (preserved previous search files).'
    )
  }

  restartSoon: () => void = () => {
    if (this.params.paused) {
      this.extension.channel.appendLine('Restart requested but paused.')
      this.pausedRestart = true
    } else {
      this.extension.channel.appendLine('Debouncing restart...')
      this.debouncedRestart()
    }
  }

  debouncedRestart: () => void = debounce(
    async () => {
      this.extension.channel.appendLine('Executing debounced restart...')
      this.stop()
      try {
        this.extension.channel.appendLine(
          'Restarting worker pool via startup()...'
        )
        await this.startup()
        this.extension.channel.appendLine('Worker pool restarted successfully.')
        this.run()
      } catch (error) {
        this.extension.channel.appendLine(
          `Failed to restart worker pool: ${
            error instanceof Error ? error.stack : String(error)
          }`
        )
      }
    },
    50,
    { leading: false, trailing: true }
  )

  async shutdown(): Promise<void> {
    this.extension.channel.appendLine('Shutting down SearchRunner...')
    this.stop()
    await this.astxSearchRunner.shutdown()
    this.extension.channel.appendLine('SearchRunner shut down complete.')
  }

  runSoon: () => void = () => {
    if (!this.params.paused) {
      this.extension.channel.appendLine('Debouncing run...')
      this.debouncedRun()
    } else {
      this.extension.channel.appendLine('Run requested but paused.')
    }
  }

  debouncedRun: () => void = debounce(
    () => {
      this.extension.channel.appendLine('Executing debounced run...')
      // Ожидаем окончания индексации, если она идет, затем запускаем поиск
      if (this.fileIndexPromise) {
        this.extension.channel.appendLine(
          'Waiting for file indexing to complete...'
        )
        this.fileIndexPromise
          .then(() => this.run())
          .catch((err) => {
            this.extension.channel.appendLine(`File indexing error: ${err}`)
            this.run() // Запускаем поиск даже если индексация не завершилась
          })
      } else {
        this.run()
      }
    },
    100,
    { leading: false, trailing: true }
  )

  updateDocumentsForChangedFile(fileUri: vscode.Uri): void {
    // Очищаем кэш для этого файла
    this.fileDocs.delete(fileUri.fsPath)

    // Обновляем индекс файлов при изменении файла
    this.updateFileIndexForChanges(fileUri)

    // Если файл был в предыдущих результатах, обновляем его в результатах
    if (this.previousSearchFiles.has(fileUri.fsPath)) {
      this.refreshFileSourceInSearchResults(fileUri).catch((error) => {
        this.extension.channel.appendLine(
          `Failed to update file in search results: ${
            error instanceof Error ? error.stack : String(error)
          }`
        )
      })
    }
  }

  // Метод для обновления индекса файлов при изменении, добавлении или удалении файла
  private updateFileIndexForChanges(fileUri: vscode.Uri): void {
    if (!this.fileIndexCache || this.fileIndexCache.size === 0) {
      return
    }

    const filePath = fileUri.fsPath
    let fileExtension = ''
    const parts = filePath.split('.')
    if (parts.length > 1) {
      fileExtension = parts[parts.length - 1].toLowerCase()
    }

    // Флаг, показывающий, что индекс был изменен
    let indexChanged = false

    // Проверяем существование файла
    vscode.workspace.fs.stat(fileUri).then(
      (stat) => {
        // Файл существует - добавляем его в индекс если соответствует расширению
        if (fileExtension) {
          // Перебираем все паттерны и проверяем соответствие расширению
          for (const [pattern, fileSet] of this.fileIndexCache.entries()) {
            if (pattern.includes(`*.${fileExtension}`) || pattern === '**/*') {
              if (!fileSet.has(filePath)) {
                fileSet.add(filePath)
                indexChanged = true
                this.extension.channel.appendLine(
                  `[FileIndex] Добавлен файл ${filePath} в индекс ${pattern}`
                )
              }
            }
          }
        }

        // Всегда добавляем в общий индекс всех файлов
        const allFilesSet = this.fileIndexCache.get('**/*')
        if (allFilesSet && !allFilesSet.has(filePath)) {
          allFilesSet.add(filePath)
          indexChanged = true
        }
      },
      () => {
        // Файл не существует - удаляем его из индекса
        let removed = false
        for (const fileSet of this.fileIndexCache.values()) {
          if (fileSet.has(filePath)) {
            fileSet.delete(filePath)
            removed = true
            indexChanged = true
          }
        }
        if (removed) {
          this.extension.channel.appendLine(
            `[FileIndex] Удален файл ${filePath} из индекса`
          )
        }
      }
    )

    // Если текущий поиск активен и индекс изменился, обновляем индекс в TextSearchRunner
    // НО не делаем этого во время выполнения поиска, чтобы избежать зацикливания
    if (
      indexChanged &&
      !this.params.paused &&
      !this.abortController?.signal.aborted
    ) {
      this.extension.channel.appendLine(
        `[FileIndex] Индекс обновлен, но не передается во время активного поиска`
      )
    }
  }

  // Метод для быстрого поиска файлов, соответствующих шаблону
  private async getFastFileList(
    includePattern: vscode.GlobPattern
  ): Promise<vscode.Uri[]> {
    const startTime = Date.now()
    let fileUris: vscode.Uri[] = []

    // Добавим подробную отладочную информацию
    this.extension.channel.appendLine(
      `[DEBUG] Getting file list for pattern: ${includePattern.toString()}`
    )
    
    // Добавляем информацию о типе includePattern
    if (typeof includePattern === 'object' && 'pattern' in includePattern) {
      this.extension.channel.appendLine(
        `[DEBUG] Pattern is a RelativePattern with base: ${(includePattern as vscode.RelativePattern).base}`
      )
    }

    try {
      // Если у нас есть общий индекс всех файлов, используем его
      const allFilesCache = this.fileIndexCache.get('**/*')
      if (allFilesCache && allFilesCache.size > 0) {
        this.extension.channel.appendLine(
          `Using all files index (${allFilesCache.size} files)`
        )
        fileUris = Array.from(allFilesCache).map((path) =>
          vscode.Uri.file(path)
        )
        
        // Если пользователь указал include, применяем дополнительную фильтрацию
        if (this.params.include && this.params.include.trim()) {
          const originalCount = fileUris.length;
          fileUris = this.applyManualIncludeFilter(fileUris, this.params.include.trim());
          this.extension.channel.appendLine(
            `Manual include: ${originalCount} → ${fileUris.length} files after filtering with "${this.params.include}"`
          )
        }
        
        // Если пользователь указал exclude, выполняем дополнительную фильтрацию
        if (this.params.exclude && this.params.exclude.trim()) {
          fileUris = this.applyManualExcludeFilter(fileUris, this.params.exclude.trim());
          this.extension.channel.appendLine(
            `After manual filtering: ${fileUris.length} files remain`
          )
        }
        
        return fileUris
      }

      // Получаем паттерны исключения ТОЛЬКО из настроек Search: Exclude
      const excludePatterns = this.getSearchExcludePatterns()
      const excludeGlob =
        excludePatterns.length > 0 ? `{${excludePatterns.join(',')}}` : null

      this.extension.channel.appendLine(
        `[DEBUG] Using exclude glob: ${excludeGlob}`
      )

      // Используем паттерн, указанный пользователем, или простой паттерн для всех файлов
      const actualPattern = this.params.include || '**/*'
      this.extension.channel.appendLine(
        `[DEBUG] Using pattern for search: ${actualPattern}`
      )

      // Используем поиск с исключением паттернов
      try {
        fileUris = await vscode.workspace.findFiles(
          includePattern,
          excludeGlob
        )
        this.extension.channel.appendLine(
          `[DEBUG] Found ${fileUris.length} files with VS Code findFiles and includePattern directly`
        )
      } catch (err) {
        this.extension.channel.appendLine(
          `[ERROR] Error using includePattern directly: ${err}`
        )
        
        // Запасной вариант: используем строку из this.params.include
        if (this.params.include) {
          fileUris = await vscode.workspace.findFiles(
            this.params.include,
            excludeGlob
          )
          this.extension.channel.appendLine(
            `[DEBUG] Found ${fileUris.length} files with this.params.include string pattern`
          )
        } else {
          // Если нет include, ищем все файлы
          fileUris = await vscode.workspace.findFiles('**/*', excludeGlob)
          this.extension.channel.appendLine(
            `[DEBUG] Found ${fileUris.length} files with fallback pattern **/*`
          )
        }
      }

      // Если пользователь указал exclude, выполняем дополнительную фильтрацию
      if (this.params.exclude && this.params.exclude.trim()) {
        const originalCount = fileUris.length;
        fileUris = this.applyManualExcludeFilter(fileUris, this.params.exclude.trim());
        this.extension.channel.appendLine(
          `Manual exclude: ${originalCount} → ${fileUris.length} files after filtering with "${this.params.exclude}"`
        )
      }

      this.extension.channel.appendLine(
        `[DEBUG] Found ${fileUris.length} files with exclusions`
      )

      // Если этот поиск не дал результатов, попробуем найти любые файлы
      if (fileUris.length === 0) {
        fileUris = await vscode.workspace.findFiles('**/*', excludeGlob)
        this.extension.channel.appendLine(
          `[DEBUG] Fallback search for any files found ${fileUris.length} files`
        )

        // Если пользователь указал exclude, выполняем дополнительную фильтрацию
        if (this.params.exclude && this.params.exclude.trim()) {
          const originalCount = fileUris.length;
          fileUris = this.applyManualExcludeFilter(fileUris, this.params.exclude.trim());
          this.extension.channel.appendLine(
            `Manual exclude (fallback): ${originalCount} → ${fileUris.length} files after filtering`
          )
        }

        if (fileUris.length === 0) {
          // Если даже этот поиск не дал результатов, значит рабочая область пуста
          this.extension.channel.appendLine(
            `[ERROR] No files found in workspace.`
          )
        } else {
          // Есть какие-то файлы, но исходный паттерн не подходит
          this.extension.channel.appendLine(
            `[ERROR] Files exist but don't match pattern: ${actualPattern}`
          )
        }
      }
    } catch (error) {
      this.extension.channel.appendLine(
        `[ERROR] Error finding files: ${error}, falling back to slower method.`
      )

      // Аварийный вариант: искать с учётом исключений
      try {
        const excludePatterns = this.getSearchExcludePatterns()
        const excludeGlob =
          excludePatterns.length > 0 ? `{${excludePatterns.join(',')}}` : null

        fileUris = await vscode.workspace.findFiles('**/*', excludeGlob)
        
        // Если пользователь указал exclude, выполняем дополнительную фильтрацию
        if (this.params.exclude && this.params.exclude.trim()) {
          const originalCount = fileUris.length;
          fileUris = this.applyManualExcludeFilter(fileUris, this.params.exclude.trim());
          this.extension.channel.appendLine(
            `Manual exclude (emergency): ${originalCount} → ${fileUris.length} files after filtering`
          )
        }
        
        this.extension.channel.appendLine(
          `[DEBUG] Emergency search found ${fileUris.length} files`
        )
      } catch (innerError) {
        this.extension.channel.appendLine(
          `[ERROR] Even emergency search failed: ${innerError}`
        )
      }
    }

    const duration = Date.now() - startTime
    this.extension.channel.appendLine(
      `Found ${fileUris.length} files in ${duration}ms`
    )

    return fileUris
  }
  
  // Новый метод для ручной фильтрации файлов по паттерну исключения
  private applyManualExcludeFilter(files: vscode.Uri[], excludePattern: string): vscode.Uri[] {
    // Разбиваем паттерн на части
    const excludeParts = excludePattern.split(',').map(part => part.trim());
    
    // Преобразуем простые имена папок в регулярные выражения для исключения
    const excludeRegexes = excludeParts.map(part => {
      if (!part.includes('*') && !part.includes('?') && !part.includes('[')) {
        // Для простых имен папок создаем регекс, исключающий эту папку и все в ней
        const escapedPart = part.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        return new RegExp(`(^|[/\\\\])${escapedPart}([/\\\\]|$)`, 'i');
      } else {
        // Для глоб-паттернов создаем соответствующий регекс
        // Заменяем * на .*, ? на ., преобразуем / и \\ правильно
        const regexPattern = part
          .replace(/\./g, '\\.')
          .replace(/\//g, '[/\\\\]')
          .replace(/\\\\/g, '[/\\\\]')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/\\\\]*')
          .replace(/\?/g, '[^/\\\\]');
        return new RegExp(regexPattern, 'i');
      }
    });
    
    this.extension.channel.appendLine(`Created ${excludeRegexes.length} exclude regexes`);
    
    // Фильтруем файлы, исключая те, что соответствуют хотя бы одному регексу
    return files.filter(uri => {
      const filePath = uri.fsPath;
      
      // Если файл соответствует хотя бы одному шаблону исключения, отфильтровываем его
      for (const regex of excludeRegexes) {
        if (regex.test(filePath)) {
          // this.extension.channel.appendLine(`Excluding file: ${filePath} (matches regex)`);
          return false;
        }
      }
      
      // Файл не соответствует ни одному шаблону исключения, оставляем его
      return true;
    });
  }

  // Новый метод для ручной фильтрации файлов по паттерну включения
  private applyManualIncludeFilter(files: vscode.Uri[], includePattern: string): vscode.Uri[] {
    // Разбиваем паттерн на части
    const includeParts = includePattern.split(',').map(part => part.trim());
    
    // Преобразуем в регулярные выражения для включения
    const includeRegexes = includeParts.map(part => {
      if (!part.includes('*') && !part.includes('?') && !part.includes('[')) {
        // Для простых имен папок создаем регекс, включающий эту папку и все в ней
        const escapedPart = part.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        return new RegExp(`(^|[/\\\\])${escapedPart}([/\\\\]|$)`, 'i');
      } else {
        // Для глоб-паттернов создаем соответствующий регекс
        const regexPattern = part
          .replace(/\./g, '\\.')
          .replace(/\//g, '[/\\\\]')
          .replace(/\\\\/g, '[/\\\\]')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/\\\\]*')
          .replace(/\?/g, '[^/\\\\]');
        return new RegExp(regexPattern, 'i');
      }
    });
    
    this.extension.channel.appendLine(`Created ${includeRegexes.length} include regexes`);
    
    // Фильтруем файлы, включая только те, что соответствуют хотя бы одному регексу
    return files.filter(uri => {
      const filePath = uri.fsPath;
      
      // Если файл соответствует хотя бы одному шаблону включения, оставляем его
      for (const regex of includeRegexes) {
        if (regex.test(filePath)) {
          return true;
        }
      }
      
      // Файл не соответствует ни одному шаблону включения, фильтруем его
      return false;
    });
  }

  // Запускает текстовый поиск с оптимизациями
  private async runTextSearch(
    FsImpl: any,
    includePattern: vscode.GlobPattern,
    excludePattern: vscode.GlobPattern | null,
    cancellationToken: vscode.CancellationToken
  ): Promise<void> {
    const startTime = Date.now()
    this.extension.channel.appendLine('Starting optimized text search...')
    this.extension.channel.appendLine(`Include pattern type: ${typeof includePattern}, value: ${JSON.stringify(includePattern)}`)
    this.extension.channel.appendLine(`Exclude pattern type: ${typeof excludePattern}, value: ${excludePattern || 'null'}`)

    try {
      // Установить контроллер прерывания для текстового поиска
      this.textSearchRunner.setAbortController(
        this.abortController || new AbortController()
      )

      // Получаем индексированные файлы
      const indexedFileUris = await this.getFastFileList(includePattern)

      if (this.abortController?.signal.aborted) {
        this.extension.channel.appendLine(
          'Text search aborted during file listing.'
        )
        return
      }

      // Создаем Set путей индексированных файлов для быстрой проверки дубликатов
      const indexedFilePaths = new Set(indexedFileUris.map((uri) => uri.fsPath))
      this.extension.channel.appendLine(
        `Found ${indexedFilePaths.size} indexed files`
      )

      // Получаем все файлы, соответствующие includePattern и не исключенные excludePattern
      // Используем стандартный метод findFiles от VS Code
      const exclude = excludePattern ? excludePattern : null
      let allFileUris: vscode.Uri[] = []
      
      try {
        allFileUris = await vscode.workspace.findFiles(
          includePattern,
          exclude
        )
        this.extension.channel.appendLine(`Files found with VS Code's findFiles: ${allFileUris.length}`)
      } catch (err) {
        this.extension.channel.appendLine(`Error during findFiles: ${err}. Using indexedFiles only.`)
      }

      // Формируем окончательный список URI файлов без дубликатов
      const finalFileUris: vscode.Uri[] = Array.from(indexedFileUris)

      // Добавляем только те файлы, которых нет среди индексированных
      let addedCount = 0
      for (const uri of allFileUris) {
        if (!indexedFilePaths.has(uri.fsPath)) {
          finalFileUris.push(uri)
          addedCount++
        }
      }

      this.extension.channel.appendLine(
        `Added ${addedCount} additional non-indexed files matching criteria`
      )
      this.extension.channel.appendLine(
        `Total files to search: ${finalFileUris.length}`
      )

      // Убедимся, что индекс файлов передан в TextSearchRunner
      if (this.fileIndexCache.size > 0) {
        this.textSearchRunner.setFileIndex(this.fileIndexCache)
        this.extension.channel.appendLine(
          `Индекс ${this.fileIndexCache.size} групп файлов передан в TextSearchRunner перед запуском поиска`
        )
      }

      // Выполняем текстовый поиск по объединенному списку файлов
      const filesWithMatches = await this.textSearchRunner.performTextSearch(
        this.params,
        finalFileUris,
        FsImpl,
        (message) => this.extension.channel.appendLine(message)
      )

      // Если не отменен, добавляем файлы с совпадениями в предыдущие результаты
      if (!this.abortController?.signal.aborted) {
        filesWithMatches.forEach((file) => this.previousSearchFiles.add(file))
      }

      // Логируем результаты
      const duration = Date.now() - startTime
      this.extension.channel.appendLine(
        `Text search completed in ${duration}ms. Found matches in ${filesWithMatches.size} files.`
      )
    } catch (error) {
      this.extension.channel.appendLine(
        `Error in text search: ${
          error instanceof Error ? error.stack : String(error)
        }`
      )
    } finally {
      if (!this.abortController?.signal.aborted) {
        this.emit('done')
      }
    }
  }

  // Базовая функция запуска поиска
  run(): void {
    if (this.params.paused) {
      this.extension.channel.appendLine('Search paused. Not running.')
      return
    }

    // Останавливаем предыдущий поиск
    this.stop()

    const abortController = new AbortController()
    this.abortController = abortController

    this.emit('start')

    // Выводим отладочную информацию о параметрах поиска
    this.extension.channel.appendLine(`[DEBUG] Search params:`)
    this.extension.channel.appendLine(`[DEBUG]   find: ${this.params.find || 'not set'}`)
    this.extension.channel.appendLine(`[DEBUG]   include: ${this.params.include || 'not set'}`)
    this.extension.channel.appendLine(`[DEBUG]   exclude: ${this.params.exclude || 'not set'}`)
    this.extension.channel.appendLine(`[DEBUG]   matchCase: ${this.params.matchCase}`)
    this.extension.channel.appendLine(`[DEBUG]   wholeWord: ${this.params.wholeWord}`)
    this.extension.channel.appendLine(`[DEBUG]   searchMode: ${this.params.searchMode}`)
    this.extension.channel.appendLine(`[DEBUG]   useTransformFile: ${this.params.useTransformFile ? 'true' : 'false'}`)

    // Проверяем изменения include и exclude для сброса кеша
    this.checkSearchParamsChanged()

    if (!this.params.find && !this.params.useTransformFile) {
      this.extension.channel.appendLine(
        'No search pattern or transform file specified.'
      )
      this.emit('done')
      return
    }

    // Выводим информацию о текущих рабочих директориях
    const wsInfo = vscode.workspace.workspaceFolders
    if (wsInfo && wsInfo.length > 0) {
      this.extension.channel.appendLine(`[DEBUG] Workspace folders:`)
      wsInfo.forEach((folder, index) => {
        this.extension.channel.appendLine(
          `[DEBUG]   ${index + 1}: ${folder.name} (${folder.uri.fsPath})`
        )
      })
    } else {
      this.extension.channel.appendLine(
        `[ERROR] No workspace folders are open!`
      )
    }

    // Если индексация еще не завершена, обновляем индекс файлов в TextSearchRunner только один раз перед поиском
    if (this.fileIndexCache.size > 0) {
      // Нет необходимости передавать индекс здесь,
      // это будет сделано перед запуском поиска в getFastFileList
      this.extension.channel.appendLine(
        `[DEBUG] Индекс ${this.fileIndexCache.size} групп файлов будет передан перед запуском поиска`
      )
    }

    const FsImpl: any = {
      readFile: async (filePath: string) => {
        const uri = vscode.Uri.file(filePath)
        try {
          if (this.fileDocs.has(filePath)) {
            const doc = this.fileDocs.get(filePath)
            if (doc) {
              return doc.getText()
            }
          }

          // Попытка получения открытого документа для быстрого доступа
          const docs = vscode.workspace.textDocuments
          const openDoc = docs.find((d) => d.uri.fsPath === filePath)

          if (openDoc) {
            this.fileDocs.set(filePath, openDoc)
            return openDoc.getText()
          }

          // Если документ не открыт, читаем файл
          const bytes = await vscode.workspace.fs.readFile(uri)
          const content = new TextDecoder('utf-8').decode(bytes)
          return content
        } catch (error) {
          throw new Error(`Failed to read ${filePath}: ${error}`)
        }
      },
      exists: async (filePath: string) => {
        const uri = vscode.Uri.file(filePath)
        try {
          await vscode.workspace.fs.stat(uri)
          return true
        } catch {
          return false
        }
      },
    }

    // Получаем пути рабочих папок в формате строк
    const workspaceFolderPaths =
      vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || []
    if (workspaceFolderPaths.length === 0) {
      this.extension.channel.appendLine('No workspace folders open.')
      this.emit('error', new Error('No workspace folders open.'))
      this.emit('done')
      return
    }

    // Преобразование параметров включения и исключения в шаблоны
    let includePattern: vscode.GlobPattern
    let excludePattern: vscode.GlobPattern | null = null

    try {
      // Используем значение из настроек include, если оно задано через includeGlob
      const include = this.includeGlob || this.params.include || '**/*.{js,jsx,ts,tsx}'
      
      // Проверяем, не является ли include уже объектом RelativePattern
      if (typeof include === 'object' && 'pattern' in include) {
        this.extension.channel.appendLine(`Using include as RelativePattern directly`);
        includePattern = include;
      } else {
        // Преобразуем строковый паттерн
        includePattern = convertGlobPattern(include, workspaceFolderPaths)
      }
      
      this.extension.channel.appendLine(`[DEBUG] Include pattern: ${JSON.stringify(includePattern)}`);

      // Получаем паттерны ТОЛЬКО из настроек Search: Exclude
      const excludePatterns = this.getSearchExcludePatterns()

      let excludeGlob = '';
      
      // Если пользователь указал exclude, используем его как приоритетный
      if (this.params.exclude && this.params.exclude.trim() !== '') {
        // Преобразуем простые имена папок в полные шаблоны исключения
        let userExclude = this.params.exclude.trim();
        
        // Разбиваем на отдельные части, если пользователь указал несколько через запятую
        const excludeParts = userExclude.split(',').map(part => part.trim());
        
        // Обрабатываем каждую часть
        const processedParts = excludeParts.map(part => {
          // Проверяем, что это простое имя папки без специальных символов glob
          if (!part.includes('*') && !part.includes('?') && !part.includes('[')) {
            // Удаляем слеш в конце, если есть
            const cleanPart = part.endsWith('/') ? part.slice(0, -1) : part;
            // Преобразуем в формат исключения папки с разными вариантами шаблонов
            // для более надежного исключения
            return `${cleanPart}/**,**/${cleanPart}/**,**/${cleanPart}`;
          }
          return part;
        });
        
        // Собираем все части обратно в строку
        userExclude = processedParts.join(',');
        
        excludeGlob = userExclude;
        
        // Добавляем системные исключения только если они есть
        if (excludePatterns.length > 0) {
          excludeGlob += `,${excludePatterns.join(',')}`;
        }
      } else {
        // Если пользовательских исключений нет, используем только системные
        excludeGlob = excludePatterns.join(',');
      }

      // Преобразуем строковый паттерн исключения, если он есть
      excludePattern = excludeGlob ? convertGlobPattern(excludeGlob, workspaceFolderPaths) : null;
      this.extension.channel.appendLine(`[DEBUG] Exclude pattern: ${excludePattern}`);

      // Если mode = searchInResults, выполняем поиск только в предыдущих результатах
      if (this.params.searchInResults && this.previousSearchFiles.size > 0) {
        this.extension.channel.appendLine(
          `Searching in previous results (${this.previousSearchFiles.size} files).`
        )

        // Запускаем текстовый поиск в предыдущих результатах
        void this.runTextSearchInPreviousResults(FsImpl, abortController.signal)
        return
      }

      // Обычный поиск по всем файлам
      this.extension.channel.appendLine(
        `Starting search with mode=${this.params.searchMode}.`
      )

      // Запускаем текстовый поиск (единственный поддерживаемый режим после оптимизации)
      void this.runTextSearch(
        FsImpl,
        includePattern,
        excludePattern,
        abortController.signal as unknown as vscode.CancellationToken
      )
    } catch (error: any) {
      this.extension.channel.appendLine(
        `Error in search: ${error.stack || error}`
      )
      this.emit('error', error)
      this.emit('done')
    }
  }

  // Новый метод: Поиск в предыдущих результатах (текстовый)
  private async runTextSearchInPreviousResults(
    FsImpl: any,
    cancellationToken: AbortSignal
  ): Promise<void> {
    const startTime = Date.now()
    this.extension.channel.appendLine(
      'Starting text search in previous results...'
    )

    try {
      // Создаем список URI файлов из предыдущих результатов
      const fileUris = Array.from(this.previousSearchFiles).map((path) =>
        vscode.Uri.file(path)
      )

      if (cancellationToken.aborted) {
        this.extension.channel.appendLine('Search aborted during setup.')
        return
      }

      // Устанавливаем контроллер прерывания
      this.textSearchRunner.setAbortController(
        this.abortController || new AbortController()
      )

      // Выполняем текстовый поиск только в файлах с предыдущими совпадениями
      const filesWithMatches = await this.textSearchRunner.performTextSearch(
        this.params,
        fileUris,
        FsImpl,
        (message) => this.extension.channel.appendLine(message)
      )

      // Обновляем список файлов с совпадениями
      if (!cancellationToken.aborted) {
        // Очищаем предыдущие результаты и сохраняем только новые
        this.previousSearchFiles.clear()
        filesWithMatches.forEach((file) => this.previousSearchFiles.add(file))
      }

      const duration = Date.now() - startTime
      this.extension.channel.appendLine(
        `Search in previous results completed in ${duration}ms. Found matches in ${filesWithMatches.size} files.`
      )
    } catch (error) {
      this.extension.channel.appendLine(
        `Error in search: ${
          error instanceof Error ? error.stack : String(error)
        }`
      )
    } finally {
      if (!cancellationToken.aborted) {
        this.emit('done')
      }
    }
  }

  // Остальной код...

  // Добавим реализацию метода для обновления файла в результатах поиска
  private async refreshFileSourceInSearchResults(
    fileUri: vscode.Uri
  ): Promise<void> {
    try {
      // Читаем актуальное содержимое файла
      const bytes = await vscode.workspace.fs.readFile(fileUri)
      const newContent = new TextDecoder('utf-8').decode(bytes)

      // Отправляем обновление в UI
      this.extension.searchReplaceViewProvider.postMessage({
        type: 'fileUpdated',
        filePath: fileUri.toString(),
        newSource: newContent,
      })
    } catch (error) {
      this.extension.channel.appendLine(
        `Error updating source for ${fileUri.fsPath}: ${error}`
      )
      throw error
    }
  }

  // Методы для работы с кешем поиска
  
  /**
   * Очищает кеш для указанного файла
   */
  clearCacheForFile(fileUri: vscode.Uri): void {
    // Очищаем кеш в TextSearchRunner
    this.textSearchRunner.clearCacheForFile(fileUri);
    this.extension.channel.appendLine(`Кеш поиска очищен для файла: ${fileUri.fsPath}`);
  }
  
  /**
   * Полностью очищает кеш поиска
   */
  clearCache(): void {
    // Очищаем кеш в TextSearchRunner
    this.textSearchRunner.clearCache();
    this.extension.channel.appendLine('Кеш поиска полностью очищен');
  }

  // Проверяем изменения include и exclude для сброса кеша
  private checkSearchParamsChanged(): void {
    // Сохраняем текущие значения для сравнения
    const currentInclude = this.params.include;
    const currentExclude = this.params.exclude;
    
    // Подробное логирование для отладки
    this.extension.channel.appendLine(`[Include/Exclude Change Check]
    - Текущий include: "${currentInclude || 'не задан'}"  
    - Предыдущий include: "${this.previousInclude || 'не задан'}"
    - Текущий exclude: "${currentExclude || 'не задан'}"
    - Предыдущий exclude: "${this.previousExclude || 'не задан'}"`);
    
    // Проверяем изменения include и exclude для сброса кеша
    if (currentInclude !== this.previousInclude || currentExclude !== this.previousExclude) {
      this.extension.channel.appendLine(`[ВАЖНО] Параметры поиска изменились, очищаем кеш.`);
      
      // Если include изменился, выводим подробную информацию
      if (currentInclude !== this.previousInclude) {
        this.extension.channel.appendLine(`Include изменился: "${this.previousInclude || 'не задан'}" -> "${currentInclude || 'не задан'}"`);
      }
      
      // Если exclude изменился, выводим подробную информацию
      if (currentExclude !== this.previousExclude) {
        this.extension.channel.appendLine(`Exclude изменился: "${this.previousExclude || 'не задан'}" -> "${currentExclude || 'не задан'}"`);
      }
      
      // Очищаем кеш и в TextSearchRunner
      this.clearCache();
      
      // Обновляем сохраненные значения
      this.previousInclude = currentInclude;
      this.previousExclude = currentExclude;
    }
  }
}
