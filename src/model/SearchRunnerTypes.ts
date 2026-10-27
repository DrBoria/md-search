import * as vscode from 'vscode'

export interface SearchRunnerMatch {
  start: number
  end: number
  loc: {
    start: { line: number; column: number }
    end: { line: number; column: number }
  }
  type?: string
  file?: string
  source?: string
  captures?: Record<string, string>
}

export type TransformResultEvent = {
  file: vscode.Uri
  source: string
  transformed?: string
  reports?: unknown[]
  matches: readonly SearchRunnerMatch[]
  error?: Error
}

export interface SearchRunnerEvents {
  result: (options: TransformResultEvent) => void
  stop: () => void
  start: () => void
  progress: (progress: { completed: number; total: number }) => void
  'search-paused': (e: { limit: number; count: number }) => void
  'skipped-large-files': (count: number) => void
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
