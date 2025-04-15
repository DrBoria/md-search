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
}

export type MessageToWebview =
  | {
      type: 'status'
      status: Partial<SearchReplaceViewStatus>
    }
  | {
      type: 'values'
      values: Partial<SearchReplaceViewValues>
    }
  | {
      type: 'addResult'
      data: SerializedTransformResultEvent
    }
  | {
      type: 'clearResults'
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
