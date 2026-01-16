export class Container {
  private static services = new Map<string, any>()

  static register<T>(key: string, instance: T): void {
    this.services.set(key, instance)
  }

  static resolve<T>(key: string): T {
    const service = this.services.get(key)
    if (!service) {
      throw new Error(`Service not found: ${key}`)
    }
    return service
  }

  static clear(): void {
    this.services.clear()
  }
}

export const SERVICE_KEYS = {
  FileService: 'FileService',
  TextSearchService: 'TextSearchService',
  CacheService: 'CacheService',
  SearchWorkflow: 'SearchWorkflow',
  SearchOrchestrator: 'SearchOrchestrator',
}
