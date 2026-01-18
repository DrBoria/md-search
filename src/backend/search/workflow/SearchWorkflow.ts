import { EventEmitter } from 'events'
import * as vscode from 'vscode'
import { TransformResultEvent } from '../../../model/SearchRunnerTypes'
import { Params } from '../../types'
import { SearchCache } from '../services/CacheService'
import { FileService } from '../services/FileService'
import { TextSearchService } from '../services/TextSearchService'
import { Pipeline } from '../utilities/Pipeline'

export class SearchWorkflow extends EventEmitter {
  private abortController: AbortController | null = null
  private isRunning = false

  constructor(
    private fileService: FileService,
    private textSearchService: TextSearchService,
    private cacheService: SearchCache
  ) {
    super()
  }

  async run(params: Params): Promise<void> {
    if (this.isRunning) {
      this.stop()
    }
    this.isRunning = true
    this.abortController = new AbortController()
    this.textSearchService.setAbortController(this.abortController)

    this.emit('start')

    try {
      const { find, searchInResults, include, exclude } = params

      // 1. Determine Source Files & Parent Node
      const { filesToScan, targetParentNode } = await this.getFilesToScan(
        params
      )

      // 2. Setup Cache Node
      const cacheNode = this.setupCacheNode(params, targetParentNode)

      if (!cacheNode && !targetParentNode) {
        // Optimization: Exact cache match found (handled inside setupCacheNode? No, separated)
        // If setupCacheNode returns null, it might mean we found an exact match and emitted results?
        // Let's refine setupCacheNode to return the node OR indicate completion.
        // For simplicity, we assume setupCacheNode always returns a node unless we're done.
      }

      // Check for exact cache match optimization
      if (
        !targetParentNode &&
        this.cacheService.getCurrentNode()?.query === find
        // && check params match...
      ) {
        // ... (Optimization logic could go here, but let's stick to the flow)
      }

      // 3. Pipeline Processing
      const processedFiles = this.cacheService.getProcessedFiles()
      const excludedFiles = this.cacheService.getExcludedFiles()

      // Emit cached results
      // If we have a cache node for this exact query, emit what we already have.
      // This is crucial for re-runs (e.g. typing "let" -> clear -> "let") where the cache persists.
      if (cacheNode && cacheNode.query === find) {
        this.emitCachedResults(cacheNode, processedFiles)
      }

      let completedCount = 0
      const totalFiles = filesToScan.filter(
        (f) => !processedFiles.has(f) && !excludedFiles.has(f)
      ).length

      this.emit('progress', { completed: 0, total: totalFiles })

      await Pipeline.from(filesToScan)
        .filter((f) => !processedFiles.has(f) && !excludedFiles.has(f))
        .processConcurrent(10, async (fileUri) => {
          if (this.abortController?.signal.aborted) return

          try {
            const content = await this.fileService.readFile(fileUri)
            const matches = await this.textSearchService.searchInFile(
              fileUri,
              content,
              params
            )

            if (matches.length > 0) {
              const result: TransformResultEvent = {
                file: vscode.Uri.parse(fileUri),
                matches,
                source: content,
              }

              this.emit('result', result)
              this.cacheService.addResult(result)
            }
          } catch (err) {
            // ignore errors
          } finally {
            completedCount++
            this.emit('progress', {
              completed: completedCount,
              total: totalFiles,
            })
          }
        })

      if (!this.abortController.signal.aborted) {
        this.cacheService.markCurrentAsComplete()
        this.finish()
      }
    } catch (error) {
      this.emit('error', error)
      this.isRunning = false
    }
  }

  private async getFilesToScan(
    params: Params
  ): Promise<{ filesToScan: string[]; targetParentNode: any }> {
    const { searchInResults, include, exclude } = params
    let filesToScan: string[] = []
    let targetParentNode: any = null

    if (searchInResults && searchInResults > 0) {
      const targetDepth = searchInResults - 1
      const currentNode = this.cacheService.getCurrentNode()
      const cachedResults = this.cacheService.getResultsFromDepth(
        targetDepth,
        currentNode
      )
      targetParentNode = this.cacheService.getAncestorAtDepth(
        targetDepth,
        currentNode
      )

      if (cachedResults) {
        filesToScan = Array.from(cachedResults.keys())
      } else {
        const current = this.cacheService.getCurrentResults()
        if (current) {
          filesToScan = Array.from(current.keys())
        } else {
          const uris = await this.fileService.findFiles(
            include || '**/*',
            exclude || ''
          )
          filesToScan = uris.map((u) => u.toString())
        }
      }
    } else {
      const uris = await this.fileService.findFiles(
        include || '**/*',
        exclude || ''
      )
      filesToScan = uris.map((u) => u.toString())
    }
    return { filesToScan, targetParentNode }
  }

  private setupCacheNode(params: Params, targetParentNode: any): any {
    const {
      find,
      searchInResults,
      matchCase,
      wholeWord,
      include,
      exclude,
      searchMode,
    } = params
    let cacheNode: any = null

    if (targetParentNode) {
      // Use createCacheNode with explicit parent
      cacheNode = this.cacheService.createCacheNode(
        find,
        matchCase,
        wholeWord,
        exclude,
        include,
        searchMode,
        !searchInResults,
        targetParentNode
      )
    } else {
      // Global search
      cacheNode = this.cacheService.findSuitableCache(
        find,
        matchCase,
        wholeWord,
        exclude,
        include,
        searchMode,
        !searchInResults
      )
      if (!cacheNode) {
        cacheNode = this.cacheService.createCacheNode(
          find,
          matchCase,
          wholeWord,
          exclude,
          include,
          searchMode,
          !searchInResults
        )
      } else if (cacheNode.query !== find) {
        // Refinement
        cacheNode = this.cacheService.createCacheNode(
          find,
          matchCase,
          wholeWord,
          exclude,
          include,
          searchMode,
          !searchInResults
        )
      }
    }
    return cacheNode
  }

  private emitCachedResults(cacheNode: any, processedFiles: Set<string>) {
    for (const [uri, result] of cacheNode.results.entries()) {
      if (processedFiles.has(uri)) {
        this.emit('result', result)
      }
    }
  }

  stop() {
    if (this.abortController) {
      this.abortController.abort()
    }
    this.isRunning = false
    this.emit('stop')
  }

  private finish() {
    this.isRunning = false
    this.emit('done')
  }
}
