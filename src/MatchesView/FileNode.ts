import { IpcMatch } from '../backend/types'
import { Uri, TreeItem, TreeItemCollapsibleState } from 'vscode'
import * as vscode from 'vscode'
import { TreeNode } from './TreeNode'
import MatchNode from './MatchNode'
import path from 'path'
import lodash from 'lodash'
const { once } = lodash
import LeafTreeItemNode from './LeafTreeItemNode'
import { MD_SEARCH_REPORTS_SCHEME, MD_SEARCH_RESULT_SCHEME } from '../constants'

export type FileNodeProps = {
  file: Uri
  source: string
  transformed?: string
  reports?: readonly unknown[]
  matches: readonly IpcMatch[]
  error?: Error
}

export default class FileNode extends TreeNode<FileNodeProps> {
  get errorMessage(): string | null {
    const { error } = this.props
    if (!error) return null
    return error.stack || error.message || String(error)
  }
  getTreeItem(): TreeItem {
    const { file, transformed, reports, matches } = this.props
    const item = new TreeItem(
      file.with({ scheme: MD_SEARCH_RESULT_SCHEME }),
      matches.length || reports?.length
        ? TreeItemCollapsibleState.Expanded
        : TreeItemCollapsibleState.None
    )
    const dirname = path.dirname(vscode.workspace.asRelativePath(file))
    if (dirname !== '.') item.description = dirname

    const { errorMessage } = this
    if (errorMessage) {
      item.tooltip = errorMessage
      item.command = {
        title: 'view error',
        command: 'vscode.open',
        arguments: [file.with({ scheme: MD_SEARCH_RESULT_SCHEME })],
      }
    } else {
      const { startLine, startColumn } = matches[0]?.loc?.start
        ? {
            startLine: matches[0].loc.start.line,
            startColumn: matches[0].loc.start.column,
          }
        : { startLine: undefined, startColumn: undefined }
      item.command = {
        title: transformed ? 'open diff' : 'open file',
        command: transformed ? 'vscode.diff' : 'vscode.open',
        arguments: [
          file,
          ...(transformed
            ? [
                file.with({ scheme: MD_SEARCH_RESULT_SCHEME }),
                path.basename(file.path),
              ]
            : []),
          ...(startLine != null && startColumn != null
            ? [
                {
                  selection: new vscode.Range(
                    startLine - 1,
                    startColumn,
                    startLine - 1,
                    startColumn
                  ),
                },
              ]
            : []),
        ],
      }
    }
    return item
  }
  getChildren: () => TreeNode[] = once((): TreeNode[] => {
    const {
      errorMessage,
      props: { file, matches, reports },
    } = this
    if (errorMessage) {
      const message = errorMessage.split(/\r\n?|\n/gm)
      return message.map(
        (line) => new LeafTreeItemNode({ item: new TreeItem(line) })
      )
    }
    let reportsItem: TreeItem | undefined
    if (reports?.length) {
      reportsItem = new TreeItem('Reports')
      reportsItem.command = {
        title: 'open reports',
        command: 'vscode.open',
        arguments: [file.with({ scheme: MD_SEARCH_REPORTS_SCHEME })],
      }
    }
    return [
      ...(reportsItem ? [new LeafTreeItemNode({ item: reportsItem })] : []),
      ...matches.map(
        (match) =>
          new MatchNode(
            {
              match,
            },
            this
          )
      ),
    ]
  })
}
