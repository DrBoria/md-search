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
  // Send mount message
  React.useEffect(() => {
    vscode.postMessage({
      type: 'mount',
    })
  }, [])

  // Handle messages from Webview
  useEventListener(window, 'message', (message: any) => {
    if (!message.data) return
    const data: MessageToWebview = message.data
    switch (data.type) {
      case 'focusSearchInput':
        try {
          const isInNestedSearch = document.querySelector('.search-level-breadcrumbs')
          let searchInput: HTMLTextAreaElement | null = null

          if (isInNestedSearch) {
            searchInput = document.querySelector('textarea[name="nestedSearch"]') as HTMLTextAreaElement
          } else {
            searchInput = document.querySelector('textarea[name="search"]') as HTMLTextAreaElement
          }

          if (searchInput) {
            const msgData = data as { selectedText?: string; triggerSearch?: boolean }
            if (msgData.selectedText) {
              searchInput.value = msgData.selectedText
              searchInput.dispatchEvent(new Event('input', { bubbles: true }))
            }
            searchInput.select()

            if (msgData.triggerSearch && msgData.selectedText) {
              const selectedTextToSearch = msgData.selectedText
              setTimeout(() => {
                vscode.postMessage({
                  type: 'search',
                  find: selectedTextToSearch,
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
                  searchInResults: 0,
                })
              }, 100)
            }
          }
        } catch (e) {
          vscode.postMessage({ type: 'log', level: 'error', message: `Error focusing search input: ${e}` })
        }
        break
      case 'focusReplaceInput':
        setTimeout(() => {
          try {
            const isInNestedSearch = document.querySelector('.search-level-breadcrumbs')

            let searchInput: HTMLTextAreaElement | null = null
            let replaceInput: HTMLTextAreaElement | null = null

            if (isInNestedSearch) {
              searchInput = document.querySelector('textarea[name="nestedSearch"]') as HTMLTextAreaElement
              replaceInput = document.querySelector('textarea[name="nestedReplace"]') as HTMLTextAreaElement
            } else {
              searchInput = document.querySelector('textarea[name="search"]') as HTMLTextAreaElement
              replaceInput = document.querySelector('textarea[name="replace"]') as HTMLTextAreaElement
            }

            const selectedText = (data as { selectedText?: string }).selectedText
            if (selectedText && searchInput) {
              searchInput.value = selectedText
              searchInput.dispatchEvent(new Event('input', { bubbles: true }))
            }

            if (replaceInput) {
              replaceInput.focus()
            }
          } catch (e) {
            vscode.postMessage({ type: 'log', level: 'error', message: `Error focusing replace input: ${e}` })
          }
        }, 50)
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
