import * as vscode from 'vscode'

export type Params = {
  find: string
  replace?: string
  useTransformFile?: boolean
  transformFile?: string
  paused?: boolean
  include?: string
  exclude?: string
  prettier?: boolean
  searchMode: 'text' | 'regex'
  matchCase: boolean
  wholeWord: boolean
  searchInResults?: number
  isReplacement?: boolean
  searchNonce?: string
}

export type IpcMatch = {
  type: 'match'
  start: number
  end: number
  file: string
  source: string
  captures: Record<string, string>
  loc: {
    start: { line: number; column: number }
    end: { line: number; column: number }
  }
}

export type ProgressEvent = {
  completed: number
  total: number
}

export interface IMdSearchExtension {
  isProduction: boolean
  context: vscode.ExtensionContext
  channel: vscode.OutputChannel
  runner: any
  transformResultProvider: any
  searchReplaceViewProvider: any
  getParams(): Params
  setParams(params: Params): void
  logError(error: Error): void
  resolveFsPath(fsPath: string): vscode.Uri
  replace(): Promise<void>
  copyMatches(fileOrder?: string[]): Promise<number>
  cutMatches(fileOrder?: string[]): Promise<number>
  pasteToMatches(fileOrder?: string[]): Promise<number>
  copyFileNames(): Promise<number>
  undoLastOperation(): Promise<boolean>
  undoLastOperation(): Promise<boolean>
  setCustomFileOrder(order: { [key: string]: number }): void
  getCustomFileOrder(): { [key: string]: number }
  triggerSearch(): void
}
