import { suite, test } from 'mocha'
import * as assert from 'assert'
import { SearchCache } from '../backend/search/services/CacheService'

suite('SearchCache Service Tests', () => {
  let cacheService: SearchCache

  //@ts-ignore
  setup(() => {
    cacheService = new SearchCache()
  })

  test('should invalidate cache when searchMode changes', () => {
    // 1. Create a cache node for TEXT search "foo"
    const nodeText = cacheService.createCacheNode(
      'foo',
      false, // matchCase
      false, // wholeWord
      undefined, // exclude
      undefined, // include
      'text', // searchMode
      true // isGlobal
    )

    assert.strictEqual(nodeText.params.searchMode, 'text')
    assert.strictEqual(cacheService.getCurrentNode(), nodeText)

    // 2. Try to find suitable cache for REGEX search "foo" (same query)
    // This should return NULL or a different node, NOT the text node
    const foundNodeRegex = cacheService.findSuitableCache(
      'foo',
      false,
      false,
      undefined,
      undefined,
      'regex', // Different mode
      true
    )

    // Expectation: Should NOT return the text node
    assert.notStrictEqual(
      foundNodeRegex,
      nodeText,
      'Should not reuse Text cache for Regex search'
    )

    // 3. Create cache node for REGEX
    const nodeRegex = cacheService.createCacheNode(
      'foo',
      false,
      false,
      undefined,
      undefined,
      'regex',
      true
    )

    assert.strictEqual(nodeRegex.params.searchMode, 'regex')
    assert.notStrictEqual(nodeRegex, nodeText)
  })

  test('should reuse cache when searchMode matches', () => {
    // 1. Create a cache node for TEXT search "bar"
    const nodeText = cacheService.createCacheNode(
      'bar',
      false,
      false,
      undefined,
      undefined,
      'text',
      true
    )

    // 2. Find suitable cache for same TEXT search
    const foundNode = cacheService.findSuitableCache(
      'bar',
      false,
      false,
      undefined,
      undefined,
      'text', // Same mode
      true
    )

    assert.strictEqual(
      foundNode,
      nodeText,
      'Should reuse cache when mode and params match'
    )
  })

  test('should support ASTX search mode', () => {
    const nodeAstx = cacheService.createCacheNode(
      'foo',
      false,
      false,
      undefined,
      undefined,
      'astx',
      true
    )

    assert.strictEqual(nodeAstx.params.searchMode, 'astx')

    const foundNode = cacheService.findSuitableCache(
      'foo',
      false,
      false,
      undefined,
      undefined,
      'astx',
      true
    )

    assert.strictEqual(foundNode, nodeAstx)

    const foundNodeText = cacheService.findSuitableCache(
      'foo',
      false,
      false,
      undefined,
      undefined,
      'text',
      true
    )

    assert.notStrictEqual(
      foundNodeText,
      nodeAstx,
      'Should not mix ASTX and Text caches'
    )
  })

  test('isCacheCompatible should respect searchMode', () => {
    // We can't access private method directly in TS without cast,
    // but we verified behavior via public APIs above.
    // This test reinforces the createCacheNode behavior which relies on it.

    const node = cacheService.createCacheNode(
      'test',
      false,
      false,
      undefined,
      undefined,
      'text',
      true
    )

    // Refinement check (child node creation)
    const childNode = cacheService.createCacheNode(
      'testing',
      false,
      false,
      undefined,
      undefined,
      'text',
      true
    )

    // Only if compatible (starts with) AND same params
    // 'testing' starts with 'test'
    assert.strictEqual(
      childNode.parent,
      node,
      'Should be child of compatible parent'
    )

    // Now try with different mode
    const regexNode = cacheService.createCacheNode(
      'testing',
      false,
      false,
      undefined,
      undefined,
      'regex',
      true
    )

    // regexNode should NOT be a child of 'text' node 'test' even if 'testing' starts with 'test'
    // because the parent (text) is not compatible with child (regex) requirements?
    // Actually, createCacheNode logic:
    // finds parent using findSuitableCache(..., searchMode='regex')
    // 'node' (text) is NOT suitable for 'regex'.
    // So regexNode should be a root or child of some other regex node.

    assert.notStrictEqual(
      regexNode.parent,
      node,
      'Regex node should not have Text node as parent'
    )
  })
})
