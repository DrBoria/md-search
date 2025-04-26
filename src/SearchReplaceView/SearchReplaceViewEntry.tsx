import * as React from 'react'
import ReactDOM from 'react-dom/client'
import SearchReplaceViewController from './SearchReplaceViewController'

// Import icon styles
import '@vscode/codicons/dist/codicon.css'
// Import vscode-material-icons instead of file-icons-js
import { getIconForFilePath, getIconUrlForFilePath } from 'vscode-material-icons'

// Create wrapper for type compatibility
const getIconUrlWrapper = (filePath: string, iconsBasePath?: string): string => {
  return getIconUrlForFilePath(filePath, iconsBasePath || '/material-icons');
};

// Export icons to global space for use in components
// @ts-ignore
window.MaterialIcons = {
  getIconForFilePath,
  getIconUrlForFilePath: getIconUrlWrapper
};

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
