import * as vscode from 'vscode'
import * as fs from 'fs'
import * as util from 'util'

const readFileAsync = util.promisify(fs.readFile)

export class FileService {
  async readFile(
    pathOrUri: string | vscode.Uri,
    options?: { ignoreSizeLimit?: boolean }
  ): Promise<string> {
    let filePath: string
    if (typeof pathOrUri === 'string') {
      filePath = pathOrUri
      if (filePath.startsWith('file://')) {
        filePath = vscode.Uri.parse(filePath).fsPath
      }
    } else {
      filePath = pathOrUri.fsPath
    }

    // 1MB limit for now to prevent OOM/High CPU on large files
    const MAX_FILE_SIZE = 1 * 1024 * 1024

    // Check size first
    try {
      if (filePath.startsWith('file://')) {
        filePath = vscode.Uri.parse(filePath).fsPath
      }

      const stats = await util.promisify(fs.stat)(filePath)
      if (!options?.ignoreSizeLimit && stats.size > MAX_FILE_SIZE) {
        throw new Error('FILE_TOO_LARGE')
      }
    } catch (e) {
      if ((e as Error).message === 'FILE_TOO_LARGE') {
        throw e
      }
      // If we can't stat, we might not be able to read it anyway, or it's a virtual file.
      // Proceed with caution or just let readFile handle the error.
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
      // Enforce exclusion of common heavy directories for multiple languages
      // Basic VS Code findFiles
      // Enforce exclusion of common heavy directories for multiple languages
      // Remove outer braces from default string to simplify merging
      // Default Excludes: .git and .vscode (always), plus User Settings (files.exclude, search.exclude)
      const config = vscode.workspace.getConfiguration();
      const filesExclude = config.get<{ [key: string]: boolean }>('files.exclude') || {};
      const searchExclude = config.get<{ [key: string]: boolean }>('search.exclude') || {};

      const settingsExcludes = Object.keys({ ...filesExclude, ...searchExclude })
        .filter(key => {
          const inFiles = filesExclude[key];
          const inSearch = searchExclude[key];
          // Exclude if true in either, unless explicitly false? 
          // Usually overrides apply, but simple merge of true values is safe for "default exclusions"
          return inFiles === true || inSearch === true;
        });

      // Always include .git and .vscode as per requirements, plus settings
      const defaultExcludesList = [
        '**/.git/**',
        '**/.vscode/**',
        ...settingsExcludes
      ];

      // Deduplicate
      const uniqueExcludes = Array.from(new Set(defaultExcludesList));
      const defaultExcludesContent = uniqueExcludes.join(',');

      // Process user exclude: *.py -> **/*.py to match VS Code behavior (recursive by default)
      const processedExclude = exclude
        ? exclude.split(',').map(p => {
          const trimmed = p.trim();
          // If starts with * but not **, and looks like an extension or wildcard file match
          if (trimmed.startsWith('*') && !trimmed.startsWith('**')) {
            return `**/${trimmed}`;
          }
          return trimmed;
        }).join(',')
        : '';

      const finalExclude = processedExclude
        ? `{${processedExclude},${defaultExcludesContent}}`
        : `{${defaultExcludesContent}}`

      // Smart Include: Support comma separation and deep search
      let finalInclude = include;
      if (include) {
        const parts = include.split(',').map(p => {
          const trimmed = p.trim();
          if (!trimmed) return '';

          // If already has wildcards, assume user knows what they are doing
          if (trimmed.includes('*')) {
            return trimmed;
          }

          // Smart logic for paths vs words
          if (trimmed.includes('/') || trimmed.includes('\\')) {
            // Path like "apps/frontend" -> flatten to "apps/frontend/**"
            return `${trimmed}/**`;
          } else {
            // Simple word like "frontend" -> flatten to "**/frontend/**"
            return `**/${trimmed}/**`;
          }
        }).filter(p => p !== '');

        if (parts.length > 1) {
          finalInclude = `{${parts.join(',')}}`;
        } else if (parts.length === 1) {
          finalInclude = parts[0];
        }
      }

      const uris = await vscode.workspace.findFiles(finalInclude, finalExclude)
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
