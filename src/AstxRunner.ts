import { AstxConfig, Transform } from 'astx'
import type { IpcMatch, AstxWorkerPool, IpcError } from 'astx/node'
import type * as AstxNodeTypes from 'astx/node'
import { TypedEmitter } from 'tiny-typed-emitter'
import * as vscode from 'vscode'
import { debounce, isEqual } from 'lodash'
import { convertGlobPattern, joinPatterns } from './glob/convertGlobPattern'
import { AstxExtension, Params } from './extension'
import Path from 'path'
import fs from 'fs/promises'
import { Fs } from 'astx/node/runTransformOnFile'
import { TextDecoder } from 'util'

export type TransformResultEvent = {
  file: vscode.Uri
  source: string
  transformed?: string
  reports?: unknown[]
  matches: readonly IpcMatch[]
  error?: Error
}

export type ProgressEvent = {
  completed: number
  total: number
}

interface FsEntry {
  name: string
  isDirectory(): boolean
}

export interface AstxRunnerEvents {
  result: (options: TransformResultEvent) => void
  stop: () => void
  start: () => void
  progress: (options: ProgressEvent) => void
  done: () => void
  error: (error: Error) => void
  replaceDone: () => void
}

export class AstxRunner extends TypedEmitter<AstxRunnerEvents> {
  private params: Params
  private pausedRestart = false
  private astxNode: typeof AstxNodeTypes | undefined = undefined
  private abortController: AbortController | undefined
  private pool: AstxWorkerPool = undefined as any
  private processedFiles: Set<string> = new Set()
  private transformResults: Map<
    string,
    {
      source: string
      transformed: string
    }
  > = new Map()
  private fs: Fs | undefined
  private config: AstxConfig | undefined
  private startupPromise: Promise<void> = Promise.reject(
    new Error('not started')
  )

  constructor(private extension: AstxExtension) {
    super()
    this.params = extension.getParams()
    this.startupPromise = this.startup().catch(err => {
      this.extension.logError(new Error(`AstxRunner initial startup failed: ${err}`))
      throw err
    })
  }

  async startup(): Promise<void> {
    if (this.astxNode && this.pool) {
      this.extension.channel.appendLine('Startup skipped: astxNode and pool already initialized.')
      return
    }

    const currentStartupPromise = (async () => {
      this.extension.channel.appendLine('Starting AstxRunner startup sequence...')
      this.extension.channel.appendLine('Importing astx/node...')
      this.astxNode = await this.extension.importAstxNode()
      this.extension.channel.appendLine('Creating/Recreating AstxWorkerPool...')
      const oldPool = this.pool
      if (oldPool) {
        this.extension.channel.appendLine('Ending previous worker pool...')
        oldPool.end().catch(e => this.extension.channel.appendLine(`Error ending previous pool: ${e}`))
      }
      if (!this.astxNode) {
        throw new Error("Failed to load astx/node, cannot create worker pool.")
      }
      this.pool = new this.astxNode.AstxWorkerPool()
      this.extension.channel.appendLine('AstxWorkerPool created/recreated.')
    })()

    this.startupPromise = currentStartupPromise

    try {
      await this.startupPromise
      this.extension.channel.appendLine('AstxRunner startup sequence completed successfully.')
    } catch (error) {
      this.extension.channel.appendLine(`AstxRunner startup sequence failed: ${error}`)
      this.pool = undefined as any
      this.astxNode = undefined
      throw error
    }
  }

  setParams(params: Params): void {
    if (!isEqual(this.params, params)) {
      this.extension.channel.appendLine(`Params changed: ${JSON.stringify(params)}`)
      this.params = params
      if (!this.params.paused && this.pausedRestart) {
        this.extension.channel.appendLine('Resuming paused restart.')
        this.pausedRestart = false
        this.restartSoon()
      } else {
        this.extension.channel.appendLine('Params changed, running soon.')
        this.runSoon()
      }
    }
  }

