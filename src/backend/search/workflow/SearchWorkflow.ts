import { EventEmitter } from 'events'
import * as vscode from 'vscode'
import { TransformResultEvent } from '../../../model/SearchRunnerTypes'
import { Params } from '../../types'
import { SearchCache, SearchCacheNode } from '../services/CacheService'
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

  private totalMatchesInRun = 0
  private isPaused = false
  private pauseResolver: (() => void) | null = null
  private currentLimitIndex = 0
  // Limits: pause at 1k, then 10k. (0 means no initial limit index, but we check against LIMITS[0])
  private readonly MATCH_LIMITS = [5000, 10000]
  private skippedLargeFiles = new Set<string>()
  private currentParams: Params | null = null

  async run(params: Params, dirtyFiles?: Set<string>): Promise<void> {
    if (this.isRunning) {
      if (this.abortController) {
        this.emit('stop')
        this.abortController.abort()
      }
    }

    this.isRunning = true
    this.isPaused = false
    this.totalMatchesInRun = 0
    this.currentLimitIndex = 0
    this.skippedLargeFiles.clear()
    this.currentParams = params

    const controller = new AbortController()
    this.abortController = controller

    this.emit('start')

    try {
      const { find, searchInResults, include, exclude } = params

      // 1. Determine Source Files & Parent Node
      const { filesToScan, targetParentNode } = await this.getFilesToScan(
        params,
        dirtyFiles
      )

      // 2. Setup Cache Node
      const cacheNode = this.setupCacheNode(params, targetParentNode)

      // 3. Pipeline Processing
      const processedFiles = this.cacheService.getProcessedFiles()
      const excludedFiles = this.cacheService.getExcludedFiles()

      // Emit cached results
      if (cacheNode && cacheNode.query === find) {
        this.emitCachedResults(cacheNode, processedFiles)
      }

      let completedCount = 0
      const totalFiles = filesToScan.filter(
        (f) => !processedFiles.has(f) && !excludedFiles.has(f)
      ).length

      this.emit('progress', { completed: 0, total: totalFiles })

      // OPTIMIZATION: Reduced concurrency from 10 to 4 to prevent UI blocking
      const CONCURRENCY = 4

      await Pipeline.from(filesToScan)
        .filter((f) => !processedFiles.has(f) && !excludedFiles.has(f))
        .processConcurrent(
          CONCURRENCY,
          async (fileUri) => {
            if (controller.signal.aborted) return

            try {
              const content = await this.fileService.readFile(fileUri)
              // If empty, it might be skipped due to size limit
              if (!content) return

              if (controller.signal.aborted) return // Double check before heavy search

              const matches = await this.textSearchService.searchInFile(
                fileUri,
                content,
                params,
                controller.signal // Pass signal
              )

              if (matches.length > 0) {
                this.totalMatchesInRun += matches.length

                const result: TransformResultEvent = {
                  file: vscode.Uri.parse(fileUri),
                  matches,
                  source: content,
                }

                this.emit('result', result)
                this.cacheService.addResult(result)
              } else {
                // Even if no matches, we might need to clear previous matches for this file
                // IF the file was previously in the results (e.g. nested search).
                const result: TransformResultEvent = {
                  file: vscode.Uri.parse(fileUri),
                  matches: [],
                  source: content,
                }
                this.cacheService.addResult(result)
              }
            } catch (err) {
              if ((err as Error).message === 'FILE_TOO_LARGE') {
                this.skippedLargeFiles.add(fileUri)
                // Emit count
                this.emit('skipped-large-files', this.skippedLargeFiles.size)
              }
            } finally {
              completedCount++
              this.emit('progress', {
                completed: completedCount,
                total: totalFiles,
              })
            }
          },
          {
            signal: controller.signal,
            checkPause: async () => {
              // Check if we hit a limit
              if (
                this.currentLimitIndex < this.MATCH_LIMITS.length &&
                this.totalMatchesInRun >=
                  this.MATCH_LIMITS[this.currentLimitIndex]
              ) {
                this.isPaused = true
                const limit = this.MATCH_LIMITS[this.currentLimitIndex]
                this.emit('search-paused', {
                  limit,
                  count: this.totalMatchesInRun,
                })

                // Wait for resume
                await new Promise<void>((resolve) => {
                  this.pauseResolver = resolve
                })

                this.isPaused = false
                this.pauseResolver = null
                this.isPaused = false
                this.pauseResolver = null
                // Check done inside the pause logic
              }
            },
          }
        )

      if (!controller.signal.aborted) {
        this.cacheService.markCurrentAsComplete()
        this.finish()
      }
    } catch (error) {
      if (controller.signal.aborted) {
        // Normal abort, don't emit error
      } else {
        this.emit('error', error)
      }
      this.isRunning = false
    }
  }

  continueSearch() {
    if (this.isPaused && this.pauseResolver) {
      if (this.currentLimitIndex < this.MATCH_LIMITS.length) {
        this.currentLimitIndex++
      }
      this.pauseResolver()
    }
  }

  async searchLargeFiles() {
    if (!this.currentParams || this.skippedLargeFiles.size === 0) return

    this.isRunning = true
    // Create a new controller for THIS run
    const controller = new AbortController()
    this.abortController = controller

    const files = Array.from(this.skippedLargeFiles)
    let completedCount = 0
    const totalFiles = files.length

    await Pipeline.from(files).processConcurrent(
      4, // Keep low concurrency
      async (fileUri) => {
        if (controller.signal.aborted) return
        try {
          // Ignore size limit here
          const content = await this.fileService.readFile(fileUri, {
            ignoreSizeLimit: true,
          })
          if (!content) return

          const matches = await this.textSearchService.searchInFile(
            fileUri,
            content,
            this.currentParams!,
            controller.signal // Pass signal
          )

          if (matches.length > 0) {
            this.totalMatchesInRun += matches.length
            const result: TransformResultEvent = {
              file: vscode.Uri.parse(fileUri),
              matches,
              source: content,
            }
            this.emit('result', result)
            this.cacheService.addResult(result)
          }
        } catch (err) {
          // ignore
        } finally {
          completedCount++
          // Emit progress?
        }
      },
      { signal: controller.signal }
    )

    // Clear them after search
    this.skippedLargeFiles.clear()
    this.emit('skipped-large-files', 0)

    this.finish()
  }

  private async getFilesToScan(
    params: Params,
    dirtyFiles?: Set<string>
  ): Promise<{
    filesToScan: string[]
    targetParentNode: SearchCacheNode | null
  }> {
    const { searchInResults, include, exclude } = params
    let filesToScan: string[] = []
    let targetParentNode: SearchCacheNode | null = null

    if (searchInResults && searchInResults > 0) {
      // Nested Search: Identify Stable Global Scope
      const scopeNode = this.cacheService.getNearestGlobalNode()

      if (scopeNode) {
        const currentResults = scopeNode.results
        // If we have scope results, use them
        if (currentResults && currentResults.size > 0) {
          const scopeFiles = Array.from(currentResults.keys())

          // MERGE Dirty Files into scope
          if (dirtyFiles && dirtyFiles.size > 0) {
            const dirtyArray = Array.from(dirtyFiles)
            // We want union, excluding duplicates
            // Note: scopeFiles are just paths (strings)
            const union = new Set([...scopeFiles, ...dirtyArray])
            filesToScan = Array.from(union)
          } else {
            filesToScan = scopeFiles
          }

          targetParentNode = scopeNode
        } else {
          // Scope node exists but empty results?
          // If dirty files exist, they might be new matches!
          if (dirtyFiles && dirtyFiles.size > 0) {
            filesToScan = Array.from(dirtyFiles)
            targetParentNode = scopeNode
          } else {
            filesToScan = []
            targetParentNode = scopeNode
          }
        }
      } else {
        // No scope node found (cache issue?), fallback to global scan

        const uris = await this.fileService.findFiles(
          include || '**/*',
          exclude || ''
        )
        filesToScan = uris.map((u) => u.toString())
      }
    } else {
      // Global Search
      const uris = await this.fileService.findFiles(
        include || '**/*',
        exclude || ''
      )
      filesToScan = uris.map((u) => u.toString())
    }

    return { filesToScan, targetParentNode }
  }

  private setupCacheNode(
    params: Params,
    targetParentNode: SearchCacheNode | null
  ): SearchCacheNode {
    const {
      find,
      searchInResults,
      matchCase,
      wholeWord,
      include,
      exclude,
      searchMode,
    } = params
    let cacheNode: SearchCacheNode | null = null

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
    // This method is guaranteed to return a CacheNode, so we can assert it.
    return cacheNode!
  }

  private emitCachedResults(
    cacheNode: SearchCacheNode,
    processedFiles: Set<string>
  ) {
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
