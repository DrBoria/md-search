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
  match: (match: any) => void
  abort: () => void
}

export interface SearchCacheEntry {
  query: string
  params: {
    matchCase: boolean
    wholeWord: boolean
    searchMode: string
  }
  results: Map<string, TransformResultEvent>
  timestamp: number
}

export interface SearchCache {
  get(key: string): SearchCacheEntry | undefined
  set(key: string, value: SearchCacheEntry): void
  has(key: string): boolean
  delete(key: string): boolean
  clear(): void
}
