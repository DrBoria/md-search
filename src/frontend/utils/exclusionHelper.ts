import { URI } from 'vscode-uri'
import { SerializedTransformResultEvent } from '../../model/SearchReplaceViewTypes'

export const uriToPath = (uriString: string | undefined): string => {
  if (!uriString) return ''
  try {
    const uri = URI.parse(uriString)
    if (uri.scheme === 'file') {
      return uri.fsPath
    }
    return uriString
  } catch (e) {
    return uriString || ''
  }
}

export interface ExclusionResult {
  newResults: Record<string, SerializedTransformResultEvent[]>
  removedKeys: string[]
  removedMatchesCount: number
  removedFileCount: number
}

export const excludePathFromResults = (
  results: Record<string, SerializedTransformResultEvent[]>,
  filePath: string
): ExclusionResult => {
  const newResults = { ...results }
  const removedKeys: string[] = []
  let removedMatchesCount = 0

  // Normalize target path once
  const targetPath = uriToPath(filePath)

  Object.keys(newResults).forEach((key) => {
    const keyPath = uriToPath(key)

    const match =
      key === filePath || // Direct match
      keyPath === targetPath || // Normalized Path equality
      keyPath.startsWith(targetPath + '/') ||
      keyPath.startsWith(targetPath + '\\')

    if (match) {
      const fileEvents = newResults[key]

      // Calculate matches for stats (crucial for Root View status update)
      const matches =
        fileEvents?.reduce((sum, e) => sum + (e.matches?.length || 0), 0) || 0
      removedMatchesCount += matches

      removedKeys.push(key)
      delete newResults[key]
    }
  })

  return {
    newResults,
    removedKeys,
    removedMatchesCount,
    removedFileCount: removedKeys.length,
  }
}
