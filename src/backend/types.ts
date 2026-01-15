import * as vscode from 'vscode'
import type * as AstxNodeTypes from 'astx/node'

export type AstxParser =
  | 'babel'
  | 'babel/auto'
  | 'recast/babel'
  | 'recast/babel/auto'

export type Params = {
  find: string
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

export interface IAstxExtension {
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
  importAstxNode(): Promise<typeof AstxNodeTypes>
  replace(): Promise<void>
  copyMatches(fileOrder?: string[]): Promise<number>
  cutMatches(fileOrder?: string[]): Promise<number>
  pasteToMatches(fileOrder?: string[]): Promise<number>
  copyFileNames(): Promise<number>
  undoLastOperation(): Promise<boolean>
  setCustomFileOrder(order: { [key: string]: number }): void
}
