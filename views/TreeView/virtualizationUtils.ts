import { FileTreeNode, FolderNode, FileNode } from './index'
import { SerializedTransformResultEvent } from '../../../model/SearchReplaceViewTypes'

type SearchMatch = NonNullable<
  SerializedTransformResultEvent['matches']
>[number]

export interface MatchNode {
  type: 'match'
  match: SearchMatch
  parentFile: FileNode
  matchIndex: number
  resultIndex: number // Index in the 'results' array of the file
}

export type VirtualNode = FileTreeNode | MatchNode

export interface FlatNode {
  node: VirtualNode
  depth: number
  index: number
}

export function flattenTree(
  node: FileTreeNode,
  expandedFolders: Set<string>,
  expandedFiles: Set<string>,
  depth: number = 0,
  result: FlatNode[] = []
): FlatNode[] {
  // Add current node
  result.push({ node, depth, index: result.length })

  // If it's a folder and expanded, process children
  if (node.type === 'folder' && expandedFolders.has(node.relativePath)) {
    node.children.forEach((child) => {
      flattenTree(child, expandedFolders, expandedFiles, depth + 1, result)
    })
  }
  // If it's a file and expanded, process matches (flatten them into rows)
  else if (node.type === 'file' && expandedFiles.has(node.absolutePath)) {
    // Iterate over results in the file
    node.results.forEach((res, resIdx) => {
      if (res.matches) {
        res.matches.forEach((match, matchIdx) => {
          const matchNode: MatchNode = {
            type: 'match',
            match,
            parentFile: node,
            matchIndex: matchIdx,
            resultIndex: resIdx,
          }
          result.push({
            node: matchNode,
            depth: depth + 1,
            index: result.length,
          })
        })
      }
    })
  }

  return result
}

export function flattenList(
  nodes: FileTreeNode[],
  expandedFolders: Set<string>,
  expandedFiles: Set<string>
): FlatNode[] {
  const result: FlatNode[] = []
  nodes.forEach((node) => {
    flattenTree(node, expandedFolders, expandedFiles, 0, result)
  })
  return result
}
