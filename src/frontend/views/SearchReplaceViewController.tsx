import * as React from 'react'
import {
  MessageFromWebview,
  MessageToWebview,
  SerializedTransformResultEvent,
  SearchReplaceViewStatus,
  SearchReplaceViewValues,
} from '../../model/SearchReplaceViewTypes'
import useEventListener from '../core/useEventListener'
import SearchReplaceViewLayout from './SearchReplaceViewLayout'

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
  // Send mount message and setup hotkeys
  React.useEffect(() => {
    vscode.postMessage({
      type: 'mount',
    })

    const handleKeyDown = (event: KeyboardEvent) => {
      const isCmdOrCtrl = event.metaKey || event.ctrlKey
      const isShift = event.shiftKey
      if (isCmdOrCtrl && isShift) {
        switch (event.key.toLowerCase()) {
          case 'c': {
            // Get file order for proper copy ordering
            const getDisplayedFileOrder = (window as any).getDisplayedFileOrder;
            const fileOrder = getDisplayedFileOrder ? getDisplayedFileOrder() : undefined;
            vscode.postMessage({ type: 'copyMatches', fileOrder })
            event.preventDefault()
            break
          }
          case 'x': {
            // Get file order for proper cut ordering
            const getDisplayedFileOrder = (window as any).getDisplayedFileOrder;
            const fileOrder = getDisplayedFileOrder ? getDisplayedFileOrder() : undefined;
            vscode.postMessage({ type: 'cutMatches', fileOrder })
            event.preventDefault()
            break
          }
          case 'v': {
            // Get file order for proper paste ordering
            const getDisplayedFileOrder = (window as any).getDisplayedFileOrder;
            const fileOrder = getDisplayedFileOrder ? getDisplayedFileOrder() : undefined;
            vscode.postMessage({ type: 'pasteToMatches', fileOrder })
            event.preventDefault()
            break
          }
          case 'n':
            vscode.postMessage({ type: 'copyFileNames' })
            event.preventDefault()
            break
          case 'z':
            vscode.postMessage({ type: 'undoLastOperation' })
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

  // Handle messages from Webview
  useEventListener(window, 'message', (message: any) => {
    if (!message.data) return
    const data: MessageToWebview = message.data
    switch (data.type) {
      case 'focusSearchInput':
        try {
          // First check if nested search exists
          // DOM structure changes depending on nested search presence
          const isInNestedSearch = document.querySelector('.search-level-breadcrumbs')

          let searchInput: HTMLTextAreaElement | null = null

          if (isInNestedSearch) {
            // If in nested search, look for nested search input
            searchInput = document.querySelector('textarea[name="nestedSearch"]') as HTMLTextAreaElement
          } else {
            // Otherwise look for main search input
            searchInput = document.querySelector('textarea[name="search"]') as HTMLTextAreaElement

          }

          // If input found, focus it
          if (searchInput) {
            searchInput.select()
          }
        } catch (e) {
          vscode.postMessage({ type: 'log', level: 'error', message: `Error focusing search input: ${e}` })
        }
        break
      case 'focusReplaceInput':
        setTimeout(() => {
          try {
            // Check for nested search
            const isInNestedSearch = document.querySelector('.search-level-breadcrumbs')

            let replaceInput: HTMLTextAreaElement | null = null

            if (isInNestedSearch) {
              // If in nested search, look for nested replace input
              replaceInput = document.querySelector('textarea[name="nestedReplace"]') as HTMLTextAreaElement
            } else {
              // Otherwise look for main replace input
              replaceInput = document.querySelector('textarea[name="replace"]') as HTMLTextAreaElement
            }

            // If input found, focus it
            if (replaceInput) {
              replaceInput.focus()
              vscode.postMessage({
                type: 'log',
                level: 'info',
                message: `Successfully focused on replace input: ${isInNestedSearch ? 'nested' : 'main'}`
              })
            } else {
              vscode.postMessage({
                type: 'log',
                level: 'error',
                message: 'Could not find any replace input field'
              })
            }
          } catch (e) {
            vscode.postMessage({ type: 'log', level: 'error', message: `Error focusing replace input: ${e}` })
          }
        }, 50) // Increase delay for more reliable operation
        break
    }
  })


  return (
    <SearchReplaceViewLayout
      // @ts-ignore TS2349: Ignoring potential incorrect type usage for SearchReplaceWebviewApi
      vscode={vscode}
    />
  )
}
