import * as React from 'react'
import ReactDOM from 'react-dom/client'
import SearchReplaceViewController from './SearchReplaceViewController'

// Импортируем стили для иконок
import '@vscode/codicons/dist/codicon.css'
// Импортируем vscode-material-icons вместо file-icons-js
import { getIconForFilePath, getIconUrlForFilePath } from 'vscode-material-icons'

// Экспортируем иконки в глобальное пространство для использования в компонентах
// @ts-ignore
window.MaterialIcons = {
  getIconForFilePath,
  getIconUrlForFilePath
};

// Сообщаем о статусе загрузки в консоль для отладки
console.log('Material Icons library loaded successfully');

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
