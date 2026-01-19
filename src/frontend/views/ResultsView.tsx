import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { useSearchGlobal } from './context/SearchGlobalContext';
import { URI } from 'vscode-uri';
import * as path from 'path-browserify';
import { Button } from '../components/ui/button';
import { TreeViewNode } from './TreeView';
import { FileIcon } from '../components/icons';
import { getHighlightedMatchContext } from './TreeView/highligtedContext';
import { getHighlightedMatchContextWithReplacement } from './TreeView/highlightedContextWithReplacement';
import { SerializedTransformResultEvent, SearchLevel } from '../../model/SearchReplaceViewTypes';
import { cn } from "../utils";

interface ResultsViewProps {
    levelIndex: number;
}

// Helper Interfaces
interface FileTreeNodeBase {
    name: string;
    relativePath: string;
}

interface FolderNode extends FileTreeNodeBase {
    type: 'folder';
    children: FileTreeNode[];
    stats?: {
        numMatches: number;
        numFilesWithMatches: number;
    };
}

interface FileNode extends FileTreeNodeBase {
    type: 'file';
    absolutePath: string;
    results: SerializedTransformResultEvent[];
}

type FileTreeNode = FolderNode | FileNode;

// Helper Functions
function uriToPath(uriString: string | undefined): string {
    if (!uriString) return '';
    try {
        const uri = URI.parse(uriString);
        if (uri.scheme === 'file') {
            return uri.fsPath;
        }
        return uriString;
    } catch (e) {
        return uriString;
    }
}

