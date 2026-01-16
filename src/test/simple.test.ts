import { describe, it, expect, vi } from 'vitest'
import * as vscode from 'vscode'

vi.mock('vscode', () => {
  return {
    window: {
      createOutputChannel: vi.fn(),
    },
    Uri: {
      file: vi.fn(),
    },
  }
})

describe('Simple Test', () => {
  it('should mock vscode', () => {
    expect(vscode.window.createOutputChannel).toBeDefined()
  })
})
