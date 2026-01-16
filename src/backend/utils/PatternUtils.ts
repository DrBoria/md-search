import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'

/**
 * Utilities for handling glob patterns, include/exclude logic, and gitignore.
 */
export class PatternUtils {
  private static readonly DEFAULT_IGNORED_PATTERNS = [
    '**/.git/**',
    '**/*.png',
    '**/*.jpg',
    '**/*.jpeg',
    '**/*.gif',
    '**/*.ico',
    '**/*.svg',
    '**/*.webp',
    '**/*.mp4',
    '**/*.webm',
    '**/*.avi',
    '**/*.mov',
    '**/*.mp3',
    '**/*.wav',
    '**/*.ogg',
    '**/*.pdf',
    '**/*.doc',
    '**/*.docx',
    '**/*.xls',
    '**/*.xlsx',
    '**/*.zip',
    '**/*.tar',
    '**/*.gz',
    '**/*.ttf',
    '**/*.otf',
    '**/*.woff',
    '**/*.woff2',
    '**/*.exe',
    '**/*.dll',
    '**/*.so',
    '**/*.class',
    '**/*.jar',
  ]

  /**
   * Gets exclude patterns from VS Code settings and .gitignore.
   */
  static getSearchExcludePatterns(): string[] {
    const exclude = vscode.workspace
      .getConfiguration('search')
      .get<{ [key: string]: boolean }>('exclude')
    let excludePatterns = [...this.DEFAULT_IGNORED_PATTERNS]

    if (exclude) {
      const userPatterns = Object.entries(exclude)
        .filter(([, value]) => value === true)
        .map(([key]) => key)
      excludePatterns = [...excludePatterns, ...userPatterns]
    }

    // Add .gitignore patterns
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders
      if (workspaceFolders && workspaceFolders.length > 0) {
        const gitignorePath = path.join(
          workspaceFolders[0].uri.fsPath,
          '.gitignore'
        )
        if (fs.existsSync(gitignorePath)) {
          const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8')
          const gitignoreLines = gitignoreContent
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'))

          const gitignorePatterns = gitignoreLines.map((line) => {
            if (line.endsWith('/')) {
              const clean = line.replace(/^\/+/, '').replace(/\/+$/, '')
              return `**/${clean}/**`
            }
            if (line.startsWith('/')) {
              return `**/${line.replace(/^\/+/, '')}`
            }
            return `**/${line}`
          })
          excludePatterns = [...excludePatterns, ...gitignorePatterns]
        }
      }
    } catch (_error) {
      // Ignore errors reading .gitignore
    }
    return excludePatterns
  }

  /**
   * Gets include patterns from VS Code settings.
   */
  static getSearchIncludePatterns(): string[] {
    const include = vscode.workspace
      .getConfiguration('search')
      .get<string>('include')
    if (!include) return []
    return include
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '')
  }
}
