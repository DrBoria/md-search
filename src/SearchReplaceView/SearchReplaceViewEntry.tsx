import * as React from 'react'
import ReactDOM from 'react-dom/client'
import SearchReplaceViewController from './SearchReplaceViewController'

// Импортируем стили для иконок
import '@vscode/codicons/dist/codicon.css'

const vscode = acquireVsCodeApi()

const el = document.createElement('div')
document.body.appendChild(el)

const root = ReactDOM.createRoot(el)
root.render(<SearchReplaceViewController vscode={vscode} />)

if (module.hot) {
  module.hot.accept('./SearchReplaceViewController', () => {
    root.render(<SearchReplaceViewController vscode={vscode} />)
  })
}
