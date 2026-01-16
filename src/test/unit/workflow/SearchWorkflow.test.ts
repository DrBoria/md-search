import { suite, test } from 'mocha'
import * as assert from 'assert'
import { SearchWorkflow } from '../../../backend/search/workflow/SearchWorkflow'
import { Params } from '../../../backend/types'

// Mock Interfaces (simplified)
class MockFileService {
  async findFiles() {
    return ['file:///root/a.ts', 'file:///root/b.ts']
  }
  async readFile() {
    return 'content'
  }
}

class MockTextSearchService {
  setAbortController() {
    // mock
  }
  async searchInFile(file: string) {
    if (file.includes('a.ts'))
      return [{ type: 'match', source: 'match' }] as any
    return []
  }
}

class MockCacheService {
  // Basic mocks
  getCurrentResults() {
    return new Map([['file:///root/prev.ts', {} as any]])
  }
  getResultsFromDepth() {
    return new Map([['file:///root/prev.ts', {} as any]])
  }
  getAncestorAtDepth() {
    return {
      children: new Map(),
      results: new Map(),
      processedFiles: new Set(),
    }
  }
  getCurrentNode() {
    return null
  }
  findSuitableCache() {
    return null
  }
  createCacheNode() {
    return {
      results: new Map(),
      processedFiles: new Set(),
      excludedFiles: new Set(),
      children: new Map(),
      params: {},
    }
  }
  addResult() {
    // mock
  }
  markCurrentAsComplete() {
    // mock
  }
  getProcessedFiles() {
    return new Set()
  }
  getExcludedFiles() {
    return new Set()
  }
}

suite('SearchWorkflow Tests', () => {
  let workflow: SearchWorkflow
  let fileService: any
  let textService: any
  let cacheService: any

  setup(() => {
    fileService = new MockFileService()
    textService = new MockTextSearchService()
    cacheService = new MockCacheService()

    workflow = new SearchWorkflow(fileService, textService, cacheService)
  })

  test('should run standard search flow', async () => {
    const params: Params = {
      find: 'test',
      matchCase: false,
      wholeWord: false,
      searchMode: 'text',
    }

    let resultCount = 0
    workflow.on('result', () => resultCount++)

    await workflow.run(params)

    assert.strictEqual(resultCount, 1, 'Should emit 1 result from a.ts')
  })

  test('should use cached files for nested search (Search in Results)', async () => {
    const params: Params = {
      find: 'refined',
      matchCase: false,
      wholeWord: false,
      searchMode: 'text',
      searchInResults: 1, // Nested
    }

    // Mock cache returning specific files
    cacheService.getResultsFromDepth = () =>
      new Map([['file:///root/cached.ts', {} as any]])
    cacheService.getAncestorAtDepth = () => ({
      children: new Map(),
      results: new Map(),
    })

    // Mock text service to match in cached file
    textService.searchInFile = async (f: string) =>
      f.includes('cached.ts') ? [{}] : []

    let resultCount = 0
    workflow.on('result', () => resultCount++)

    await workflow.run(params)

    assert.strictEqual(resultCount, 1, 'Should find match in cached file')
  })
})
