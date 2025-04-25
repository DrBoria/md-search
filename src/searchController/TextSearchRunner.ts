import * as vscode from 'vscode'
import type { IpcMatch } from 'astx/node'
import { TypedEmitter } from 'tiny-typed-emitter'
import { AstxRunnerEvents, TransformResultEvent } from './SearchRunnerTypes'
import { cpus } from 'os'
import { SearchCache } from './SearchCache'

// Количество worker threads для параллельной обработки файлов
const DEFAULT_CONCURRENT_WORKERS = Math.max(1, Math.min(cpus().length - 1, 4))
// Размер пакета файлов для обработки за один раз
const BATCH_SIZE = 10

// Определение типа IpcMatch с необходимыми свойствами для сравнения
interface ExtendedIpcMatch extends IpcMatch {
  start: number
  end: number
}

export class TextSearchRunner extends TypedEmitter<AstxRunnerEvents> {
  private processedFiles: Set<string> = new Set()
  private abortController: AbortController | undefined
  private concurrentWorkers: number
  // Добавляем поле для хранения индекса файлов
  private fileIndexCache: Map<string, Set<string>> | null = null
  // Флаг, указывающий, что поиск уже выполняется
  private isSearchRunning = false
  // Флаг, который показывает, что индекс уже был установлен в этом сеансе поиска
  private isIndexSetInCurrentSearch = false
  // Добавляем кеш поиска
  private searchCache: SearchCache

  constructor(
    private extension: any,
    concurrentWorkers = DEFAULT_CONCURRENT_WORKERS
  ) {
    super()
    this.concurrentWorkers = concurrentWorkers
    this.searchCache = new SearchCache(this.extension.channel)
  }

  // Новый метод для установки ссылки на файловый индекс из SearchRunner
  setFileIndex(fileIndexCache: Map<string, Set<string>>): void {
    // Если индекс уже установлен в текущем поиске, не вызываем повторно
    if (this.isSearchRunning && this.isIndexSetInCurrentSearch) {
      this.extension.channel.appendLine(
        `[TextSearchRunner] Попытка повторной установки индекса во время поиска игнорируется`
      )
      return
    }

    this.fileIndexCache = fileIndexCache
    this.isIndexSetInCurrentSearch = true
    this.extension.channel.appendLine(
      `[TextSearchRunner] Получен индекс файлов с ${fileIndexCache.size} типами файлов`
    )
  }

  // Оптимизированная фильтрация списка файлов с использованием индекса
  private filterFilesByIndexAndPattern(
    fileUris: vscode.Uri[],
    includePattern: string
  ): { indexedFiles: vscode.Uri[]; otherFiles: vscode.Uri[] } {
    if (!this.fileIndexCache || fileUris.length === 0) {
      return { indexedFiles: [], otherFiles: fileUris }
    }

    this.extension.channel.appendLine(
      `[TextSearchRunner] Разделение ${fileUris.length} файлов на индексированные и неиндексированные...`
    )

    const startTime = Date.now()
    const indexedFiles: vscode.Uri[] = []
    const otherFiles: vscode.Uri[] = []
    const allIndexedPaths = new Set<string>()

    // Собираем все индексированные пути в один набор для быстрой проверки
    if (this.fileIndexCache.has('**/*')) {
      const allFilesSet = this.fileIndexCache.get('**/*')
      if (allFilesSet && allFilesSet.size > 0) {
        allFilesSet.forEach((path) => allIndexedPaths.add(path))
      }
    } else {
      // Если нет общего индекса, собираем из всех паттернов
      for (const fileSet of this.fileIndexCache.values()) {
        fileSet.forEach((path) => allIndexedPaths.add(path))
      }
    }

    // Разделяем файлы на индексированные и остальные
    fileUris.forEach((uri) => {
      if (allIndexedPaths.has(uri.fsPath)) {
        indexedFiles.push(uri)
      } else {
        otherFiles.push(uri)
      }
    })

    const duration = Date.now() - startTime
    this.extension.channel.appendLine(
      `[TextSearchRunner] Выделено ${indexedFiles.length} индексированных и ${otherFiles.length} неиндексированных файлов за ${duration}ms`
    )

    return { indexedFiles, otherFiles }
  }

