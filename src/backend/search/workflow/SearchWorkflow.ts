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

  private totalMatchesInRun = 0
  private isPaused = false
  private pauseResolver: (() => void) | null = null
  private currentLimitIndex = 0
  // Limits: pause at 1k, then 10k. (0 means no initial limit index, but we check against LIMITS[0])
  private readonly MATCH_LIMITS = [5000, 10000]
  private skippedLargeFiles = new Set<string>()
  private currentParams: Params | null = null

  async run(params: Params): Promise<void> {
    if (this.isRunning) {
      this.stop()
    }
    this.isRunning = true
    this.isPaused = false
    this.totalMatchesInRun = 0
    this.currentLimitIndex = 0
    this.pauseResolver = null
    this.skippedLargeFiles.clear()
    this.currentParams = params

    this.abortController = new AbortController()
    this.textSearchService.setAbortController(this.abortController)

    this.emit('start')

    try {
      const { find, searchInResults, include, exclude } = params

      // 1. Determine Source Files & Parent Node
      const { filesToScan, targetParentNode } =
        await this.getFilesToScan(params)

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
            if (this.abortController?.signal.aborted) return

            try {
              const content = await this.fileService.readFile(fileUri)
              // If empty, it might be skipped due to size limit
              if (!content) return

              const matches = await this.textSearchService.searchInFile(
                fileUri,
                content,
                params
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
            signal: this.abortController.signal,
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

      if (!this.abortController.signal.aborted) {
        this.cacheService.markCurrentAsComplete()
        this.finish()
      }
    } catch (error) {
      if (this.abortController?.signal.aborted) {
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
    this.abortController = new AbortController() // New controller or reuse?
    // If we reuse, ensure it's not aborted.
    if (!this.abortController || this.abortController.signal.aborted) {
      this.abortController = new AbortController()
    }

    const files = Array.from(this.skippedLargeFiles)
    let completedCount = 0
    const totalFiles = files.length

    await Pipeline.from(files).processConcurrent(
      4, // Keep low concurrency
      async (fileUri) => {
        if (this.abortController?.signal.aborted) return
        try {
          // Ignore size limit here
          const content = await this.fileService.readFile(fileUri, {
            ignoreSizeLimit: true,
          })
          if (!content) return

          const matches = await this.textSearchService.searchInFile(
            fileUri,
            content,
            this.currentParams!
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
      { signal: this.abortController.signal }
    )

    // Clear them after search
    this.skippedLargeFiles.clear()
    this.emit('skipped-large-files', 0)

    this.finish()
  }

  private async getFilesToScan(
    params: Params
  ): Promise<{ filesToScan: string[]; targetParentNode: any }> {
    const { searchInResults, include, exclude } = params
    let filesToScan: string[] = []
    let targetParentNode: any = null

    console.log(
      `[SearchWorkflow] getFilesToScan called. params.searchInResults: ${searchInResults}`
    )

    if (searchInResults && searchInResults > 0) {
      const targetDepth = searchInResults - 1
      const currentNode = this.cacheService.getCurrentNode()
      console.log(
        `[SearchWorkflow] Nested Search. targetDepth: ${targetDepth}, currentNode depth: ${currentNode?.depth}`
      )

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
        console.log(
          `[SearchWorkflow] Found cached results at depth ${targetDepth}. Scanning ${filesToScan.length} files.`
        )
      } else {
        const current = this.cacheService.getCurrentResults()
        if (current) {
          filesToScan = Array.from(current.keys())
          console.log(
            `[SearchWorkflow] Fallback to current results. Scanning ${filesToScan.length} files.`
          )
        } else {
          // Verify if we actually wanted a nested search but failed
          console.log(
            `[SearchWorkflow] Cache miss for nested search! Falling back to full scan.`
          )
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
      // console.log(`[SearchWorkflow] Global search. Scanning ${filesToScan.length} files.`)
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
