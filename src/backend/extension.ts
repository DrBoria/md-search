// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import os from 'os'
import { SearchOrchestrator } from './searchController/SearchOrchestrator'
import { SearchReplaceViewProvider } from './SearchReplaceViewProvider'
import TransformResultProvider from './providers/TransformResultProvider'

import path from 'path'
import { isEqual } from 'lodash'
import { Container, SERVICE_KEYS } from './ioc/Container'
import { FileService } from './search/services/FileService'
import { TextSearchService } from './search/services/TextSearchService'
import { SearchCache } from './search/services/CacheService'
import { SearchWorkflow } from './search/workflow/SearchWorkflow'

let extension: MdSearchExtension

import { IMdSearchExtension, Params } from './types'

const paramsInConfig: (keyof Params)[] = ['prettier']

export class MdSearchExtension implements IMdSearchExtension {
  isProduction: boolean
  replacing = false

  channel: vscode.OutputChannel = vscode.window.createOutputChannel('mdSearch')
  runner: SearchOrchestrator
  transformResultProvider: TransformResultProvider
  searchReplaceViewProvider: SearchReplaceViewProvider
  fsWatcher: vscode.FileSystemWatcher | undefined

  private params: Params
  private externalWatchPattern: vscode.GlobPattern | undefined
  private externalFsWatcher: vscode.FileSystemWatcher | undefined
  // Store cut/copied matches
  private matchesBuffer: string[] = []
  // Store cut positions for accurate paste
  private cutPositions: Map<
    string,
    Array<{ start: number; end: number; originalLength: number }>
  > = new Map()
  // Store custom file order from drag and drop
  private customFileOrder: { [key: string]: number } = {}
  // Store undo state for operations
  private undoState: {
    // Store file contents and results before cut/paste operations
    savedFileContents: Map<string, string>
    savedResults: Map<string, any>
    canUndo: boolean
  } = {
      savedFileContents: new Map(),
      savedResults: new Map(),
      canUndo: false,
    }

  constructor(public context: vscode.ExtensionContext) {
    // const config = vscode.workspace.getConfiguration('astx')
    this.params = {
      find: '',
      isReplacement: false,
      matchCase: false,
      searchInResults: 0,
      searchMode: 'text',
      wholeWord: false,
      // ...Object.fromEntries(paramsInConfig.map((p) => [p, config[p]])),
    } as Params
    this.isProduction =
      context.extensionMode === vscode.ExtensionMode.Production

    // Initialize Services & DI
    const fileService = new FileService()
    const textSearchService = new TextSearchService()
    const cacheService = new SearchCache()

    Container.register(SERVICE_KEYS.FileService, fileService)
    Container.register(SERVICE_KEYS.TextSearchService, textSearchService)
    Container.register(SERVICE_KEYS.CacheService, cacheService)

    const workflow = new SearchWorkflow(
      fileService,
      textSearchService,
      cacheService
    )
    Container.register(SERVICE_KEYS.SearchWorkflow, workflow)

    // Create Orchestrator
    this.runner = new SearchOrchestrator(this, workflow, cacheService)
    Container.register(SERVICE_KEYS.SearchOrchestrator, this.runner)

    this.transformResultProvider = new TransformResultProvider(this)
    this.searchReplaceViewProvider = new SearchReplaceViewProvider(this)
  }

  logError = (error: Error): void => {
    const message = `ERROR: ${error.stack || error.message || String(error)}`
    this.channel.appendLine(message)
    const config = vscode.workspace.getConfiguration('mdSearch')
    if (config.showErrorNotifications) {
      vscode.window.showErrorMessage(message)
    }
  }

  resolveFsPath(fsPath: string): vscode.Uri {
    fsPath = fsPath.trim().replace(/^~/, os.homedir())
    if (!path.isAbsolute(fsPath)) {
      const { workspaceFolders = [] } = vscode.workspace
      let folder =
        workspaceFolders.length === 1 ? workspaceFolders[0] : undefined
      if (workspaceFolders.length > 1) {
        const topDir = fsPath.split(path.sep)[0]
        folder = workspaceFolders.find((f) => f.name === topDir)
      }
      if (folder) fsPath = path.resolve(folder.uri.fsPath, fsPath)
    }
    return vscode.Uri.parse(fsPath)
  }

  getParams(): Params {
    return { ...this.params }
  }