  async performTextSearch(
    params: any,
    fileUris: vscode.Uri[],
    FsImpl: any,
    logMessage: (message: string) => void
  ): Promise<Set<string>> {
    // Установка флага, что поиск выполняется
    this.isSearchRunning = true
    this.isIndexSetInCurrentSearch = true

    // Создаем новый AbortController для этого поиска и сохраняем на него ссылку
    if (!this.abortController) {
      this.abortController = new AbortController()
    }
    const { signal } = this.abortController

    const filesWithMatches = new Set<string>()
    const startTime = Date.now()

    // Извлекаем параметры поиска
    const { find, matchCase, wholeWord, exclude } = params

    // Проверяем текущий узел кеша, если он существует
    const currentNode = this.searchCache.getCurrentNode();
    
    // Если текущий узел существует, но запрос не является его расширением или 
    // дочерним узлом, очищаем кеш полностью
    if (currentNode && find && !find.startsWith(currentNode.query)) {
      logMessage(`[CacheSearch] Новый запрос не является расширением предыдущего, очищаем кеш`);
      this.searchCache.clearCache();
    }

    // Проверяем наличие подходящего кеша
    let cacheNode = this.searchCache.findSuitableCache(
      find, 
      matchCase, 
      wholeWord, 
      exclude
    )

    if (!cacheNode) {
      // Если подходящий кеш не найден, создаем новый
      logMessage(`[CacheSearch] Создание нового кеша для запроса "${find}"`)
      cacheNode = this.searchCache.createCacheNode(find, matchCase, wholeWord, exclude)
    } else {
      // Если кеш найден, загружаем результаты из него
      logMessage(`[CacheSearch] Найден кеш для запроса "${find}", используем кешированные результаты`)
      
      // Добавляем файлы из кеша в результаты
      const cachedResults = this.searchCache.getCurrentResults();
      if (cachedResults) {
        for (const [uri, result] of cachedResults.entries()) {
          if (result.file) {
            filesWithMatches.add(result.file.toString())
            this.handleResult(result)
          }
        }
      }
    }

    try {
      // Получаем списки файлов, которые уже обработаны и которые нужно пропустить
      const processedFiles = this.searchCache.getProcessedFiles()
      const excludedFiles = this.searchCache.getExcludedFiles()
      
      // Фильтруем файлы, которые не нужно обрабатывать повторно
      const filesToProcess = fileUris.filter(uri => {
        const filePath = uri.toString();
        return !processedFiles.has(filePath) && !excludedFiles.has(filePath);
      });

      // Разделяем файлы на проиндексированные и остальные
      const { indexedFiles, otherFiles } = this.filterFilesByIndexAndPattern(
        filesToProcess,
        ''
      )

      // Общее количество файлов для поиска
      const total = indexedFiles.length + otherFiles.length + processedFiles.size
      let completed = processedFiles.size

      this.emit('progress', { completed, total })
      logMessage(
        `Всего ${total} файлов: ${processedFiles.size} из кеша, ${indexedFiles.length} проиндексированных файлов и ${otherFiles.length} непроиндексированных.`
      )

      // Если кеш полный и завершен, нет нужды продолжать поиск
      if (this.searchCache.isCurrentSearchComplete() && filesToProcess.length === 0) {
        logMessage('Все результаты получены из кеша, поиск завершен.')
        this.emit('done')
        return filesWithMatches;
      }

      // Обрабатываем индексированные файлы первыми (они приоритетны)
      if (indexedFiles.length > 0) {
        logMessage(`Обработка ${indexedFiles.length} проиндексированных файлов...`)

        // Преобразуем в пути к файлам
        const indexedPaths = indexedFiles.map((uri) => uri.fsPath)

        this.concurrentWorkers = Math.ceil(indexedPaths.length / BATCH_SIZE)

        // Создаем группы индексированных файлов для параллельной обработки
        const indexedGroups: string[][] = Array.from(
          { length: this.concurrentWorkers },
          () => []
        )

        indexedPaths.forEach((file, index) => {
          indexedGroups[index % this.concurrentWorkers].push(file)
        })

        // Обрабатываем индексированные файлы параллельно
        await this.processFilesInBatches(
          indexedGroups,
          params,
          FsImpl,
          signal,
          (file, result) => {
            filesWithMatches.add(file)
            // Добавляем результат в кеш
            this.searchCache.addResult(result)
          },
          (progress) => {
            completed += progress
            this.emit('progress', { completed, total })
          },
          logMessage
        )

        logMessage(
          `Завершен поиск в ${indexedFiles.length} проиндексированных файлах, найдены совпадения в ${filesWithMatches.size} файлах.`
        )
      }

      // Затем обрабатываем остальные файлы, если поиск не отменен
      if (!signal.aborted && otherFiles.length > 0) {
        logMessage(`Обработка ${otherFiles.length} непроиндексированных файлов...`)

        // Преобразуем в пути к файлам
        const otherPaths = otherFiles.map((uri) => uri.fsPath)

        // Создаем группы остальных файлов для параллельной обработки
        const otherGroups: string[][] = Array.from(
          { length: this.concurrentWorkers },
          () => []
        )

        otherPaths.forEach((file, index) => {
          otherGroups[index % this.concurrentWorkers].push(file)
        })

        // Обрабатываем остальные файлы параллельно
        await this.processFilesInBatches(
          otherGroups,
          params,
          FsImpl,
          signal,
          (file, result) => {
            filesWithMatches.add(file)
            // Добавляем результат в кеш
            this.searchCache.addResult(result)
          },
          (progress) => {
            completed += progress
            this.emit('progress', { completed, total })
          },
          logMessage
        )
      }

      // Если поиск не был прерван, помечаем кеш как завершенный
      if (!signal.aborted) {
        this.searchCache.markCurrentAsComplete();
        logMessage(`Поиск завершен, кеш "${find}" помечен как завершенный.`);
      }

      return filesWithMatches
    } catch (error) {
      logMessage(`Error during text search: ${error}`)
      // В случае ошибки также отправляем сообщение об ошибке
      this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error))
      )
      return filesWithMatches
    } finally {
      // Сбрасываем флаги при завершении поиска в любом случае
      this.isSearchRunning = false
      this.isIndexSetInCurrentSearch = false

      const duration = Date.now() - startTime
      logMessage(
        `Text search completed in ${duration}ms with ${filesWithMatches.size} matches`
      )

      // Явно посылаем событие о завершении поиска для обновления UI
      if (!signal.aborted) {
        this.emit('done')
      }
    }
  }

  // Новый метод для потоковой обработки групп файлов
  private async processFilesInBatches(
    fileGroups: string[][],
    params: any,
    FsImpl: any,
    signal: AbortSignal,
    onMatchFound: (file: string, result: TransformResultEvent) => void,
    onProgress: (progress: number) => void,
    logMessage: (message: string) => void
  ): Promise<void> {
    // Для каждой рабочей группы создаем отдельный поток обработки
    for (let groupIndex = 0; groupIndex < fileGroups.length; groupIndex++) {
      if (signal.aborted) break

      const fileGroup = fileGroups[groupIndex]

      // Обрабатываем пакет файлов параллельно, но с ограничением количества одновременных операций
      const batchPromises = fileGroup.map((file) =>
        this.processFile(
          file,
          params,
          FsImpl,
          signal,
          onMatchFound,
          onProgress,
          logMessage
        )
      )

      await Promise.all(batchPromises)

      if (signal.aborted) break
    }
  }

  // Обработка одного файла
  private async processFile(
    file: string,
    params: any,
    FsImpl: any,
    signal: AbortSignal,
    onMatchFound: (file: string, result: TransformResultEvent) => void,
    onProgress: (progress: number) => void,
    logMessage: (message: string) => void
  ): Promise<void> {
    if (signal.aborted) return

    const { find, matchCase, wholeWord } = params
    let source = ''
    let fileError: Error | undefined = undefined
    const matches: ExtendedIpcMatch[] = []
    
    // Определяем тип файла для отладки
    const fileExtension = file.split('.').pop()?.toLowerCase() || '';
    
    try {
      // Индексируем файл перед обработкой - это позволит индексировать все просканированные файлы
      this.indexSingleFile(file, logMessage)

      source = await FsImpl.readFile(file, 'utf8')
      if (signal.aborted) return
      
      // Дополнительное логирование для TS и JS файлов
      if (fileExtension === 'ts' || fileExtension === 'js') {
        logMessage(`[DEBUG] Обрабатывается ${fileExtension} файл: ${file}`)
      }

      // Оптимизированный поиск совпадений
      await this.findMatches(
        source,
        file,
        find,
        matchCase,
        wholeWord,
        matches,
        logMessage
      )
      
      // Если файл TS и в нем есть совпадения - особый лог
      if (fileExtension === 'ts' && matches.length > 0) {
        logMessage(`[DEBUG] Найдены совпадения в TS файле: ${file} (${matches.length} совпадений)`)
      }
    } catch (err: any) {
      if (signal.aborted) return
      logMessage(`Error processing file ${file}: ${err.message}`)
      fileError = err instanceof Error ? err : new Error(String(err))
    } finally {
      if (!signal.aborted) {
        let ipcError: any = undefined
        if (fileError) {
          ipcError = {
            name: 'Error',
            message: fileError.message,
            stack: fileError.stack,
          }
        }

        // Создаем объект результата
        const result: TransformResultEvent = {
          file: vscode.Uri.file(file),
          source,
          transformed: undefined,
          matches,
          reports: [],
          error: ipcError,
        }

        // Если файл содержит совпадения, добавляем его в коллекцию
        if (matches.length > 0) {
          onMatchFound(file, result)
          logMessage(
            `[Debug] File with matches: ${file} (${matches.length} matches)`
          )

          this.handleResult(result)
        }

        onProgress(1) // Сообщаем о прогрессе (1 файл)
        this.processedFiles.add(file)
      }
    }
  }

  // Метод для индексации одного файла
  private indexSingleFile(
    filePath: string,
    logMessage: (message: string) => void
  ): void {
    // Инициализируем fileIndexCache, если он еще не существует
    if (!this.fileIndexCache) {
      this.fileIndexCache = new Map<string, Set<string>>()
      this.fileIndexCache.set('**/*', new Set<string>())
    }

    // Получаем набор всех файлов
    const allFilesSet = this.fileIndexCache.get('**/*')!

    // Добавляем файл в общий индекс, если его еще нет
    if (!allFilesSet.has(filePath)) {
      allFilesSet.add(filePath)

      // Также добавляем файл в соответствующую категорию по расширению
      const fileExt = filePath.split('.').pop()?.toLowerCase()
      if (fileExt) {
        const pattern = `*.${fileExt}`
        let filesByExt = this.fileIndexCache.get(pattern)
        if (!filesByExt) {
          filesByExt = new Set<string>()
          this.fileIndexCache.set(pattern, filesByExt)
        }
        filesByExt.add(filePath)
      }
    }
  }

  handleResult(result: TransformResultEvent): void {
    const { file } = result

    if (!file) {
      this.extension.channel.appendLine(
        `Received result with missing file path.`
      )
      return
    }

    if (this.abortController?.signal.aborted) {
      this.extension.channel.appendLine(
        `handleResult skipped for ${file.fsPath}: Aborted.`
      )
      return
    }

    this.processedFiles.add(file.fsPath)
    this.emit('result', result)
  }

  stop(): void {
    if (this.abortController) {
      this.extension.channel.appendLine('Aborting current text search...')
      this.abortController.abort()
      this.abortController = undefined
    }
    // this.processedFiles.clear()
    this.isSearchRunning = false
    this.isIndexSetInCurrentSearch = false
    this.emit('stop')
    this.extension.channel.appendLine('Text search stopped, results cleared.')
  }

  setAbortController(controller: AbortController): void {
    this.abortController = controller
  }

  // Оптимизированный поиск совпадений в файле
  private async findMatches(
    source: string,
    file: string,
    find: string,
    matchCase: boolean,
    wholeWord: boolean,
    matches: ExtendedIpcMatch[],
    logMessage: (message: string) => void
  ): Promise<void> {
    // Проверка на прерывание поиска
    if (this.abortController?.signal.aborted) {
      logMessage(`[DEBUG] Search aborted for file: ${file}`)
      return
    }

    logMessage(`[DEBUG] Searching in file: ${file}`)
    logMessage(`[DEBUG] Search pattern: "${find}"`)

    const regexFlags = matchCase ? 'g' : 'gi'
    const escapedPattern = find.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
    const searchPattern = wholeWord ? `\\b${escapedPattern}\\b` : escapedPattern
    const regex = new RegExp(searchPattern, regexFlags)

    // Используем разные подходы в зависимости от размера файла
    if (source.length > 1024 * 1024) {
      // 1 MB
      // Для больших файлов используем поиск по чанкам без разбиения всего файла на строки
      await this.findMatchesInChunks(source, file, regex, matches)
    } else {
      // Для небольших файлов можно использовать обычный подход
      const lines = source.split(/\r\n?|\n/)
      await this.findMatchesInSource(source, file, regex, lines, matches)
    }
  }

  // Поиск совпадений для больших файлов с разбивкой на части
  private async findMatchesInChunks(
    source: string,
    file: string,
    regex: RegExp,
    matches: ExtendedIpcMatch[]
  ): Promise<void> {
    const CHUNK_SIZE = 512 * 1024 // 512 KB
    const overlap = 1024 // 1 KB overlap между чанками для обработки совпадений на границах

    // Проверка флага abort через abortController
    if (this.abortController?.signal.aborted) return

    // Кэш для позиций начала строк
    const lineStartPositions = new Map<
      number,
      { line: number; column: number }
    >()

    // Инициализируем только первую позицию, остальные будем вычислять по необходимости
    lineStartPositions.set(0, { line: 1, column: 0 })

    for (
      let startPos = 0;
      startPos < source.length;
      startPos += CHUNK_SIZE - overlap
    ) {
      // Проверка прерывания поиска в начале каждой итерации
      if (this.abortController?.signal.aborted) return

      const endPos = Math.min(startPos + CHUNK_SIZE, source.length)
      const chunk = source.substring(startPos, endPos)

      // Освобождаем event loop для предотвращения блокировки UI
      await new Promise((resolve) => setTimeout(resolve, 0))

      // Сбрасываем lastIndex для нового поиска
      regex.lastIndex = 0

      let matchResult: RegExpExecArray | null
      let matchesInCurrentChunk = 0

      while ((matchResult = regex.exec(chunk)) !== null) {
        // Проверка прерывания поиска внутри цикла обработки совпадений
        if (this.abortController?.signal.aborted) return

        // Периодически освобождаем event loop, чтобы не блокировать UI
        // особенно важно при большом количестве совпадений
        if (++matchesInCurrentChunk % 100 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }

        // Пропускаем пустые совпадения
        if (matchResult[0].length === 0) {
          regex.lastIndex++
          continue
        }

        const chunkOffset = startPos
        const matchStartOffset = chunkOffset + matchResult.index
        const matchEndOffset = matchStartOffset + matchResult[0].length
        const matchText = matchResult[0]

        // Пропускаем дубликаты, которые могут возникнуть из-за перекрытия
        const isDuplicate = matches.some(
          (m) => m.start === matchStartOffset && m.end === matchEndOffset
        )

        if (!isDuplicate) {
          // Ищем ближайшую известную позицию начала строки перед matchStartOffset
          let closestPosition = 0
          let posInfo = { line: 1, column: 0 }

          for (const [pos, info] of lineStartPositions.entries()) {
            if (pos <= matchStartOffset && pos > closestPosition) {
              closestPosition = pos
              posInfo = info
            }
          }

          // Вычисляем line и column для текущего совпадения только от ближайшей известной позиции
          let line = posInfo.line
          let column = posInfo.column

          // Вычисляем позицию только для еще не обработанных символов
          for (let i = closestPosition; i < matchStartOffset; i++) {
            if (source[i] === '\n') {
              line++
              column = 0
              lineStartPositions.set(i + 1, { line, column })
            } else if (source[i] === '\r') {
              if (i + 1 < source.length && source[i + 1] === '\n') {
                i++
              }
              line++
              column = 0
              lineStartPositions.set(i + 1, { line, column })
            } else {
              column++
            }
          }

          // Сохраняем позицию сразу после текущего совпадения, чтобы ускорить следующие вычисления
          lineStartPositions.set(matchEndOffset, {
            line,
            column: column + matchText.length,
          })

          // Вычисляем конечную позицию для совпадения
          let endLine = line
          let endColumn = column

          // Если совпадение содержит символы новой строки, нужно вычислить конечную позицию
          for (let i = 0; i < matchText.length; i++) {
            if (matchText[i] === '\n') {
              endLine++
              endColumn = 0
            } else if (matchText[i] === '\r') {
              if (i + 1 < matchText.length && matchText[i + 1] === '\n') {
                i++
              }
              endLine++
              endColumn = 0
            } else {
              endColumn++
            }
          }

          // Добавляем совпадение
          matches.push({
            type: 'match' as any,
            start: matchStartOffset,
            end: matchEndOffset,
            file,
            source: matchText,
            captures: {},
            report: undefined,
            transformed: undefined,
            loc: {
              start: { line, column },
              end: { line: endLine, column: endColumn },
            },
            path: undefined,
            node: undefined,
            paths: undefined,
            nodes: undefined,
          } as unknown as ExtendedIpcMatch)
        }
      }
    }
  }

  // Поиск совпадений в файле целиком (для небольших файлов)
  private async findMatchesInSource(
    source: string,
    file: string,
    regex: RegExp,
    lines: string[],
    matches: ExtendedIpcMatch[]
  ): Promise<void> {
    // Проверка флага abort через abortController
    if (this.abortController?.signal.aborted) return

    let matchResult: RegExpExecArray | null
    let matchesFound = 0

    while ((matchResult = regex.exec(source)) !== null) {
      // Проверка прерывания поиска внутри цикла
      if (this.abortController?.signal.aborted) return

      // Периодически освобождаем event loop
      if (++matchesFound % 100 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      // Пропускаем пустые совпадения
      if (matchResult[0].length === 0) {
        regex.lastIndex++
        continue
      }

      const startOffset = matchResult.index
      const endOffset = startOffset + matchResult[0].length

      this.addMatch(
        source,
        file,
        startOffset,
        endOffset,
        matchResult[0],
        lines,
        matches
      )
    }
  }

  // Метод addMatchForLargeFile теперь не нужен, так как его логика перенесена в findMatchesInChunks
  // Сохраним метод для обратной совместимости, но сделаем его приватным и пустым
  private async addMatchForLargeFile(
    source: string,
    file: string,
    startOffset: number,
    endOffset: number,
    matchText: string,
    matches: ExtendedIpcMatch[]
  ): Promise<void> {
    // Метод заменен встроенной логикой в findMatchesInChunks
    return
  }

  // Добавляет совпадение в список
  private addMatch(
    source: string,
    file: string,
    startOffset: number,
    endOffset: number,
    matchText: string,
    lines: string[],
    matches: ExtendedIpcMatch[]
  ): void {
    // Убедимся, что совпадение не пустое
    if (!matchText || matchText.length === 0) {
      return
    }

    let line = 0,
      column = 0,
      currentOffset = 0

    // Находим номер строки и столбца для совпадения
    for (let i = 0; i < lines.length; i++) {
      const lineLength = lines[i].length
      const lineEndOffset = currentOffset + lineLength
      const newlineLength =
        source[lineEndOffset] === '\r' && source[lineEndOffset + 1] === '\n'
          ? 2
          : source[lineEndOffset] === '\n' || source[lineEndOffset] === '\r'
          ? 1
          : 0
      const nextOffset = lineEndOffset + newlineLength

      if (startOffset >= currentOffset && startOffset <= lineEndOffset) {
        line = i
        column = startOffset - currentOffset
        break
      }

      currentOffset = nextOffset
    }

    // Для совместимости с интерфейсом ExtendedIpcMatch используем двойное приведение типа
    matches.push({
      type: 'match' as any,
      start: startOffset,
      end: endOffset,
      file,
      source: matchText,
      captures: {},
      report: undefined,
      transformed: undefined,
      loc: {
        start: { line: line + 1, column },
        end: {
          line: line + 1,
          column: column + matchText.length,
        },
      },
      path: undefined,
      node: undefined,
      paths: undefined,
      nodes: undefined,
    } as unknown as ExtendedIpcMatch)
  }

  // Добавляем метод очистки кеша для файла
  clearCacheForFile(fileUri: vscode.Uri): void {
    this.searchCache.clearCacheForFile(fileUri);
  }

  // Метод для полной очистки кеша
  clearCache(): void {
    this.searchCache.clearCache();
  }
}
