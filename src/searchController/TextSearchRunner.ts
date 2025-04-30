import * as vscode from 'vscode'
import type { IpcMatch } from 'astx/node'
import { TypedEmitter } from 'tiny-typed-emitter'
import { AstxRunnerEvents, TransformResultEvent } from './SearchRunnerTypes'
import { cpus } from 'os'
import { SearchCache } from './SearchCache'
import { Params } from '../extension'

// Количество worker threads для параллельной обработки файлов
const DEFAULT_CONCURRENT_WORKERS = Math.max(1, Math.min(cpus().length - 1, 4))
// Размер пакета файлов для обработки за один раз
const BATCH_SIZE = 50

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
      return
    }

    this.fileIndexCache = fileIndexCache
    this.isIndexSetInCurrentSearch = true
  }

  // Оптимизированная фильтрация списка файлов с использованием индекса
  private filterFilesByIndexAndPattern(
    fileUris: vscode.Uri[],
    includePattern: string
  ): { indexedFiles: vscode.Uri[]; otherFiles: vscode.Uri[] } {
    if (!this.fileIndexCache || fileUris.length === 0) {
      return { indexedFiles: [], otherFiles: fileUris }
    }

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

    return { indexedFiles, otherFiles }
  }

  async performTextSearch(
    params: Params,
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
    const { find, matchCase, wholeWord, exclude, include, searchMode } = params

    // Not applicable for regexp and astx search
    if (searchMode === 'text') {
      // Проверяем наличие подходящего кеша
      let cacheNode = this.searchCache.findSuitableCache(
        find,
        matchCase,
        wholeWord,
        exclude,
        include // Передаем include-паттерн в метод поиска кеша
      )

      if (!cacheNode) {
        // Если подходящий кеш не найден, создаем новый
        cacheNode = this.searchCache.createCacheNode(
          find,
          matchCase,
          wholeWord,
          exclude,
          include,
        )
      } else {
        // Для уточняющего запроса создаем новый узел кеша, если он еще не существует
        if (cacheNode.query !== find) {
          cacheNode = this.searchCache.createCacheNode(
            find,
            matchCase,
            wholeWord,
            exclude,
            include
          )
        }

        // Добавляем файлы из кеша в результаты
        const cachedResults = this.searchCache.getCurrentResults()
        if (cachedResults) {
          // Подсчитываем добавленные результаты для логирования
          for (const [uri, result] of cachedResults.entries()) {
            if (result.file) {
              filesWithMatches.add(result.file.toString())
              this.handleResult(result)
            }
          }
        }
      }
    }

    try {
      // Получаем списки файлов, которые уже обработаны и которые нужно пропустить
      const processedFiles = searchMode === 'text' ? this.searchCache.getProcessedFiles() : new Set();
      const excludedFiles = this.searchCache.getExcludedFiles()

      // Фильтруем файлы, которые не нужно обрабатывать повторно
      const filesToProcess = fileUris.filter((uri) => {
        const filePath = uri.toString()
        return !processedFiles.has(filePath) && !excludedFiles.has(filePath)
      })

      // Разделяем файлы на проиндексированные и остальные
      const { indexedFiles, otherFiles } = this.filterFilesByIndexAndPattern(
        filesToProcess,
        ''
      )

      // Общее количество файлов для поиска
      const total =
        indexedFiles.length + otherFiles.length + processedFiles.size
      let completed = processedFiles.size

      this.emit('progress', { completed, total })

      // Если кеш полный и завершен, нет нужды продолжать поиск
      if (
        this.searchCache.isCurrentSearchComplete() &&
        filesToProcess.length === 0
      ) {
        this.emit('done')
        return filesWithMatches
      }

      // Обрабатываем индексированные файлы первыми (они приоритетны)
      if (indexedFiles.length > 0) {
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
      }

      // Затем обрабатываем остальные файлы, если поиск не отменен
      if (!signal.aborted && otherFiles.length > 0) {
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
        this.searchCache.markCurrentAsComplete()
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
    params: Params,
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
    params: Params,
    FsImpl: any,
    signal: AbortSignal,
    onMatchFound: (file: string, result: TransformResultEvent) => void,
    onProgress: (progress: number) => void,
    logMessage: (message: string) => void
  ): Promise<void> {
    if (signal.aborted) return

    const { find, matchCase, wholeWord, searchMode } = params
    let source = ''
    let fileError: Error | undefined = undefined
    const matches: ExtendedIpcMatch[] = []
    let normalizedPath = file
    if (normalizedPath.startsWith('/file:///')) {
      normalizedPath = normalizedPath.replace('/file://', '')
    }

    try {
      source = await FsImpl.readFile(normalizedPath, 'utf8')
      if (signal.aborted) return

      // Оптимизированный поиск совпадений
      await this.findMatches(
        source,
        normalizedPath,
        find,
        searchMode,
        matchCase,
        wholeWord,
        matches,
        logMessage
      )
    } catch (err: any) {
      if (signal.aborted) return
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
          file: vscode.Uri.file(normalizedPath),
          source,
          transformed: undefined,
          matches,
          reports: [],
          error: ipcError,
        }

        // Если файл содержит совпадения, добавляем его в коллекцию
        if (matches.length > 0) {
          onMatchFound(normalizedPath, result)
          this.handleResult(result)
        }

        onProgress(1) // Сообщаем о прогрессе (1 файл)
        this.processedFiles.add(normalizedPath)
      }
    }
  }

  handleResult(result: TransformResultEvent): void {
    const { file } = result

    if (!file) {
      return
    }

    if (this.abortController?.signal.aborted) {
      return
    }

    // Получаем текущий узел кеша и его запрос
    // const currentNode = this.searchCache.getCurrentNode()

    // if (
    //   currentNode &&
    //   result.matches &&
    //   result.matches.length > 0 &&
    //   result.source
    // ) {
    //   const { query, params } = currentNode

    //   // Фильтруем совпадения, чтобы показывать только те, которые соответствуют текущему запросу
    //   const filteredMatches = result.matches.filter((match) => {
    //     const queryLength = query.length
    //     const matchTextLength = match.end - match.start
    //     const newMatchStart = Math.min(
    //       match.start - (queryLength - matchTextLength)
    //     )
    //     const newMatchEnd = Math.max(
    //       match.end + (queryLength - matchTextLength)
    //     )
    //     const matchText = result.source!.substring(newMatchStart, newMatchEnd)

    //     if (params.searchMode === 'regex') {
    //       return new RegExp(query, 'g').test(matchText)
    //     }
    //     // Применяем ту же логику фильтрации, что и в SearchCache.resultMatchesQuery
    //     if (!params.matchCase) {
    //       const lowerText = matchText.toLowerCase()
    //       const lowerQuery = query.toLowerCase()

    //       if (params.wholeWord) {
    //         const regex = new RegExp(`\\b${escapeRegExp(lowerQuery)}\\b`, 'i')
    //         return regex.test(lowerText)
    //       } else {
    //         return lowerText.includes(lowerQuery)
    //       }
    //     } else {
    //       if (params.wholeWord) {
    //         const regex = new RegExp(`\\b${escapeRegExp(query)}\\b`)
    //         return regex.test(matchText)
    //       } else {
    //         return matchText.includes(query)
    //       }
    //     }
    //   })

    //   // Если после фильтрации в файле не осталось совпадений, не добавляем его в результаты
    //   if (filteredMatches.length === 0) {
    //     return
    //   }

    //   // Обновляем результат с отфильтрованными совпадениями
    //   result.matches = filteredMatches
    // }

    this.processedFiles.add(file.fsPath)

    // Явный emit с отладочным сообщением
    this.emit('result', result)
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort()
    }
  }

  stop(): void {
    this.abort();

    this.isSearchRunning = false
    this.isIndexSetInCurrentSearch = false
    this.emit('stop')
  }

  setAbortController(controller: AbortController): void {
    this.abortController = controller
  }

  // Оптимизированный поиск совпадений в файле
  private async findMatches(
    source: string,
    file: string,
    find: string,
    searchMode: 'text' | 'regex' | 'astx',
    matchCase: boolean,
    wholeWord: boolean,
    matches: ExtendedIpcMatch[],
    logMessage: (message: string) => void
  ): Promise<void> {
    // Проверка на прерывание поиска
    if (this.abortController?.signal.aborted) {
      return
    }

    const regexFlags = matchCase ? 'g' : 'gi'
    const escapedPattern = find.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
    const searchPattern = wholeWord ? `\\b${escapedPattern}\\b` : escapedPattern

    // Обработка специального случая с $N в конце регулярного выражения
    let captureGroupIndex = 0
    let regexPattern = find

    if (searchMode === 'regex') {
      // Проверяем, заканчивается ли регулярное выражение на $N
      const captureGroupMatch = find.match(/\$(\d+)$/);
      if (captureGroupMatch) {
        // Извлекаем индекс группы захвата и обрезаем регулярное выражение
        captureGroupIndex = parseInt(captureGroupMatch[1], 10);
        regexPattern = find.slice(0, -captureGroupMatch[0].length);
      }
    }

    const regex = searchMode === "regex" ? new RegExp(regexPattern, 'gi') : new RegExp(searchPattern, regexFlags)

    // Используем разные подходы в зависимости от размера файла
    if (source.length > 1024 * 1024) {
      // 1 MB
      // Для больших файлов используем поиск по чанкам без разбиения всего файла на строки
      await this.findMatchesInChunks(source, file, regex, matches, captureGroupIndex, logMessage)
    } else {
      // Для небольших файлов можно использовать обычный подход
      const lines = source.split(/\r\n?|\n/)
      await this.findMatchesInSource(source, file, regex, lines, matches, captureGroupIndex, logMessage)
    }
  }

  // Поиск совпадений для больших файлов с разбивкой на части
  private async findMatchesInChunks(
    source: string,
    file: string,
    regex: RegExp,
    matches: ExtendedIpcMatch[],
    captureGroupIndex = 0,
    logMessage: (message: string) => void
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
        if (matchResult[captureGroupIndex].length === 0) {
          regex.lastIndex++
          continue
        }

        logMessage(`FILE: ${file}, \nMATCHES: ${formatMatchResult(matchResult)}`);
        const chunkOffset = startPos
        // Находим позицию группы захвата внутри общего совпадения
        const fullMatch = matchResult[0]
        const groupMatch = matchResult[captureGroupIndex]
        const groupOffset = fullMatch.indexOf(groupMatch)

        const matchStartOffset = chunkOffset + matchResult.index + (captureGroupIndex > 0 ? groupOffset : 0)
        const matchEndOffset = matchStartOffset + matchResult[captureGroupIndex].length
        const matchText = matchResult[captureGroupIndex]

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
    matches: ExtendedIpcMatch[],
    captureGroupIndex = 0,
    logMessage: (message: string) => void
  ): Promise<void> {
    // Проверка флага abort через abortController
    if (this.abortController?.signal.aborted) return

    let matchResult: RegExpExecArray | null
    let matchesFound = 0

    // Создаем копию регулярки для безопасности
    const workingRegex = new RegExp(regex.source, regex.flags);
    workingRegex.lastIndex = 0;

    while ((matchResult = workingRegex.exec(source)) !== null) {
      // Проверка прерывания поиска внутри цикла
      if (this.abortController?.signal.aborted) return

      // Периодически освобождаем event loop
      if (++matchesFound % 100 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      const matchTextResult = matchResult[captureGroupIndex];

      logMessage(`FILE: ${file}, \nMATCHES: ${formatMatchResult(matchResult)}`);
      // Пропускаем пустые совпадения
      if (matchTextResult.length === 0) {
        workingRegex.lastIndex++
        continue
      }
      // Находим позицию группы захвата внутри общего совпадения
      const fullMatch = matchResult[0]
      const groupMatch = matchResult[captureGroupIndex]
      const groupOffset = fullMatch.indexOf(groupMatch)

      const startOffset = matchResult.index + (captureGroupIndex > 0 ? groupOffset : 0)
      const endOffset = startOffset + matchResult[captureGroupIndex].length

      this.addMatch(
        source,
        file,
        startOffset,
        endOffset,
        matchTextResult,
        lines,
        matches
      )

      // ВАЖНО: После нахождения совпадения продвигаем lastIndex вперед
      // чтобы продолжить поиск с конца текущего совпадения
      if (workingRegex.lastIndex <= endOffset) {
        workingRegex.lastIndex = endOffset + 1;
      }
    }
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

    let startLine = 0,
      startColumn = 0,
      endLine = 0,
      endColumn = 0,
      currentOffset = 0

    // Находим номер строки и столбца для начала совпадения
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
        startLine = i
        startColumn = startOffset - currentOffset
        break
      }

      currentOffset = nextOffset
    }

    // Сбрасываем текущий отступ и начинаем поиск для конечной позиции
    currentOffset = 0

    // Находим номер строки и столбца для конца совпадения
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

      if (endOffset > currentOffset && endOffset <= lineEndOffset) {
        endLine = i
        endColumn = endOffset - currentOffset
        break
      } else if (endOffset === nextOffset) {
        // Особый случай: конец совпадения точно на символе новой строки
        endLine = i
        endColumn = lineLength
        break
      } else if (endOffset > lineEndOffset && endOffset < nextOffset) {
        // Особый случай: конец совпадения между символами новой строки \r\n
        endLine = i
        endColumn = lineLength
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
        start: { line: startLine + 1, column: startColumn },
        end: { line: endLine + 1, column: endColumn },
      },
      path: undefined,
      node: undefined,
      paths: undefined,
      nodes: undefined,
    } as unknown as ExtendedIpcMatch)
  }

  // Добавляем метод очистки кеша для файла
  clearCacheForFile(fileUri: vscode.Uri): void {
    this.searchCache.clearCacheForFile(fileUri)
  }

  // Метод для полной очистки кеша
  clearCache(): void {
    this.searchCache.clearCache()
  }

  // Новый метод для выполнения текстового поиска без использования кеша
  async performTextSearchWithoutCache(
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

    try {
      // Разделяем файлы на проиндексированные и остальные (без кеша)
      const { indexedFiles, otherFiles } = this.filterFilesByIndexAndPattern(
        fileUris,
        ''
      )

      // Общее количество файлов для поиска
      const total = indexedFiles.length + otherFiles.length
      let completed = 0

      this.emit('progress', { completed, total })

      // Обрабатываем индексированные файлы первыми (они приоритетны)
      if (indexedFiles.length > 0) {
        logMessage(
          `Обработка ${indexedFiles.length} проиндексированных файлов без кеша...`
        )

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
            // НЕ добавляем результат в кеш для вложенного поиска
          },
          (progress) => {
            completed += progress
            this.emit('progress', { completed, total })
          },
          logMessage
        )
      }

      // Затем обрабатываем остальные файлы, если поиск не отменен
      if (!signal.aborted && otherFiles.length > 0) {
        logMessage(
          `Обработка ${otherFiles.length} непроиндексированных файлов без кеша...`
        )

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
            // НЕ добавляем результат в кеш для вложенного поиска
          },
          (progress) => {
            completed += progress
            this.emit('progress', { completed, total })
          },
          logMessage
        )
      }

      return filesWithMatches
    } catch (error) {
      logMessage(`Error during text search without cache: ${error}`)
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
        `Text search without cache completed in ${duration}ms with ${filesWithMatches.size} matches`
      )

      // Явно посылаем событие о завершении поиска для обновления UI
      if (!signal.aborted) {
        this.emit('done')
      }
    }
  }
}

// Функция для экранирования спецсимволов в регулярных выражениях
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Добавляем функцию форматирования результатов поиска
function formatMatchResult(matchResult: RegExpExecArray): string {
  if (!matchResult) return 'no matches';

  let result = `$0: ${matchResult[0]}`;

  // Добавляем группы захвата, если они есть
  for (let i = 1; i < matchResult.length; i++) {
    result += `\n$${i}: ${matchResult[i]}`;
  }

  return result;
}
