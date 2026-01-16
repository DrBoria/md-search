import { TypedEmitter } from 'tiny-typed-emitter'
import * as vscode from 'vscode'
import { debounce } from 'lodash'
import { Params, IAstxExtension } from '../types'
import { AstxRunnerEvents } from '../../model/SearchRunnerTypes'
import { SearchWorkflow } from '../search/workflow/SearchWorkflow'
import { FileService } from '../search/services/FileService'
import { TextSearchService } from '../search/services/TextSearchService'
import { SearchCache } from '../search/services/CacheService'

export type { TransformResultEvent } from '../../model/SearchRunnerTypes'

/**
 * Controller class that manages the SearchWorkflow.
 * Refactored to delegate logic to SearchWorkflow, FileIndexer, and TextSearchRunner.
 */
export class SearchRunner extends TypedEmitter<AstxRunnerEvents> {
  private params: Params
  private workflow: SearchWorkflow
  private extension: IAstxExtension

  // Services
  private fileService: FileService
  private textSearchService: TextSearchService
  private cacheService: SearchCache

  constructor(extension: IAstxExtension) {
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
  setParams(params: Params): void {
    const prevFn = JSON.stringify(this.params)
    const newFn = JSON.stringify(params)

    this.params = params
    this.params = params
    // console.log(
    //   '[SearchRunner] setParams called',
    //   'params:',
    //   JSON.stringify(params),
    //   'changed:',
    //   prevFn !== newFn
    // )

    if (prevFn !== newFn) {
      // console.log('[SearchRunner] Parameters changed, triggering restartSoon')
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
    this.cacheService.clearCacheForFile(uri)
  }

  excludeFileFromCache(uri: vscode.Uri): void {
    this.cacheService.excludeFileFromCache(uri)
  }

  updateDocumentsForChangedFile(uri: vscode.Uri): void {
    // Stub or implement if needed. TextSearchRunner might handle this internally via cache check or we need to forward it.
    // For now, clearing cache for file is safe fallback.
    this.clearCacheForFile(uri)
  }
}