  setParams(params: Params): void {
    if (!isEqual(this.params, params)) {
      if (params.transformFile !== this.params.transformFile) {
        if (params.transformFile) {
          const resolved = this.resolveFsPath(params.transformFile)
          if (vscode.workspace.getWorkspaceFolder(resolved)) {
            this.setExternalWatchPattern(undefined)
          } else {
            this.setExternalWatchPattern(
              new vscode.RelativePattern(
                vscode.Uri.file(path.dirname(resolved.fsPath)),
                path.basename(resolved.fsPath)
              )
            )
          }
        } else {
          this.setExternalWatchPattern(undefined)
        }
      }
      const config = vscode.workspace.getConfiguration('mdSearch')
      for (const key of paramsInConfig) {
        if (params[key] !== this.params[key]) {
          config.update(key, params[key], vscode.ConfigurationTarget.Workspace)
        }
      }

      // Clear search cache when search parameters change (matchCase, wholeWord),
      // UNLESS we are refining a search (searchInResults > 0), in which case we need the cache history.
      const searchParamsChanged =
        params.matchCase !== this.params.matchCase ||
        params.wholeWord !== this.params.wholeWord ||
        params.searchMode !== this.params.searchMode

      if (searchParamsChanged && params.searchInResults === 0) {
        this.runner.clearCache()
      }

      this.params = params

      // No deed to set params if replacement is in progress
      if (!params.isReplacement) {
        this.runner.setParams({ ...this.params })
      }
    }
  }

  triggerSearch(): void {
    this.runner.restartSoon()
  }

  getCustomFileOrder(): { [key: string]: number } {
    return { ...this.customFileOrder }
  }

  setCustomFileOrder(customOrder: { [key: string]: number }): void {
    this.channel.appendLine(
      `[Extension] setCustomFileOrder called with ${Object.keys(customOrder).length} items`
    )
    this.customFileOrder = { ...customOrder }
    this.channel.appendLine(
      `[Extension] Custom file order updated in memory. Keys: ${Object.keys(customOrder).slice(0, 5).join(', ')}...`
    )
  }

  activate(context: vscode.ExtensionContext): void {
    // this.runner.startup().catch(this.logError)

    context.subscriptions.push(this.channel)

    context.subscriptions.push(
      vscode.commands.registerCommand('mdSearch.restartWorkerPool', () =>
        this.runner.restartSoon()
      )
    )

    context.subscriptions.push(
      vscode.commands.registerCommand('mdSearch.showOutput', () => {
        this.channel.show()
      })
    )

    // Команда поиска теперь не только фокусирует вид, но и гарантирует,
    // что SearchReplaceViewProvider уже инициализирован
    context.subscriptions.push(
      vscode.commands.registerCommand('mdSearch.search', () => {
        const editor = vscode.window.activeTextEditor
        const selectedText = editor?.document.getText(editor.selection) || ''

        vscode.commands
          .executeCommand('workbench.view.extension.mdSearch-mdSearch')
          .then(() => {
            this.searchReplaceViewProvider.showWithSearchFocus(selectedText)
          })
      })
    )

    context.subscriptions.push(
      vscode.commands.registerCommand('mdSearch.replace', () => {
        const editor = vscode.window.activeTextEditor
        const selectedText = editor?.document.getText(editor.selection) || ''

        vscode.commands
          .executeCommand('workbench.view.extension.mdSearch-mdSearch')
          .then(() => {
            this.searchReplaceViewProvider.showWithReplaceFocus(selectedText)
          })
      })
    )

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(
        (e: vscode.ConfigurationChangeEvent) => {
          if (!e.affectsConfiguration('MD Search')) return
          const config = vscode.workspace.getConfiguration('mdSearch')
          if (paramsInConfig.some((p) => this.params[p] !== config[p])) {
            this.setParams({
              ...this.params,
              ...Object.fromEntries(paramsInConfig.map((p) => [p, config[p]])),
            })
          }
        }
      )
    )

    vscode.workspace.onDidChangeTextDocument(
      this.handleTextDocumentChange,
      context.subscriptions
    )

    const setIncludePaths =
      ({ useTransformFile }: { useTransformFile: boolean }) =>
        (dir: vscode.Uri, arg2: vscode.Uri[]) => {
          const dirs =
            Array.isArray(arg2) &&
              arg2.every((item) => item instanceof vscode.Uri)
              ? arg2
              : [dir || vscode.window.activeTextEditor?.document.uri].filter(
                (x): x is vscode.Uri => x instanceof vscode.Uri
              )
          if (!dirs.length) return
          const newParams: Params = {
            ...this.getParams(),
            useTransformFile,
            include: dirs.map(normalizeFsPath).join(', '),
          }

          // Сначала устанавливаем параметры
          this.setParams(newParams)

          // Затем уже показываем представление с фокусом
          this.searchReplaceViewProvider.showWithSearchFocus()
          this.searchReplaceViewProvider.postMessage({
            type: 'values',
            values: newParams,
          })
        }
    const findInPath = setIncludePaths({ useTransformFile: false })

