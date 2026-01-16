import * as vscode from 'vscode'
import { TextDecoder } from 'util'

/**
 * Utilities for file system operations.
 */
export class FileUtils {
  /**
   * Reads a file and returns its content as string.
   * Tries to use opened document first, then falls back to file system.
   */
  static async readFile(
    uri: vscode.Uri,
    openDocs: Map<string, vscode.TextDocument>
  ): Promise<string> {
    const filePath = uri.fsPath

    // Check cache/map
    if (openDocs.has(filePath)) {
      return openDocs.get(filePath)!.getText()
    }

    // Check VS Code opened documents
    const openDoc = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath === filePath
    )
    if (openDoc) {
      openDocs.set(filePath, openDoc)
      return openDoc.getText()
    }

    // Read from disk
    try {
      const bytes = await vscode.workspace.fs.readFile(uri)
      return new TextDecoder('utf-8').decode(bytes)
    } catch (error) {
      throw new Error(`Failed to read ${filePath}: ${error}`)
    }
  }

  /**
   * Checks if a file exists.
   */
  static async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri)
      return true
    } catch {
      return false
    }
  }
}
