import { TypedEmitter } from 'tiny-typed-emitter'
import * as vscode from 'vscode'
import { debounce } from 'lodash'
import { Params, IMdSearchExtension } from '../types'
import { SearchRunnerEvents } from '../../model/SearchRunnerTypes'
import { SearchWorkflow } from '../search/workflow/SearchWorkflow'
import { FileService } from '../search/services/FileService'
import { TextSearchService } from '../search/services/TextSearchService'
import { SearchCache } from '../search/services/CacheService'

import { TransformResultEvent } from '../../model/SearchRunnerTypes'
export type { TransformResultEvent }

/**
 * Controller class that manages the SearchWorkflow.
 * Refactored to delegate logic to SearchWorkflow, FileIndexer, and TextSearchRunner.
 */
export class SearchRunner extends TypedEmitter<SearchRunnerEvents> {
  private params: Params
  private workflow: SearchWorkflow
  private extension: IMdSearchExtension

  // Services
  private fileService: FileService
  private textSearchService: TextSearchService
  private cacheService: SearchCache

  constructor(extension: IMdSearchExtension) {
    super()
    this.extension = extension
    this.params = {} as Params // Initialize with empty/default

    // Initialize dependencies
    this.fileService = new FileService()
    this.textSearchService = new TextSearchService() // We need to fix method names
    this.cacheService = new SearchCache()

    // Initialize Workflow
    this.workflow = new SearchWorkflow(
      this.fileService,
      this.textSearchService,
      this.cacheService
    )

    // Forward Workflow events to the outside world (UI)
    this.workflow.on('result', (e) => this.emit('result', e))
    this.workflow.on('start', () => this.emit('start'))
    this.workflow.on('done', () => this.emit('done'))
    this.workflow.on('error', (e) => this.emit('error', e))
    this.workflow.on('progress', (e) => this.emit('progress', e))
    this.workflow.on('stop', () => this.emit('stop'))
    // this.workflow.on('match', (m) => this.emit('match', m)) // Not used in new workflow yet?
    // this.workflow.on('replaceDone', () => this.emit('replaceDone')) // Not used yet
  }

  /**
   * Updates search parameters and triggers a restart.
   */
  setParams(params: Params, triggerRestart = true): void {
    const prevFn = JSON.stringify(this.params)
    const newFn = JSON.stringify(params)

    this.params = params

    if (triggerRestart && prevFn !== newFn) {
      this.debouncedRestart()
    }
  }

  // Debounce the restart to avoid rapid-fire searches
  debouncedRestart: () => void = debounce(async () => {
    // console.log('[SearchRunner] debouncedRestart triggering stop() and run()')
    this.workflow.stop()
    this.run()
  }, 300)

  /**
   * Main entry point to run the search.
   */
  async run(): Promise<void> {
    // console.log(
    //   '[SearchRunner] run() called',
    //   'params:',
    //   JSON.stringify(this.params, null, 2)
    // )
    // Basic validation
    if (!this.params.find) {
      // console.log('[SearchRunner] No find pattern, skipping run')
      return
    }
    if (this.params.paused) {
      // console.log('[SearchRunner] Search paused, skipping run')
      return
    }

    // Delegate to workflow
    // console.log('[SearchRunner] Delegating to workflow.run()')
    await this.workflow.run(this.params)
  }

  stop(): void {
    this.workflow.stop()
  }

  abort(): void {
    this.stop()
  }

  // Legacy/Stubs for compatibility if needed, or remove
  async startup(): Promise<void> {
    return Promise.resolve()
  }
  async shutdown(): Promise<void> {
    this.stop()
  }

  // Legacy/Compatibility methods
  runSoon(): void {
    this.debouncedRestart()
  }

  restartSoon(): void {
    this.debouncedRestart()
  }

  clearCache(): void {
    this.cacheService.clearCache()
  }

  clearCacheForFile(uri: vscode.Uri): void {
    // Deprecated: use removeFileFromCache or invalidateFileInCache
    this.cacheService.removeFileFromCache(uri)
  }

  removeFileFromCache(uri: vscode.Uri): void {
    this.cacheService.removeFileFromCache(uri)
  }

  invalidateFileInCache(uri: vscode.Uri): void {
    this.cacheService.invalidateFileInCache(uri)
  }

  excludeFileFromCache(uri: vscode.Uri): void {
    this.cacheService.excludeFileFromCache(uri)
  }

  /*
   * Scans a single file and emits a result (for Live Updates).
   * Note: This bypasses the workflow's queue and filtering to provide immediate feedback.
   */
  async scanFile(document: vscode.TextDocument): Promise<void> {
    const { find } = this.params
    if (!find) return

    try {
      // Invalidate cache for this file first (preserve in results so we don't lose context)
      // Actually scanFile is simpler - we just want to force a re-scan.
      this.invalidateFileInCache(document.uri)

      // Run search using service directly
      const content = document.getText()
      const matches = await this.textSearchService.searchInFile(
        document.uri.fsPath,
        content,
        this.params,
        undefined // No abort signal for single file scan? Or distinct one?
      )

      // Create result event - Emit even if matches are empty so frontend can clear entries
      const result: TransformResultEvent = {
        file: document.uri,
        matches,
        source: content,
      }

      this.emit('result', result)

      // Update cache only if there are matches (or should we cache empty results?
      // CacheService usually caches positive results. If we don't cache empty, next search might re-scan.
      // But clearing cache above ensures correctness.)
      this.cacheService.addResult(result)
    } catch (e) {
      // console.error(`Error scanning file ${document.uri.fsPath}:`, e)
    }
  }
}
