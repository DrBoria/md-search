import { suite, test } from 'mocha'
import * as assert from 'assert'
import { Pipeline } from '../../../backend/search/utilities/Pipeline'

const emptySource: number[] = []

suite('Pipeline Utility Tests', () => {
  test('should filter and map data correctly', async () => {
    const source = [1, 2, 3, 4, 5]

    const result = await Pipeline.from(source)
      .filter((num: number) => num % 2 === 0) // Keep evens: 2, 4
      .map(async (num: number) => num * 10) // Multiply by 10: 20, 40
      .execute()

    assert.deepStrictEqual(result, [20, 40])
  })

  test('should handle empty source', async () => {
    const result = await Pipeline.from(emptySource)
      .map(async (x: any) => x)
      .execute()

    assert.deepStrictEqual(result, [])
  })

  test('should handle concurrent async operations', async () => {
    const source = [10, 20, 30]

    const result = await Pipeline.from(source)
      .map(async (num: number) => {
        await new Promise((r) => setTimeout(r, 10)) // simulate delay
        return num + 1
      })
      .execute()

    assert.deepStrictEqual(result, [11, 21, 31])
  })
})
