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
  matches?: Array<{ start: number; end: number }>
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
  | { type: 'addBatchResults'; data: SerializedTransformResultEvent[]; isSearchRunning: boolean }
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

export type MessageFromWebview =
  | {
      type: 'mount'
    }
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
  | { type: 'copyMatches' }
  | { type: 'cutMatches' }
  | { type: 'pasteToMatches' }

// === Combined Message Type (for use in component) ===
export type Message = MessageFromWebview | MessageToWebview
