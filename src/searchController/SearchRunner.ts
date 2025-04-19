import { AstxConfig, Transform } from 'astx'
import type { IpcMatch, AstxWorkerPool, IpcError } from 'astx/node'
import type * as AstxNodeTypes from 'astx/node'
import { TypedEmitter } from 'tiny-typed-emitter'
import * as vscode from 'vscode'
import { debounce, isEqual } from 'lodash'
import { convertGlobPattern, joinPatterns } from '../glob/convertGlobPattern'
import { AstxExtension, Params } from '../extension'
import Path from 'path'
import fs from 'fs/promises'
import { Fs } from 'astx/node/runTransformOnFile'
import { TextDecoder } from 'util'
import { TextSearchRunner } from './TextSearchRunner'
import { AstxSearchRunner } from './AstxSearchRunner'
import { AstxRunnerEvents, TransformResultEvent } from './SearchRunnerTypes'

export type { TransformResultEvent } from './SearchRunnerTypes'

export type ProgressEvent = {
  completed: number
  total: number
}

interface FsEntry {
  name: string
  isDirectory(): boolean
}

export class AstxRunner extends TypedEmitter<AstxRunnerEvents> {
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
    new Error('not started')
  )
  private textSearchRunner: TextSearchRunner
  private astxSearchRunner: AstxSearchRunner

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
        new Error(`AstxRunner initial startup failed: ${err}`)
      )
      throw err
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
    this.extension.channel.appendLine('Starting AstxRunner startup sequence...')

    try {
      await this.astxSearchRunner.setupWorkerPool()
      this.extension.channel.appendLine(
        'AstxRunner startup sequence completed successfully.'
      )
    } catch (error) {
      this.extension.channel.appendLine(
        `AstxRunner startup sequence failed: ${error}`
      )
      throw error
    }
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
    this.transformResults.clear()
    this.processedFiles.clear()
    this.previousSearchFiles.clear()
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
    250,
    { leading: false, trailing: true }
  )

  async shutdown(): Promise<void> {
    this.extension.channel.appendLine('Shutting down AstxRunner...')
    this.stop()
    await this.astxSearchRunner.shutdown()
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

  // Handles document updates for changed or deleted files
  updateDocumentsForChangedFile(fileUri: vscode.Uri): void {
    // Remove the file from fileDocs cache
    if (this.fileDocs.has(fileUri.fsPath)) {
      this.fileDocs.delete(fileUri.fsPath)
    }
    
    // Mark file as changed to ensure it's reprocessed in next search
    this.processedFiles.delete(fileUri.fsPath)
    
    // Update params from extension to ensure latest settings
    this.params = this.extension.getParams()
    
    // Если файл в результатах поиска - обновить его содержимое в UI
    this.refreshFileSourceInSearchResults(fileUri)
  }
  
  // Обновляет исходный код файла в результатах поиска
  private async refreshFileSourceInSearchResults(fileUri: vscode.Uri): Promise<void> {
    // Проверяем, есть ли файл в результатах поиска
    if (this.previousSearchFiles.has(fileUri.fsPath)) {
      try {
        // Читаем актуальное содержимое файла
        const source = await vscode.workspace.fs.readFile(fileUri);
        const newContent = new TextDecoder('utf-8').decode(source);
        
        // Отправляем сообщение в SearchReplaceViewProvider об обновлении файла
        this.extension.channel.appendLine(
          `[Debug] Sending updated source for ${Path.basename(fileUri.fsPath)} to SearchReplaceView`
        );
        
        // Отправляем событие обновления файла в SearchReplaceViewProvider
        this.extension.searchReplaceViewProvider.postMessage({
          type: 'fileUpdated',
          filePath: fileUri.toString(),
          newSource: newContent
        });
      } catch (error) {
        this.extension.channel.appendLine(
          `[Debug] Error updating source for ${fileUri.fsPath}: ${error}`
        );
      }
    }
  }

  async handleChange(fileUri: vscode.Uri): Promise<void> {
    // Log entry into handleChange
    this.extension.channel.appendLine(
      `[Debug] handleChange called for ${Path.basename(
        fileUri.fsPath
      )}. Current previousSearchFiles.size: ${this.previousSearchFiles.size}`
    )

    if (this.params.paused) {
      this.extension.channel.appendLine(
        `File change detected (${Path.basename(
          fileUri.fsPath
        )}) but runner is paused.`
      )
      return
    }
    if (this.params.searchMode === 'text') {
      this.extension.channel.appendLine(
        `File change detected in text mode (${Path.basename(
          fileUri.fsPath
        )}), re-running search.`
      )
      this.runSoon()
      return
    }

    const file = fileUri.fsPath
    this.extension.channel.appendLine(
      `File change detected in AST mode: ${Path.basename(file)}`
    )

    if (!this.processedFiles.has(file)) {
      this.extension.channel.appendLine(
        `Changed file (${Path.basename(
          file
        )}) was not in the previous results. Triggering full re-run.`
      )
      this.runSoon()
      return
    }

    try {
      await this.startupPromise
    } catch (startupError) {
      this.extension.channel.appendLine(
        `Cannot handle change for ${Path.basename(file)}: Startup failed.`
      )
      return
    }

    const { fs, config } = this
    const { find, replace, useTransformFile } = this.params
    let { transformFile } = this.params

    if (!fs || !config || this.abortController?.signal.aborted) {
      this.extension.channel.appendLine(
        `Skipping handleChange for ${Path.basename(
          file
        )}: Pool/FS/Config unavailable or already aborted.`
      )
      return
    }

    if (transformFile) {
      transformFile = this.extension.resolveFsPath(transformFile).fsPath
    }

    const transform: Transform = { find, replace }

    this.extension.channel.appendLine(
      `Re-running transform on changed file: ${Path.basename(file)}`
    )

    try {
      await this.runSingleFileAstSearch(
        file,
        transform,
        transformFile,
        useTransformFile ?? false
      )
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        this.extension.channel.appendLine(
          `handleChange aborted for ${Path.basename(
            file
          )} during error handling.`
        )
        return
      }
      if (error instanceof Error) {
        const logMessage = `Error handling change for ${Path.basename(file)}: ${
          error.message
        }`
        this.extension.logError(new Error(logMessage))
        this.emit('error', error)
      } else {
        const unknownErrorMessage = `Unknown error during handleChange for ${Path.basename(
          file
        )}: ${String(error)}`
        this.extension.channel.appendLine(unknownErrorMessage)
        this.emit('error', new Error(unknownErrorMessage))
      }
    }
  }

  private async runSingleFileAstSearch(
    file: string,
    transform: Transform,
    transformFile: string | undefined,
    useTransformFile: boolean
  ): Promise<void> {
    // Make sure AST worker pool is set up
    await this.startupPromise

    if (!this.fs || !this.config || this.abortController?.signal.aborted) {
      return
    }

    const result = await this.astxSearchRunner.pool.runTransformOnFile({
      ...(useTransformFile ? { transformFile } : { transform }),
      file,
      source: await this.fs.readFile(file, 'utf8'),
      config: this.config,
    })

    if (this.abortController?.signal.aborted) {
      return
    }

    this.astxSearchRunner.handleResult(result)
    this.handleTransformResult(result)
    this.extension.channel.appendLine(
      `Successfully processed change for ${Path.basename(file)}.`
    )
  }

  private handleTransformResult(result: any): void {
    const { file, source = '', transformed } = result

    if (file && transformed != null && transformed !== source) {
      this.transformResults.set(file, { source, transformed })
    } else if (file) {
      this.transformResults.delete(file)
    }
  }

  run(): void {
    this.extension.channel.appendLine('Run method invoked.')

    // Stop current run
    if (this.abortController) {
      this.extension.channel.appendLine('Aborting current run...')
      this.abortController.abort()
      this.abortController = undefined
    }
    this.transformResults.clear()
    this.processedFiles.clear()
    // IMPORTANT: Don't clear previousSearchFiles here!
    this.emit('stop')
    this.extension.channel.appendLine(
      'Run stopped, results cleared (preserved previous search files).'
    )

    // Add detailed log about previousSearchFiles
    this.extension.channel.appendLine(
      `[Debug] BEFORE run logic: previousSearchFiles.size = ${this.previousSearchFiles.size}`
    )
    if (this.previousSearchFiles.size > 0) {
      this.extension.channel.appendLine(
        `[Debug] First few files in previousSearchFiles: ${Array.from(
          this.previousSearchFiles
        )
          .slice(0, 3)
          .map((f) => Path.basename(f))
          .join(', ')}...`
      )
    }


    // Skip search if find pattern is empty
    if (!this.params.find || this.params.find.trim() === '') {
      this.extension.channel.appendLine(
        'Find pattern is empty, skipping search.'
      )
      this.emit('done')
      return
    }

    // Create abort controller and set it in both runners
    const abortController = new AbortController()
    this.abortController = abortController
    this.textSearchRunner.setAbortController(abortController)
    this.astxSearchRunner.setAbortController(abortController)

    const { signal } = abortController
    const cancellationTokenSource = new vscode.CancellationTokenSource()
    signal.addEventListener('abort', () => {
      this.extension.channel.appendLine(
        'Abort signal received, cancelling token source.'
      )
      cancellationTokenSource.cancel()
    })
    const cancellationToken = cancellationTokenSource.token

    try {
      this.emit('start')
      this.extension.channel.appendLine(
        `Running search with searchMode=${this.params.searchMode}, searchInResults=${this.params.searchInResults}, matchCase=${this.params.matchCase}, wholeWord=${this.params.wholeWord}`
      )

      const { searchMode, searchInResults } = this.params
      const workspaceFolders =
        vscode.workspace.workspaceFolders?.map((f) => f.uri.path) || []

      if (!workspaceFolders.length) {
        this.extension.channel.appendLine('No workspace folders found.')
        this.emit('done')
        return
      }

      // Add logging right before the check
      this.extension.channel.appendLine(
        `[Debug] Checking searchInResults: ${searchInResults}, previousSearchFiles size: ${this.previousSearchFiles.size}`
      )
      if (searchInResults && this.previousSearchFiles.size === 0) {
        // Add logging inside the block
        this.extension.channel.appendLine(
          '[Debug] Entered searchInResults && previousSearchFiles.size === 0 block.'
        )
        this.extension.channel.appendLine(
          'No previous search results to search in.'
        )
        this.emit('done')
        return
      }

      const includePattern: vscode.GlobPattern = this.params.include
        ? convertGlobPattern(this.params.include, workspaceFolders)
        : new vscode.RelativePattern(
            vscode.workspace.workspaceFolders![0],
            '**/*'
          )

      this.extension.channel.appendLine(
        `[Debug] Converted include pattern: ${includePattern.toString()}`
      )
      
      const excludePattern: vscode.GlobPattern | null = this.params.exclude
        ? convertGlobPattern(this.params.exclude, workspaceFolders)
        : null

      if (excludePattern) {
        this.extension.channel.appendLine(
          `[Debug] Converted exclude pattern: ${excludePattern.toString()}`
        )
      } else {
        this.extension.channel.appendLine(`[Debug] No exclude pattern set`)
      }

      // Update in-memory document cache
      this.fileDocs.clear()
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === 'file' && !doc.isClosed)
          this.fileDocs.set(doc.uri.fsPath, doc)
      }

      const FsImpl: any = {
        // Временно используем any, чтобы избежать ошибок типизации
        readFile: async (file: string, encoding: string): Promise<string> => {
          const doc = this.fileDocs.get(file)
          if (doc) return doc.getText()
          try {
            const raw = await vscode.workspace.fs.readFile(
              vscode.Uri.file(file)
            )
            return new TextDecoder(
              encoding === 'utf8' ? 'utf-8' : encoding
            ).decode(raw)
          } catch (e) {
            this.extension.channel.appendLine(
              `Error reading file ${file}: ${e}`
            )
            throw e
          }
        },
        // readdir имплементация для поиска файлов
        readdir: async (dir: string): Promise<FsEntry[]> => {
          try {
            const entries = await vscode.workspace.fs.readDirectory(
              vscode.Uri.file(dir)
            )
            return entries.map(([name, type]) => ({
              name,
              isDirectory: () => (type & vscode.FileType.Directory) !== 0,
              isFile: () => (type & vscode.FileType.File) !== 0,
              isSymbolicLink: () => (type & vscode.FileType.SymbolicLink) !== 0,
            }))
          } catch (e) {
            this.extension.channel.appendLine(
              `Error reading directory ${dir}: ${e}`
            )
            throw e
          }
        },
        realpath: fs.realpath,
      }

      this.fs = FsImpl as Fs

      if (searchMode === 'text') {
        this.runTextSearch(
          FsImpl,
          includePattern,
          excludePattern,
          cancellationToken
        )
      } else {
        this.runAstSearch(
          FsImpl,
          includePattern,
          excludePattern,
          workspaceFolders
        )
      }
    } finally {
      this.extension.channel.appendLine(
        'Run method finally block executing, disposing cancellation token.'
      )
      cancellationTokenSource.dispose()
    }
  }

  private async runTextSearch(
    FsImpl: Fs,
    includePattern: vscode.GlobPattern,
    excludePattern: vscode.GlobPattern | null,
    cancellationToken: vscode.CancellationToken
  ): Promise<void> {
    this.extension.channel.appendLine('Executing Text Search...')
    this.extension.channel.appendLine(`[Debug] Text search with includePattern: ${includePattern.toString()}`)
    if (excludePattern) {
      this.extension.channel.appendLine(`[Debug] Text search with excludePattern: ${excludePattern.toString()}`)
    }

    try {
      let fileUris: vscode.Uri[]

      // Get VSCode's ignore patterns from search.exclude and files.exclude settings
      const searchConfig = vscode.workspace.getConfiguration('search')
      const filesConfig = vscode.workspace.getConfiguration('files')

      const searchExcludes = searchConfig.get('exclude') as Record<
        string,
        boolean
      >
      const filesExcludes = filesConfig.get('exclude') as Record<
        string,
        boolean
      >

      // Build exclude patterns from VSCode settings
      const vsCodeExcludePatterns: string[] = []

      // Add patterns from search.exclude
      for (const [pattern, isExcluded] of Object.entries(searchExcludes)) {
        if (isExcluded) {
          vsCodeExcludePatterns.push(pattern)
        }
      }

      // Add patterns from files.exclude
      for (const [pattern, isExcluded] of Object.entries(filesExcludes)) {
        if (isExcluded) {
          vsCodeExcludePatterns.push(pattern)
        }
      }

      // Log the exclude patterns we're using
      this.extension.channel.appendLine(
        `[Debug] Using VSCode exclude patterns: ${vsCodeExcludePatterns.join(
          ', '
        )}`
      )

      // Combine with user-provided exclude patterns
      let combinedExcludePattern: vscode.GlobPattern | null = excludePattern

      if (vsCodeExcludePatterns.length > 0) {
        const vsCodeExcludePattern = `{${vsCodeExcludePatterns.join(',')}}`

        if (excludePattern) {
          // Combine user-defined exclude with VSCode exclude patterns
          combinedExcludePattern =
            typeof excludePattern === 'string'
              ? `${excludePattern},${vsCodeExcludePattern}`
              : new vscode.RelativePattern(
                  excludePattern instanceof vscode.RelativePattern
                    ? excludePattern.baseUri
                    : vscode.workspace.workspaceFolders![0].uri,
                  `${
                    excludePattern instanceof vscode.RelativePattern
                      ? excludePattern.pattern
                      : excludePattern
                  },${vsCodeExcludePattern}`
                )
        } else {
          // Just use VSCode exclude patterns
          combinedExcludePattern = vsCodeExcludePattern
        }
      }

      this.extension.channel.appendLine(
        `[Debug] Final exclude pattern: ${combinedExcludePattern}`
      )

      if (this.params.searchInResults) {
        this.extension.channel.appendLine(
          `[Debug] Search in Results active. Using previousSearchFiles with ${this.previousSearchFiles.size} files.`
        )
        fileUris = Array.from(this.previousSearchFiles).map((file) =>
          vscode.Uri.file(file)
        )

        // Make sure we have files to search in
        if (fileUris.length === 0) {
          this.extension.channel.appendLine(
            'No previous search results available to search within. Falling back to normal search.'
          )
          fileUris = await vscode.workspace.findFiles(
            includePattern,
            combinedExcludePattern,
            undefined,
            cancellationToken
          )
        }
      } else {
        this.extension.channel.appendLine(
          `[Debug] Calling vscode.workspace.findFiles with includePattern: ${includePattern.toString()}`
        )
        if (combinedExcludePattern) {
          this.extension.channel.appendLine(
            `[Debug] Combined exclude pattern: ${combinedExcludePattern.toString()}`
          )
        }
        
        fileUris = await vscode.workspace.findFiles(
          includePattern,
          combinedExcludePattern,
          undefined,
          cancellationToken
        )
      }

      if (cancellationToken.isCancellationRequested) {
        this.extension.channel.appendLine('Text search cancelled during setup.')
        this.emit('done')
        return
      }

      // Log for debugging purposes
      this.extension.channel.appendLine(
        `[Debug] Searching in ${fileUris.length} files`
      )

      // Run the actual text search
      const filesWithMatches = await this.textSearchRunner.performTextSearch(
        this.params,
        fileUris,
        FsImpl,
        (message: string) => this.extension.channel.appendLine(message)
      )

      if (!this.abortController?.signal.aborted) {
        // Update previousSearchFiles with only files that had matches
        const matchesCount = filesWithMatches.size

        if (this.params.searchInResults) {
          this.extension.channel.appendLine(
            `[Debug] Nested search completed. Found matches in ${matchesCount} files within previous results.`
          )
        } else {
          this.extension.channel.appendLine(
            `[Debug] Normal search completed. Saving ${matchesCount} files WITH MATCHES to previousSearchFiles.`
          )
        }

        // Always update the previousSearchFiles with the latest results
        this.previousSearchFiles = filesWithMatches

        this.extension.channel.appendLine(
          'Text search finished processing files.'
        )
        this.emit('done')
      }
    } catch (error: any) {
      this.extension.channel.appendLine(
        `Search error: ${error?.message || String(error)}`
      )
      this.emit('error', error)
      this.emit('done')
    }
  }

  private async runAstSearch(
    FsImpl: Fs,
    includePattern: vscode.GlobPattern,
    excludePattern: vscode.GlobPattern | null,
    workspaceFolders: string[]
  ): Promise<void> {
    this.extension.channel.appendLine('Executing AST Search...')

    try {
      await this.startupPromise

      // Get VSCode's ignore patterns from search.exclude and files.exclude settings
      const searchConfig = vscode.workspace.getConfiguration('search')
      const filesConfig = vscode.workspace.getConfiguration('files')

      const searchExcludes = searchConfig.get('exclude') as Record<
        string,
        boolean
      >
      const filesExcludes = filesConfig.get('exclude') as Record<
        string,
        boolean
      >

      // Build exclude patterns
      const vsCodeExcludePatterns: string[] = []

      // Add patterns from search.exclude
      for (const [pattern, isExcluded] of Object.entries(searchExcludes)) {
        if (isExcluded) {
          vsCodeExcludePatterns.push(pattern)
        }
      }

      // Add patterns from files.exclude
      for (const [pattern, isExcluded] of Object.entries(filesExcludes)) {
        if (isExcluded) {
          vsCodeExcludePatterns.push(pattern)
        }
      }

      // Log the exclude patterns we're using
      this.extension.channel.appendLine(
        `[Debug] Using VSCode exclude patterns for AST search: ${vsCodeExcludePatterns.join(
          ', '
        )}`
      )

      let astPaths: string[]
      if (this.params.searchInResults) {
        const previousFilesList = Array.from(this.previousSearchFiles)
        astPaths = previousFilesList
        this.extension.channel.appendLine(
          `AST search in ${previousFilesList.length} previous results`
        )
      } else {
        const astInclude = this.params.include
          ? convertGlobPattern(this.params.include, workspaceFolders)
          : joinPatterns(workspaceFolders)
        // Extract pattern string from GlobPattern
        astPaths = [
          // @ts-ignore
          typeof astInclude === 'string' ? astInclude : astInclude.toString(),
        ]
      }

      // Convert GlobPattern to string and combine with VSCode exclude patterns
      let astExclude = this.params.exclude
        ? typeof excludePattern === 'string'
          ? excludePattern
          : excludePattern
          ? excludePattern.toString()
          : undefined
        : undefined

      // Combine user-provided exclude patterns with VSCode patterns
      if (vsCodeExcludePatterns.length > 0) {
        const vsCodeExcludeString = `{${vsCodeExcludePatterns.join(',')}}`

        if (astExclude) {
          // Combine with existing exclude pattern
          astExclude = `${astExclude},${vsCodeExcludeString}`
        } else {
          // Just use VSCode excludes
          astExclude = vsCodeExcludeString
        }
      }

      this.extension.channel.appendLine(
        `[Debug] Final AST exclude pattern: ${astExclude}`
      )

      if (!this.params.searchInResults) {
        this.processedFiles.clear()
        this.transformResults.clear()
      }

      // Run the AST search
      const filesWithMatches = await this.astxSearchRunner.performAstSearch(
        this.params,
        astPaths,
        astExclude,
        workspaceFolders,
        FsImpl,
        (message: string) => this.extension.channel.appendLine(message)
      )

      if (!this.abortController?.signal.aborted) {
        // Update the filesWithMatches
        if (!this.params.searchInResults) {
          this.previousSearchFiles = filesWithMatches
        }

        this.emit('done')
      }
    } catch (error) {
      if (!this.abortController?.signal.aborted) {
        const finalError =
          error instanceof Error ? error : new Error(String(error))
        this.extension.logError(finalError)
        this.emit('error', finalError)
        this.emit('done')
      }
    }
  }

  async replace(): Promise<void> {
    const edit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit()
    if (this.transformResults.size === 0) {
      this.extension.channel.appendLine('No transformations to apply.')
      return
    }

    this.extension.channel.appendLine(
      `Preparing ${this.transformResults.size} file edits...`
    )
    let preparedEdits = 0
    for (const [
      file,
      { source, transformed },
    ] of this.transformResults.entries()) {
      try {
        const fileUri = vscode.Uri.file(file)
        const range = new vscode.Range(
          new vscode.Position(0, 0),
          endPosition(source)
        )
        edit.replace(fileUri, range, transformed)
        preparedEdits++
      } catch (e) {
        this.extension.channel.appendLine(
          `Error preparing edit for file ${file}: ${e}`
        )
      }
    }

    if (preparedEdits === 0) {
      this.extension.channel.appendLine(
        `No edits could be prepared (errors occurred?).`
      )
      return
    }

    try {
      this.extension.channel.appendLine(
        `Applying ${preparedEdits} workspace edits...`
      )
      const success = await vscode.workspace.applyEdit(edit)
      if (success) {
        this.extension.channel.appendLine(`Applied edits successfully.`)
        this.transformResults.clear()
        this.processedFiles.clear()
        this.emit('replaceDone')
      } else {
        this.extension.channel.appendLine(
          `Failed to apply workspace edit (applyEdit returned false). Edits remain staged.`
        )
        this.emit(
          'error',
          new Error('Workspace edit failed to apply. Edits remain staged.')
        )
      }
    } catch (applyError) {
      this.extension.channel.appendLine(
        `Error applying workspace edit: ${applyError}`
      )
      this.emit(
        'error',
        applyError instanceof Error ? applyError : new Error(String(applyError))
      )
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
