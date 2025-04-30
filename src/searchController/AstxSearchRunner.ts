import * as vscode from 'vscode'
import type { IpcMatch, AstxWorkerPool, IpcError } from 'astx/node'
import type * as AstxNodeTypes from 'astx/node'
import { AstxConfig, Transform } from 'astx'
import { TypedEmitter } from 'tiny-typed-emitter'
import Path from 'path'
import { AstxRunnerEvents, TransformResultEvent } from './SearchRunnerTypes'

export class AstxSearchRunner extends TypedEmitter<AstxRunnerEvents> {
  private processedFiles: Set<string> = new Set()
  private abortController: AbortController | undefined
  private astxNode: typeof AstxNodeTypes | undefined = undefined
  public pool: AstxWorkerPool = undefined as any
  private config: AstxConfig | undefined

  constructor(private extension: any) {
    super()
  }

  async setupWorkerPool(): Promise<void> {
    this.astxNode = await this.extension.importAstxNode()
    const oldPool = this.pool
    if (oldPool) {
      oldPool
        .end()
        .catch((e: any) =>
          this.extension.channel.appendLine(`Error ending previous pool: ${e}`)
        )
    }
    if (!this.astxNode) {
      throw new Error('Failed to load astx/node, cannot create worker pool.')
    }
    this.pool = new this.astxNode.AstxWorkerPool()
  }

  async performAstSearch(
    params: any,
    astPaths: string[],
    astExclude: string | undefined,
    workspaceFolders: string[],
    FsImpl: any,
    logMessage: (message: string) => void
  ): Promise<Set<string>> {
    if (!this.pool || !this.astxNode) {
      throw new Error('AST search cannot proceed: Worker pool not available.')
    }

    const { signal } = this.abortController || new AbortController()
    const {
      find,
      replace,
      useTransformFile,
      transformFile: origTransformFile,
      parser,
      prettier,
      babelGeneratorHack,
      preferSimpleReplacement,
      searchInResults,
    } = params

    const astConfig: Partial<AstxConfig> = {
      prettier,
      preferSimpleReplacement,
      parser,
      parserOptions:
        parser === 'babel' || parser === 'babel/auto'
          ? {
              preserveFormat: babelGeneratorHack ? 'generatorHack' : undefined,
            }
          : undefined,
    }

    this.config = astConfig as AstxConfig

    const filesWithMatches = new Set<string>()
    let transformFile = origTransformFile
    if (transformFile) {
      transformFile = this.extension.resolveFsPath(transformFile).fsPath
    }

    // Create transform
    const transform: Transform = { find, replace }

    try {
      for await (const next of this.pool.runTransform({
        paths: astPaths,
        exclude: searchInResults ? undefined : astExclude,
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
        if (signal.aborted) return filesWithMatches
        if (next.type === 'progress') {
          const { completed, total } = next
          this.emit('progress', { completed, total })
          continue
        }
        if (next.result) {
          this.handleResult(next.result)
          if (
            next.result.file &&
            next.result.matches &&
            next.result.matches.length > 0
          ) {
            filesWithMatches.add(next.result.file)
          }
        } else {
          logMessage(`Received event without result type: ${next.type}`)
        }
      }

      return filesWithMatches
    } catch (error) {
      if (signal.aborted) {
        logMessage('AST search aborted.')
        return filesWithMatches
      }
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logMessage('AST search aborted (AbortError).')
        } else {
          this.extension.logError(error)
          this.emit('error', error)
        }
      } else {
        logMessage(`Unknown error during AST run: ${String(error)}`)
        const errorObj = new Error(String(error))
        this.emit('error', errorObj)
      }
      return filesWithMatches
    }
  }

  handleResult(result: AstxNodeTypes.IpcTransformResult): void {
    const {
      file,
      source = '',
      transformed,
      matches,
      reports,
      error: ipcError,
    } = result

    if (!file) {
      this.extension.channel.appendLine(
        `Received result with missing file path.`
      )
      return
    }
    const fileUri = vscode.Uri.file(file)

    if (this.abortController?.signal.aborted) {
      this.extension.channel.appendLine(
        `handleResult skipped for ${Path.basename(file)}: Aborted.`
      )
      return
    }

    this.processedFiles.add(file)

    let resultError: Error | undefined = undefined
    if (ipcError) {
      const invertedError = this.astxNode?.invertIpcError
        ? this.astxNode.invertIpcError(ipcError)
        : ipcError
      resultError = new Error(invertedError.message)
      resultError.name = invertedError.name
      resultError.stack = invertedError.stack
      if ('filename' in invertedError && invertedError.filename) {
        ;(resultError as any).filename = invertedError.filename
      }
      if ('loc' in invertedError && invertedError.loc) {
        ;(resultError as any).loc = invertedError.loc
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
      this.extension.channel.appendLine(
        `handleResult skipped emitting for ${Path.basename(
          file
        )}: Aborted before emit.`
      )
      return
    }

    this.emit('result', event)
  }

  stop(): void {
    if (this.abortController) {
      this.extension.channel.appendLine('Aborting current AST search...')
      this.abortController.abort()
      this.abortController = undefined
    }
    this.processedFiles.clear()
    this.emit('stop')
    this.extension.channel.appendLine('AST search stopped, results cleared.')
  }

  async shutdown(): Promise<void> {
    this.extension.channel.appendLine('Shutting down AstxSearchRunner...')
    this.stop()
    const poolToEnd = this.pool
    this.pool = undefined as any
    this.astxNode = undefined
    if (poolToEnd) {
      this.extension.channel.appendLine('Ending worker pool...')
      await poolToEnd
        .end()
        .catch((e: any) =>
          this.extension.channel.appendLine(
            `Error ending pool during shutdown: ${e}`
          )
        )
      this.extension.channel.appendLine('Worker pool ended.')
    }
    this.extension.channel.appendLine('AstxSearchRunner shut down complete.')
  }

  setAbortController(controller: AbortController): void {
    this.abortController = controller
  }
}
