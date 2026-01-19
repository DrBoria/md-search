import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { useSearchGlobal } from './context/SearchGlobalContext';
import { URI } from 'vscode-uri';
import * as path from 'path-browserify';
import { Button } from '../components/ui/button';
import { TreeViewNode } from './TreeView';
import { FileIcon } from '../components/icons';
import { getLineFromSource } from './utils';
import { getHighlightedMatchContext } from './TreeView/highligtedContext';
import { getHighlightedMatchContextWithReplacement } from './TreeView/highlightedContextWithReplacement';
import { SerializedTransformResultEvent, SearchLevel } from '../../model/SearchReplaceViewTypes';

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
        status,
        vscode,
        searchLevels,
        setSearchLevels,
        setResultsByFile, // needed for root exclude? 
        isInNestedSearch, // actually we know if we are nested by levelIndex > 0 usually, but let's check context
        values: globalValues, // root values, but for styling highlighted context we need LEVEL values
        workspacePath,
        viewMode: globalViewMode, // Global viewMode as fallback
    } = useSearchGlobal();

    // Get Level Data
    const level = searchLevels[levelIndex];
    // Helper to get safe values
    const resultsByFile = level?.resultsByFile || {};
    // Use level-specific values if available (for nested search context), otherwise global
    const values = level?.values || globalValues;
    // Use level-specific viewMode if available, otherwise fallback to global
    const viewMode = level?.viewMode || globalViewMode || 'tree';

    // Local State for Pagination
    const [visibleResultsLimit, setVisibleResultsLimit] = useState(50);
    const [isLoadingMore, setIsLoadingMore] = useState(false);

    // Derived State for Pagination
    const paginatedFilePaths = useMemo(() => {
        return Object.keys(resultsByFile).slice(0, visibleResultsLimit);
    }, [resultsByFile, visibleResultsLimit]);


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
        if (!resultsByFile || !paginatedFilePaths || paginatedFilePaths.length === 0) {
            return {};
        }
        return paginatedFilePaths.reduce((acc, path) => {
            if (resultsByFile[path]) {
                acc[path] = resultsByFile[path];
            }
            return acc;
        }, {} as Record<string, SerializedTransformResultEvent[]>);
    }, [paginatedFilePaths, resultsByFile]);

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

                    const totalMatches = results.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
                    if (totalMatches === 0) return null;

                    const filePathKey = filePath;
                    const isExpanded = currentExpandedFiles.has(filePath);

                    return (
                        <div key={filePathKey} className="mb-2 rounded-[3px] overflow-hidden">
                            <div
                                className="flex items-center p-[2px] gap-2 cursor-pointer hover:bg-[var(--vscode-list-hoverBackground)]"
                                onClick={() => toggleFileExpansion(filePath)}
                            >
                                <span className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`} />
                                <FileIcon filePath={filePath} />
                                <span
                                    className="font-bold cursor-pointer"
                                    onClick={(e) => { e.stopPropagation(); handleFileClick(filePath); }}
                                    title={`Click to open ${displayPath}`}
                                >
                                    {displayPath}
                                </span>
                                <span className="ml-auto mr-2 text-[var(--vscode-descriptionForeground)]">
                                    {totalMatches} matches
                                </span>
                                <button
                                    onClick={(e) => { e.stopPropagation(); handleExcludeFile(filePath); }}
                                    title={`Exclude ${displayPath} from search`}
                                    className="bg-transparent border-none p-[2px] cursor-pointer flex items-center text-[#bcbbbc] rounded-[3px] hover:bg-[rgba(128,128,128,0.2)] hover:text-[var(--vscode-errorForeground)]"
                                >
                                    <span className="codicon codicon-close" />
                                </button>
                            </div>

                            {isExpanded && (
                                <div className="py-1 bg-[var(--vscode-editor-background)]">
                                    {results.map((result, resultIdx) =>
                                        result.matches?.map((match, matchIdx) => (
                                            <div
                                                key={`${resultIdx}-${matchIdx}`}
                                                className="px-6 py-[2px] cursor-pointer relative hover:bg-[var(--vscode-list-hoverBackground)] group"
                                                onClick={() => handleResultItemClick(filePath, match)}
                                                title={getLineFromSource(result.source, match.start, match.end)}
                                            >
                                                {values.replace && values.replace.length > 0
                                                    ? getHighlightedMatchContextWithReplacement(result.source, match, values.find, values.replace, values.searchMode, values.matchCase, values.wholeWord, undefined, values.searchMode === 'regex')
                                                    : getHighlightedMatchContext(result.source, match, undefined, values.searchMode === 'regex')}

                                                {values.replace && (
                                                    <div className="absolute right-[5px] top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                                                        onClick={(e) => { e.stopPropagation(); handleReplaceSelectedFiles([filePath]); }}>
                                                        <button className="bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] border-none rounded-[2px] cursor-pointer px-[6px] py-[2px] text-xs hover:bg-[var(--vscode-button-hoverBackground)]" title="Replace this match">
                                                            <span className="codicon codicon-replace-all" />
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
                {Object.keys(resultsByFile).length > visibleResultsLimit && (
                    <div className="p-[10px] text-center">
                        <button className="bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] border-none px-3 py-[6px] rounded-[2px] cursor-pointer hover:bg-[var(--vscode-button-hoverBackground)]" onClick={loadMoreResults} disabled={isLoadingMore}>
                            {isLoadingMore ? 'Loading...' : `Load more results (${Object.keys(resultsByFile).length - visibleResultsLimit} remaining)`}
                        </button>
                    </div>
                )}
            </>
        );
    };

    const renderTreeViewResults = () => {
        if (!paginatedResults || Object.keys(paginatedResults).length === 0) {
            return status.running ? (
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
                {Object.keys(resultsByFile).length > visibleResultsLimit && (
                    <div className="p-[10px] text-center">
                        <button className="bg-[var(--input-background)] border border-[var(--panel-view-border)] text-[var(--panel-tab-active-border)] px-3 py-[6px] rounded-[2px] cursor-pointer hover:border-[var(--panel-tab-active-border)]" onClick={loadMoreResults} disabled={isLoadingMore}>
                            {isLoadingMore ? 'Loading...' : `Load more results`}
                        </button>
                    </div>
                )}
            </>
        );
    };

    return (
        <div className="flex-grow overflow-auto mt-2">
            {viewMode === 'list' ? renderListViewResults() : renderTreeViewResults()}
        </div>
    );
};
