import * as vscode from 'vscode'

export type TransformResultEvent = {
  file: vscode.Uri
  source: string
  transformed?: string
  reports?: unknown[]
  matches: readonly any[]
  error?: Error
}

export interface AstxRunnerEvents {
  result: (options: TransformResultEvent) => void
  stop: () => void
  start: () => void
  progress: (options: { completed: number; total: number }) => void
  done: () => void
  error: (error: Error) => void
  replaceDone: () => void
}
