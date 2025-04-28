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

type SearchReplaceWebviewState = {
  status: SearchReplaceViewStatus
  values: SearchReplaceViewValues
  results: SerializedTransformResultEvent[]
}

export interface SearchReplaceWebviewApi {
  postMessage(message: MessageFromWebview): void
  getState(): SearchReplaceWebviewState | undefined
  setState<T extends SearchReplaceWebviewState | undefined>(newState: T): T
}

export interface Props {
  vscode: SearchReplaceWebviewApi
}

export default function SearchReplaceViewController({ vscode }: Props): React.ReactElement {
  // Отправка сообщения о монтировании и настройка горячих клавиш
  React.useEffect(() => {
    vscode.postMessage({
      type: 'mount',
    })

    const handleKeyDown = (event: KeyboardEvent) => {
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

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  // Обработка сообщений от Webview
  useEventListener(window, 'message', (message: any) => {
    if (!message.data) return
    const data: MessageToWebview = message.data
    switch (data.type) {
      case 'focusSearchInput':
        setTimeout(() => {
          try {
            const searchInput = document.querySelector('input[placeholder*="Find"]') as HTMLInputElement
            if (searchInput) searchInput.focus()
          } catch (e) {
            vscode.postMessage({ type: 'log', level: 'error', message: `Error focusing search input: ${e}` })
          }
        }, 100)
        break
      case 'focusReplaceInput':
        setTimeout(() => {
          try {
            const replaceInput = document.querySelector('input[placeholder*="Replace"]') as HTMLInputElement
            if (replaceInput) replaceInput.focus()
          } catch (e) {
            vscode.postMessage({ type: 'log', level: 'error', message: `Error focusing replace input: ${e}` })
          }
        }, 100)
        break
    }
  })


  return (
    <SearchReplaceView
      // @ts-ignore TS2349: Ignoring potential incorrect type usage for SearchReplaceWebviewApi
      vscode={vscode}
    />
  )
}
