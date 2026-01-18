import * as vscode from 'vscode'
import { TransformResultEvent } from '../searchController/SearchRunner'
import {
  MD_SEARCH_REPORTS_SCHEME,
  MD_SEARCH_RESULT_SCHEME,
} from '../../constants'
import { IMdSearchExtension } from '../types'

export default class TransformResultProvider
  implements vscode.TextDocumentContentProvider, vscode.FileDecorationProvider
{
  results: Map<string, TransformResultEvent> = new Map()

  constructor(private extension: IMdSearchExtension) {
    const { runner } = extension
    runner.on('stop', () => {
      const uris = [...this.results.keys()].flatMap((raw) => [
        vscode.Uri.parse(raw).with({ scheme: MD_SEARCH_RESULT_SCHEME }),
        vscode.Uri.parse(raw).with({ scheme: MD_SEARCH_REPORTS_SCHEME }),
      ])
      this.results.clear()
      this._onDidChangeFileDecorations.fire(uris)
      for (const uri of uris) this._onDidChange.fire(uri)
    })
    runner.on('abort', () => {
      this.results.clear()
    })
    runner.on('result', (event: TransformResultEvent) => {
      const { file } = event
      const uri = file.with({ scheme: 'file' })
      if (
        event.matches?.length ||
        event.reports?.length ||
        event.error ||
        (event.transformed && event.transformed !== event.source)
      ) {
        this.results.set(uri.toString(), event)
      } else {
        if (!this.results.has(uri.toString())) {
          return
        }
        this.results.delete(uri.toString())
      }
      const uris = [
        event.file.with({ scheme: MD_SEARCH_RESULT_SCHEME }),
        event.file.with({ scheme: MD_SEARCH_REPORTS_SCHEME }),
      ]
      for (const uri of uris) this._onDidChange.fire(uri)
      this._onDidChangeFileDecorations.fire(uris)
    })
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const result = this.results.get(uri.with({ scheme: 'file' }).toString())
    switch (uri.scheme) {
      case MD_SEARCH_RESULT_SCHEME: {
        const transformed = result?.transformed
        if (transformed) return transformed
        const error = result?.error

        if (error) {
          return error.stack || error.message || String(error)
        }
        break
      }
      case MD_SEARCH_REPORTS_SCHEME: {
        return (result?.reports || [])
          ?.map((report) => `Report type: ${typeof report}`)
          .join('\n')
      }
    }
    return ''
  }

  private _onDidChange: vscode.EventEmitter<vscode.Uri> =
    new vscode.EventEmitter<vscode.Uri>()

  readonly onDidChange = this._onDidChange.event

  private _onDidChangeFileDecorations: vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  > = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>()

  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event

  provideFileDecoration(
    uri: vscode.Uri
  ): vscode.ProviderResult<vscode.FileDecoration> {
    const error = this.results.get(
      uri.with({ scheme: 'file' }).toString()
    )?.error
    if (error) {
      return new vscode.FileDecoration(
        '!',
        undefined,
        new vscode.ThemeColor('list.errorForeground')
      )
    }
    return new vscode.FileDecoration()
  }

  // Method for clearing all results and notifying of changes
  clear(): void {
    const uris = [...this.results.keys()].flatMap((raw) => [
      vscode.Uri.parse(raw).with({ scheme: MD_SEARCH_RESULT_SCHEME }),
      vscode.Uri.parse(raw).with({ scheme: MD_SEARCH_REPORTS_SCHEME }),
    ])
    this.results.clear()
    this._onDidChangeFileDecorations.fire(uris)
    for (const uri of uris) this._onDidChange.fire(uri)
  }
}
