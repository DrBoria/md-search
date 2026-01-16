import { suite, test } from 'mocha'
import * as assert from 'assert'
import { TextSearchService } from '../../../backend/search/services/TextSearchService'
import { Params } from '../../../backend/types'

suite('TextSearchService Tests', () => {
  let service: TextSearchService

  setup(() => {
    service = new TextSearchService()
  })

  const baseParams: Params = {
    find: '',
    replace: '',
    matchCase: false,
    wholeWord: false,
    searchMode: 'text',
  }

  test('should find simple text matches (case-insensitive default)', async () => {
    const content = 'Hello World hello'
    const params: Params = {
      ...baseParams,
      find: 'hello',
      matchCase: false,
      searchMode: 'text',
    }

    const matches = await service.searchInFile('test.txt', content, params)

    assert.strictEqual(matches.length, 2)
    assert.strictEqual(matches[0].source, 'Hello')
    assert.strictEqual(matches[1].source, 'hello')
  })

  test('should find case-sensitive text matches', async () => {
    const content = 'Hello World hello'
    const params: Params = {
      ...baseParams,
      find: 'hello',
      matchCase: true,
      searchMode: 'text',
    }

    const matches = await service.searchInFile('test.txt', content, params)

    assert.strictEqual(matches.length, 1)
    assert.strictEqual(matches[0].source, 'hello')
  })

  test('should match whole words', async () => {
    const content = 'foobar foo bar'
    const params: Params = {
      ...baseParams,
      find: 'foo',
      wholeWord: true,
      searchMode: 'text',
    }

    const matches = await service.searchInFile('test.txt', content, params)

    assert.strictEqual(matches.length, 1)
    assert.strictEqual(matches[0].source, 'foo') // Should not match foobar
  })

  test('should find regex matches', async () => {
    const content = 'id: 123, id: 456'
    const params: Params = {
      ...baseParams,
      find: 'id: \\d+',
      searchMode: 'regex',
    }

    const matches = await service.searchInFile('test.txt', content, params)

    assert.strictEqual(matches.length, 2)
    assert.strictEqual(matches[0].source, 'id: 123')
  })

  test('should handle capture groups ($N)', async () => {
    const content = 'func name1() func name2()'
    // Regex to match function and capture name in group 1
    // Query syntax: <regex> $1
    const find = 'func (\\w+)\\(\\) $1'
    const params: Params = { ...baseParams, find, searchMode: 'regex' }

    const matches = await service.searchInFile('test.txt', content, params)

    assert.strictEqual(matches.length, 2)
    // Expecting ONLY the captured name
    assert.strictEqual(matches[0].source, 'name1')
    assert.strictEqual(matches[1].source, 'name2')
  })

  test('should skip match if capture group is missing/empty', async () => {
    const content = 'foo bar'
    // (foo) or (baz)
    // search: (foo)|(baz) $2
    // For 'foo', group 1 is 'foo', group 2 is undefined/empty. Should skip.

    const find = '(foo)|(baz) $2'
    const params: Params = { ...baseParams, find, searchMode: 'regex' }

    const matches = await service.searchInFile('test.txt', content, params)

    assert.strictEqual(matches.length, 0)
  })
})