  stop(): void {
    if (this.abortController) {
      this.extension.channel.appendLine('Aborting current run...')
      this.abortController.abort()
      this.abortController = undefined
    }
    this.transformResults.clear()
    this.processedFiles.clear()
    this.emit('stop')
    this.extension.channel.appendLine('Run stopped, results cleared.')
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
        this.extension.channel.appendLine('Restarting worker pool via startup()...')
        await this.startup()
        this.extension.channel.appendLine('Worker pool restarted successfully.')
        this.run()
      } catch (error) {
        this.extension.channel.appendLine(
          `Failed to restart worker pool: ${error instanceof Error ? error.stack : String(error)}`
        )
      }
    },
    250,
    { leading: false, trailing: true }
  )

  async shutdown(): Promise<void> {
    this.extension.channel.appendLine('Shutting down AstxRunner...')
    this.stop()
    const poolToEnd = this.pool
    this.pool = undefined as any
    this.astxNode = undefined
    if (poolToEnd) {
      this.extension.channel.appendLine('Ending worker pool...')
      await poolToEnd.end().catch(e => this.extension.channel.appendLine(`Error ending pool during shutdown: ${e}`))
      this.extension.channel.appendLine('Worker pool ended.')
    }
    this.extension.channel.appendLine('AstxRunner shut down complete.')
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
      this.run()
    },
    250,
    { leading: false, trailing: true }
  )

  async handleChange(fileUri: vscode.Uri): Promise<void> {
    if (this.params.paused) {
      this.extension.channel.appendLine(`File change detected (${fileUri.fsPath}) but runner is paused.`)
      return
    }
    if (this.params.searchMode === 'text') {
      this.extension.channel.appendLine(`File change detected in text mode (${fileUri.fsPath}), re-running search.`)
      this.runSoon()
      return
    }

    const file = fileUri.fsPath
    this.extension.channel.appendLine(`File change detected in AST mode: ${file}`)

    if (!this.processedFiles.has(file)) {
      this.extension.channel.appendLine(`Changed file (${file}) was not in the previous results. Triggering full re-run.`)
      this.runSoon()
      return
    }

    try {
      await this.startupPromise
    } catch (startupError) {
      this.extension.channel.appendLine(`Cannot handle change for ${file}: Startup failed.`)
      return
    }

    const { fs, config, pool } = this
    const { find, replace, useTransformFile } = this.params
    let { transformFile } = this.params

    if (!pool || !fs || !config || this.abortController?.signal.aborted) {
      this.extension.channel.appendLine(`Skipping handleChange for ${file}: Pool/FS/Config unavailable or already aborted.`)
      return
    }

    if (transformFile) {
      transformFile = this.extension.resolveFsPath(transformFile).fsPath
    }

    const transform: Transform = { find, replace }

    this.extension.channel.appendLine(`Re-running transform on changed file: ${file}`)
    try {
      const result = await pool.runTransformOnFile({
        ...(useTransformFile ? { transformFile } : { transform }),
        file,
        source: await fs.readFile(file, 'utf8'),
        config,
      })

      if (this.abortController?.signal.aborted) {
        this.extension.channel.appendLine(`handleChange aborted for ${file} after transform.`)
        return
      }

      this.handleResult(result)
      this.extension.channel.appendLine(`Successfully processed change for ${file}.`)
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        this.extension.channel.appendLine(`handleChange aborted for ${file} during error handling.`)
        return
      }
      if (error instanceof Error) {
        const logMessage = `Error handling change for ${file}: ${error.message}`
        this.extension.logError(new Error(logMessage), error.stack)
        this.emit('error', error)
      } else {
        const unknownErrorMessage = `Unknown error during handleChange for ${file}: ${String(error)}`
        this.extension.channel.appendLine(unknownErrorMessage)
        this.emit('error', new Error(unknownErrorMessage))
      }
    }
  }

  handleResult(result: AstxNodeTypes.IpcTransformResult): void {
    const { file, source = '', transformed, matches, reports, error: ipcError } = result
    if (!file) {
      this.extension.channel.appendLine(`Received result with missing file path: ${JSON.stringify(result)}`)
      return
    }
    const fileUri = vscode.Uri.file(file)

    if (this.abortController?.signal.aborted) {
      this.extension.channel.appendLine(`handleResult skipped for ${file}: Aborted.`)
      return
    }

    this.processedFiles.add(file)

    if (transformed != null && transformed !== source) {
      this.transformResults.set(file, { source, transformed })
    } else {
      this.transformResults.delete(file)
    }

    let resultError: Error | undefined = undefined
    if (ipcError) {
      const invertedError = this.astxNode?.invertIpcError ? this.astxNode.invertIpcError(ipcError) : ipcError
      resultError = new Error(invertedError.message)
      resultError.name = invertedError.name
      resultError.stack = invertedError.stack
      if ('filename' in invertedError && invertedError.filename) {
        (resultError as any).filename = invertedError.filename
      }
      if ('loc' in invertedError && invertedError.loc) {
        (resultError as any).loc = invertedError.loc
      }
    }

    const event: TransformResultEvent = {
      file: fileUri,
      source,
      transformed,
      reports,
      matches: matches || [],
      error: resultError,
    }
    if (this.abortController?.signal.aborted) {
      this.extension.channel.appendLine(`handleResult skipped emitting for ${file}: Aborted before emit.`)
      return
    }
    this.emit('result', event)
  }

  run(): void {
    this.extension.channel.appendLine('Run method invoked.')
    this.stop()

    const abortController = new AbortController()
    this.abortController = abortController
    const { signal } = abortController
    const cancellationTokenSource = new vscode.CancellationTokenSource()
    signal.addEventListener('abort', () => {
      this.extension.channel.appendLine('Abort signal received, cancelling token source.')
      cancellationTokenSource.cancel()
    })
    const cancellationToken = cancellationTokenSource.token

    try {
      this.emit('start')
      this.extension.channel.appendLine(`Running search with params: ${JSON.stringify(this.params)}`)

      const { find, replace, useTransformFile, parser, prettier, babelGeneratorHack, preferSimpleReplacement, searchMode, matchCase, wholeWord } = this.params
      let { transformFile } = this.params
      const workspaceFolders = vscode.workspace.workspaceFolders?.map((f) => f.uri.path) || []

      if (!workspaceFolders.length) {
        this.extension.channel.appendLine('No workspace folders found.')
        this.emit('done')
        return
      }
      if (useTransformFile) {
        if (!transformFile) {
          this.extension.channel.appendLine('No transform file specified.')
          this.emit('done')
          return
        }
        transformFile = this.extension.resolveFsPath(transformFile).fsPath
      } else {
        if (!find?.trim()) {
          this.extension.channel.appendLine('Find expression is empty.')
          this.emit('done')
          return
        }
      }

      const includePattern: vscode.GlobPattern = this.params.include
        ? convertGlobPattern(this.params.include, workspaceFolders)
        : new vscode.RelativePattern(vscode.workspace.workspaceFolders![0], '**/*')

      const excludePattern: vscode.GlobPattern | null = this.params.exclude
        ? convertGlobPattern(this.params.exclude, workspaceFolders)
        : null

      const fileDocs: Map<string, vscode.TextDocument> = new Map()
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === 'file' && !doc.isClosed) fileDocs.set(doc.uri.fsPath, doc)
      }

      const FsImpl: Fs = {
        readFile: async (file: string, encoding: string): Promise<string> => {
          const doc = fileDocs.get(file)
          if (doc) return doc.getText()
          try {
            const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(file))
            return new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding).decode(raw)
          } catch (e) {
            this.extension.channel.appendLine(`Error reading file ${file}: ${e}`)
            throw e
          }
        },
        readdir: async (dir: string): Promise<FsEntry[]> => {
          try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir))
            return entries.map(([name, type]) => ({
              name,
              isDirectory: () => (type & vscode.FileType.Directory) !== 0,
              isFile: () => (type & vscode.FileType.File) !== 0,
              isSymbolicLink: () => (type & vscode.FileType.SymbolicLink) !== 0,
            }))
          } catch (e) {
            this.extension.channel.appendLine(`Error reading directory ${dir}: ${e}`)
            throw e
          }
        },
        realpath: fs.realpath,
      }

      this.fs = FsImpl

      const baseConfig: Partial<AstxConfig> = {
        prettier,
        preferSimpleReplacement,
      }

      if (searchMode === 'text') {
        this.extension.channel.appendLine('Executing Text Search...')
        const findPattern = find || ''
        const textConfig = { ...baseConfig, matchCase, wholeWord }
        this.config = baseConfig as AstxConfig

        (async () => {
          let completed = 0
          let total = 0
          try {
            await this.startupPromise
            if (!this.astxNode) throw new Error("astx/node failed to load.")

            this.processedFiles.clear()
            this.transformResults.clear()

            this.extension.channel.appendLine(`Finding files with include: ${JSON.stringify(includePattern)}, exclude: ${JSON.stringify(excludePattern)}`)
            let fileUris: vscode.Uri[]
            try {
              fileUris = await vscode.workspace.findFiles(includePattern, excludePattern, undefined, cancellationToken)
              total = fileUris.length
              this.emit('progress', { completed, total })
              this.extension.channel.appendLine(`Found ${total} files for text search.`)
              if (total === 0) {
                this.extension.channel.appendLine(`> Include: ${JSON.stringify(includePattern)}`)
                this.extension.channel.appendLine(`> Exclude: ${JSON.stringify(excludePattern)}`)
              }
            } catch (findFilesError) {
              if (cancellationToken.isCancellationRequested) {
                this.extension.channel.appendLine('Text search cancelled during findFiles.')
              } else {
                this.extension.channel.appendLine(`Error using vscode.workspace.findFiles: ${findFilesError}.`)
                this.emit('error', findFilesError instanceof Error ? findFilesError : new Error(String(findFilesError)))
              }
              this.emit('done')
              return
            }

            const files = fileUris.map(uri => uri.fsPath)
            this.extension.channel.appendLine(`Processing ${total} files...`)

            for (const file of files) {
              if (cancellationToken.isCancellationRequested) break
              let source = ''
              let fileError: Error | undefined = undefined
              const matches: AstxNodeTypes.IpcMatch[] = []

              try {
                source = await FsImpl.readFile(file, 'utf8')
                if (cancellationToken.isCancellationRequested) continue

                const lines = source.split(/\r\n?|\n/)
                const regexFlags = textConfig.matchCase ? 'g' : 'gi'
                const escapedPattern = findPattern.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
                const searchPattern = textConfig.wholeWord ? `\\b${escapedPattern}\\b` : escapedPattern
                const regex = new RegExp(searchPattern, regexFlags)
                let matchResult: RegExpExecArray | null

                while ((matchResult = regex.exec(source)) !== null) {
                  if (cancellationToken.isCancellationRequested) break
                  const startOffset = matchResult.index
                  const endOffset = startOffset + matchResult[0].length

                  let line = 0, column = 0, currentOffset = 0
                  for (let i = 0; i < lines.length; i++) {
                    const lineLength = lines[i].length
                    const lineEndOffset = currentOffset + lineLength
                    const newlineLength = source[lineEndOffset] === '\r' && source[lineEndOffset + 1] === '\n' ? 2 : (source[lineEndOffset] === '\n' || source[lineEndOffset] === '\r' ? 1 : 0)
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
                      end: { line: line + 1, column: column + matchResult[0].length }
                    },
                    path: undefined,
                    node: undefined,
                    paths: undefined,
                    nodes: undefined,
                  } as unknown as AstxNodeTypes.IpcMatch)

                  if (matchResult[0].length === 0) regex.lastIndex++
                }
              } catch (err: any) {
                if (cancellationToken.isCancellationRequested) break
                this.extension.channel.appendLine(`Error processing file ${file}: ${err.message}`)
                fileError = err instanceof Error ? err : new Error(String(err))
              } finally {
                if (!cancellationToken.isCancellationRequested) {
                  let ipcError: AstxNodeTypes.IpcError | undefined = undefined
                  if (fileError) {
                    ipcError = {
                      name: "Error",
                      message: fileError.message,
                      stack: fileError.stack
                    }
                  }

                  this.handleResult({
                    file,
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
              if (cancellationToken.isCancellationRequested) break
            }

            if (!cancellationToken.isCancellationRequested) {
              this.extension.channel.appendLine('Text search finished processing files.')
              this.emit('done')
            } else {
              this.extension.channel.appendLine('Text search cancelled during file processing.')
              this.emit('done')
            }
          } catch (error) {
            if (!cancellationToken.isCancellationRequested) {
              const finalError = error instanceof Error ? error : new Error(String(error))
              this.extension.logError(finalError)
              this.emit('error', finalError)
              this.emit('done')
            } else {
              this.extension.channel.appendLine('Text search cancelled during setup/error.')
              this.emit('done')
            }
          }
        })()
      } else {
        this.extension.channel.appendLine('Executing AST Search...')
        const currentPool = this.pool
        if (!currentPool) {
          this.extension.channel.appendLine('AST Search cannot proceed: Worker pool not available.')
          this.emit('error', new Error('Worker pool not available.'))
          this.emit('done')
          return
        }

        const astConfig = { ...baseConfig }
        astConfig.parser = parser
        astConfig.parserOptions =
          parser === 'babel' || parser === 'babel/auto'
            ? { preserveFormat: babelGeneratorHack ? 'generatorHack' : undefined }
            : undefined

        this.config = astConfig as AstxConfig

        const transform: Transform = { find, replace }

        (async () => {
          try {
            await this.startupPromise
            if (!currentPool) throw new Error("Worker pool unavailable after startup await.")

            this.extension.channel.appendLine(`Starting AST search with transform/transformFile: ${useTransformFile ? transformFile : JSON.stringify(transform)}`)
            this.extension.channel.appendLine(`AST config: ${JSON.stringify(astConfig)}`)
            const astInclude = this.params.include ? convertGlobPattern(this.params.include, workspaceFolders) : joinPatterns(workspaceFolders)
            const astExclude = this.params.exclude ? convertGlobPattern(this.params.exclude, workspaceFolders) : undefined
            this.extension.channel.appendLine(`AST paths: ${JSON.stringify(astInclude)}, exclude: ${JSON.stringify(astExclude)}`)

            for await (const next of currentPool.runTransform({
              paths: [astInclude],
              exclude: astExclude,
              getResolveAgainstDir: (filename: string) => {
                return (
                  workspaceFolders.find(
                    (f) => !Path.relative(f, filename).startsWith('.')
                  ) || process.cwd()
                )
              },
              ...(useTransformFile ? { transformFile } : { transform }),
              config: astConfig,
              fs: FsImpl,
              signal,
            })) {
              if (signal.aborted) return
              if (next.type === 'progress') {
                const { completed, total } = next
                this.emit('progress', { completed, total })
                continue
              }
              if (next.result) { this.handleResult(next.result) }
              else { this.extension.channel.appendLine(`Received event without result: ${JSON.stringify(next)}`) }
            }
            if (!signal.aborted) { this.emit('done') }
            else { this.extension.channel.appendLine('AST search finished due to abort signal.') }
          } catch (error) {
            if (signal.aborted) {
              this.extension.channel.appendLine('AST search caught error during abort.')
              return
            }
            if (error instanceof Error) {
              if (error.name === 'AbortError') { this.extension.channel.appendLine('AST search aborted (AbortError).') }
              else {
                this.extension.logError(error)
                this.emit('error', error)
                this.emit('done')
              }
            } else {
              this.extension.channel.appendLine(`Unknown error during AST run: ${String(error)}`)
              const errorObj = new Error(String(error))
              this.emit('error', errorObj)
              this.emit('done')
            }
          } finally {
            this.extension.channel.appendLine('AST run async IIFE finished.')
          }
        })()
      }
    } finally {
      this.extension.channel.appendLine('Run method finally block executing, disposing cancellation token.')
      cancellationTokenSource.dispose()
    }
  }

  async replace(): Promise<void> {
    const edit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit()
    if (this.transformResults.size === 0) {
      this.extension.channel.appendLine('No transformations to apply.')
      return
    }

    this.extension.channel.appendLine(`Preparing ${this.transformResults.size} file edits...`)
    let preparedEdits = 0
    for (const [ file, { source, transformed }, ] of this.transformResults.entries()) {
      try {
        const fileUri = vscode.Uri.file(file)
        const range = new vscode.Range(new vscode.Position(0, 0), endPosition(source))
        edit.replace(fileUri, range, transformed)
        preparedEdits++
      } catch (e) {
        this.extension.channel.appendLine(`Error preparing edit for file ${file}: ${e}`)
      }
    }

    if (preparedEdits === 0) {
      this.extension.channel.appendLine(`No edits could be prepared (errors occurred?).`)
      return
    }

    try {
      this.extension.channel.appendLine(`Applying ${preparedEdits} workspace edits...`)
      const success = await vscode.workspace.applyEdit(edit)
      if (success) {
        this.extension.channel.appendLine(`Applied edits successfully.`)
        this.transformResults.clear()
        this.processedFiles.clear()
        this.emit('stop')
      } else {
        this.extension.channel.appendLine(`Failed to apply workspace edit (applyEdit returned false). Edits remain staged.`)
        this.emit('error', new Error('Workspace edit failed to apply. Edits remain staged.'))
      }
    } catch (applyError) {
      this.extension.channel.appendLine(`Error applying workspace edit: ${applyError}`)
      this.emit('error', applyError instanceof Error ? applyError : new Error(String(applyError)))
    }
  }
}

function endPosition(s: string): vscode.Position {
  let line = 0
  let column = 0
  const rx = /\r\n?|\n/g
  let lastIndex = 0
  while (rx.exec(s) !== null) {
    line++
    lastIndex = rx.lastIndex
  }
  column = s.length - lastIndex
  return new vscode.Position(line, column)
}
