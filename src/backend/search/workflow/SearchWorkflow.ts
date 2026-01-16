import * as vscode from 'vscode'
import { EventEmitter } from 'events'
import { Params } from '../../types'
import { TransformResultEvent } from '../../../model/SearchRunnerTypes'
import { FileService } from '../services/FileService'
import { TextSearchService } from '../services/TextSearchService'
import { SearchCache } from '../services/CacheService' // Assuming renamed or aliased
import { TaskQueue } from '../utilities/TaskQueue'

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
    this.textSearchService.setAbortController(this.abortController) // Pass signal to service

    this.emit('start')

    try {
      const { find, searchInResults, include, exclude } = params

      // 1. Determine Source Files
      let filesToScan: string[] = []
      let targetParentNode: any = null // Store the parent node for cache creation

      if (searchInResults && searchInResults > 0) {
        const targetDepth = searchInResults - 1
        const currentNode = this.cacheService.getCurrentNode()

        // console.log(
        //   `[SearchWorkflow] Nested Search (Level ${searchInResults}). Target Base Depth: ${targetDepth}`
        // )
        // console.log(
        //   `[SearchWorkflow] Current Cache Node: ${
        //     currentNode
        //       ? `Query="${currentNode.query}", Depth=${currentNode.depth}, Results=${currentNode.results.size}`
        //       : 'NULL'
        //   }`
        // )

        const cachedResults = this.cacheService.getResultsFromDepth(
          targetDepth,
          currentNode
        )
        targetParentNode = this.cacheService.getAncestorAtDepth(
          targetDepth,
          currentNode
        )

        if (cachedResults) {
          // console.log(
          //   `[SearchWorkflow] Found results from depth ${targetDepth}. Size: ${cachedResults.size}`
          // )
          filesToScan = Array.from(cachedResults.keys())
        } else {
          // console.warn(
          //   `[SearchWorkflow] WARNING: Could not find results from depth ${targetDepth}. Falling back to standard search? Or previous results?`
          // )
          // ... fallback logic ...
          const current = this.cacheService.getCurrentResults()
          if (current) {
            // console.log(
            //   `[SearchWorkflow] Fallback: Using current node results. Size: ${current.size}`
            // )
            filesToScan = Array.from(current.keys())
          } else {
            // console.log(
            //   '[SearchWorkflow] Fallback: Standard search (no cache found).'
            // )
            const effectiveInclude = include || '**/*'
            const uris = await this.fileService.findFiles(
              effectiveInclude,
              exclude || ''
            )
            filesToScan = uris.map((u) => u.toString())
          }
        }
      } else {
        // console.log(
        //   '[SearchWorkflow] Standard search (Global). Finding files in workspace...'
        // )
        const effectiveInclude = include || '**/*'
        const uris = await this.fileService.findFiles(
          effectiveInclude,
          exclude || ''
        )
        filesToScan = uris.map((u) => u.toString())
      }

      // console.log(`[SearchWorkflow] Files to scan: ${filesToScan.length}`)

      // 2. Setup Cache Node
      // For nested search, we FORCE the parent to be the one we scoped to, ignoring params compatibility.

      let cacheNode: any = null

      // First try to find existing compatible node if we are NOT forcing parent (Global)
      // Or if we are nested, we can still check children of targetParentNode?

      // Actually, if we have targetParentNode, we should ideally use it.

      if (!targetParentNode) {
        // Standard logic
        cacheNode = this.cacheService.findSuitableCache(
          find,
          params.matchCase,
          params.wholeWord,
          exclude,
          include,
          params.searchMode,
          !searchInResults
        )
      } else {
        // We have a forced parent. Check if it already has a child with this query and params?
        // But CacheService.findSuitableCache logic is complex.
        // Let's simplified: just create new node with forced parent.
        // CacheService.createCacheNode handles child attachment.
        // But we want to avoid duplicates if it exists.
        // For now, let's just create (it handles 'latest child' somewhat?)
        // Actually, createCacheNode doesn't check if child exists, it blindly creates.
        // We should ideally check targetParentNode.children.
      }

      // Simplification: Always use createCacheNode if we are in nested mode to ensure structure.
      // But we can check if explicitParent has child.

      if (targetParentNode) {
        // Check for existing child in targetParentNode
        // We'd need to manually check.
        // For now, let's just create a new node. It's safer for the "Search in Results" logic.
        cacheNode = this.cacheService.createCacheNode(
          find,
          params.matchCase,
          params.wholeWord,
          exclude,
          include,
          params.searchMode,
          !searchInResults,
          targetParentNode
        )
      } else {
        if (!cacheNode) {
          cacheNode = this.cacheService.createCacheNode(
            find,
            params.matchCase,
            params.wholeWord,
            exclude,
            include,
            params.searchMode,
            !searchInResults
          )
        } else if (cacheNode.query !== find) {
          // Refinement
          cacheNode = this.cacheService.createCacheNode(
            find,
            params.matchCase,
            params.wholeWord,
            exclude,
            include,
            params.searchMode,
            !searchInResults
          )
        } else {
          // console.log('[SearchWorkflow] Exact cache match.')
          // ... optimization ...
          const results = this.cacheService.getCurrentResults()
          if (results) {
            for (const res of results.values()) {
              this.emit('result', res)
            }
            this.finish()
            return
          }
        }
      }

      // 3. Filter files that are already in the NEW cache node (if copied from parent)
      // Wait, filesToScan came from potentially the PARENT (if searchInResults).
      // cacheNode is the NEW node.
      // If createCacheNode copied logic, then createCacheNode logic populates `processedFiles`.

      const processedFiles = this.cacheService.getProcessedFiles() // From Current Node
      const excludedFiles = this.cacheService.getExcludedFiles()

      const realFilesToProcess = filesToScan.filter(
        (f) => !processedFiles.has(f) && !excludedFiles.has(f)
      )

      // Emit already processed results (inherited from parent)
      if (cacheNode && cacheNode.results.size > 0 && processedFiles.size > 0) {
        // console.log(
        //   `[SearchWorkflow] Emitting ${processedFiles.size} cached results.`
        // )
        for (const [uri, result] of cacheNode.results.entries()) {
          // We emit result if it matches our criteria.
          // Since they are in cacheNode.results, they matched createCacheNode's check.
          // And createCacheNode put them in processedFiles.
          if (processedFiles.has(uri)) {
            this.emit('result', result)
          }
        }
      }

      // console.log(
      //   `[SearchWorkflow] Real files to process: ${realFilesToProcess.length}`
      // )

      this.emit('progress', { completed: 0, total: realFilesToProcess.length })

      // 4. Processing Queue
      const queue = new TaskQueue<void>({
        concurrency: 10, // Adjust as needed
        signal: this.abortController.signal,
      })

      let completedCount = 0

      const tasks = realFilesToProcess.map((fileUri) => async () => {
        if (this.abortController?.signal.aborted) return

        try {
          // Remove file:// prefix if present for reading (depends on FileService implementation, but safe to be clean)
          // TextSearchRunner used fs.readFile handling, FileService does it too.

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
              source: content, // Optional?
            }

            this.emit('result', result)
            this.cacheService.addResult(result)
          }
        } catch (err) {
          // console.error(`Error processing file ${fileUri}:`, err)
        } finally {
          completedCount++
          this.emit('progress', {
            completed: completedCount,
            total: realFilesToProcess.length,
          })
        }
      })

      queue.addAll(tasks)
      await queue.onIdle()

      if (!this.abortController.signal.aborted) {
        this.cacheService.markCurrentAsComplete()
        this.finish()
      }
    } catch (error) {
      // console.error('[SearchWorkflow] Error:', error)
      this.emit('error', error)
      this.isRunning = false
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
