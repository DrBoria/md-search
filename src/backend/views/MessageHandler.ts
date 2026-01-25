import * as vscode from 'vscode'
import { IMdSearchExtension } from '../types'
import {
  MessageFromWebviewSchema,
  MessageToWebview,
  SearchReplaceViewValues,
  SearchReplaceViewStatus,
} from '../../model/SearchReplaceViewTypes'
import { MD_SEARCH_RESULT_SCHEME } from '../../constants'

export class MessageHandler {
  constructor(
    private extension: IMdSearchExtension,
    private viewProvider: {
      notifyReplacementComplete: (
        totalReplacements: number,
        totalFilesChanged: number
      ) => void
      notifyCopyMatchesComplete: (count: number) => void
      notifyCutMatchesComplete: (count: number) => void
      notifyPasteToMatchesComplete: (count: number) => void
      notifyCopyFileNamesComplete: (count: number) => void
      notifyUndoComplete: (restored: boolean) => void
      postMessage: (message: MessageToWebview) => void
      getStatus: () => SearchReplaceViewStatus
      onWebviewMounted: () => void
    }
  ) {}

  public async handle(rawMessage: unknown): Promise<void> {
    const validation = MessageFromWebviewSchema.safeParse(rawMessage)

    if (!validation.success) {
      this.extension.logError(
        new Error(
          `Invalid message received from webview: ${JSON.stringify(
            validation.error.format()
          )}`
        )
      )
      return
    }

    const message = validation.data

    // Debug log for relevant messages
    if (
      ['copyMatches', 'cutMatches', 'pasteToMatches'].includes(message.type)
    ) {
      this.extension.channel.appendLine(
        `[MessageHandler] Received message: ${message.type}`
      )
    }

    try {
      switch (message.type) {
        case 'mount':
          await this.handleMount()
          break
        case 'search':
          this.handleSearch(message)
          break
        case 'values':
          this.handleValues(message.values)
          break
        case 'replace':
          this.handleReplace(message.filePaths)
          break
        case 'abort':
          this.handleAbort()
          break
        case 'stop':
          this.handleStop()
          break
        case 'copyMatches':
          await this.handleCopyMatches(message.fileOrder)
          break
        case 'cutMatches':
          console.log('cutMatches', message.fileOrder)
          await this.handleCutMatches(message.fileOrder)
          break
        case 'pasteToMatches':
          await this.handlePasteToMatches(message.fileOrder)
          break
        case 'copyFileNames':
          await this.handleCopyFileNames()
          break
        case 'excludeFile':
          this.handleExcludeFile(message.filePath)
          break
        case 'undoLastOperation':
          await this.handleUndoLastOperation()
          break
        case 'openFile':
          await this.handleOpenFile(message.filePath, message.range)
          break
        case 'log':
          this.handleLog(message.level, message.message, message.data)
          break
        case 'updateFileOrder':
          this.handleUpdateFileOrder(message.customOrder)
          break
        case 'continue-search':
          this.handleContinueSearch()
          break
        case 'search-large-files':
          this.handleSearchLargeFiles()
          break
      }
    } catch (error) {
      this.extension.logError(
        error instanceof Error
          ? error
          : new Error(`Error handling webview message: ${error}`)
      )
    }
  }

  private async handleMount(): Promise<void> {
    // Mark webview as mounted and flush any pending messages
    this.viewProvider.onWebviewMounted()

    const workspaceFolders = vscode.workspace.workspaceFolders || []
    const workspacePath =
      workspaceFolders.length > 0 ? workspaceFolders[0].uri.toString() : ''

    const currentParams = this.extension.getParams()

    // The instruction implies a call to setParams here, likely to update initial state without triggering a search.
    // The provided snippet is a bit malformed, but the intent seems to be to set parameters
    // without restarting the search immediately.
    // Assuming the intent is to set the initial parameters without triggering a search on mount.
    this.extension.setParams(currentParams, false) // Do not restart search immediately, let frontend handle optimistic update

    const values: any = {
      ...currentParams,
      parser: (currentParams as any).parser || 'babel',
      babelGeneratorHack: (currentParams as any).babelGeneratorHack || false,
      preferSimpleReplacement:
        (currentParams as any).preferSimpleReplacement || false,
      include: (currentParams as any).include || '',
      exclude: (currentParams as any).exclude || '',
      replace: currentParams.replace || '',
      paused: (currentParams as any).paused || false,
      prettier: (currentParams as any).prettier || false,
      searchInResults: (currentParams as any).searchInResults || 0,
    }

    const status = this.viewProvider.getStatus()

    const customFileOrder = this.extension.getCustomFileOrder()

    this.viewProvider.postMessage({
      type: 'initialData',
      workspacePath,
      values: values as SearchReplaceViewValues,
      status,
      customFileOrder,
    })
  }

  private handleValues(values: SearchReplaceViewValues): void {
    this.extension.setParams(values)
  }

  private handleSearch(values: SearchReplaceViewValues): void {
    this.extension.setParams(values)
    this.extension.triggerSearch()
  }

  private handleReplace(filePaths?: string[]): void {
    filePaths = filePaths || []
    this.extension.channel.appendLine(
      `Replace request received with ${filePaths.length} files`
    )

    if (filePaths.length > 0) {
      const originalResults = this.extension.transformResultProvider.results
      const filteredResults = new Map()

      for (const filePath of filePaths) {
        if (originalResults.has(filePath)) {
          filteredResults.set(filePath, originalResults.get(filePath))
        }
      }

      const tempResults = this.extension.transformResultProvider.results
      this.extension.transformResultProvider.results = filteredResults

      this.extension.replace()

      this.extension.transformResultProvider.results = tempResults
    } else {
      this.extension.replace()
    }
  }

