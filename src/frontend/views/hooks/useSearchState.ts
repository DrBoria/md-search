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
  const [viewMode, setViewMode] = useState<'list' | 'tree'>('tree')

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

  const isInNestedSearch = searchLevels.length > 1

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

          if (updatedResultsByFile[filePath]) {
            updatedResultsByFile[filePath] = [
              ...updatedResultsByFile[filePath],
              ...uniqueNewResults,
            ]
          } else {
            updatedResultsByFile[filePath] = [...uniqueNewResults]
          }

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

          if (newResults[filePath]) {
            newResults[filePath] = [
              ...newResults[filePath],
              ...uniqueNewResults,
            ]
          } else {
            newResults[filePath] = [...uniqueNewResults]
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
          if (updatedResultsByFile[filePath]) {
            updatedResultsByFile[filePath] = [
              ...updatedResultsByFile[filePath],
              ...uniqueNewResults,
            ]
          } else {
            updatedResultsByFile[filePath] = [...uniqueNewResults]
          }

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
          break
        case 'status':
          setStatus((prev) => ({ ...prev, ...message.status }))
          break
        case 'values':
          console.log('value handleMessages', message.values)
          setValues((prev) => ({ ...prev, ...message.values }))
          break
        case 'clearResults':
          setStatus((prev) => ({
            ...prev,
            numMatches: 0,
            numFilesWithMatches: 0,
            numFilesWithErrors: 0,
            numFilesThatWillChange: 0,
            completed: 0,
            total: 0,
          }))

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
            setResultsByFile({})
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
          console.log('DEBUG: addBatchResults', JSON.stringify(message))
          if (message.data && message.data.length > 0) {
            console.log(
              'DEBUG: First item matches:',
              JSON.stringify(message.data[0].matches)
            )
          }

          const batchResults = message.data

          // Clear results if this is the first batch of a new search
          if (shouldClearResultsRef.current) {
            console.log('DEBUG: Clearing results (Ref Trigger)')
            shouldClearResultsRef.current = false
            setIsSearchRequested(false)

            // Clear Pending
            pendingResultsRef.current = {}

            if (isInNestedSearch) {
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

          // Append to pending (removed the old inside-clearing logic)
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
      }
    },
    [
      flushPendingResults,
      isInNestedSearch,
      values.searchInResults,
      isSearchRequested,
    ]
  )

  // Sync current values to the corresponding searchLevels entry
  // This ensures breadcrumb labels reflect what the user has typed
  useEffect(() => {
    console.log('=== useEffect SYNC triggered ===')
    console.log(
      'values.find:',
      values.find,
      'values.searchInResults:',
      values.searchInResults
    )

    setSearchLevels((prev) => {
      const index = values.searchInResults
      if (index < 0 || index >= prev.length) {
        console.log('useEffect SYNC: index out of bounds, skipping')
        return prev
      }
      const currentLevel = prev[index]
      if (!currentLevel) {
        console.log('useEffect SYNC: currentLevel is null, skipping')
        return prev
      }

      // Only update if values have actually changed (avoid infinite loops)
      if (
        currentLevel.values?.find === values.find &&
        currentLevel.values?.matchCase === values.matchCase &&
        currentLevel.values?.wholeWord === values.wholeWord &&
        currentLevel.values?.searchMode === values.searchMode
      ) {
        console.log('useEffect SYNC: values unchanged, skipping')
        return prev
      }

      console.log('useEffect SYNC: Updating level', index)
      console.log(
        '  Old find:',
        currentLevel.values?.find,
        'Old label:',
        currentLevel.label
      )
      console.log('  New find:', values.find)

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

      console.log('  Result label:', newLevels[index].label)
      console.log(
        '  All levels after sync:',
        JSON.stringify(
          newLevels.map((l) => ({ find: l.values?.find, label: l.label }))
        )
      )

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
        vscode.postMessage(msg)
      }, 50), // Reduced to 50ms
    [vscode]
  )

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      debouncedPostMessage.cancel()
    }
  }, [debouncedPostMessage])

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
          debouncedPostMessage({ type: 'values', values: next })
        }

        // Sync find value to searchLevels for breadcrumb labels
        if ('find' in changed) {
          console.log(
            'postValuesChange: find is in changed, triggering setSearchLevels sync'
          )
          setSearchLevels((levels) => {
            const index = next.searchInResults
            console.log(
              'postValuesChange setSearchLevels: index:',
              index,
              'levels.length:',
              levels.length
            )

            if (index < 0 || index >= levels.length) {
              console.log(
                'postValuesChange setSearchLevels: index out of bounds, skipping'
              )
              return levels
            }

            console.log(
              'postValuesChange setSearchLevels: Updating level',
              index
            )
            console.log(
              '  Old find:',
              levels[index].values?.find,
              'Old label:',
              levels[index].label
            )
            console.log('  New find:', next.find)

            const newLevels = [...levels]
            newLevels[index] = {
              ...newLevels[index],
              values: { ...newLevels[index].values, find: next.find },
              label: next.find ? next.find : newLevels[index].label,
            }

            console.log('  Result label:', newLevels[index].label)
            console.log(
              '  All levels after postValuesChange sync:',
              JSON.stringify(
                newLevels.map((l) => ({ find: l.values?.find, label: l.label }))
              )
            )

            return newLevels
          })
        }

        return next
      })
    },
    [debouncedPostMessage, setSearchLevels]
  )

  return {
    values,
    setValues,
    status,
    setStatus,
    resultsByFile,
    setResultsByFile,
    workspacePath,
    setWorkspacePath,
    isSearchRequested,
    setIsSearchRequested,
    replacementResult,
    setReplacementResult,
    searchLevels,
    setSearchLevels,
    handleMessage,
    postValuesChange,
    isInNestedSearch,
    viewMode,
    setViewMode,
    valuesRef,
    skipSearchUntilRef,
  }
}
