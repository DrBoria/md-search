import { TypedEmitter } from 'tiny-typed-emitter'
import * as vscode from 'vscode'
import { debounce } from 'lodash'
import { Params, IAstxExtension } from '../types'
import { AstxRunnerEvents } from '../../model/SearchRunnerTypes'
import { SearchWorkflow } from '../search/workflow/SearchWorkflow'
import { SearchCache } from '../search/services/CacheService'

export type { TransformResultEvent } from '../../model/SearchRunnerTypes'

/**
 * Controller class that manages the SearchWorkflow.
 * Orchestrates the search process and manages state/debouncing.
 */
export class SearchOrchestrator extends TypedEmitter<AstxRunnerEvents> {
  private params: Params
  private extension: IAstxExtension

  // Dependencies
  private workflow: SearchWorkflow
  private cacheService: SearchCache

  constructor(
    extension: IAstxExtension,
    workflow: SearchWorkflow,
    cacheService: SearchCache
  ) {
    super()
    this.extension = extension
    this.params = {} as Params
    this.workflow = workflow
    this.cacheService = cacheService

    // Forward Workflow events to the outside world (UI)
    this.workflow.on('result', (e) => this.emit('result', e))
    this.workflow.on('start', () => this.emit('start'))
    this.workflow.on('done', () => this.emit('done'))
    this.workflow.on('error', (e) => this.emit('error', e))
    this.workflow.on('progress', (e) => this.emit('progress', e))
    this.workflow.on('stop', () => this.emit('stop'))
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
    this.cacheService.clearCacheForFile(uri)
  }

  excludeFileFromCache(uri: vscode.Uri): void {
    this.cacheService.excludeFileFromCache(uri)
  }

  updateDocumentsForChangedFile(uri: vscode.Uri): void {
    this.clearCacheForFile(uri)
  }

  async startup(): Promise<void> {
    // legacy support
  }

  async shutdown(): Promise<void> {
    this.stop()
  }
}