  private handleAbort(): void {
    this.extension.channel.appendLine(
      'Received stop command from webview, aborting search...'
    )
    this.extension.runner.abort()
  }

  private handleStop(): void {
    this.extension.channel.appendLine(
      'Received stop command from webview, stopping search...'
    )
    this.extension.runner.stop()
  }

  private async handleCopyMatches(fileOrder?: string[]): Promise<void> {
    console.log(
      `[MessageHandler] handleCopyMatches called. Order provided: ${!!fileOrder}`
    )
    const count = await this.extension.copyMatches(fileOrder)
    this.viewProvider.notifyCopyMatchesComplete(count)
  }

  private async handleCutMatches(fileOrder?: string[]): Promise<void> {
    console.log(
      `[MessageHandler] handleCutMatches called. Order provided: ${!!fileOrder}`
    )
    const count = await this.extension.cutMatches(fileOrder)
    this.viewProvider.notifyCutMatchesComplete(count)
  }

  private async handlePasteToMatches(fileOrder?: string[]): Promise<void> {
    this.extension.channel.appendLine(
      `[MessageHandler] handlePasteToMatches called. Order provided: ${!!fileOrder}`
    )
    const count = await this.extension.pasteToMatches(fileOrder)
    this.viewProvider.notifyPasteToMatchesComplete(count)
  }

  private async handleCopyFileNames(): Promise<void> {
    const count = await this.extension.copyFileNames()
    this.viewProvider.notifyCopyFileNamesComplete(count)
  }

  private handleExcludeFile(filePath: string): void {
    const fileUri = vscode.Uri.parse(filePath)
    console.log(`[MessageHandler] handleExcludeFile called for: ${filePath}`)
    console.log(`[MessageHandler] Parsed URI fsPath: ${fileUri.fsPath}`)

    // 1. Exclude from cache (immediate effect on backend state)
    this.extension.runner.excludeFileFromCache(fileUri)
    this.extension.transformResultProvider.results.delete(filePath)

    // We need to notify the provider to update its state, but the provider handles state itself.
    // Ideally, the provider logic should also be decoupled or exposed.
    // For now, assuming direct manipulation is handled by the provider's listeners,
    // but we need to trigger the fileUpdated message.
    // Since MessageHandler doesn't have access to provider's private state,
    // we might need to rely on the extension logic or emit an event.

    // However, looking at the original code, the provider manually sends 'fileUpdated'.
    this.viewProvider.postMessage({
      type: 'fileUpdated',
      filePath,
      newSource: '',
    })

    this.extension.channel.appendLine(`File excluded from search: ${filePath}`)
  }

  private async handleUndoLastOperation(): Promise<void> {
    try {
      const restored = await this.extension.undoLastOperation()
      this.viewProvider.notifyUndoComplete(restored)
    } catch (error) {
      this.viewProvider.notifyUndoComplete(false)
      throw error
    }
  }

  private async handleOpenFile(
    filePath: string,
    range?: { start: number; end?: number }
  ): Promise<void> {
    const uri = vscode.Uri.parse(filePath)
    const result = this.extension.transformResultProvider.results.get(
      uri.toString()
    )

    if (result && result.transformed && result.transformed !== result.source) {
      const transformedUri = uri.with({ scheme: MD_SEARCH_RESULT_SCHEME })
      const filename = uri.path.substring(uri.path.lastIndexOf('/') + 1)
      vscode.commands.executeCommand(
        'vscode.diff',
        uri,
        transformedUri,
        `${filename} ↔ Changes`
      )
    } else {
      if (range?.start !== undefined) {
        try {
          const document = await vscode.workspace.openTextDocument(uri)
          const startPos = document.positionAt(range.start)
          const endPos =
            range.end !== undefined ? document.positionAt(range.end) : startPos

          vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(startPos, endPos),
          })
        } catch (error) {
          this.extension.logError(
            error instanceof Error ? error : new Error(String(error))
          )
          vscode.window.showTextDocument(uri)
        }
      } else {
        vscode.window.showTextDocument(uri)
      }
    }
  }

  private handleLog(level: string, message: string, data: any): void {
    const logMessage = `[Webview ${level.toUpperCase()}] ${message}`
    this.extension.channel.appendLine(logMessage)
    if (data) {
      this.extension.channel.appendLine(`Data: ${JSON.stringify(data)}`)
    }
  }

  private handleUpdateFileOrder(customOrder: { [key: string]: number }): void {
    this.extension.channel.appendLine(
      `[MessageHandler] handleUpdateFileOrder received with ${Object.keys(customOrder).length} items`
    )
    this.extension.setCustomFileOrder(customOrder)
  }

  private handleContinueSearch(): void {
    this.extension.channel.appendLine(
      '[MessageHandler] received continue-search'
    )
    if (this.extension.runner.continueSearch) {
      this.extension.runner.continueSearch()
    }
  }

  private handleSearchLargeFiles(): void {
    this.extension.channel.appendLine(
      '[MessageHandler] received search-large-files'
    )
    if (this.extension.runner.searchLargeFiles) {
      this.extension.runner.searchLargeFiles()
    }
  }
}
