export class Pipeline<T> {
  private input: T[]

  private constructor(input: T[]) {
    this.input = input
  }

  static from<T>(input: T[]): Pipeline<T> {
    return new Pipeline(input)
  }

  filter(predicate: (item: T) => boolean): Pipeline<T> {
    this.input = this.input.filter(predicate)
    return this
  }

  async filterAsync(
    predicate: (item: T) => Promise<boolean>
  ): Promise<Pipeline<T>> {
    const results = await Promise.all(this.input.map(predicate))
    this.input = this.input.filter((_, index) => results[index])
    return this
  }

  map<U>(mapper: (item: T) => U): Pipeline<U> {
    return new Pipeline(this.input.map(mapper))
  }

  async mapAsync<U>(mapper: (item: T) => Promise<U>): Promise<Pipeline<U>> {
    const results = await Promise.all(this.input.map(mapper))
    return new Pipeline(results)
  }

  async processConcurrent(
    concurrency: number,
    processor: (item: T) => Promise<void>
  ): Promise<void> {
    const queue = []
    const executing = new Set<Promise<void>>()

    for (const item of this.input) {
      const p = Promise.resolve().then(() => processor(item))
      executing.add(p)
      const clean = () => executing.delete(p)
      p.then(clean).catch(clean)

      if (executing.size >= concurrency) {
        await Promise.race(executing)
      }
    }
    await Promise.all(executing)
  }

  execute(): T[] {
    return this.input
  }
}
