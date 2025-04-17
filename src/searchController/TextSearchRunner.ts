import * as vscode from 'vscode'
import type { IpcMatch } from 'astx/node'
import { TypedEmitter } from 'tiny-typed-emitter'
import { TextDecoder } from 'util'
import { AstxRunnerEvents, TransformResultEvent } from './SearchRunnerTypes'

export class TextSearchRunner extends TypedEmitter<AstxRunnerEvents> {
  private processedFiles: Set<string> = new Set()
  private abortController: AbortController | undefined

  constructor(private extension: any) {
    super()
  }

  async performTextSearch(
    params: any,
    fileUris: vscode.Uri[],
    FsImpl: any,
    logMessage: (message: string) => void
  ): Promise<Set<string>> {
    const { signal } = this.abortController || new AbortController()
    const { find, matchCase, wholeWord, searchInResults } = params
    const filesWithMatches = new Set<string>()
    const total = fileUris.length
    let completed = 0

    this.emit('progress', { completed, total })
    logMessage(`Found ${total} files for text search.`)
    if (total === 0) {
      logMessage('No files found for searching.')
      return filesWithMatches
    }

    const files = fileUris.map((uri) => uri.fsPath)
    logMessage(`Processing ${total} files...`)

    for (const file of files) {
      if (signal.aborted) break
      let source = ''
      let fileError: Error | undefined = undefined
      const matches: IpcMatch[] = []

      try {
        source = await FsImpl.readFile(file, 'utf8')
        if (signal.aborted) continue

        logMessage(`[DEBUG] Searching in file: ${file}`)
        logMessage(`[DEBUG] Search pattern: "${find}"`)

        const lines = source.split(/\r\n?|\n/)
        const regexFlags = matchCase ? 'g' : 'gi'
        const escapedPattern = find.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
        const searchPattern = wholeWord
          ? `\\b${escapedPattern}\\b`
          : escapedPattern
        const regex = new RegExp(searchPattern, regexFlags)
        logMessage(`[DEBUG] Final regex pattern: ${regex}`)
        let matchResult: RegExpExecArray | null

        while ((matchResult = regex.exec(source)) !== null) {
          if (signal.aborted) break
          const startOffset = matchResult.index
          const endOffset = startOffset + matchResult[0].length

          let line = 0,
            column = 0,
            currentOffset = 0
          for (let i = 0; i < lines.length; i++) {
            const lineLength = lines[i].length
            const lineEndOffset = currentOffset + lineLength
            const newlineLength =
              source[lineEndOffset] === '\r' &&
              source[lineEndOffset + 1] === '\n'
                ? 2
                : source[lineEndOffset] === '\n' ||
                  source[lineEndOffset] === '\r'
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

          matches.push({
            type: 'match' as any,
            start: startOffset,
            end: endOffset,
            file,
            source: matchResult[0],
            captures: {},
            report: undefined,
            transformed: undefined,
            loc: {
              start: { line: line + 1, column },
              end: {
                line: line + 1,
                column: column + matchResult[0].length,
              },
            },
            path: undefined,
            node: undefined,
            paths: undefined,
            nodes: undefined,
          } as unknown as IpcMatch)

          if (matchResult[0].length === 0) regex.lastIndex++
        }
      } catch (err: any) {
        if (signal.aborted) break
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

          // If file has matches, add it to the collection
          if (matches.length > 0) {
            filesWithMatches.add(file)
            logMessage(
              `[Debug] File with matches: ${file} (${matches.length} matches)`
            )
          }

          this.handleResult({
            file: vscode.Uri.file(file),
            source,
            transformed: undefined,
            matches,
            reports: [],
            error: ipcError,
          })

          completed++
          this.emit('progress', { completed, total })
        }
      }
      if (signal.aborted) break
    }

    return filesWithMatches
  }

  handleResult(result: TransformResultEvent): void {
    const { file, source = '', transformed, matches, reports, error } = result

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
    this.processedFiles.clear()
    this.emit('stop')
    this.extension.channel.appendLine('Text search stopped, results cleared.')
  }

  setAbortController(controller: AbortController): void {
    this.abortController = controller
  }
}
