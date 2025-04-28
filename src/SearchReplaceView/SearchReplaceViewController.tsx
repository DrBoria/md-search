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

    // Добавляем обработчики горячих клавиш
    const handleKeyDown = (event: KeyboardEvent) => {
      // Проверяем сочетания клавиш
      const isCmdOrCtrl = event.metaKey || event.ctrlKey
      const isShift = event.shiftKey
      
      if (isCmdOrCtrl && isShift) {
        switch (event.key.toLowerCase()) {
          case 'c':
            vscode.postMessage({ type: 'copyMatches' })
            event.preventDefault()
            break
          case 'x':
            vscode.postMessage({ type: 'cutMatches' })
            event.preventDefault()
            break
          case 'v':
            vscode.postMessage({ type: 'pasteToMatches' })
            event.preventDefault()
            break
        }
      }
    }

    // Добавляем обработчик
    window.addEventListener('keydown', handleKeyDown)

    // Удаляем обработчик при размонтировании компонента
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
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
      // case 'status':
      //   setStatus((s) => ({ ...s, ...data.status }))
      //   break
      // case 'values':
      //   setValues((v) => ({ ...v, ...data.values }))
      //   break
      // case 'clearResults':
      //   setResults([])
      //   break
      case 'focusSearchInput':
        // Add a setTimeout to ensure the DOM is ready
        setTimeout(() => {
          try {
            const searchInput = document.querySelector('input[placeholder*="Find"]') as HTMLInputElement
            if (searchInput) {
              searchInput.focus()
            } 
          } catch (e) {
            vscode.postMessage({ type: 'log', level: 'error', message: `Error focusing search input: ${e}` })
          }
        }, 100)
        break
      case 'focusReplaceInput':
        // Add a setTimeout to ensure the DOM is ready
        setTimeout(() => {
          try {
            const replaceInput = document.querySelector('input[placeholder*="Replace"]') as HTMLInputElement
            if (replaceInput) {
              replaceInput.focus()
              vscode.postMessage({ type: 'log', level: 'info', message: 'Focused replace input' })
            } else {
              vscode.postMessage({ type: 'log', level: 'warn', message: 'Replace input not found' })
            }
          } catch (e) {
            vscode.postMessage({ type: 'log', level: 'error', message: `Error focusing replace input: ${e}` })
          }
        }, 100)
        break
      case 'copyMatchesComplete':
        vscode.postMessage({ 
          type: 'log', 
          level: 'info', 
          message: `Copied ${data.count} matches to buffer` 
        })
        // Можно добавить всплывающее уведомление или обновить UI при необходимости
        break
      case 'cutMatchesComplete':
        vscode.postMessage({ 
          type: 'log', 
          level: 'info', 
          message: `Cut ${data.count} matches to buffer` 
        })
        // Очищаем результаты, так как текст был вырезан
        setResults([])
        break
      case 'pasteToMatchesComplete':
        vscode.postMessage({ 
          type: 'log', 
          level: 'info', 
          message: `Pasted to ${data.count} matches` 
        })
        // Можно добавить всплывающее уведомление или обновить UI при необходимости
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
