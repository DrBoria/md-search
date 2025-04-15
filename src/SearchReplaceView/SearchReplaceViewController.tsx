import * as React from 'react'
import {
  MessageFromWebview,
  MessageToWebview,
  SerializedTransformResultEvent,
  SearchReplaceViewStatus,
  SearchReplaceViewValues,
} from './SearchReplaceViewTypes'
import useEventListener from '../react/useEventListener'
import SearchReplaceView from './SearchReplaceView'

type SearchReplaceWebviewState = unknown

export interface SearchReplaceWebviewApi {
  /**
   * Post a message to the owner of the webview.
   *
   * @param message Data to post. Must be JSON serializable.
   */
  postMessage(message: MessageFromWebview): void

  /**
   * Get the persistent state stored for this webview.
   *
   * @return The current state or `undefined` if no state has been set.
   */
  getState(): SearchReplaceWebviewState

  /**
   * Set the persistent state stored for this webview.
   *
   * @param newState New persisted state. This must be a JSON serializable object. Can be retrieved
   * using {@link getState}.
   *
   * @return The new state.
   */
  setState<T extends SearchReplaceWebviewState | undefined>(newState: T): T
}

export interface Props {
  vscode: SearchReplaceWebviewApi
}

export default function SearchReplaceViewController({
  vscode,
}: Props): React.ReactElement {
  React.useEffect(() => {
    vscode.postMessage({
      type: 'mount',
    })
  }, [])

  const [status, setStatus] = React.useState<SearchReplaceViewStatus>({
    running: false,
    completed: 0,
    total: 0,
    numMatches: 0,
    numFilesThatWillChange: 0,
    numFilesWithMatches: 0,
    numFilesWithErrors: 0,
  })

  // @ts-ignore TS2345: Ignoring missing properties in initial state
  const [values, setValues] = React.useState<SearchReplaceViewValues>({
    find: '',
    replace: '',
    include: '',
    exclude: '',
  })

  const [results, setResults] = React.useState<SerializedTransformResultEvent[]>([])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useEventListener(window, 'message', (message: any) => {
    if (!message.data) return
    const data: MessageToWebview = message.data
    switch (data.type) {
      case 'status':
        setStatus((s) => ({ ...s, ...data.status }))
        break
      case 'values':
        setValues((v) => ({ ...v, ...data.values }))
        break
      case 'addResult':
        // Send received data to extension host for logging in Output Channel
        try {
          vscode.postMessage({ 
              type: 'log', 
              level: 'info', 
              message: 'Received addResult data:', 
              // Only send key info to avoid large objects/circular refs
              data: { 
                  file: data.data.file, 
                  matchesCount: data.data.matches?.length ?? 0, 
                  hasError: data.data.error != null 
              } 
          });
        } catch (e) {
            // Handle potential errors during message creation/posting
            vscode.postMessage({ type: 'log', level: 'error', message: 'Error trying to log received data' });
        }
        setResults((prevResults) => [...prevResults, data.data])
        break
      case 'clearResults':
        setResults([])
        break
    }
  })

  const handleValuesChange = React.useCallback(
    (updates: Partial<SearchReplaceViewValues>) => {
      setValues((prev: SearchReplaceViewValues): SearchReplaceViewValues => {
        const values: SearchReplaceViewValues = { ...prev, ...updates }
        vscode.postMessage({
          type: 'values',
          values,
        })
        return values
      })
    },
    []
  )

  const handleReplaceAllClick = React.useCallback(() => {
    vscode.postMessage({
      type: 'replace',
    })
  }, [])

  return (
    <SearchReplaceView
      status={status}
      values={values}
      results={results}
      onValuesChange={handleValuesChange}
      onReplaceAllClick={handleReplaceAllClick}
      // @ts-ignore TS2349: Ignoring potential incorrect type usage for SearchReplaceWebviewApi
      vscode={vscode}
    />
  )
}
