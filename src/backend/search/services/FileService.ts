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
      const uris = await vscode.workspace.findFiles(include, exclude)
      return uris.filter((uri) => {
        const ext = uri.path.split('.').pop()?.toLowerCase()
        if (
          ext &&
          [
            'png',
            'jpg',
            'jpeg',
            'gif',
            'bmp',
            'ico',
            'webp',
            'tiff',
            'mp4',
            'mov',
            'avi',
            'mkv',
            'webm',
            'mp3',
            'wav',
            'ogg',
            'flac',
            'zip',
            'tar',
            'gz',
            '7z',
            'rar',
            'exe',
            'dll',
            'so',
            'dylib',
            'bin',
            'obj',
            'class',
            'jar',
            'pdf',
            'doc',
            'docx',
            'xls',
            'xlsx',
            'ppt',
            'pptx',
          ].includes(ext)
        ) {
          return false
        }
        return true
      })
    } catch (error) {
      // console.error('[FileService] findFiles error:', error)
      return []
    }
  }
}
