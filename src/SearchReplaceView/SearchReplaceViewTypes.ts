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
  searchInResults: boolean
}

export type InitialDataFromExtension = {
  type: 'initialData'
  values: SearchReplaceViewValues
  status: SearchReplaceViewStatus
  workspacePath?: string
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

// === Combined Message Type (for use in component) ===
export type Message = MessageFromWebview | MessageToWebview
