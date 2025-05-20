import * as React from 'react'
import {
  MessageFromWebview,
  MessageToWebview,
  SerializedTransformResultEvent,
  SearchReplaceViewStatus,
  SearchReplaceViewValues,
} from './SearchReplaceViewTypes'
import useEventListener from '../react/useEventListener'
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
        try {
          // Сначала проверяем, есть ли вложенный поиск
          // В зависимости от наличия вложенного поиска меняется DOM-структура
          const isInNestedSearch = document.querySelector('.search-level-breadcrumbs')
          
          let searchInput: HTMLTextAreaElement | null = null
          
          if (isInNestedSearch) {
            // Если мы во вложенном поиске, ищем поле ввода вложенного поиска
            searchInput = document.querySelector('textarea[name="nestedSearch"]') as HTMLTextAreaElement
          } else {
            // Иначе ищем основное поле поиска
            searchInput = document.querySelector('textarea[name="search"]') as HTMLTextAreaElement
        
          }
          
          // Если нашли поле, фокусируем его
          if (searchInput) {
            searchInput.focus()
          }
        } catch (e) {
          vscode.postMessage({ type: 'log', level: 'error', message: `Error focusing search input: ${e}` })
        }
        break
      case 'focusReplaceInput':
        setTimeout(() => {
          try {
            // Проверяем наличие вложенного поиска
            const isInNestedSearch = document.querySelector('.search-level-breadcrumbs')
            
            let replaceInput: HTMLTextAreaElement | null = null
            
            if (isInNestedSearch) {
              // Если мы во вложенном поиске, ищем поле замены вложенного поиска
              replaceInput = document.querySelector('textarea[name="nestedReplace"]') as HTMLTextAreaElement
            } else {
              // Иначе ищем основное поле замены
              replaceInput = document.querySelector('textarea[name="replace"]') as HTMLTextAreaElement
            }
            
            // Если нашли поле, фокусируем его
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
        }, 50) // Увеличиваем задержку для более надежной работы
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
