import { z } from 'zod'

export const SearchReplaceViewStatusSchema = z.object({
  running: z.boolean(),
  completed: z.number(),
  total: z.number(),
  error: z.instanceof(Error).optional(),
  numMatches: z.number(),
  numFilesThatWillChange: z.number(),
  numFilesWithMatches: z.number(),
  numFilesWithErrors: z.number(),
})
export type SearchReplaceViewStatus = z.infer<
  typeof SearchReplaceViewStatusSchema
>

export const SerializedTransformResultEventSchema = z.object({
  file: z.string(),
  source: z.string().optional(),
  transformed: z.string().optional(),
  matches: z
    .array(
      z.object({
        start: z.number(),
        end: z.number(),
        loc: z.object({
          start: z.object({ line: z.number(), column: z.number() }),
          end: z.object({ line: z.number(), column: z.number() }),
        }),
      })
    )
    .optional(),
  reports: z.array(z.any()).optional(),
  error: z.any().optional(),
  data: z.unknown().optional(),
})
export type SerializedTransformResultEvent = z.infer<
  typeof SerializedTransformResultEventSchema
>

export const AstxParserSchema = z.enum([
  'babel',
  'babel/auto',
  'recast/babel',
  'recast/babel/auto',
])
export type AstxParser = z.infer<typeof AstxParserSchema>

export const SearchReplaceViewValuesSchema = z.object({
  find: z.string(),
  replace: z.string(),
  paused: z.boolean(),
  include: z.string(),
  exclude: z.string(),
  parser: z.string(),
  prettier: z.boolean(),
  babelGeneratorHack: z.boolean(),
  preferSimpleReplacement: z.boolean(),
  searchMode: z.enum(['text', 'regex']),
  matchCase: z.boolean(),
  wholeWord: z.boolean(),
  searchInResults: z.number(),
  isReplacement: z.boolean().optional(),
  searchNonce: z.string().optional(),
})
export type SearchReplaceViewValues = z.infer<
  typeof SearchReplaceViewValuesSchema
>

const ViewUndoStateSchemaBase = z.object({
  resultsByFile: z.record(
    z.string(),
    z.array(SerializedTransformResultEventSchema)
  ),
  values: SearchReplaceViewValuesSchema,
  expandedFiles: z.array(z.string()),
  expandedFolders: z.array(z.string()),
  viewMode: z.enum(['list', 'tree']),
  isReplaceVisible: z.boolean(),
  isNestedReplaceVisible: z.boolean(),
})

// Circular dependency handling for SearchLevel
export const SearchLevelSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    values: SearchReplaceViewValuesSchema,
    resultsByFile: z.record(
      z.string(),
      z.array(SerializedTransformResultEventSchema)
    ),
    matchCase: z.boolean(),
    wholeWord: z.boolean(),
    searchMode: SearchReplaceViewValuesSchema.shape.searchMode,
    isReplaceVisible: z.boolean(),
    viewMode: z.enum(['list', 'tree']),
    expandedFiles: z.union([z.instanceof(Set), z.array(z.string())]),
    expandedFolders: z.union([z.instanceof(Set), z.array(z.string())]),
    label: z.string().optional(),
    stats: z
      .object({
        numMatches: z.number(),
        numFilesWithMatches: z.number(),
      })
      .optional(),
  })
)

export const ViewUndoStateSchema = ViewUndoStateSchemaBase.extend({
  searchLevels: z.array(SearchLevelSchema),
})
export type ViewUndoState = z.infer<typeof ViewUndoStateSchema>
export type SearchLevel = z.infer<typeof SearchLevelSchema>

export const InitialDataFromExtensionSchema = z.object({
  type: z.literal('initialData'),
  values: SearchReplaceViewValuesSchema,
  status: SearchReplaceViewStatusSchema,
  workspacePath: z.string(),
  searchLevels: z.array(SearchLevelSchema).optional(),
  customFileOrder: z.record(z.string(), z.number()).optional(),
})
export type InitialDataFromExtension = z.infer<
  typeof InitialDataFromExtensionSchema
>

export const StatusUpdateFromExtensionSchema = z.object({
  type: z.literal('status'),
  status: SearchReplaceViewStatusSchema.partial(),
  data: SerializedTransformResultEventSchema.optional(),
})
export type StatusUpdateFromExtension = z.infer<
  typeof StatusUpdateFromExtensionSchema
>

