import { Params } from '../../types'
import { SearchRunnerMatch } from '../../../model/SearchRunnerTypes'

export class TextSearchService {
  private abortController: AbortController | null = null

  setAbortController(controller: AbortController): void {
    this.abortController = controller
  }

  async searchInFile(
    file: string,
    content: string,
    params: Params,
    _logMessage?: (msg: string) => void
  ): Promise<SearchRunnerMatch[]> {
    const { matchCase, wholeWord, searchMode } = params
    let find = params.find
    const matches: SearchRunnerMatch[] = []
    let captureGroupIndex = 0

    // Extract capture group index if present (e.g., "$1")
    if (searchMode === 'regex') {
      const captureGroupMatch = find.match(/\$(\d+)$/)
      if (captureGroupMatch) {
        captureGroupIndex = parseInt(captureGroupMatch[1], 10)
        find = find.slice(0, -captureGroupMatch[0].length)
      }
    }

    // Construct Regex
    let regex: RegExp
    try {
      if (searchMode === 'regex') {
        const flags = matchCase ? 'g' : 'gi'
        regex = new RegExp(find, flags)
      } else {
        // Text mode
        const escaped = this.escapeRegExp(find)
        if (wholeWord) {
          const flags = matchCase ? 'g' : 'gi'
          regex = new RegExp(`\\b${escaped}\\b`, flags)
        } else {
          const flags = matchCase ? 'g' : 'gi'
          regex = new RegExp(escaped, flags)
        }
      }
    } catch (e) {
      // Invalid regex
      return []
    }

    // Binary file check (heuristic: content contains null bytes)
    if (content.includes('\0')) {
      return []
    }

    await this.findMatchesInChunks(
      content,
      file,
      regex,
      matches,
      captureGroupIndex
    )

    return matches
  }

  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  // Copied and adapted from TextSearchRunner
  private async findMatchesInChunks(
    source: string,
    file: string,
    regex: RegExp,
    matches: SearchRunnerMatch[],
    captureGroupIndex = 0
  ): Promise<void> {
    const CHUNK_SIZE = 512 * 1024 // 512 KB
    const overlap = 1024 // 1 KB

    if (this.abortController?.signal.aborted) return

    const lineStartPositions = new Map<
      number,
      { line: number; column: number }
    >()
    lineStartPositions.set(0, { line: 1, column: 0 })

    for (
      let startPos = 0;
      startPos < source.length;
      startPos += CHUNK_SIZE - overlap
    ) {
      if (this.abortController?.signal.aborted) return

      const endPos = Math.min(startPos + CHUNK_SIZE, source.length)
      const chunk = source.substring(startPos, endPos)

      // Yield to event loop
      await new Promise((resolve) => setTimeout(resolve, 0))

      regex.lastIndex = 0
      let matchResult: RegExpExecArray | null
      let matchesInCurrentChunk = 0

      while ((matchResult = regex.exec(chunk)) !== null) {
        if (this.abortController?.signal.aborted) return

        if (++matchesInCurrentChunk % 100 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }

        if (matchResult[captureGroupIndex].length === 0) {
          regex.lastIndex++
          continue
        }

        // logMessage(`FILE: ${file}, \nMATCHES: ${matchResult[0]}`);

        const chunkOffset = startPos
        const fullMatch = matchResult[0]
        const groupMatch = matchResult[captureGroupIndex]
        const groupOffset = fullMatch.indexOf(groupMatch)

        const matchStartOffset =
          chunkOffset +
          matchResult.index +
          (captureGroupIndex > 0 ? groupOffset : 0)
        const matchEndOffset =
          matchStartOffset + matchResult[captureGroupIndex].length
        const matchText = matchResult[captureGroupIndex]

        // Avoid duplicates from overlap
        const isDuplicate = matches.some(
          (m) => m.start === matchStartOffset && m.end === matchEndOffset
        )

        if (!isDuplicate) {
          const loc = this.calculateLocation(
            source,
            matchStartOffset,
            matchEndOffset,
            matchText,
            lineStartPositions
          )

          matches.push({
            type: 'match' as any,
            start: matchStartOffset,
            end: matchEndOffset,
            file,
            source: matchText,
            loc,
          } as unknown as SearchRunnerMatch)
        }
      }
    }
  }

  private calculateLocation(
    source: string,
    startOffset: number,
    endOffset: number,
    text: string,
    lineStartPositions: Map<number, { line: number; column: number }>
  ) {
    // ... simplified location calculation or copied from original ...
    // For brevity in this plan, I'll implement a robust version based on the original logic

    let closestPosition = 0
    let posInfo = { line: 1, column: 0 }

    for (const [pos, info] of lineStartPositions.entries()) {
      if (pos <= startOffset && pos > closestPosition) {
        closestPosition = pos
        posInfo = info
      }
    }

    let line = posInfo.line
    let column = posInfo.column

    for (let i = closestPosition; i < startOffset; i++) {
      if (source[i] === '\n') {
        line++
        column = 0
        lineStartPositions.set(i + 1, { line, column })
      } else {
        column++
      }
    }

    // Cache position after this match
    lineStartPositions.set(endOffset, { line, column: column + text.length })

    // End position calc
    let endLine = line
    let endColumn = column
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') {
        endLine++
        endColumn = 0
      } else {
        endColumn++
      }
    }

    return {
      start: { line, column },
      end: { line: endLine, column: endColumn },
    }
  }
}
