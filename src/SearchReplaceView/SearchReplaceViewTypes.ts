export type SearchReplaceViewStatus = {
  running: boolean
  completed: number
  total: number
  error?: Error
  numMatches: number
  numFilesThatWillChange: number
  numFilesWithMatches: number
  numFilesWithErrors: number
}

// Represents the data received from the extension host for a single file result
// Note: `file` is a string representation of the URI
export type SerializedTransformResultEvent = {
  file: string
  source?: string
  transformed?: string
  matches?: Array<{
    start: number
    end: number
    loc: {
      start: { line: number; column: number }
      end: { line: number; column: number }
    }
  }>
  reports?: any[]
  error?: any
  data?: unknown
}

export type AstxParser =
  | 'babel'
  | 'babel/auto'
  | 'recast/babel'
  | 'recast/babel/auto'

export interface SearchReplaceViewValues {
  find: string
  replace: string
  paused: boolean
  include: string
  exclude: string
  parser: string
  prettier: boolean
  babelGeneratorHack: boolean
  preferSimpleReplacement: boolean
  searchMode: 'astx' | 'text' | 'regex'
  matchCase: boolean
  wholeWord: boolean
  searchInResults: number
  isReplacement?: boolean
}

// State that can be saved and restored for undo functionality
export interface ViewUndoState {
  searchLevels: SearchLevel[]
  resultsByFile: Record<string, SerializedTransformResultEvent[]>
  values: SearchReplaceViewValues
  expandedFiles: string[]
  expandedFolders: string[]
  viewMode: 'list' | 'tree'
  isReplaceVisible: boolean
  isNestedReplaceVisible: boolean
}

// Represents a single level of search in the Find in Found stack
export interface SearchLevel {
  // Values for this search level
  values: SearchReplaceViewValues
  // Results for this search level
  resultsByFile: Record<string, SerializedTransformResultEvent[]>
  // UI state for this level
  matchCase: boolean
  wholeWord: boolean
  searchMode: SearchReplaceViewValues['searchMode']
  isReplaceVisible: boolean
  viewMode: 'list' | 'tree' // Добавляем viewMode
  // Navigation state within results
  expandedFiles: Set<string> | string[]
  expandedFolders: Set<string> | string[]
  // Label for this search level (for navigation breadcrumbs)
  label?: string
  // Statistics for this search level
  stats?: {
    numMatches: number
    numFilesWithMatches: number
  }
}

export type InitialDataFromExtension = {
  type: 'initialData'
  values: SearchReplaceViewValues
  status: SearchReplaceViewStatus
  workspacePath: string
  searchLevels?: SearchLevel[]
}

export type StatusUpdateFromExtension = {
  type: 'status'
  status: Partial<SearchReplaceViewStatus>
  data: SerializedTransformResultEvent
}

export type ValuesUpdateFromExtension = {
  type: 'values'
  values: Partial<SearchReplaceViewValues>
}

export type ClearResultsMessage = {
  type: 'clearResults'
}

export type AddResultMessage = {
  type: 'addResult'
  data: SerializedTransformResultEvent
}

export type MessageToWebview =
  | ValuesUpdateFromExtension
  | StatusUpdateFromExtension
  | ClearResultsMessage
  | AddResultMessage
  | InitialDataFromExtension
  | {
      type: 'addBatchResults'
      data: SerializedTransformResultEvent[]
      isSearchRunning: boolean
    }
  | { type: 'replaceDone' }
  | { type: 'stop' }
  | { type: 'focusSearchInput' }
  | { type: 'focusReplaceInput' }
  | {
      type: 'replacementComplete'
      totalReplacements: number
      totalFilesChanged: number
    }
  | {
      type: 'fileUpdated'
      filePath: string
      newSource: string
    }
  | {
      type: 'copyMatchesComplete'
      count: number
    }
  | {
      type: 'cutMatchesComplete'
      count: number
    }
  | {
      type: 'pasteToMatchesComplete'
      count: number
    }
  | {
      type: 'copyFileNamesComplete'
      count: number
    }
  | {
      type: 'undoComplete'
      restored: boolean
    }
  | {
      type: 'restoreViewState'
      viewState: ViewUndoState
    }

export type MessageFromWebview =
  | { type: 'mount' }
  | { type: 'unmount' }
  | {
      type: 'values'
      values: SearchReplaceViewValues
    }
  | ({
      type: 'search'
    } & SearchReplaceViewValues)
  | {
      type: 'replace'
      filePaths?: string[]
    }
  | {
      type: 'openFile'
      filePath: string // String URI of the file to open
      range?: { start: number; end: number } // Optional range (character offsets)
    }
  | {
      type: 'log'
      level: 'info' | 'warn' | 'error'
      message: string
      data?: any // Optional structured data
    }
  | { type: 'stop' }
  | { type: 'abort' }
  | { type: 'copyMatches'; fileOrder?: string[] }
  | { type: 'cutMatches'; fileOrder?: string[] }
  | { type: 'pasteToMatches'; fileOrder?: string[] }
  | { type: 'copyFileNames' }
  | { type: 'excludeFile'; filePath: string }
  | { type: 'saveViewMode'; viewMode: 'list' | 'tree' }
  | { type: 'undoLastOperation' }
  | {
      type: 'updateFileOrder'
      customOrder: { [key: string]: number }
    }

// === Combined Message Type (for use in component) ===
export type Message = MessageFromWebview | MessageToWebview

export type SearchReplaceViewInitialData = {
  type: 'initialData'
  values: SearchReplaceViewValues
  status: SearchReplaceViewStatus
  results: SerializedTransformResultEvent[]
  viewMode?: 'list' | 'tree' // Добавляем viewMode
}