function buildFileTree(
    resultsByFile: Record<string, SerializedTransformResultEvent[]>,
    workspacePathUri: string,
    customOrder?: { [key: string]: number },
): FolderNode {
    const root: FolderNode = { name: '', relativePath: '', type: 'folder', children: [], stats: { numMatches: 0, numFilesWithMatches: 0 } };
    const workspacePath = uriToPath(workspacePathUri);

    const findOrCreateFolder = (
        parent: FolderNode,
        segment: string,
        currentRelativePath: string
    ): FolderNode => {
        const existing = parent.children?.find(
            (child) => child.type === 'folder' && child.name === segment
        ) as FolderNode | undefined;
        if (existing) {
            return existing;
        }
        const newFolder: FolderNode = {
            name: segment,
            relativePath: currentRelativePath,
            type: 'folder',
            children: [],
            stats: { numMatches: 0, numFilesWithMatches: 0 }
        };
        parent.children.push(newFolder);
        return newFolder;
    };

    Object.entries(resultsByFile).forEach(([absoluteFilePathOrUri, fileResults]) => {
        const absoluteFilePath = uriToPath(absoluteFilePathOrUri);
        const displayPath = workspacePath
            ? path.relative(workspacePath, absoluteFilePath)
            : absoluteFilePath;

        const posixDisplayPath = displayPath.replace(/\\/g, '/');
        const segments = posixDisplayPath.split('/').filter(Boolean);
        let currentNode = root;
        let currentRelativePath = '';

        const fileMatches = fileResults?.length > 0 && fileResults[0]?.matches
            ? fileResults.reduce((sum, r) => sum + (r.matches?.length || 0), 0)
            : 0;
        const hasMatches = fileMatches > 0;

        if (hasMatches) {
            root.stats!.numMatches += fileMatches;
            root.stats!.numFilesWithMatches += 1;
        }

        segments.forEach((segment, index) => {
            currentRelativePath = currentRelativePath ? path.posix.join(currentRelativePath, segment) : segment;
            if (index === segments.length - 1) {
                const fileNode: FileNode = {
                    name: path.basename(absoluteFilePath),
                    relativePath: posixDisplayPath,
                    absolutePath: absoluteFilePathOrUri,
                    type: 'file',
                    results: fileResults
                };
                currentNode.children.push(fileNode);
            } else {
                currentNode = findOrCreateFolder(currentNode, segment, currentRelativePath);
                if (hasMatches) {
                    currentNode.stats!.numMatches += fileMatches;
                    currentNode.stats!.numFilesWithMatches += 1;
                }
            }
        });
    });

    // Sorting logic
    const sortNodeChildren = (node: FolderNode) => {
        node.children.sort((a, b) => {
            if (customOrder) {
                const aOrder = customOrder[a.relativePath] ?? 999999;
                const bOrder = customOrder[b.relativePath] ?? 999999;
                if (aOrder !== bOrder) return aOrder - bOrder;
            }
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        node.children.forEach(child => {
            if (child.type === 'folder') sortNodeChildren(child);
        });
    };
    sortNodeChildren(root);

    return root;
}

export const ResultsView: React.FC<ResultsViewProps> = ({ levelIndex }) => {
    const {
        status: currentStatus,
        vscode,
        searchLevels,
        setSearchLevels,
        setResultsByFile,
        isInNestedSearch,
        values: globalValues,
        workspacePath,
        viewMode: globalViewMode,
        staleResultsByFile, // FROM CONTEXT
        staleStatus, // FROM CONTEXT
        staleLevel, // FROM CONTEXT
    } = useSearchGlobal();

    // Get Level Data
    const level = searchLevels[levelIndex];
    // Helper to get safe values
    const levelResults = level?.resultsByFile || {};

    // Determine effective results (current or stale)
    // Determine effective results (current or stale)
    // BUT only if we are truly empty.
    const effectiveResultsByFile = useMemo(() => {
        const hasCurrent = Object.keys(levelResults).length > 0;
        if (hasCurrent) return levelResults;

        // If we are nested, and we have stale results that match this level?
        // Check staleLevel matches levelIndex.
        if (staleResultsByFile && Object.keys(staleResultsByFile).length > 0 && staleLevel === levelIndex) {
            return staleResultsByFile;
        }

        return levelResults;
    }, [levelResults, staleResultsByFile, staleLevel, levelIndex]);

    const isStale = Object.keys(levelResults).length === 0 && staleResultsByFile !== null && Object.keys(staleResultsByFile || {}).length > 0 && staleLevel === levelIndex;

    // Use level-specific values if available, otherwise global
    const values = level?.values || globalValues;
    // Use level-specific viewMode if available, otherwise fallback to global
    const viewMode = level?.viewMode || globalViewMode || 'tree';

    // Local State for Pagination
    const [visibleResultsLimit, setVisibleResultsLimit] = useState(50);
    const [isLoadingMore, setIsLoadingMore] = useState(false);

    // Derived State for Pagination
    const paginatedFilePaths = useMemo(() => {
        return Object.keys(effectiveResultsByFile).slice(0, visibleResultsLimit);
    }, [effectiveResultsByFile, visibleResultsLimit]);


    // Handlers
    const loadMoreResults = useCallback(() => {
        if (isLoadingMore) return;
        setIsLoadingMore(true);
        setTimeout(() => {
            setVisibleResultsLimit(prev => prev + 50);
            setIsLoadingMore(false);
        }, 50);
    }, [isLoadingMore]);

    const handleFileClick = useCallback((absolutePathOrUri: string) => {
        vscode.postMessage({ type: 'openFile', filePath: absolutePathOrUri });
    }, [vscode]);

    const handleResultItemClick = useCallback((absolutePathOrUri: string, range?: { start: number; end: number }) => {
        vscode.postMessage({ type: 'openFile', filePath: absolutePathOrUri, ...(range && { range }) });
    }, [vscode]);

    const handleReplaceSelectedFiles = useCallback((filePaths: string[]) => {
        if (!values?.find || !values.replace || filePaths.length === 0) return;

        // If nested, we need to handle replace differently? 
        // Logic in `useSearchItemController` handled this via IPC message 'replace' with filePaths.
        vscode.postMessage({ type: 'replace', filePaths });
    }, [values.find, values.replace, vscode]);

    const handleExcludeFile = useCallback((filePath: string) => {
        vscode.postMessage({ type: 'excludeFile', filePath });
        // Update local state to remove file immediately
        setSearchLevels(prev => {
            const newLevels = [...prev];
            const currentLevel = newLevels[levelIndex];
            if (currentLevel && currentLevel.resultsByFile[filePath]) {
                const updatedResultsByFile = { ...currentLevel.resultsByFile };
                delete updatedResultsByFile[filePath];
                newLevels[levelIndex] = { ...currentLevel, resultsByFile: updatedResultsByFile };
            }
            return newLevels;
        });
    }, [vscode, levelIndex, setSearchLevels]);

    const toggleFileExpansion = useCallback((relativePath: string) => {
        setSearchLevels(prev => {
            const newLevels = [...prev];
            if (newLevels[levelIndex]) {
                const newSet = new Set(newLevels[levelIndex].expandedFiles);
                if (newSet.has(relativePath)) newSet.delete(relativePath);
                else newSet.add(relativePath);
                newLevels[levelIndex] = { ...newLevels[levelIndex], expandedFiles: newSet };
            }
            return newLevels;
        });
    }, [levelIndex, setSearchLevels]);

    const toggleFolderExpansion = useCallback((relativePath: string) => {
        setSearchLevels(prev => {
            const newLevels = [...prev];
            if (newLevels[levelIndex]) {
                const newSet = new Set(newLevels[levelIndex].expandedFolders);
                if (newSet.has(relativePath)) newSet.delete(relativePath);
                else newSet.add(relativePath);
                newLevels[levelIndex] = { ...newLevels[levelIndex], expandedFolders: newSet };
            }
            return newLevels;
        });
    }, [levelIndex, setSearchLevels]);

    // Drag handlers (simplified)
    const handleDragStart = useCallback((e: React.DragEvent, node: FileTreeNode) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ relativePath: node.relativePath, type: node.type }));
        e.dataTransfer.effectAllowed = 'move';
    }, []);
    const handleDragOver = useCallback((e: React.DragEvent, targetNode: FileTreeNode) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }, []);
    const handleDrop = useCallback((e: React.DragEvent, targetNode: FileTreeNode) => { e.preventDefault(); }, []);


    // Derivations
    const paginatedResults = useMemo(() => {
        if (!effectiveResultsByFile || !paginatedFilePaths || paginatedFilePaths.length === 0) {
            return {};
        }
        return paginatedFilePaths.reduce((acc, path) => {
            if (effectiveResultsByFile[path]) {
                acc[path] = effectiveResultsByFile[path];
            }
            return acc;
        }, {} as Record<string, SerializedTransformResultEvent[]>);
    }, [paginatedFilePaths, effectiveResultsByFile]);

    const currentExpandedFiles = useMemo((): Set<string> => {
        const files = level?.expandedFiles;
        return files instanceof Set ? files : new Set<string>(files || []);
    }, [level]);

    const currentExpandedFolders = useMemo((): Set<string> => {
        const folders = level?.expandedFolders;
        return folders instanceof Set ? folders : new Set<string>(folders || []);
    }, [level]);


    // Render Functions
    const renderListViewResults = () => {
        const resultEntries = Object.entries(paginatedResults);

        if (resultEntries.length === 0) {
            // Check if searching
            if (status.running) {
                return (
                    <div className="p-[10px] text-[var(--vscode-descriptionForeground)] text-center flex justify-center items-center gap-2">
                        <span className="codicon codicon-loading codicon-modifier-spin"></span><span>Searching...</span>
                    </div>
                );
            }
            return (
                <div className="p-[10px] text-[var(--vscode-descriptionForeground)] text-center">No matches found.</div>
            );
        }

        return (
            <>
                {resultEntries.map(([filePath, results]) => {
                    const displayPath = workspacePath
                        ? path.relative(uriToPath(workspacePath), uriToPath(filePath))
                        : uriToPath(filePath);

                    // Normalize path for consistent display
                    let cleanDisplayPath = displayPath;
                    if (cleanDisplayPath.startsWith('/') || cleanDisplayPath.startsWith('\\')) {
                        cleanDisplayPath = cleanDisplayPath.substring(1);
                    }

                    const node: FileNode = {
                        type: 'file',
                        name: cleanDisplayPath,
                        relativePath: cleanDisplayPath,
                        absolutePath: filePath,
                        results: results
                    };

                    /* 
                       Note: In SearchReplaceViewLayout they use '0' level for list view items. 
                       We should do the same to match styles.
                    */

                    return (
                        <TreeViewNode
                            key={filePath}
                            node={node}
                            level={0}
                            expandedFolders={currentExpandedFolders}
                            toggleFolderExpansion={toggleFolderExpansion}
                            expandedFiles={currentExpandedFiles}
                            toggleFileExpansion={toggleFileExpansion}
                            handleFileClick={handleFileClick}
                            handleResultItemClick={handleResultItemClick}
                            handleReplace={handleReplaceSelectedFiles}
                            currentSearchValues={values}
                            handleExcludeFile={handleExcludeFile}
                            onDragStart={handleDragStart}
                            onDragOver={handleDragOver}
                            onDrop={handleDrop}
                        />
                    );
                })}
                {Object.keys(effectiveResultsByFile).length > visibleResultsLimit && (
                    <div className="p-[10px] text-center">
                        <button className="bg-[var(--input-background)] border border-[var(--panel-view-border)] text-[var(--panel-tab-active-border)] px-3 py-[6px] rounded-[2px] cursor-pointer hover:border-[var(--panel-tab-active-border)]" onClick={loadMoreResults} disabled={isLoadingMore}>
                            {isLoadingMore ? 'Loading...' : `Load more results`}
                        </button>
                    </div>
                )}
            </>
        );
    };

    const renderTreeViewResults = () => {
        if (!paginatedResults || Object.keys(paginatedResults).length === 0) {
            return currentStatus.running ? (
                <div className="p-[10px] text-center flex gap-2 justify-center"><span className="codicon codicon-loading codicon-modifier-spin" /><span>Searching...</span></div>
            ) : (
                <div className="p-[10px] text-center text-[var(--vscode-descriptionForeground)]">No matches found.</div>
            );
        }

        const paginatedFileTree = buildFileTree(paginatedResults, workspacePath, {}); // Custom order not supported yet

        return (
            <>
                {paginatedFileTree.children.length > 0 ? (
                    paginatedFileTree.children.map(node => (
                        <TreeViewNode
                            key={node.relativePath}
                            node={node}
                            level={0}
                            expandedFolders={currentExpandedFolders}
                            toggleFolderExpansion={toggleFolderExpansion}
                            expandedFiles={currentExpandedFiles}
                            toggleFileExpansion={toggleFileExpansion}
                            handleFileClick={handleFileClick}
                            handleResultItemClick={handleResultItemClick}
                            handleReplace={handleReplaceSelectedFiles}
                            currentSearchValues={values}
                            handleExcludeFile={handleExcludeFile}
                            onDragStart={handleDragStart}
                            onDragOver={handleDragOver}
                            onDrop={handleDrop}
                        />
                    ))
                ) : null}
                {Object.keys(effectiveResultsByFile).length > visibleResultsLimit && (
                    <div className="p-[10px] text-center">
                        <button className="bg-[var(--input-background)] border border-[var(--panel-view-border)] text-[var(--panel-tab-active-border)] px-3 py-[6px] rounded-[2px] cursor-pointer hover:border-[var(--panel-tab-active-border)]" onClick={loadMoreResults} disabled={isLoadingMore}>
                            {isLoadingMore ? 'Loading...' : `Load more results`}
                        </button>
                    </div>
                )}
            </>
        );
    };

    const status = currentStatus; // Alias for compatibility

    return (
        <div className={cn(
            "flex-grow overflow-auto mt-2 transition-opacity duration-200",
            isStale ? "opacity-50" : ""
        )}>
            {viewMode === 'list' ? renderListViewResults() : renderTreeViewResults()}
        </div>
    );
};