export const ValuesUpdateFromExtensionSchema = z.object({
  type: z.literal('values'),
  values: SearchReplaceViewValuesSchema.partial(),
})
export type ValuesUpdateFromExtension = z.infer<
  typeof ValuesUpdateFromExtensionSchema
>

export const ClearResultsMessageSchema = z.object({
  type: z.literal('clearResults'),
})
export type ClearResultsMessage = z.infer<typeof ClearResultsMessageSchema>

export const AddResultMessageSchema = z.object({
  type: z.literal('addResult'),
  data: SerializedTransformResultEventSchema,
})
export type AddResultMessage = z.infer<typeof AddResultMessageSchema>

export const MessageToWebviewSchema = z.discriminatedUnion('type', [
  ValuesUpdateFromExtensionSchema,
  StatusUpdateFromExtensionSchema,
  ClearResultsMessageSchema,
  AddResultMessageSchema,
  InitialDataFromExtensionSchema,
  z.object({
    type: z.literal('addBatchResults'),
    data: z.array(SerializedTransformResultEventSchema),
    isSearchRunning: z.boolean(),
    nonce: z.string().optional(),
  }),
  z.object({ type: z.literal('replaceDone') }),
  z.object({ type: z.literal('stop') }),
  z.object({
    type: z.literal('focusSearchInput'),
    selectedText: z.string().optional(),
    triggerSearch: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('focusReplaceInput'),
    selectedText: z.string().optional(),
  }),
  z.object({
    type: z.literal('replacementComplete'),
    totalReplacements: z.number(),
    totalFilesChanged: z.number(),
  }),
  z.object({
    type: z.literal('fileUpdated'),
    filePath: z.string(),
    newSource: z.string(),
  }),
  z.object({ type: z.literal('copyMatchesComplete'), count: z.number() }),
  z.object({ type: z.literal('cutMatchesComplete'), count: z.number() }),
  z.object({ type: z.literal('pasteToMatchesComplete'), count: z.number() }),
  z.object({ type: z.literal('copyFileNamesComplete'), count: z.number() }),
  z.object({ type: z.literal('undoComplete'), restored: z.boolean() }),
  z.object({
    type: z.literal('search-paused'),
    limit: z.number(),
    count: z.number(),
  }),
  z.object({
    type: z.literal('skipped-large-files'),
    count: z.number(),
  }),
  z.object({
    type: z.literal('restoreViewState'),
    viewState: ViewUndoStateSchema,
  }),
])
export type MessageToWebview = z.infer<typeof MessageToWebviewSchema>

export const MessageFromWebviewSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mount') }),
  z.object({ type: z.literal('unmount') }),
  z.object({
    type: z.literal('values'),
    values: SearchReplaceViewValuesSchema,
  }),
  SearchReplaceViewValuesSchema.extend({ type: z.literal('search') }),
  z.object({
    type: z.literal('replace'),
    filePaths: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('openFile'),
    filePath: z.string(),
    range: z.object({ start: z.number(), end: z.number() }).optional(),
  }),
  z.object({
    type: z.literal('log'),
    level: z.enum(['info', 'warn', 'error']),
    message: z.string(),
    data: z.any().optional(),
  }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('abort') }),
  z.object({ type: z.literal('continue-search') }),
  z.object({ type: z.literal('search-large-files') }),
  z.object({
    type: z.literal('copyMatches'),
    fileOrder: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('cutMatches'),
    fileOrder: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('pasteToMatches'),
    fileOrder: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal('copyFileNames') }),
  z.object({ type: z.literal('excludeFile'), filePath: z.string() }),
  z.object({
    type: z.literal('saveViewMode'),
    viewMode: z.enum(['list', 'tree']),
  }),
  z.object({ type: z.literal('undoLastOperation') }),
  z.object({
    type: z.literal('updateFileOrder'),
    customOrder: z.record(z.string(), z.number()),
  }),
])
export type MessageFromWebview = z.infer<typeof MessageFromWebviewSchema>

export const SearchReplaceViewInitialDataSchema = z.object({
  type: z.literal('initialData'),
  values: SearchReplaceViewValuesSchema,
  status: SearchReplaceViewStatusSchema,
  results: z.array(SerializedTransformResultEventSchema),
  viewMode: z.enum(['list', 'tree']).optional(),
})
export type SearchReplaceViewInitialData = z.infer<
  typeof SearchReplaceViewInitialDataSchema
>

export type Message = MessageFromWebview | MessageToWebview
