// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import os from 'os'
import { SearchRunner } from './searchController/SearchRunner'
import { SearchReplaceViewProvider } from './SearchReplaceView/SearchReplaceViewProvider'
import TransformResultProvider from './TransformResultProvider'
import type * as AstxNodeTypes from 'astx/node'
import fs from 'fs-extra'
import path from 'path'
import { isEqual } from 'lodash'

let extension: AstxExtension

export type AstxParser =
  | 'babel'
  | 'babel/auto'
  | 'recast/babel'
  | 'recast/babel/auto'

export type Params = {
  find?: string
  replace?: string
  useTransformFile?: boolean
  transformFile?: string
  paused?: boolean
  include?: string
  exclude?: string
  parser?: AstxParser
  prettier?: boolean
  babelGeneratorHack?: boolean
  preferSimpleReplacement?: boolean
  searchMode: 'text' | 'regex' | 'astx'
  matchCase: boolean
  wholeWord: boolean
  searchInResults?: number
  isReplacement?: boolean
}

const paramsInConfig: (keyof Params)[] = [
  'parser',
  'prettier',
  'babelGeneratorHack',
  'preferSimpleReplacement',
]

export class AstxExtension {
  isProduction: boolean
  replacing = false

  channel: vscode.OutputChannel = vscode.window.createOutputChannel('astx')
  runner: SearchRunner
  transformResultProvider: TransformResultProvider
  searchReplaceViewProvider: SearchReplaceViewProvider
  fsWatcher: vscode.FileSystemWatcher | undefined

