import { splitGlobPattern } from './splitGlobPattern'
import path from 'path'
import * as vscode from 'vscode'

// Создаем канал для логирования
const globLogger = vscode.window.createOutputChannel(
  'VSCode Deep Search Glob Patterns'
)

export function joinPatterns(patterns: readonly string[]): string {
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`
}

export function convertGlobPattern(
  patterns: string | vscode.RelativePattern,
  workspaceFolders: readonly string[]
): string | vscode.RelativePattern {
  // Если patterns уже является RelativePattern, возвращаем его как есть
  if (typeof patterns === 'object' && 'pattern' in patterns) {
    globLogger.appendLine(
      `Received RelativePattern object, returning as is: ${patterns.pattern}`
    )
    return patterns
  }

  // Добавляем отладочную информацию
  globLogger.appendLine(`Converting glob pattern: "${patterns}"`)

  // Проверяем, является ли шаблон простым путем к директории
  // без глобальных символов (* ? [ ] { })
  if (/^[^*?[\]{}]+$/.test(patterns) && !path.extname(patterns)) {
    globLogger.appendLine(`Detected simple directory path: "${patterns}"`)
    const appWorkspaceFolders = vscode.workspace.workspaceFolders
    if (appWorkspaceFolders && appWorkspaceFolders.length > 0) {
      return new vscode.RelativePattern(
        appWorkspaceFolders[0],
        `${patterns}/**/*`
      )
    }
    return patterns
  }

  const specificFolderPatterns: Map<string, string[]> = new Map()
  const byName = new Map(workspaceFolders.map((f) => [path.basename(f), f]))
  const generalPatterns: string[] = []
  const resultPatterns = []

  for (const pattern of splitGlobPattern(patterns)) {
    globLogger.appendLine(`Processing pattern part: "${pattern}"`)

    if (path.isAbsolute(pattern)) {
      resultPatterns.push(pattern)
      continue
    }
    const [basedir] = pattern.split(path.sep)
    const workspaceFolder = byName.get(basedir)
    if (workspaceFolder) {
      let forFolder = specificFolderPatterns.get(workspaceFolder)
      if (!forFolder)
        specificFolderPatterns.set(workspaceFolder, (forFolder = []))
      forFolder?.push(path.relative(basedir, pattern))
    } else {
      // Don't add **/ prefix if the pattern already starts with it or is relative
      const isRecursive = pattern.startsWith('**')
      generalPatterns.push(
        pattern.startsWith('.') || isRecursive
          ? pattern
          : path.join('**', pattern)
      )
    }
  }

  for (const [workspaceFolder, patterns] of specificFolderPatterns.entries()) {
    // Should ideally construct a relative pattern like "FolderName/pattern" if possible,
    // but specific folder targeting via glob strings usually requires the folder name relative to workspace root?
    // If we have map of Name -> Path, we can reconstruct Name.
    const folderName = path.basename(workspaceFolder)
    resultPatterns.push(path.join(folderName, joinPatterns(patterns)))
  }

  if (generalPatterns.length) {
    resultPatterns.push(joinPatterns(generalPatterns))
  }

  // Если паттерн содержит только имя директории без глобальных шаблонов, добавим '**/*'
  if (resultPatterns.length === 0 && patterns && !patterns.includes('*')) {
    globLogger.appendLine(
      `Adding recursive pattern for directory: "${patterns}"`
    )
    resultPatterns.push(path.join(patterns, '**', '*'))
  }

  const result = joinPatterns(resultPatterns)
  globLogger.appendLine(`Final converted pattern: "${result}"`)
  return result
}