    context.subscriptions.push(
      vscode.commands.registerCommand('mdSearch.findInFile', findInPath)
    )

    context.subscriptions.push(
      vscode.commands.registerCommand('mdSearch.findInFolder', findInPath)
    )

    // После регистрации WebView провайдера, добавляем логику инициализации фоновых задач
    // для ускорения первого поиска
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        SearchReplaceViewProvider.viewType,
        this.searchReplaceViewProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    )

    // Запускаем фоновую индексацию при активации расширения
    this.startBackgroundInitialization()

    // Global cut/copy/paste
    context.subscriptions.push(
      vscode.commands.registerCommand('mdSearch.copyMatches', async () => {
        const count = await this.copyMatches()
        this.searchReplaceViewProvider.notifyCopyMatchesComplete(count)
      })
    )

    context.subscriptions.push(
      vscode.commands.registerCommand('mdSearch.cutMatches', async () => {
        const count = await this.cutMatches()
        this.searchReplaceViewProvider.notifyCutMatchesComplete(count)
      })
    )

    context.subscriptions.push(
      vscode.commands.registerCommand('mdSearch.pasteToMatches', async () => {
        const count = await this.pasteToMatches()
        this.searchReplaceViewProvider.notifyPasteToMatchesComplete(count)
      }),

      vscode.commands.registerCommand('mdSearch.copyFileNames', async () => {
        const count = await this.copyFileNames()
        this.searchReplaceViewProvider.notifyCopyFileNamesComplete(count)
      }),

      vscode.commands.registerCommand(
        'mdSearch.undoLastOperation',
        async () => {
          const restored = await this.undoLastOperation()
          this.searchReplaceViewProvider.notifyUndoComplete(restored)
        }
      )
    )

    context.subscriptions.push({
      dispose: () => {
        this.setExternalWatchPattern(undefined)
      },
    })
  }

  async deactivate(): Promise<void> {
    if (this.context.workspaceState) {
      for (const key of this.context.workspaceState.keys()) {
        await this.context.workspaceState.update(key, undefined)
      }
    }

    // Очищаем кэш поиска при деактивации
    this.runner.clearCache()

    // eslint-disable-next-line no-console
    await this.runner.shutdown().catch((error: any) => console.error(error))
  }

  private setExternalWatchPattern(
    externalWatchPattern: vscode.GlobPattern | undefined
  ) {
    function formatWatchPattern(pattern: vscode.GlobPattern): string {
      return typeof pattern === 'string'
        ? pattern
        : path.join(pattern.baseUri.fsPath, pattern.pattern)
    }
    if (isEqual(this.externalWatchPattern, externalWatchPattern)) return
    if (this.externalWatchPattern)
      this.channel.appendLine(
        `unwatching ${formatWatchPattern(this.externalWatchPattern)}`
      )
    this.externalWatchPattern = externalWatchPattern
    this.externalFsWatcher?.dispose()
    if (!externalWatchPattern) {
      this.externalFsWatcher = undefined
      return
    }
    this.externalFsWatcher =
      vscode.workspace.createFileSystemWatcher(externalWatchPattern)
    this.externalFsWatcher.onDidChange(this.handleFsChange)
    this.externalFsWatcher.onDidCreate(this.handleFsChange)
    this.externalFsWatcher.onDidDelete(this.handleFsChange)
    this.channel.appendLine(
      `watching ${formatWatchPattern(externalWatchPattern)}`
    )
  }

  // Новый метод для выполнения фоновой инициализации
  private startBackgroundInitialization(): void {
    this.channel.appendLine('Starting background initialization...')

    // Используем setTimeout чтобы не блокировать активацию расширения
    setTimeout(() => {
      // Предварительно инициализируем SearchRunner
      this.runner.startup().catch(this.logError)
    }, 200)
  }

  // Updated replace method with optimizations for text mode and WorkspaceEdit
  async replace(): Promise<void> {
    if (this.replacing) return
    this.replacing = true
    try {
      // Get current parameters
      const params = this.getParams()

      // Check if replace was called in replacement mode (from cut or paste)
      const isReplacementOperation = params.isReplacement === true

      // Check replace string only if this is not a replacement operation
      if (!isReplacementOperation && !params.replace) {
        return
      }

      const resultsMap = this.transformResultProvider.results
      const { find, replace, matchCase, searchMode } = params
      const replaceValue = replace || '' // ensure string

      if (!find || !resultsMap) {
        this.channel.appendLine(
          'Replace cancelled: Missing find pattern or no search results.'
        )
        return
      }

      let totalReplacements = 0
      let totalFilesChanged = 0

      const workspaceEdit = new vscode.WorkspaceEdit()
      const filesToProcess = Array.from(resultsMap.entries()).filter(
        ([, result]) => result.matches && result.matches.length > 0
      )

      for (const [uriString, result] of filesToProcess) {
        if (!result.matches || result.matches.length === 0) continue

        const uri = vscode.Uri.parse(uriString)
        // If document is open, use its text model? WorkspaceEdit handles this mostly, 
        // but we need to calculate ranges based on the *current* content if we want to be safe.
        // However, our search results (matches) have start/end indices based on the content *at the time of search*.
        // If the file changed, these might be invalid.
        // Assuming the user hasn't modified file since search (or search updated).

        // To construct a TextEdit, we need vscode.Range.
        // We can convert start/end index to Position if we have the document.

        let document: vscode.TextDocument
        try {
          document = await vscode.workspace.openTextDocument(uri)
        } catch (e) {
          this.channel.appendLine(`Could not open document ${uriString}, skipping.`)
          continue
        }

        const edits: vscode.TextEdit[] = []

        // Sort matches descending to avoid interfering (though WorkspaceEdit handles random order, it's good practice)
        // Actually for WorkspaceEdit, order doesn't matter as long as ranges don't overlap.

        for (const match of result.matches) {
          if (typeof match.start !== 'number' || typeof match.end !== 'number') continue

          const startPos = document.positionAt(match.start)
          const endPos = document.positionAt(match.end)
          const range = new vscode.Range(startPos, endPos)

          const matchedText = document.getText(range)
          let replacementText = replaceValue

          // Handle regex group substitutions ($1, $2, etc.)
          if (searchMode === 'regex' && replacementText.includes('$')) {
            try {
              const pattern = find
              const flags = matchCase ? 'g' : 'gi'
              const regex = new RegExp(pattern, flags)

              const regexMatch = regex.exec(matchedText)
              if (regexMatch) {
                replacementText = replacementText.replace(
                  /\$(\d+)/g,
                  (_, groupNum) => {
                    const groupIndex = parseInt(groupNum, 10)
                    return regexMatch[groupIndex] || ''
                  }
                )
              }
            } catch (error: any) {
              // ignore
            }
          }

          edits.push(vscode.TextEdit.replace(range, replacementText))
          totalReplacements++
        }

        if (edits.length > 0) {
          workspaceEdit.set(uri, edits)
          totalFilesChanged++
        }
      }

      if (totalFilesChanged > 0) {
        const success = await vscode.workspace.applyEdit(workspaceEdit)
        if (!success) {
          this.logError(new Error('Failed to apply workspace edit'))
        } else {
          // Save all modified documents
          // Optional: user might want to review? simpler to save for "Replace All" behavior
          // But standard VS Code replace all doesn't always autosave.
          // For "Cut", we definitely want to save or at least keep dirty.
          // If we keep dirty, `scanFile` needs to read from dirtied document.
          // `SearchRunner.ts` `scanFile` uses `document.getText()` which gets dirty content.
          // So we are good!

          // However, if we want to mimic "Replace All" which usually saves files in many extensions:
          // Let's explicitly save if it's a "Replace All" action, 
          // but for "Cut" maybe just leave it dirty?
          // The user said "blinks ... then shows data from cache".
          // If we leave it dirty, `scanFile` sees new content.
          // If we previously wrote to disk, checking "dirty" vs "disk" might have raced.

          // Let's Try to Save to be consistent with previous fs.writeFile behavior.
          // But purely using WorkspaceEdit is enough to update the view.
          // We can iterate and save.

          // Actually, saving might trigger the watcher again.
          // We should probably save.
          await vscode.workspace.saveAll()
        }
      }

      this.searchReplaceViewProvider.notifyReplacementComplete(
        totalReplacements,
        totalFilesChanged
      )

      if (!isReplacementOperation) {
        this.transformResultProvider.clear()
      }

      this.channel.appendLine(
        `${params.searchMode} replace finished. Replaced ${totalReplacements} occurrences in ${totalFilesChanged} files.`
      )
    } catch (error: any) {
      this.logError(error)
    } finally {
      setTimeout(() => {
        this.replacing = false
      }, 250)
    }
  }

  handleFsChange = (uri: vscode.Uri): void => {
    const { transformFile } = this.getParams()

    // Check if we are in replace mode
    if (this.replacing) {
      this.runner.updateDocumentsForChangedFile(uri)
      return
    }

    // If this is a transformation file change
    if (
      transformFile &&
      uri.toString() === this.resolveFsPath(transformFile).toString()
    ) {
      this.runner.restartSoon()
      return
    }

    // Clear cache for changed file
    this.runner.clearCacheForFile(uri)
    this.channel.appendLine(
      `[Cache] Cache cleared for modified file: ${uri.fsPath}`
    )

    // Normal processing, regardless of search view visibility
    // This ensures data stays current even if UI is closed
    // Since handleChange was removed in SearchRunner, just run runSoon
    this.runner.runSoon()
  }

  handleTextDocumentChange = (e: vscode.TextDocumentChangeEvent): void => {
    // Clear cache for modified document
    this.runner.clearCacheForFile(e.document.uri)

    // Update all dependent documents
    this.runner.updateDocumentsForChangedFile(e.document.uri)
  }

  // Method to save file contents before cut/paste operations
  private async saveFileContentsForUndo(): Promise<void> {
    const resultsMap = this.transformResultProvider.results
    this.undoState.savedFileContents.clear()
    this.undoState.savedResults.clear()

    // Save original file contents for all files with matches
    for (const [uriString, result] of resultsMap.entries()) {
      if (result.matches && result.matches.length > 0) {
        try {
          const uri = vscode.Uri.parse(uriString)
          const contentBytes = await vscode.workspace.fs.readFile(uri)
          const originalContent = Buffer.from(contentBytes).toString('utf8')
          this.undoState.savedFileContents.set(uriString, originalContent)
          this.undoState.savedResults.set(uriString, result)
        } catch (error: any) {
          this.logError(
            new Error(
              `Failed to save file for undo: ${uriString}: ${error.message}`
            )
          )
        }
      }
    }

    this.undoState.canUndo = true
    this.channel.appendLine(
      `Saved ${this.undoState.savedFileContents.size} files for undo`
    )
  }

  // Method to restore files from undo state
  async undoLastOperation(): Promise<boolean> {
    if (
      !this.undoState.canUndo ||
      this.undoState.savedFileContents.size === 0
    ) {
      this.channel.appendLine('No operation to undo')
      return false
    }

    try {
      let restoredCount = 0

      // Restore file contents
      for (const [
        uriString,
        originalContent,
      ] of this.undoState.savedFileContents.entries()) {
        try {
          const uri = vscode.Uri.parse(uriString)
          const contentBytes = Buffer.from(originalContent, 'utf8')
          await vscode.workspace.fs.writeFile(uri, contentBytes as any)
          restoredCount++
        } catch (error: any) {
          this.logError(
            new Error(`Failed to restore file: ${uriString}: ${error.message}`)
          )
        }
      }

      // Restore results in TransformResultProvider
      this.transformResultProvider.results.clear()
      for (const [uriString, result] of this.undoState.savedResults.entries()) {
        this.transformResultProvider.results.set(uriString, result)
      }

      // Clear undo state
      this.undoState.savedFileContents.clear()
      this.undoState.savedResults.clear()
      this.undoState.canUndo = false

      this.channel.appendLine(`Restored ${restoredCount} files from undo`)

      // Trigger search to refresh results
      this.runner.runSoon()

      return true
    } catch (error: any) {
      this.logError(error)
      return false
    }
  }

  // Method for copying all found matches to buffer
  async copyMatches(fileOrder?: string[]): Promise<number> {
    this.channel.appendLine(
      `Copying all matches to buffer... Using UI order: ${!!fileOrder}`
    )
    const resultsMap = this.transformResultProvider.results
    const params = this.getParams()
    this.matchesBuffer = []
    this.cutPositions.clear() // Clear cut positions since this is copy, not cut
    let count = 0

    // Get files with matches, respecting the order from UI if provided
    let filesWithMatches: [string, any][]
    if (fileOrder && fileOrder.length > 0) {
      // Use the order provided by UI
      filesWithMatches = fileOrder
        .map((filePath) => {
          const result = resultsMap.get(filePath)
          return [filePath, result] as [string, any]
        })
        .filter(
          ([_, result]) => result && result.matches && result.matches.length > 0
        )
    } else {
      // Fallback to original method if no order provided
      filesWithMatches = Array.from(resultsMap.entries()).filter(
        ([_, result]) => result.matches && result.matches.length > 0
      )
    }

    for (const [, result] of filesWithMatches) {
      if (result.matches && result.matches.length > 0 && result.source) {
        for (const match of result.matches) {
          const matchText = result.source.substring(match.start, match.end)
          let textToCopy = matchText

          // If we have a replace pattern and we're in regex mode, apply the replacement pattern to get the transformed text
          if (
            params.replace &&
            params.searchMode === 'regex' &&
            params.replace.includes('$')
          ) {
            try {
              const pattern = params.find
              const flags = params.matchCase ? 'g' : 'gi'
              const regex = new RegExp(pattern, flags)

              // Execute regex on matched text to get groups
              const regexMatch = regex.exec(matchText)
              if (regexMatch) {
                // Replace $1, $2, etc. with corresponding groups
                textToCopy = params.replace.replace(
                  /\$(\d+)/g,
                  (_, groupNum) => {
                    const groupIndex = parseInt(groupNum, 10)
                    return regexMatch[groupIndex] || ''
                  }
                )
              }
            } catch (error: any) {
              this.channel.appendLine(
                `Regex group substitution in copy failed: ${error.message}`
              )
              // Fall back to original matched text
            }
          }

          this.matchesBuffer.push(textToCopy)
          count++
        }
      }
    }

    // Copy ALL matches to system clipboard, separated by 2 empty lines
    if (this.matchesBuffer.length > 0) {
      const clipboardText = this.matchesBuffer.join('\n\n\n\n')
      await vscode.env.clipboard.writeText(clipboardText)
    }

    this.channel.appendLine(`Copied ${count} matches to buffer.`)
    return count
  }

  // Method for copying all found file names with # prefix
  async copyFileNames(): Promise<number> {
    this.channel.appendLine('Copying all file names to clipboard...')
    const resultsMap = this.transformResultProvider.results
    const fileNames: string[] = []

    for (const [uriString, result] of resultsMap.entries()) {
      if (result.matches && result.matches.length > 0) {
        const uri = vscode.Uri.parse(uriString)
        const fileName = path.basename(uri.fsPath)
        fileNames.push(`#${fileName}`)
      }
    }

    // Remove duplicates and sort
    const uniqueFileNames = [...new Set(fileNames)].sort()

    // Copy to system clipboard, separated by new lines
    if (uniqueFileNames.length > 0) {
      const clipboardText = uniqueFileNames.join('\n')
      await vscode.env.clipboard.writeText(clipboardText)
    }

    this.channel.appendLine(
      `Copied ${uniqueFileNames.length} file names to clipboard.`
    )
    return uniqueFileNames.length
  }

  // Method for cutting all found matches to buffer
  async cutMatches(fileOrder?: string[]): Promise<number> {
    this.channel.appendLine(
      `Cutting all matches to buffer... Using UI order: ${!!fileOrder}`
    )

    // Save file contents before cut operation for undo
    await this.saveFileContentsForUndo()

    const resultsMap = this.transformResultProvider.results
    const params = this.getParams()
    this.matchesBuffer = []
    this.cutPositions.clear() // Clear previous cut positions
    let count = 0

    // Get files with matches, respecting the order from UI if provided
    let filesWithMatches: [string, any][]
    if (fileOrder && fileOrder.length > 0) {
      // Use the order provided by UI
      filesWithMatches = fileOrder
        .map((filePath) => {
          const result = resultsMap.get(filePath)
          return [filePath, result] as [string, any]
        })
        .filter(
          ([_, result]) => result && result.matches && result.matches.length > 0
        )
    } else {
      // Fallback to original method if no order provided
      filesWithMatches = Array.from(resultsMap.entries()).filter(
        ([_, result]) => result.matches && result.matches.length > 0
      )
    }

    // First copy all matches to buffer and save their positions
    for (const [uriString, result] of filesWithMatches) {
      if (result.matches && result.matches.length > 0 && result.source) {
        const filePositions: Array<{
          start: number
          end: number
          originalLength: number
        }> = []

        for (const match of result.matches) {
          const matchText = result.source.substring(match.start, match.end)
          let textToCopy = matchText

          // If we have a replace pattern and we're in regex mode, apply the replacement pattern to get the transformed text
          if (
            params.replace &&
            params.searchMode === 'regex' &&
            params.replace.includes('$')
          ) {
            try {
              const pattern = params.find
              const flags = params.matchCase ? 'g' : 'gi'
              const regex = new RegExp(pattern, flags)

              // Execute regex on matched text to get groups
              const regexMatch = regex.exec(matchText)
              if (regexMatch) {
                // Replace $1, $2, etc. with corresponding groups
                textToCopy = params.replace.replace(
                  /\$(\d+)/g,
                  (_, groupNum) => {
                    const groupIndex = parseInt(groupNum, 10)
                    return regexMatch[groupIndex] || ''
                  }
                )
              }
            } catch (error: any) {
              this.channel.appendLine(
                `Regex group substitution in cut failed: ${error.message}`
              )
              // Fall back to original matched text
            }
          }

          // Save position info for accurate paste later
          filePositions.push({
            start: match.start,
            end: match.end,
            originalLength: matchText.length,
          })

          this.matchesBuffer.push(textToCopy)
          count++
        }

        // Store positions for this file
        this.cutPositions.set(uriString, filePositions)
      }
    }

    // Copy ALL matches to system clipboard, separated by 2 empty lines
    if (this.matchesBuffer.length > 0) {
      const clipboardText = this.matchesBuffer.join('\n\n\n\n')
      await vscode.env.clipboard.writeText(clipboardText)
    }

    // Now replace with empty string
    if (count > 0) {
      // Save current parameters
      const originalReplace = this.params.replace

      // Set empty string for replacement
      this.setParams({
        ...this.params,
        replace: '',
        isReplacement: true,
      })

      // Perform replacement
      await this.replace()

      // Restore parameters
      this.setParams({
        ...this.params,
        replace: originalReplace,
        isReplacement: false,
      })
    }

    this.channel.appendLine(`Cut ${count} matches to buffer.`)
    return count
  }

  async pasteToMatches(fileOrder?: string[]): Promise<number> {
    try {
      // Get text from system clipboard
      const clipboardText = await vscode.env.clipboard.readText()

      if (clipboardText.length === 0) {
        return 0
      }

      // Check if we have cut positions saved (for accurate paste after cut)
      if (this.cutPositions.size > 0) {
        return await this.pasteToSavedPositions(clipboardText, fileOrder)
      }

      // Fallback to current search results if no cut positions saved
      const resultsMap = this.transformResultProvider.results
      if (!resultsMap || resultsMap.size === 0) {
        this.channel.appendLine('No matching results to paste to')
        return 0
      }

      // Save file contents before paste operation for undo
      await this.saveFileContentsForUndo()

      // Split clipboard text by 2 empty lines (4 newlines total)
      const clipboardParts = clipboardText.split('\n\n\n\n')

      // Get files with matches, respecting the order from UI if provided
      let filesWithMatches: [string, any][]
      if (fileOrder && fileOrder.length > 0) {
        // Use the order provided by UI
        filesWithMatches = fileOrder
          .map((filePath) => {
            const result = resultsMap.get(filePath)
            return [filePath, result] as [string, any]
          })
          .filter(
            ([_, result]) =>
              result && result.matches && result.matches.length > 0
          )
      } else {
        // Fallback to original method if no order provided
        filesWithMatches = Array.from(resultsMap.entries()).filter(
          ([_, result]) => result.matches && result.matches.length > 0
        )
      }

      // Determine if we should distribute parts or use full text
      const shouldDistributeParts =
        clipboardParts.length === filesWithMatches.length

      this.channel.appendLine(
        `Clipboard parts: ${clipboardParts.length}, Files with matches: ${filesWithMatches.length
        }, Distribute: ${shouldDistributeParts}, Using UI order: ${!!fileOrder}`
      )

      let totalReplacements = 0
      let totalFilesChanged = 0

      // Limit concurrent processing to avoid overloading the system
      const MAX_CONCURRENT = 5

      for (let i = 0; i < filesWithMatches.length; i += MAX_CONCURRENT) {
        const batch = filesWithMatches.slice(i, i + MAX_CONCURRENT)
        await Promise.all(
          batch.map(async ([uriString, result], batchIndex) => {
            try {
              if (!result.matches || result.matches.length === 0) {
                return
              }

              const uri = vscode.Uri.parse(uriString)

              // Read file content directly
              const contentBytes = await vscode.workspace.fs.readFile(uri)
              const originalContent = Buffer.from(contentBytes).toString('utf8')

              // Determine what text to use for replacement
              const fileIndex = i + batchIndex
              const replacementText = shouldDistributeParts
                ? clipboardParts[fileIndex] || ''
                : clipboardText

              // Process matches in reverse order to avoid shifting indices
              const sortedMatches = [...result.matches].sort(
                (a, b) => b.start - a.start
              )

              let newContent = originalContent
              let replacementsInFile = 0

              // Apply replacements to each match
              for (const match of sortedMatches) {
                if (
                  typeof match.start !== 'number' ||
                  typeof match.end !== 'number'
                ) {
                  continue
                }

                // Make direct replacement
                newContent =
                  newContent.substring(0, match.start) +
                  replacementText +
                  newContent.substring(match.end)

                replacementsInFile++
              }

              // Write changes only if they actually exist
              if (newContent !== originalContent) {
                totalReplacements += replacementsInFile
                totalFilesChanged++

                // Write directly to file
                const newContentBytes = Buffer.from(newContent, 'utf8')
                await vscode.workspace.fs.writeFile(uri, newContentBytes as any)
              }
            } catch (error: any) {
              this.logError(
                new Error(`Failed to replace in ${uriString}: ${error.message}`)
              )
            }
          })
        )
      }

      // Send message to webview with replacement results
      this.searchReplaceViewProvider.notifyReplacementComplete(
        totalReplacements,
        totalFilesChanged
      )

      return totalFilesChanged
    } catch (error: any) {
      this.logError(new Error(`pasteToMatches error: ${error.message}`))
      return 0
    }
  }

  // Method to paste to exact positions where content was cut
  private async pasteToSavedPositions(
    clipboardText: string,
    fileOrder?: string[]
  ): Promise<number> {
    this.channel.appendLine('Pasting to saved cut positions...')

    // Save file contents before paste operation for undo
    await this.saveFileContentsForUndo()

    // Split clipboard text by 2 empty lines (4 newlines total)
    const clipboardParts = clipboardText.split('\n\n\n\n')

    // Get files with cut positions, respecting the order from UI if provided
    let filesWithCutPositions: [string, any][]
    if (fileOrder && fileOrder.length > 0) {
      // Use the order provided by UI
      filesWithCutPositions = fileOrder
        .map((filePath) => {
          const positions = this.cutPositions.get(filePath)
          return positions ? ([filePath, positions] as [string, any]) : null
        })
        .filter(Boolean) as [string, any][]
    } else {
      // Fallback to original method if no order provided
      filesWithCutPositions = Array.from(this.cutPositions.entries())
    }

    // Determine if we should distribute parts or use full text
    const shouldDistributeParts =
      clipboardParts.length === filesWithCutPositions.length

    this.channel.appendLine(
      `Clipboard parts: ${clipboardParts.length}, Files with cut positions: ${filesWithCutPositions.length
      }, Distribute: ${shouldDistributeParts}, Using UI order: ${!!fileOrder}`
    )

    let totalReplacements = 0
    let totalFilesChanged = 0

    // Process files with saved cut positions
    for (let i = 0; i < filesWithCutPositions.length; i++) {
      const [uriString, positions] = filesWithCutPositions[i]

      try {
        const uri = vscode.Uri.parse(uriString)
        const contentBytes = await vscode.workspace.fs.readFile(uri)
        const originalContent = Buffer.from(contentBytes).toString('utf8')

        // Determine what text to use for replacement
        const replacementText = shouldDistributeParts
          ? clipboardParts[i] || ''
          : clipboardText

        // Calculate adjusted positions (after cuts have been made, positions shift)
        let newContent = originalContent
        let totalOffset = 0

        // Process positions in forward order to calculate cumulative offset
        const sortedPositions = [...positions].sort((a, b) => a.start - b.start)

        for (const position of sortedPositions) {
          // Adjust position based on previous changes
          const adjustedStart = position.start - totalOffset

          // Insert replacement text at the adjusted position
          newContent =
            newContent.substring(0, adjustedStart) +
            replacementText +
            newContent.substring(adjustedStart)

          // Update offset: we added replacementText.length but removed position.originalLength
          totalOffset += position.originalLength - replacementText.length
          totalReplacements++
        }

        // Write changes only if content changed
        if (newContent !== originalContent) {
          totalFilesChanged++
          const newContentBytes = Buffer.from(newContent, 'utf8')
          await vscode.workspace.fs.writeFile(uri, newContentBytes as any)
          this.channel.appendLine(
            `Pasted to ${positions.length} positions in: ${uri.fsPath}`
          )
        }
      } catch (error: any) {
        this.logError(
          new Error(
            `Failed to paste to saved positions in ${uriString}: ${error.message}`
          )
        )
      }
    }

    // Clear cut positions after successful paste
    this.cutPositions.clear()

    // Send message to webview with replacement results
    this.searchReplaceViewProvider.notifyReplacementComplete(
      totalReplacements,
      totalFilesChanged
    )

    this.channel.appendLine(
      `Pasted to ${totalReplacements} saved positions in ${totalFilesChanged} files`
    )
    return totalFilesChanged
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extension = new MdSearchExtension(context)
  extension.activate(context)

  // Remove automatic activation to prevent unwanted focus
  // activateSearchView(context)
}

export async function deactivate(): Promise<void> {
  // eslint-disable-next-line no-console
  await extension?.deactivate().catch((error) => console.error(error))
}

function normalizeFsPath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri)
  return folder
    ? `${(vscode.workspace.workspaceFolders?.length ?? 0) > 1
      ? path.basename(folder.uri.path) + '/'
      : ''
    }${path.relative(folder.uri.path, uri.path)}`
    : uri.fsPath
}
