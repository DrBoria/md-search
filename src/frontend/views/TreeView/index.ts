export type FileTreeNode = FolderNode | FileNode

export interface FileTreeNodeBase {
  name: string
  relativePath: string
  absolutePath: string
}

export interface FolderNode extends FileTreeNodeBase {
  type: 'folder'
  children: FileTreeNode[]
  results?: any[]
  stats: {
    numMatches: number
    numFilesWithMatches: number
  }
}

export interface FileNode extends FileTreeNodeBase {
  type: 'file'
  file: string // URI
  results: any[]
  stats?: {
    numMatches: number
    numFilesWithMatches: number
  }
  description?: string
}
