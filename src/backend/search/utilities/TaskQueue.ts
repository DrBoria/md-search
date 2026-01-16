export interface TaskQueueOptions {
  concurrency: number
  signal?: AbortSignal
}

export class TaskQueue<T> {
  private queue: (() => Promise<T>)[] = []
  private activeCount = 0
  private concurrency: number
  private signal?: AbortSignal
  private resolveAll?: () => void
  private results: T[] = []
  private errors: Error[] = []

  constructor(options: TaskQueueOptions) {
    this.concurrency = options.concurrency
    this.signal = options.signal
  }

  add(task: () => Promise<T>): void {
    this.queue.push(task)
    this.processNext()
  }

  addAll(tasks: (() => Promise<T>)[]): void {
    tasks.forEach((task) => this.add(task))
  }

  private async processNext(): Promise<void> {
    if (this.signal?.aborted) return
    if (this.activeCount >= this.concurrency) return
    if (this.queue.length === 0) {
      if (this.activeCount === 0 && this.resolveAll) {
        this.resolveAll()
      }
      return
    }

    const task = this.queue.shift()
    if (!task) return

    this.activeCount++

    try {
      const result = await task()
      if (!this.signal?.aborted) {
        this.results.push(result)
      }
    } catch (error) {
      if (!this.signal?.aborted) {
        this.errors.push(
          error instanceof Error ? error : new Error(String(error))
        )
      }
    } finally {
      this.activeCount--
      this.processNext()
    }
  }

  async onIdle(): Promise<{ results: T[]; errors: Error[] }> {
    if (this.queue.length === 0 && this.activeCount === 0) {
      return { results: this.results, errors: this.errors }
    }

    return new Promise((resolve) => {
      this.resolveAll = () =>
        resolve({ results: this.results, errors: this.errors })
      // Try to kickstart if nothing is running but items are in queue (edge case)
      if (this.activeCount < this.concurrency) {
        this.processNext()
      }
    })
  }
}
