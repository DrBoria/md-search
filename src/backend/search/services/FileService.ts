import * as vscode from 'vscode'
import * as fs from 'fs'
import * as util from 'util'

const readFileAsync = util.promisify(fs.readFile)

export class FileService {
  async readFile(pathOrUri: string | vscode.Uri): Promise<string> {
    let filePath: string
    if (typeof pathOrUri === 'string') {
      filePath = pathOrUri
      if (filePath.startsWith('file://')) {
        filePath = vscode.Uri.parse(filePath).fsPath
      }
    } else {
      filePath = pathOrUri.fsPath
    }

    // Use fs.readFile for performance on local files
    const buffer = await readFileAsync(filePath)
    // Detect encoding if possible, but default to utf-8 for now
    // In a real generic extension, we might use jschardet or similar
    return buffer.toString('utf-8')
  }

  async findFiles(include: string, exclude: string): Promise<vscode.Uri[]> {
    // console.log(
    //   `[FileService] findFiles: include=${include}, exclude=${exclude}`
    // )
    try {
      // Basic VS Code findFiles
      return await vscode.workspace.findFiles(include, exclude)
    } catch (error) {
      // console.error('[FileService] findFiles error:', error)
      return []
    }
  }
}
