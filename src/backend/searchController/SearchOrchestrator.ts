import { TypedEmitter } from 'tiny-typed-emitter'
import * as vscode from 'vscode'
import { debounce } from 'lodash'
import { Params, IMdSearchExtension } from '../types'
import { SearchRunnerEvents } from '../../model/SearchRunnerTypes'
import { SearchWorkflow } from '../search/workflow/SearchWorkflow'
import { TextSearchService } from '../search/services/TextSearchService'

/**
 * Controller class that manages the SearchWorkflow.
 * Orchestrates the search process and manages state/debouncing.
 */
export class SearchOrchestrator extends TypedEmitter<SearchRunnerEvents> {
  private params: Params
  private extension: IMdSearchExtension

  // Dependencies
  private workflow: SearchWorkflow
  private cacheService: SearchCache
  private textSearchService: TextSearchService

  constructor(
    extension: IMdSearchExtension,
    workflow: SearchWorkflow,
    cacheService: SearchCache,
    textSearchService: TextSearchService
  ) {
    super()
    this.extension = extension
    this.params = {} as Params
    this.workflow = workflow
    this.cacheService = cacheService
    this.textSearchService = textSearchService

    // Forward Workflow events to the outside world (UI)
    this.workflow.on('result', (e) => this.emit('result', e))
    this.workflow.on('start', () => this.emit('start'))
    this.workflow.on('done', () => this.emit('done'))
    this.workflow.on('error', (e) => this.emit('error', e))
    this.workflow.on('progress', (e) => this.emit('progress', e))
    this.workflow.on('skipped-large-files', (count) =>
      this.emit('skipped-large-files', count)
    )
    this.workflow.on('stop', () => this.emit('stop'))
    this.workflow.on('search-paused', (e) => this.emit('search-paused', e))
  }

  continueSearch(): void {
    this.workflow.continueSearch()
  }

  searchLargeFiles(): void {
    this.workflow.searchLargeFiles()
  }

  /**
   * Updates search parameters and triggers a restart.
   */
  setParams(params: Params): void {
    const prevFn = JSON.stringify(this.params)
    const newFn = JSON.stringify(params)

    this.params = params

    if (prevFn !== newFn) {
      this.debouncedRestart()
    }
  }

  // Debounce the restart to avoid rapid-fire searches
  debouncedRestart: () => void = debounce(async () => {
    this.workflow.stop()
    this.run()
  }, 300)

  /**
   * Main entry point to run the search.
   */
  async run(): Promise<void> {
    // Basic validation
    if (!this.params.find) {
      return
    }
    if (this.params.paused) {
      return
    }

    // Delegate to workflow
    await this.workflow.run(this.params)
  }

  stop(): void {
    this.workflow.stop()
  }

  abort(): void {
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
    // Deprecated
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

  updateDocumentsForChangedFile(uri: vscode.Uri): void {
    this.invalidateFileInCache(uri)
  }

  async startup(): Promise<void> {
    // legacy support
  }

  async shutdown(): Promise<void> {
    this.stop()
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
        undefined // No abort signal for single file scan
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
      console.error(`Error scanning file ${document.uri.fsPath}:`, e)
    }
  }
}
