/* eslint-disable no-console */
import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { debounce } from 'lodash'
import {
  MessageToWebview,
  MessageToWebviewSchema,
  SerializedTransformResultEvent,
  SearchReplaceViewStatus,
  SearchReplaceViewValues,
  SearchLevel,
} from '../../../model/SearchReplaceViewTypes'
import { MessageFromWebview } from '../../../model/SearchReplaceViewTypes'

interface UseSearchStateProps {
  vscode: {
    postMessage(message: MessageFromWebview): void
    getState(): { [key: string]: any } | undefined
    setState(newState: { [key: string]: any }): void
  }
}

export const useSearchState = ({ vscode }: UseSearchStateProps) => {
  // --- State Initialization ---
  const initialStateSearchLevelsLength = 0
  const [values, setValues] = useState<SearchReplaceViewValues>({
    find: '',
    replace: '',
    paused: false,
    include: '',
    exclude: '',
    parser: 'babel',
    prettier: true,
    babelGeneratorHack: false,
    preferSimpleReplacement: false,
    searchMode: 'text',
    matchCase: false,
    wholeWord: false,
    searchInResults: Math.max(initialStateSearchLevelsLength - 1, 0),
  })

  // Ref that is SYNCHRONOUSLY updated whenever values change
  // This allows callbacks to always read the latest values without waiting for React re-render
  const valuesRef = useRef(values)

  const [status, setStatus] = useState<SearchReplaceViewStatus>({
    running: false,
    completed: 0,
    total: 0,
    numMatches: 0,
    numFilesThatWillChange: 0,
    numFilesWithMatches: 0,
    numFilesWithErrors: 0,
  })

  // Store results keyed by absolute path initially
  const [resultsByFile, setResultsByFile] = useState<
    Record<string, SerializedTransformResultEvent[]>
  >({})
  // Stale Results State (for smooth transitions)
  const [staleResultsByFile, setStaleResultsByFile] = useState<Record<
    string,
    SerializedTransformResultEvent[]
  > | null>(null)

  const [staleLevel, setStaleLevel] = useState<number | null>(null)

  const [staleStatus, setStaleStatus] =
    useState<SearchReplaceViewStatus | null>(null)

  const [workspacePath, setWorkspacePath] = useState<string>('')

  // State to track when a search is requested but results haven't arrived yet
  const [isSearchRequested, setIsSearchRequested] = useState(false)

  // Replacement Result State
  const [replacementResult, setReplacementResult] = useState<{
    totalReplacements: number
    totalFilesChanged: number
    show: boolean
  }>({
    totalReplacements: 0,
    totalFilesChanged: 0,
    show: false,
  })

  // --- UI State that is also part of SearchLevel ---
  // --- UI State that is also part of SearchLevel ---
  const [viewMode, setViewMode] = useState<'list' | 'tree'>('tree')
  const [customFileOrder, setCustomFileOrder] = useState<string[]>([])

  // --- Multi-level Nested Search (Find in Found) States ---
  const [searchLevels, setSearchLevels] = useState<SearchLevel[]>(() => {
    // Check if we have saved search levels in state (omitted for now to match current simple logic)
    return [
      {
        values,
        resultsByFile: {}, // Initial empty results
        matchCase: values?.matchCase,
        wholeWord: values?.wholeWord,
        searchMode: values?.searchMode,
        isReplaceVisible: false,
        expandedFiles: new Set(),
        expandedFolders: new Set(),
        label: values?.find || 'Initial search',
        viewMode: 'tree',
      },
    ]
  })

  // Determine if we are actively viewing a nested search level (not Root)
  // We check index > 0. If index is 0, we are at Root, even if history exists.
  const isInNestedSearch = values.searchInResults > 0;
  const searchLevelsRef = useRef(searchLevels)
  useEffect(() => {
    searchLevelsRef.current = searchLevels
  }, [searchLevels])

  // --- Throttling Logic ---
  const throttleTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pendingResultsRef = useRef<
    Record<string, SerializedTransformResultEvent[]>
  >({})
  const shouldClearResultsRef = useRef(false)
  const skipSearchUntilRef = useRef(0) // Timestamp until which to skip sending values message (used for navigation)
  const throttleDelayRef = useRef<number>(100)
  const lastUpdateTimeRef = useRef<number>(Date.now())

  const flushPendingResults = useCallback(() => {
    const resultCount = Object.keys(pendingResultsRef.current).length
    if (resultCount === 0) return

    const now = Date.now()

    // Adaptive throttling
    let totalMatches = 0
    const allEntries = Object.entries(pendingResultsRef.current)
    for (const [, results] of allEntries) {
      totalMatches += results.reduce(
        (sum, result) => sum + (result.matches?.length || 0),
        0
      )
    }

    if (totalMatches > 1000) throttleDelayRef.current = 500
    else if (totalMatches > 500) throttleDelayRef.current = 400
    else if (totalMatches > 100) throttleDelayRef.current = 300
    else throttleDelayRef.current = 150

    // Batch processing
    const batchSize = totalMatches > 500 ? 10 : 50
    const batch = allEntries.slice(0, batchSize)
    const remaining = allEntries.slice(batchSize)

    // Clear processed items from ref immediately
    pendingResultsRef.current = Object.fromEntries(remaining)

    if (isInNestedSearch && values.searchInResults > 0) {
      setSearchLevels((prev) => {
        if (
          prev.length === 0 ||
          values.searchInResults < 0 ||
          values.searchInResults >= prev.length
        ) {
          return prev
        }

        const newLevels = [...prev]
        const level = newLevels[values.searchInResults]
        const updatedResultsByFile = { ...level.resultsByFile }
        const updatedExpandedFiles = new Set(level.expandedFiles)
        const updatedExpandedFolders = new Set(level.expandedFolders)

        batch.forEach(([filePath, results]) => {
          if (results.length === 0) return

          const existingEvents = updatedResultsByFile[filePath] || []
          const seenSignatures = new Set<string>() // Use local Set for this file + batch

          // Init with existing
          existingEvents.forEach((event: SerializedTransformResultEvent) => {
            event.matches?.forEach((m: { start: number; end: number }) => {
              seenSignatures.add(`${m.start}-${m.end}`)
            })
          })

          const uniqueNewResults = results
            .map((event) => {
              if (!event.matches) return event
              // Filter matches, but ALSO update seenSignatures as we go!
              const uniqueMatches = event.matches.filter(
                (m: { start: number; end: number }) => {
                  const key = `${m.start}-${m.end}`
                  if (seenSignatures.has(key)) return false
                  seenSignatures.add(key)
                  return true
                }
              )
              return uniqueMatches.length > 0
                ? { ...event, matches: uniqueMatches }
                : null
            })
            .filter(Boolean) as SerializedTransformResultEvent[]

          if (uniqueNewResults.length === 0) return

          if (uniqueNewResults.length === 0) return

          // Replace existing results for this file (Live Update support)
          // Since backend emits full file results, we overwrite instead of appending.
          updatedResultsByFile[filePath] = [...uniqueNewResults]

          // Auto-expand logic remains the same (calculating TOTAL matches including new ones)
          const allMatches = updatedResultsByFile[filePath].reduce(
            (sum: number, r: SerializedTransformResultEvent) =>
              sum + (r.matches?.length || 0),
            0
          )

          if (allMatches < 50) {
            updatedExpandedFiles.add(filePath)
          } else {
            updatedExpandedFiles.delete(filePath)
          }

          if (workspacePath && filePath.startsWith(workspacePath)) {
            let rel = filePath.substring(workspacePath.length)
            if (rel.startsWith('/') || rel.startsWith('\\'))
              rel = rel.substring(1)
            rel = rel.replace(/\\/g, '/')

            const parts = rel.split('/')
            let currentPath = ''
            for (let i = 0; i < parts.length - 1; i++) {
              currentPath = currentPath
                ? `${currentPath}/${parts[i]}`
                : parts[i]
              updatedExpandedFolders.add(currentPath)
            }
          }
        })

        newLevels[values.searchInResults] = {
          ...level,
          resultsByFile: updatedResultsByFile,
          expandedFiles: updatedExpandedFiles,
          expandedFolders: updatedExpandedFolders,
        }
        return newLevels
      })
    } else {
      // Level 0

      // 1. Update Results (Same as before)
      setResultsByFile((prev) => {
        const newResults = { ...prev }
        batch.forEach(([filePath, results]) => {
          if (results.length === 0) return

          // Deduplication Logic
          const existingEvents = newResults[filePath] || []
          const seenSignatures = new Set<string>()

          // 1. Load existing
          existingEvents.forEach((event: SerializedTransformResultEvent) => {
            event.matches?.forEach((m: { start: number; end: number }) => {
              seenSignatures.add(`${m.start}-${m.end}`)
            })
          })

          // 2. Filter new (intra-batch aware)
          const uniqueNewResults = results
            .map((event: SerializedTransformResultEvent) => {
              if (!event.matches) return event
              const uniqueMatches = event.matches.filter(
                (m: { start: number; end: number }) => {
                  const key = `${m.start}-${m.end}`
                  if (seenSignatures.has(key)) return false
                  seenSignatures.add(key)
                  return true
                }
              )
              return uniqueMatches.length > 0
                ? { ...event, matches: uniqueMatches }
                : null
            })
            .filter(Boolean) as SerializedTransformResultEvent[]

          if (uniqueNewResults.length === 0) return

          // Replace results (Live Update support)
          if (newResults[filePath]) {
            newResults[filePath] = uniqueNewResults
          } else {
            newResults[filePath] = uniqueNewResults
          }
        })
        return newResults
      })

      // 2. Update Expansion AND Results (in searchLevels)
      setSearchLevels((prev) => {
        const newLevels = [...prev]
        if (!newLevels[0]) {
          newLevels[0] = {
            values,
            resultsByFile: {},
            expandedFiles: new Set(),
            expandedFolders: new Set(),
            isReplaceVisible: false,
            label: values.find || 'Initial search',
            matchCase: values.matchCase,
            wholeWord: values.wholeWord,
            searchMode: values.searchMode,
            viewMode: 'tree',
          }
        }

        const level0 = newLevels[0]
        const updatedResultsByFile = { ...level0.resultsByFile }
        const expandedFiles = new Set(level0.expandedFiles)
        const expandedFolders = new Set(level0.expandedFolders)

        let changed = false
        let resultsChanged = false

        batch.forEach(([filePath, results]) => {
          if (results.length === 0) return

          // Deduplication Logic (Synced with setResultsByFile)
          const existingEvents = updatedResultsByFile[filePath] || []
          const seenSignatures = new Set<string>()
          existingEvents.forEach((event: SerializedTransformResultEvent) => {
            event.matches?.forEach((m: { start: number; end: number }) => {
              seenSignatures.add(`${m.start}-${m.end}`)
            })
          })

          const uniqueNewResults = results
            .map((event: SerializedTransformResultEvent) => {
              if (!event.matches) return event
              const uniqueMatches = event.matches.filter(
                (m: { start: number; end: number }) => {
                  const key = `${m.start}-${m.end}`
                  if (seenSignatures.has(key)) return false
                  seenSignatures.add(key)
                  return true
                }
              )
              return uniqueMatches.length > 0
                ? { ...event, matches: uniqueMatches }
                : null
            })
            .filter(Boolean) as SerializedTransformResultEvent[]

          if (uniqueNewResults.length === 0) return

          resultsChanged = true
          // Replace results (Live Update)
          updatedResultsByFile[filePath] = uniqueNewResults

          // Expansion Logic
          const totalMatches = updatedResultsByFile[filePath].reduce(
            (s: number, r: SerializedTransformResultEvent) =>
              s + (r.matches?.length || 0),
            0
          )

          if (totalMatches < 50) {
            if (!expandedFiles.has(filePath)) {
              expandedFiles.add(filePath)
              changed = true
            }
          } else {
            if (expandedFiles.has(filePath)) {
              expandedFiles.delete(filePath)
              changed = true
            }
          }

          if (workspacePath && filePath.startsWith(workspacePath)) {
            let rel = filePath.substring(workspacePath.length)
            if (rel.startsWith('/') || rel.startsWith('\\'))
              rel = rel.substring(1)
            rel = rel.replace(/\\/g, '/')
            const parts = rel.split('/')
            let currentPath = ''
            for (let i = 0; i < parts.length - 1; i++) {
              currentPath = currentPath
                ? `${currentPath}/${parts[i]}`
                : parts[i]
              if (!expandedFolders.has(currentPath)) {
                expandedFolders.add(currentPath)
                changed = true
              }
            }
          }
        })

        if (changed || resultsChanged) {
          console.log(
            `DEBUG: Search state updated. Matches added: ${resultsChanged}, Expansion changed: ${changed}`
          )
          newLevels[0] = {
            ...level0,
            resultsByFile: updatedResultsByFile,
            expandedFiles,
            expandedFolders,
          }
          return newLevels
        }
        return prev
      })
    }

    lastUpdateTimeRef.current = now

    if (remaining.length > 0) {
      setTimeout(flushPendingResults, 10)
    }
  }, [
    isInNestedSearch,
    values.searchInResults,
    values.find,
    values.matchCase,
    values.wholeWord,
    values.searchMode,
    values,
  ])

  // --- Message Handler ---
  const handleMessage = useCallback(
    (rawMessage: unknown) => {
      const validation = MessageToWebviewSchema.safeParse(rawMessage)
      if (!validation.success) {
        console.error('Invalid message received:', validation.error)
        return
      }
      const message = validation.data

      switch (message.type) {
        case 'initialData':
          setWorkspacePath(message.workspacePath)
          if (message.customFileOrder) {
            const keys = Object.keys(message.customFileOrder).sort(
              (a, b) => message.customFileOrder![a] - message.customFileOrder![b]
            )
            setCustomFileOrder(keys)
          }
          break
        case 'status':
          setStatus((prev) => ({ ...prev, ...message.status }))
          // If search is completed, clear stale results
          if (
            message.status.total !== undefined &&
            message.status.total > 0 &&
            message.status.completed === message.status.total
          ) {
            setStaleResultsByFile(null)
            setStaleStatus(null)
            setStaleLevel(null)
          }
          break
        case 'values':
          console.log('value handleMessages', message.values)
          setValues((prev) => ({ ...prev, ...message.values }))
          break

        // ... (inside handleMessage)

        case 'clearResults':
          console.log('DEBUG: FE clearResults received')
          // Save current results as stale before clearing
          if (Object.keys(resultsByFile).length > 0) {
            setStaleResultsByFile(resultsByFile)
            setStaleLevel(0)
          }

          setStaleStatus((prev) => {
            if (status.numMatches > 0) return status
            return prev
          })

          setStatus((prev) => ({
            ...prev,
            numMatches: 0,
            numFilesWithMatches: 0,
            numFilesWithErrors: 0,
            numFilesThatWillChange: 0,
            completed: 0,
            total: 0,
          }))

          if (isInNestedSearch) {
            // Save stale results for nested search before clearing
            const currentLevelIndex = values.searchInResults
            const currentLevelResults =
              searchLevelsRef.current[currentLevelIndex]?.resultsByFile
            if (
              currentLevelResults &&
              Object.keys(currentLevelResults).length > 0
            ) {
              setStaleResultsByFile(currentLevelResults)
              setStaleLevel(currentLevelIndex)
            }
          }

          setReplacementResult({
            totalReplacements: 0,
            totalFilesChanged: 0,
            show: false,
          })
          pendingResultsRef.current = {}
          setIsSearchRequested(false)
          if (throttleTimeoutRef.current) {
            clearTimeout(throttleTimeoutRef.current)
            throttleTimeoutRef.current = null
          }

          if (isInNestedSearch && values.searchInResults > 0) {
            setSearchLevels((prev) => {
              const newLevels = [...prev]
              if (newLevels[values.searchInResults]) {
                newLevels[values.searchInResults] = {
                  ...newLevels[values.searchInResults],
                  resultsByFile: {},
                }
              }
              return newLevels
            })
          } else {
            console.log('DEBUG: FE clearResults - Clearing resultsByFile')
            setResultsByFile({})
            // Sync searchLevels[0]
            setSearchLevels((prev) => {
              const newLevels = [...prev]
              if (newLevels.length > 0) {
                newLevels[0] = { ...newLevels[0], resultsByFile: {} }
              }
              return newLevels
            })
          }
          break

        case 'addBatchResults': {
          const messageNonce = message.nonce
          const currentNonce = valuesRef.current.searchNonce
          const batchSize = message.data.length
          console.log(`DEBUG: FE addBatchResults received. Size: ${batchSize}. Nonce: ${messageNonce} (Current: ${currentNonce})`)

          // NONCE VALIDATION: Ignore results from stale/outdated searches
          if (messageNonce && currentNonce && messageNonce !== currentNonce) {
            console.log(
              `WARNING: Stale results ignored! Message nonce: ${messageNonce}, Current nonce: ${currentNonce}`
            )
            break
          }

          const batchResults = message.data

          // Clear results if this is the first batch of a new search
          if (shouldClearResultsRef.current) {
            console.log('DEBUG: Clearing results (Ref Trigger)')
            shouldClearResultsRef.current = false
            setIsSearchRequested(false)

            // Set stale results here too if triggered by frontend logic
            // Determine Stale Results Snapshot
            if (isInNestedSearch) {
              const currentLevelIndex = values.searchInResults
              const currentLevelResults =
                searchLevelsRef.current[currentLevelIndex]?.resultsByFile

              if (
                currentLevelResults &&
                Object.keys(currentLevelResults).length > 0
              ) {
                setStaleResultsByFile(currentLevelResults)
                setStaleLevel(currentLevelIndex)
              }
            } else {
              if (Object.keys(resultsByFile).length > 0) {
                setStaleResultsByFile(resultsByFile)
                setStaleLevel(0)
              }
            }

            setStaleStatus((prev) => {
              if (status.numMatches > 0) return status
              return prev
            })

            // Clear Pending
            pendingResultsRef.current = {}

            if (isInNestedSearch) {
              // ... existing nested clear logic
              setSearchLevels((prev) => {
                const currentLevel = prev[values.searchInResults]
                if (!currentLevel) return prev
                const newLevels = [...prev]
                newLevels[values.searchInResults] = {
                  ...currentLevel,
                  resultsByFile: {},
                  expandedFiles: new Set(),
                  expandedFolders: new Set(),
                }
                return newLevels
              })
            } else {
              setResultsByFile({})
            }
          }

          // If we have new results, clear the stale results
          if (batchResults.length > 0) {
            setStaleResultsByFile(null)
            setStaleStatus(null)
            setStaleLevel(null)
          } else {
            console.log('DEBUG: Received EMPTY batch results')
          }

          // Debug Content
          if (batchResults.length > 0) {
            const firstMatch = batchResults[0]
            if (firstMatch && firstMatch.matches && firstMatch.matches.length > 0) {
              const firstSubMatch = firstMatch.matches[0]
              if (firstMatch.source) {
                const preview = firstMatch.source.substring(firstSubMatch.start, Math.min(firstSubMatch.end, firstSubMatch.start + 50)).replace(/\n/g, '\\n')
                console.log(`DEBUG: FE First Batch Match Content: "${preview}" (File: ${firstMatch.file})`)
              }
            }
          }

          // Append to pending
          batchResults.forEach((newResult: SerializedTransformResultEvent) => {
            const hasMatches = newResult.matches && newResult.matches.length > 0
            if (!hasMatches && !newResult.error) return

            if (!pendingResultsRef.current[newResult.file]) {
              pendingResultsRef.current[newResult.file] = []
            }
            pendingResultsRef.current[newResult.file].push(newResult)
          })

          flushPendingResults()
          break
        }

        case 'fileUpdated': {
          const { filePath, newSource } = message
          setResultsByFile((prev) => {
            if (!prev[filePath] || prev[filePath].length === 0) return prev
            const updatedResults = prev[filePath].map((result) => ({
              ...result,
              source: newSource,
            }))
            return { ...prev, [filePath]: updatedResults }
          })
          setSearchLevels((prev) => {
            if (prev.length === 0) return prev
            return prev.map((level) => {
              if (
                !level.resultsByFile[filePath] ||
                level.resultsByFile[filePath].length === 0
              ) {
                return level
              }
              const updatedResults = level.resultsByFile[filePath].map(
                (result: SerializedTransformResultEvent) => ({
                  ...result,
                  source: newSource,
                })
              )
              return {
                ...level,
                resultsByFile: {
                  ...level.resultsByFile,
                  [filePath]: updatedResults,
                },
              }
            })
          })
          break
        }
        case 'replacementComplete': {
          setResultsByFile({})
          setStatus((prev) => ({
            ...prev,
            numMatches: 0,
            numFilesWithMatches: 0,
            completed: 0,
            total: 0,
          }))
          pendingResultsRef.current = {}
          setReplacementResult({
            totalReplacements: message.totalReplacements,
            totalFilesChanged: message.totalFilesChanged,
            show: true,
          })
          break
        }
        case 'focusReplaceInput': {
          setSearchLevels((prev) => {
            const newLevels = [...prev]
            // Ensure root level exists and set isReplaceVisible to true
            if (newLevels.length > 0) {
              newLevels[0] = { ...newLevels[0], isReplaceVisible: true }
            }
            return newLevels
          })
          break
        }
      }
    },
    [
      flushPendingResults,
      isInNestedSearch,
      values.searchInResults,
      isSearchRequested,
    ]
  )

  // Clear stale results when switching levels to prevent ghosting
  useEffect(() => {
    setStaleResultsByFile({});
    setStaleLevel(null);
  }, [values.searchInResults]);

  // Sync resultsByFile with the current level's results from searchLevels
  // This ensures that when navigating back/forward, `resultsByFile` (active) matches the level storage.
  useEffect(() => {
    const currentLevelResults = searchLevels[values.searchInResults]?.resultsByFile || {};
    setResultsByFile(currentLevelResults);
  }, [values.searchInResults, searchLevels]);

  // Sync current values to the corresponding searchLevels entry
  // This ensures breadcrumb labels reflect what the user has typed
  useEffect(() => {
    setSearchLevels((prev) => {
      const index = values.searchInResults
      if (index < 0 || index >= prev.length) {
        return prev
      }
      const currentLevel = prev[index]
      if (!currentLevel) {
        return prev
      }

      // Only update if values have actually changed (avoid infinite loops)
      if (
        currentLevel.values?.find === values.find &&
        currentLevel.values?.matchCase === values.matchCase &&
        currentLevel.values?.wholeWord === values.wholeWord &&
        currentLevel.values?.searchMode === values.searchMode
      ) {
        return prev
      }

      const newLevels = [...prev]
      newLevels[index] = {
        ...currentLevel,
        values: {
          ...currentLevel.values,
          find: values.find,
          matchCase: values.matchCase,
          wholeWord: values.wholeWord,
          searchMode: values.searchMode,
        },
        label: values.find ? values.find : currentLevel.label,
      }

      return newLevels
    })
  }, [
    values.find,
    values.matchCase,
    values.wholeWord,
    values.searchMode,
    values.searchInResults,
  ])

  // --- Debounced Message Sender ---
  const debouncedPostMessage = useMemo(
    () =>
      debounce((msg: MessageFromWebview) => {
        console.log('DEBUG: debouncedPostMessage EXECUTING', msg.type)
        vscode.postMessage(msg)
      }, 50),
    [vscode]
  )

  // Separate debouncer to avoid clobbering 'values' messages with 'search' messages
  const debouncedTriggerSearch = useMemo(
    () =>
      debounce((msg: MessageFromWebview) => {
        console.log('DEBUG: debouncedTriggerSearch EXECUTING', msg.type, (msg as any).searchNonce)
        vscode.postMessage(msg)
      }, 300),
    [vscode]
  )

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      debouncedPostMessage.cancel()
      debouncedTriggerSearch.cancel()
    }
  }, [debouncedPostMessage, debouncedTriggerSearch])

  // Sync customFileOrder to backend
  const prevCustomOrderRef = useRef<Record<string, number>>({})
  useEffect(() => {
    console.log('[useSearchState] Sync Effect Running. CustomFileOrder Len:', customFileOrder.length)
    const customOrder: Record<string, number> = {}
    customFileOrder.forEach((path, index) => {
      customOrder[path] = index
    })

    const prevStr = JSON.stringify(prevCustomOrderRef.current)
    const currStr = JSON.stringify(customOrder)

    if (prevStr === currStr) {
      // console.log('[useSearchState] Sync Effect: No change detected. Skipping.')
      return
    }

    console.log(`[useSearchState] Sync Effect: Change detected! Prev: ${prevStr.substring(0, 50)}... Curr: ${currStr.substring(0, 50)}...`)

    prevCustomOrderRef.current = customOrder

    console.log('Sending updateFileOrder to backend:', customOrder)
    debouncedPostMessage({
      type: 'updateFileOrder',
      customOrder,
    })
  }, [customFileOrder, debouncedPostMessage])

  useEffect(() => {
    console.log('[useSearchState] MOUNTED')
    return () => console.log('[useSearchState] UNMOUNTED')
  }, [])

  const postValuesChange = useCallback(
    (changed: Partial<SearchReplaceViewValues>) => {
      console.log('=== postValuesChange called ===')
      console.log('changed:', JSON.stringify(changed))

      // Check if we should skip sending to backend (e.g., during navigation)
      // skipSearchUntilRef stores a timestamp - if current time is before it, skip
      const now = Date.now()
      const shouldSkipSearch = now < skipSearchUntilRef.current
      if (shouldSkipSearch) {
        console.log(
          'postValuesChange: within skip window, skipping backend message'
        )
      } else {
        // Mark validation as requested so we know to clear current results when new ones arrive
        setIsSearchRequested(true)
        shouldClearResultsRef.current = true
      }

      setValues((prev) => {
        const nonce =
          Date.now().toString() + Math.random().toString().slice(2, 5)
        const next = { ...prev, ...changed, searchNonce: nonce }

        // Update ref SYNCHRONOUSLY so callbacks always have latest values
        valuesRef.current = next

        console.log(
          'postValuesChange setValues: next.find:',
          next.find,
          'next.searchInResults:',
          next.searchInResults
        )

        // Only send to backend if not skipping
        if (!shouldSkipSearch) {
          // CRITICAL OPTIMIZATION:
          // If we are only navigating BACKWARDS (decreasing searchInResults), trust the cached state.
          // Even if 'find' is in the changed object (restoring old value), we DO NOT want to trigger a new search.
          const isBackNav = changed.searchInResults !== undefined &&
            changed.searchInResults < prev.searchInResults;

          if (!isBackNav) {
            console.log('DEBUG: Calling debouncedTriggerSearch', next.searchNonce)
            debouncedTriggerSearch({
              type: 'search',
              ...next,
              searchInResults: next.searchInResults,
            })
          } else {
            console.log('DEBUG: Calling debouncedPostMessage (values)', next.searchNonce)
            debouncedPostMessage({ type: 'values', values: next })
          }
        }



        return next
      })
    },
    [debouncedPostMessage]
  )

  return {
    values,
    setValues,
    postValuesChange,
    status,
    setStatus,
    workspacePath,
    setWorkspacePath,
    searchLevels,
    setSearchLevels,
    isInNestedSearch,
    valuesRef,
    viewMode,
    setViewMode,
    resultsByFile,
    setResultsByFile,
    staleResultsByFile,
    staleStatus,
    staleLevel,
    customFileOrder,
    setCustomFileOrder,
    vscode,
    replacementResult,
    setReplacementResult,
    isSearchRequested,
    setIsSearchRequested,
    handleMessage,
    skipSearchUntilRef,
  }
}
