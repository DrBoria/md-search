import { suite, test } from 'mocha'
import * as assert from 'assert'
import { TaskQueue } from '../../../backend/search/utilities/TaskQueue'

suite('TaskQueue Utility Tests', () => {
  test('should process tasks with concurrency limit', async () => {
    const queue = new TaskQueue<number>({ concurrency: 2 })
    const results: number[] = []

    // Create 5 tasks that take some time
    const tasks = [1, 2, 3, 4, 5].map((id) => async () => {
      await new Promise((resolve) => setTimeout(resolve, 10)) // simulate work
      results.push(id)
      return id
    })

    queue.addAll(tasks)
    await queue.onIdle()

    assert.strictEqual(results.length, 5)
    // Order isn't guaranteed with concurrency, but all should finish
    tasks.forEach((_, i) => assert.ok(results.includes(i + 1)))
  })

  test('should abort tasks when signal is aborted', async () => {
    const controller = new AbortController()
    const queue = new TaskQueue<void>({
      concurrency: 1,
      signal: controller.signal,
    })

    let taskRunCount = 0
    const tasks = [1, 2, 3].map(() => async () => {
      taskRunCount++
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    queue.addAll(tasks)

    // Allow first task to start
    await new Promise((resolve) => setTimeout(resolve, 5))

    // Abort
    controller.abort()
    await queue.onIdle()

    // Only the first task (or maybe second if timing race) should have run.
    // The queue checks signal before starting new tasks.
    assert.ok(
      taskRunCount < 3,
      `Expected fewer than 3 tasks to run, got ${taskRunCount}`
    )
  })

  test('should handle task errors gracefully', async () => {
    const queue = new TaskQueue<string>({ concurrency: 1 })
    const results: string[] = []

    queue.add(async () => {
      results.push('success1')
      return 'ok'
    })

    queue.add(async () => {
      throw new Error('Task Failed')
    })

    queue.add(async () => {
      results.push('success2')
      return 'ok'
    })

    await queue.onIdle()

    assert.strictEqual(results.length, 2)
    assert.deepStrictEqual(results, ['success1', 'success2'])
  })
})