  private params: Params
  private externalWatchPattern: vscode.GlobPattern | undefined
  private externalFsWatcher: vscode.FileSystemWatcher | undefined
  // Store cut/copied matches
  private matchesBuffer: string[] = []
  // New flag to track the first search run
  private firstSearchExecuted = false

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
    this.runner = new SearchRunner(this)
    this.transformResultProvider = new TransformResultProvider(this)
    this.searchReplaceViewProvider = new SearchReplaceViewProvider(this)
  }

  async importAstxNode(): Promise<typeof AstxNodeTypes> {
    const config = vscode.workspace.getConfiguration('astx')
    if (!config.astxPath) return await import('astx/node')

    this.channel.appendLine(`importing astx/node from ${config.astxPath}...`)
    const result = await (async () => {
      const pkg = await fs.readJson(path.join(config.astxPath, 'package.json'))
      let subpath
      if (pkg.exports['./node']) {
        subpath =
          typeof pkg.exports['./node'] === 'string'
            ? pkg.exports['./node']
            : pkg.exports['./node'].require ?? pkg.exports['./node'].default
      } else if (pkg.exports['./*']) {
        subpath = (
          typeof pkg.exports['./*'] === 'string'
            ? pkg.exports['./*']
            : pkg.exports['./*'].require ?? pkg.exports['./*'].default
        )?.replace('*', 'node')
      }
      if (!subpath) {
        throw new Error(
          `failed to find export map entry for ./node or a matching pattern`
        )
      }
      const resolvedPath = path.join(config.astxPath, subpath)
      this.channel.appendLine(`resolved to ${resolvedPath}`)
      return require(/* webpackIgnore: true */ resolvedPath)
    })()

    this.channel.appendLine(
      `successfully imported astx/node from ${config.astxPath}`
    )
    return result
  }

  logError = (error: Error): void => {
    const message = `ERROR: ${error.stack || error.message || String(error)}`
    this.channel.appendLine(message)
    const config = vscode.workspace.getConfiguration('astx')
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
      const config = vscode.workspace.getConfiguration('astx')
      for (const key of paramsInConfig) {
        if (params[key] !== this.params[key]) {
          config.update(key, params[key], vscode.ConfigurationTarget.Workspace)
        }
      }
      this.channel.appendLine(
        `[Debug] Setting params: find="${params.find}", replace="${params.replace}", searchInResults=${params.searchInResults}`
      )

      // Clear search cache when search parameters change (matchCase, wholeWord)
      if (
        params.matchCase !== this.params.matchCase ||
        params.wholeWord !== this.params.wholeWord ||
        params.exclude !== this.params.exclude
      ) {
        this.channel.appendLine(
          `[Cache] Clearing cache due to search parameter changes`
        )
        this.runner.clearCache()
      }

      this.params = { ...params }

      // No deed to set params if replacement is in progress
      if (!params.isReplacement) {
        this.runner.setParams({ ...this.params })
      }
    }
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
        this.searchReplaceViewProvider.showWithSearchFocus()
      })
    )

    // Команда replace, открывающая панель с фокусом на поле замены
    context.subscriptions.push(
      vscode.commands.registerCommand('mdSearch.replace', () => {
        // Сначала показываем панель с фокусом на поле замены
        this.searchReplaceViewProvider.showWithReplaceFocus()
      })
    )

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(
        (e: vscode.ConfigurationChangeEvent) => {
          if (!e.affectsConfiguration('astx')) return
          const config = vscode.workspace.getConfiguration('astx')
          if (paramsInConfig.some((p) => this.params[p] !== config[p])) {
            this.setParams({
              ...this.params,
              ...Object.fromEntries(paramsInConfig.map((p) => [p, config[p]])),
            })
          }
        }
      )
    )

    // this.fsWatcher = vscode.workspace.createFileSystemWatcher(
    //   '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'
    // )
    // this.fsWatcher.onDidChange(this.handleFsChange)
    // this.fsWatcher.onDidCreate(this.handleFsChange)
    // this.fsWatcher.onDidDelete(this.handleFsChange)
    // context.subscriptions.push(this.fsWatcher)

    vscode.workspace.onDidChangeTextDocument(
      this.handleTextDocumentChange,
      context.subscriptions
    )

    // context.subscriptions.push(
    //   vscode.commands.registerCommand(
    //     'mdSearch.setAsTransformFile',
    //     (
    //       transformFile: vscode.Uri | undefined = vscode.window.activeTextEditor
    //         ?.document.uri
    //     ) => {
    //       if (!transformFile) return
    //       const newParams = {
    //         ...this.getParams(),
    //         useTransformFile: true,
    //         transformFile: normalizeFsPath(transformFile),
    //       }
    //       this.setParams(newParams)
    //       vscode.commands.executeCommand(
    //         `${SearchReplaceViewProvider.viewType}.focus`
    //       )
    //     }
    //   )
    // )

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
      }
    const findInPath = setIncludePaths({ useTransformFile: false })
    // const transformInPath = setIncludePaths({ useTransformFile: true })

    context.subscriptions.push(
      vscode.commands.registerCommand('mdSearch.findInFile', findInPath)
    )
    // context.subscriptions.push(
    //   vscode.commands.registerCommand(
    //     'mdSearch.transformInFile',
    //     transformInPath
    //   )
    // )
    context.subscriptions.push(
      vscode.commands.registerCommand('mdSearch.findInFolder', findInPath)
    )
    // context.subscriptions.push(
    //   vscode.commands.registerCommand(
    //     'mdSearch.transformInFolder',
    //     transformInPath
    //   )
    // )

    // context.subscriptions.push(
    //   vscode.workspace.registerTextDocumentContentProvider(
    //     ASTX_RESULT_SCHEME,
    //     this.transformResultProvider
    //   ),
    //   vscode.workspace.registerTextDocumentContentProvider(
    //     ASTX_REPORTS_SCHEME,
    //     this.transformResultProvider
    //   )
    // )

    // context.subscriptions.push(
    //   vscode.window.registerFileDecorationProvider(this.transformResultProvider)
    // )

    // После регистрации WebView провайдера, добавляем логику инициализации фоновых задач
    // для ускорения первого поиска
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        SearchReplaceViewProvider.viewType,
        this.searchReplaceViewProvider
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
      })
    )

    context.subscriptions.push({
      dispose: () => {
        this.setExternalWatchPattern(undefined)
      },
    })
  }

  async deactivate(): Promise<void> {
    // Clear workspaceState when VS Code is closed
    if (this.context.workspaceState) {
      await this.context.workspaceState.update(
        'searchReplaceViewState',
        undefined
      )
      this.channel.appendLine('SearchReplaceView state cleared on deactivation')
    }

    // eslint-disable-next-line no-console
    await this.runner.shutdown().catch((error) => console.error(error))
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
      this.runner
        .startup()
        .catch(this.logError)
        .then(() => {
          this.channel.appendLine(
            'Background SearchRunner initialization completed'
          )
        })
    }, 500)
  }

  // Updated replace method with optimizations for text mode
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
        // Don't do anything if replace string is empty
        this.channel.appendLine('Replace cancelled: Replace string is empty.')
        return
      }

      if (params.searchMode === 'astx') {
        // --- AST Mode Replacement (Existing Logic) ---
        this.channel.appendLine('Starting AST replace...')
        // Этот метод больше не поддерживается
        // await this.runner.replace()
        this.channel.appendLine('AST replace is not supported in this version.')
      } else {
        // --- Text/Regex Mode Replacement (Optimized Logic) ---
        this.channel.appendLine(
          `Starting optimized ${params.searchMode} replace...`
        )
        const resultsMap = this.transformResultProvider.results
        const { find, replace, matchCase, wholeWord, searchMode } = params

        if (!find || !resultsMap) {
          this.channel.appendLine(
            'Replace cancelled: Missing find pattern or no search results.'
          )
          return
        }

        let totalReplacements = 0
        let totalFilesChanged = 0

        // Обрабатываем файлы параллельно с ограничением количества одновременных операций
        const MAX_CONCURRENT_WRITES = 10
        const filesToProcess = Array.from(resultsMap.entries()).filter(
          ([_, result]) => result.matches && result.matches.length > 0
        )

        // Создаем группы файлов для параллельной обработки
        for (let i = 0; i < filesToProcess.length; i += MAX_CONCURRENT_WRITES) {
          const batch = filesToProcess.slice(i, i + MAX_CONCURRENT_WRITES)
          const batchPromises = batch.map(([uriString, result]) => {
            return (async () => {
              try {
                const uri = vscode.Uri.parse(uriString)
                const contentBytes = await vscode.workspace.fs.readFile(uri)
                const originalContent =
                  Buffer.from(contentBytes).toString('utf8')
                let newContent = originalContent

                // Construct the regex for replacement
                let pattern = find
                const flags = matchCase ? 'g' : 'gi' // Always global, add 'i' if case-insensitive

                if (searchMode === 'text') {
                  pattern = escapeRegExp(find) // Escape special characters for literal search
                  if (wholeWord) {
                    pattern = `\\b${pattern}\\b` // Add word boundaries
                  }
                }

                const regex = new RegExp(pattern, flags)

                // Perform the replacement
                let replacementCount = 0
                newContent = originalContent.replace(regex, (match) => {
                  replacementCount++
                  return replace || ''
                })

                // Write back only if content changed
                if (newContent !== originalContent) {
                  this.channel.appendLine(
                    `Replacing ${replacementCount} matches in: ${uri.fsPath}`
                  )
                  totalReplacements += replacementCount
                  totalFilesChanged++
                  const newContentBytes = Buffer.from(newContent, 'utf8')
                  await vscode.workspace.fs.writeFile(uri, newContentBytes)
                }
              } catch (error: any) {
                this.logError(
                  new Error(
                    `Failed to replace in ${uriString}: ${error.message}`
                  )
                )
              }
            })()
          })

          // Ждем завершения текущей группы перед обработкой следующей
          await Promise.all(batchPromises)
        }

        // Отправляем сообщение в webview с результатами замены
        this.searchReplaceViewProvider.notifyReplacementComplete(
          totalReplacements,
          totalFilesChanged
        )

        // Clear search results only if this is not a cut operation
        if (!isReplacementOperation) {
          this.transformResultProvider.clear()
        }

        this.channel.appendLine(
          `${params.searchMode} replace finished. Replaced ${totalReplacements} occurrences in ${totalFilesChanged} files.`
        )
      }
    } catch (error: any) {
      this.logError(error)
    } finally {
      // FS change event triggers in about 250 ms
      setTimeout(() => {
        this.replacing = false
      }, 300)
    }
  }

  handleFsChange = (uri: vscode.Uri): void => {
    const { transformFile } = this.getParams()

    // Check if we are in replace mode
    if (this.replacing) {
      this.channel.appendLine(
        `[Debug] File changed during replace: ${uri.fsPath}`
      )
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

  // Method for copying all found matches to buffer
  async copyMatches(): Promise<number> {
    this.channel.appendLine('Copying all matches to buffer...')
    const resultsMap = this.transformResultProvider.results
    this.matchesBuffer = []
    let count = 0

    for (const [uriString, result] of resultsMap.entries()) {
      if (result.matches && result.matches.length > 0 && result.source) {
        for (const match of result.matches) {
          const matchText = result.source.substring(match.start, match.end)
          this.matchesBuffer.push(matchText)
          count++
        }
      }
    }

    // Copy ALL matches to system clipboard, separated by new line
    if (this.matchesBuffer.length > 0) {
      const clipboardText = this.matchesBuffer.join('\n\n')
      await vscode.env.clipboard.writeText(clipboardText)
    }

    this.channel.appendLine(`Copied ${count} matches to buffer.`)
    return count
  }

  // Method for cutting all found matches to buffer
  async cutMatches(): Promise<number> {
    this.channel.appendLine('Cutting all matches to buffer...')
    const resultsMap = this.transformResultProvider.results
    this.matchesBuffer = []
    let count = 0

    // First copy all matches to buffer
    for (const [uriString, result] of resultsMap.entries()) {
      if (result.matches && result.matches.length > 0 && result.source) {
        for (const match of result.matches) {
          const matchText = result.source.substring(match.start, match.end)
          this.matchesBuffer.push(matchText)
          count++
        }
      }
    }

    // Copy ALL matches to system clipboard, separated by new line
    if (this.matchesBuffer.length > 0) {
      const clipboardText = this.matchesBuffer.join('\n\n')
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

  // Method for pasting buffer value to all found matches
  async pasteToMatches(): Promise<number> {
    // Get text from system clipboard
    const clipboardText = await vscode.env.clipboard.readText()

    if (clipboardText.length === 0) {
      this.channel.appendLine('Paste cancelled: Buffer is empty.')
      return 0
    }

    this.channel.appendLine(
      `Pasting ${clipboardText.length} values from buffer to matches...`
    )

    // Use current matches and direct replacement instead of regular expressions
    const resultsMap = this.transformResultProvider.results
    let totalReplacements = 0
    let totalFilesChanged = 0

    const modificationPromises: Promise<void>[] = []

    for (const [uriString, result] of resultsMap.entries()) {
      if (result.matches && result.matches.length > 0) {
        const uri = vscode.Uri.parse(uriString)
        modificationPromises.push(
          (async () => {
            try {
              // Read file content directly
              const contentBytes = await vscode.workspace.fs.readFile(uri)
              const originalContent = Buffer.from(contentBytes).toString('utf8')

              // Process matches in reverse order to avoid shifting indices
              const sortedMatches = [...result.matches].sort(
                (a, b) => b.start - a.start
              )

              let newContent = originalContent
              let replacementsInFile = 0

              // Apply replacements to each match
              for (let i = 0; i < sortedMatches.length; i++) {
                const match = sortedMatches[i]
                // Take value from buffer cyclically
                const replaceValue = clipboardText[i % clipboardText.length]

                // Make direct replacement without any modifications
                newContent =
                  newContent.substring(0, match.start) +
                  replaceValue +
                  newContent.substring(match.end)

                replacementsInFile++
              }

              // Write changes only if they actually exist
              if (newContent !== originalContent) {
                this.channel.appendLine(
                  `Replacing ${replacementsInFile} matches in: ${uri.fsPath}`
                )
                totalReplacements += replacementsInFile
                totalFilesChanged++

                // Write directly to file
                const newContentBytes = Buffer.from(newContent, 'utf8')
                await vscode.workspace.fs.writeFile(uri, newContentBytes)
              }
            } catch (error: any) {
              this.logError(
                new Error(
                  `Failed to replace in ${uri.fsPath}: ${error.message}`
                )
              )
            }
          })()
        )
      }
    }

    // Wait for all file operations to complete
    await Promise.all(modificationPromises)

    // Send message to webview with replacement results
    this.searchReplaceViewProvider.notifyReplacementComplete(
      totalReplacements,
      totalFilesChanged
    )

    this.channel.appendLine(
      `Paste finished. Replaced ${totalReplacements} occurrences in ${totalFilesChanged} files.`
    )

    return totalFilesChanged
  }

  // Method for getting matches buffer
  getMatchesBuffer(): string[] {
    return [...this.matchesBuffer]
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extension = new AstxExtension(context)
  extension.activate(context)

  // Ensure the search view is activated as soon as possible
  // This ensures the event listeners and state persistence are active
  // even if the user hasn't opened the UI yet
  activateSearchView(context)
}

// Helper function to activate the search view programmatically
function activateSearchView(context: vscode.ExtensionContext): void {
  // Try to activate the search view programmatically
  vscode.commands
    .executeCommand(`${SearchReplaceViewProvider.viewType}.focus`)
    .then(
      () => {
        // After focusing, hide it unless the user explicitly wanted it
        // This is just to initialize the view's state
        // Hide it only in setInterval to avoid flickering the UI
        setTimeout(() => {
          if (extension.searchReplaceViewProvider.visible) {
            // If the view was already visible before we focused it, keep it open
            // The user probably opened it manually before this was called
          } else {
            // Otherwise, we can safely hide it since we only needed to initialize it
            vscode.commands.executeCommand(`workbench.action.closePanel`)
          }
        }, 100)
      },
      (error: Error) => {
        // If the command fails (e.g., in tests), log the error but don't fail the activation
        extension.channel.appendLine(
          `Failed to programmatically activate search view: ${error.message}`
        )
      }
    )
}

export async function deactivate(): Promise<void> {
  // eslint-disable-next-line no-console
  await extension?.deactivate().catch((error) => console.error(error))
}

function normalizeFsPath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri)
  return folder
    ? `${
        (vscode.workspace.workspaceFolders?.length ?? 0) > 1
          ? path.basename(folder.uri.path) + '/'
          : ''
      }${path.relative(folder.uri.path, uri.path)}`
    : uri.fsPath
}

// Simple regex escaper
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // $& means the whole matched string
}
