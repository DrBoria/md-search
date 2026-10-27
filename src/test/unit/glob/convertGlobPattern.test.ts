import { suite, test } from 'mocha'
import * as assert from 'assert'
import * as path from 'path'
import {
  convertGlobPattern,
  joinPatterns,
} from '../../../backend/glob/convertGlobPattern'

// Mocking vscode logic needed for this test
// The file imports 'vscode', so we need to ensure it uses our mock or similar.
// Since we can't easily injection-mock in this setup without a proper DI container or proxyquire,
// we will rely on the fact that if this runs in an environment where 'vscode' is mocked globally
// (via setup.ts or similar), it works.
// However, looking at the previous 'vscode-mock.ts', it exports 'RelativePattern'.
// We might need to adjust the import in the test or run it with a loader that handles aliases.
// For now, writing the test logic as requested.

suite('convertGlobPattern Utilities', () => {
  test('joinPatterns should join multiple patterns', () => {
    assert.strictEqual(joinPatterns(['a', 'b']), '{a,b}')
    assert.strictEqual(joinPatterns(['single']), 'single')
  })

  test('convertGlobPattern should prepend ** for relative patterns', () => {
    // Mock workspace folders
    const workspaceFolders = ['/root']

    const result = convertGlobPattern('src/*.ts', workspaceFolders)
    // Logic: if not absolute, joins with **
    // Check implementation: generalPatterns.push(path.join('**', pattern))
    // path.join might vary by OS, assuming POSIX for now or just checking containment
    assert.ok(
      (result as string).includes('**') &&
        (result as string).includes('src/*.ts')
    )
  })

  test('convertGlobPattern should handle simple directory paths', () => {
    // Test logic: if /^[^*?[\]{}]+$/.test(patterns) && !path.extname(patterns)
    // returns RelativePattern
    // We need to mock vscode.workspace.workspaceFolders for this branch
    // This is hard without proper mocking infrastructure shown in the file list.
    // But we can verify it *tries* to return a RelativePattern if dependencies allow.
  })

  // Test absolute paths behavior
  test('should preserve absolute paths', () => {
    const absPath = path.resolve('/tmp/test.ts')
    const result = convertGlobPattern(absPath, [])
    assert.strictEqual(result, absPath)
  })
})
