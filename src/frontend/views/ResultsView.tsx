import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
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
    absolutePath: string; // Added absolutePath
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
    // Root's absolute path is the workspace path
    const root: FolderNode = {
        name: '',
        relativePath: '',
        absolutePath: uriToPath(workspacePathUri),
        type: 'folder',
        children: [],
        stats: { numMatches: 0, numFilesWithMatches: 0 }
    };
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

        // Construct absolute path for the folder
        const folderAbsolutePath = path.join(parent.absolutePath, segment); // Assuming simple join works for our internal structure, or we calculate from workspace
        // Actually, safer to join relative path to workspace path
        const safeAbsolutePath = workspacePath ? path.join(workspacePath, currentRelativePath) : currentRelativePath;

        const newFolder: FolderNode = {
            name: segment,
            relativePath: currentRelativePath,
            absolutePath: safeAbsolutePath, // Store absolute path
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
                // Try both absolute path and relative path for lookup
                const aOrder = customOrder[a.absolutePath] ?? customOrder[a.relativePath] ?? 999999;
                const bOrder = customOrder[b.absolutePath] ?? customOrder[b.relativePath] ?? 999999;

                console.log(`[buildFileTree] Sorting: ${a.name} (${aOrder}) vs ${b.name} (${bOrder})`);

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
        staleResultsByFile,
        staleStatus,
        staleLevel,
        customFileOrder, // Added
        setCustomFileOrder // Added
    } = useSearchGlobal();

    const [visibleResultsLimit, setVisibleResultsLimit] = useState(50);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [listParent] = useAutoAnimate<HTMLDivElement>();
    const [treeParent] = useAutoAnimate<HTMLDivElement>();

    // Derived Logic for Results
    const level = searchLevels[levelIndex];

    const effectiveResultsByFile = useMemo(() => {
        const currentResults = level?.resultsByFile || {};
        if (Object.keys(currentResults).length > 0) return currentResults;

        // Check for stale results if current are empty
        if (levelIndex === 0) {
            // Root level fallback
            if (staleResultsByFile && Object.keys(staleResultsByFile).length > 0 && (staleLevel === 0 || staleLevel === null || staleLevel === undefined)) {
                return staleResultsByFile;
            }
        } else {
            // Nested level fallback
            if (staleResultsByFile && Object.keys(staleResultsByFile).length > 0 && staleLevel === levelIndex) {
                return staleResultsByFile;
            }
        }
        return {};
    }, [level, levelIndex, staleResultsByFile, staleLevel]);

    const isStale = useMemo(() => {
        const currentResults = level?.resultsByFile || {};
        const hasCurrent = Object.keys(currentResults).length > 0;
        if (hasCurrent) return false;

        if (levelIndex === 0) {
            return !!staleResultsByFile && (staleLevel === 0 || staleLevel === null || staleLevel === undefined);
        } else {
            return !!staleResultsByFile && staleLevel === levelIndex;
        }
    }, [level, levelIndex, staleResultsByFile, staleLevel]);


    // Handlers
    const loadMoreResults = useCallback(() => {
        if (isLoadingMore) return;
        setIsLoadingMore(true);
        // Simulate async load or just increase limit
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
        const find = level?.values?.find || globalValues.find;
        const replace = level?.values?.replace !== undefined ? level.values.replace : globalValues.replace;
        if (!find || replace === undefined || filePaths.length === 0) return;
        vscode.postMessage({ type: 'replace', filePaths });
    }, [level, globalValues, vscode]);

    const handleExcludeFile = useCallback((filePath: string) => {
        vscode.postMessage({ type: 'excludeFile', filePath });
        // Optimistic update handled in Layout or Context? 
        // Logic was duplicated in Layout. For specific view, we might relying on global state update.
        // But we can trigger a local update if needed via setSearchLevels.
        // For now let's rely on backend sending 'fileUpdated' or similar, OR the Layout logic if it listens to exclude.
        // Actually Layout has logic to remove from results.
        // But we need to make sure UI reflects it.
        // Replicating exclusion logic here safely:

        setSearchLevels(prev => {
            const newLevels = [...prev];
            const targetLevel = newLevels[levelIndex];
            if (!targetLevel) return prev;

            const newResults = { ...targetLevel.resultsByFile };
            let changed = false;

            Object.keys(newResults).forEach(key => {
                if (key === filePath || key.startsWith(filePath + (filePath.includes('/') ? '/' : '\\'))) {
                    delete newResults[key];
                    changed = true;
                }
            });

            if (changed) {
                newLevels[levelIndex] = { ...targetLevel, resultsByFile: newResults };
                return newLevels;
            }
            return prev;
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

    // View Mode: prefer level-specific mode (for nested), fallback to global (for root)
    const viewMode = level?.viewMode || globalViewMode || 'tree';

    // Values for highlighting
    const values = level?.values || globalValues;

    // Drag handlers
    const handleDragStart = useCallback((e: React.DragEvent, node: FileTreeNode) => {
        // Allow dragging both files and folders
        e.dataTransfer.setData('text/plain', node.absolutePath || node.relativePath);
        e.dataTransfer.effectAllowed = 'move';
        console.log('[ResultsView] Drag Start:', {
            path: node.absolutePath || node.relativePath,
            type: node.type,
            node
        });
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent, targetNode: FileTreeNode) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // reducing log spam, but uncomment if needed
        // console.log('[ResultsView] Drag Over:', targetNode.relativePath);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent, targetNode: FileTreeNode) => {
        console.error('[ResultsView] handleDrop ENTERED');
        try {
            e.preventDefault();
            const sourcePath = e.dataTransfer.getData('text/plain');

            // Target path should be the node's absolute path (which now exists for folders too)
            // or relative path as fallback. Preferably absolute.
            const targetPath = (targetNode as any).absolutePath || targetNode.relativePath;

            console.error('[ResultsView] Handle Drop Data:', {
                sourcePath,
                targetPath,
                targetNodeType: targetNode.type,
                targetNodePath: targetNode.relativePath
            });

            if (!sourcePath || !targetPath || sourcePath === targetPath) {
                console.error('[ResultsView] Drop ignored: validation failed or same source/target');
                return;
            }

            const currentFilePaths = Object.keys(effectiveResultsByFile);

            let newOrder: string[] = [];
            if (customFileOrder && customFileOrder.length > 0) {
                newOrder = [...customFileOrder];
                // Append missing visible files
                currentFilePaths.forEach(p => {
                    if (!newOrder.includes(p)) {
                        newOrder.push(p);
                    }
                });
            } else {
                newOrder = [...currentFilePaths];
            }

            // Ensure source and target are in the order list
            if (!newOrder.includes(sourcePath)) {
                console.error('[ResultsView] Adding missing sourcePath to order:', sourcePath);
                newOrder.push(sourcePath);
            }
            if (!newOrder.includes(targetPath)) {
                console.error('[ResultsView] Adding missing targetPath to order:', targetPath);
                newOrder.push(targetPath);
            }

            const sourceIndex = newOrder.indexOf(sourcePath);
            const targetIndex = newOrder.indexOf(targetPath);

            console.error('[ResultsView] Indices:', { sourceIndex, targetIndex });

            if (sourceIndex === -1 || targetIndex === -1) {
                console.error('[ResultsView] Source or Target index not found after insertion check');
                return;
            }

            // Reorder
            newOrder.splice(sourceIndex, 1);
            let adjustedTargetIndex = newOrder.indexOf(targetPath);

            // Adjust insertion point based on direction
            if (sourceIndex < targetIndex) {
                // Dragging Down: Insert AFTER target
                adjustedTargetIndex += 1;
            }
            newOrder.splice(adjustedTargetIndex, 0, sourcePath);

            console.error('[ResultsView] NEW ORDER Generated (first 5):', newOrder.slice(0, 5));
            setCustomFileOrder(newOrder);
        } catch (err) {
            console.error('[ResultsView] DATA DROP ERROR:', err);
        }
    }, [effectiveResultsByFile, customFileOrder, setCustomFileOrder]);


    // Derived State for Pagination
    const sortedFilePaths = useMemo(() => {
        const keys = Object.keys(effectiveResultsByFile);
        if (!customFileOrder || customFileOrder.length === 0) return keys;

        // Sort keys based on customFileOrder
        // Create map for O(1) lookup
        const orderMap = new Map(customFileOrder.map((path, index) => [path, index]));

        return keys.sort((a, b) => {
            const indexA = orderMap.has(a) ? orderMap.get(a)! : 999999;
            const indexB = orderMap.has(b) ? orderMap.get(b)! : 999999;
            return indexA - indexB;
        });
    }, [effectiveResultsByFile, customFileOrder]);

    const paginatedFilePaths = useMemo(() => {
        return sortedFilePaths.slice(0, visibleResultsLimit);
    }, [sortedFilePaths, visibleResultsLimit]);

    // Compute custom order map for Tree View (absolute paths to indices)
    // Wait, buildFileTree uses relativePath? 
    // Let's modify buildFileTree to use Absolute Path if available on node?
    // Folder nodes don't have absolute paths easily mapped unless we map them?
    // But Drag and Drop operates on Files.
    // So if I pass `{ [absolutePath]: index }` to buildFileTree, I need to check `node.absolutePath`.
    // Let's look at `buildFileTree` again.
    // It calls `sortNodeChildren`. `a.relativePath` is available. `a.type`.
    // `FileNode` has `absolutePath`.
    // So distinct handling:
    // If we want to sort files in Tree View based on our "Flat List Order", it's weird because Tree View is hierarchical.
    // But users might drag files within a folder.
    // If I just pass the map, I can verify in `buildFileTree`.
    // I will try to map keys -> index.

    // Actually, converting absolute paths in `customFileOrder` to `relativePath` is hard without workspace path logic here or repeatedly calling `path.relative`.
    // `buildFileTree` computes relative path itself.
    // Easier: modify `buildFileTree` to accept `fileOrderMap` keyed by `absolutePath` for files.
    // I can't modify `buildFileTree` easily inside this tool call without replacing the massive function.
    // Let's stick to List View support primarily, as reordering a Tree structure via flatten list is ambiguous.
    // BUT user asked for "reorder files left side".
    // If I drop a file, it reorders.
    // If I am in List View, works great.
    // In Tree View, `buildFileTree` is used.
    // I should generate `customOrder` map using `workspacePath`.
    // `uriToPath` and `path.relative` are used in `renderListViewResults`.
    // I can replicate this.

    // Use Absolute Paths for the map since we now track them in FolderNode
    const customOrderMap = useMemo(() => {
        if (!customFileOrder || customFileOrder.length === 0) return {};
        const map: { [key: string]: number } = {};

        customFileOrder.forEach((path, index) => {
            // We trust the path in customFileOrder is absolute (as stored by handleDrop)
            map[path] = index;
            // Also store uriToPath version just in case of mismatch
            map[uriToPath(path)] = index;
        });
        return map;
    }, [customFileOrder]);

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
        // Use sorted paginated results (derived from sortedFilePaths)
        // ...
        // (existing logic uses paginatedResults which relies on paginatedFilePaths)
        const resultEntries = paginatedFilePaths.map(path => [path, effectiveResultsByFile[path]] as [string, SerializedTransformResultEvent[]]);

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
            <div className="flex flex-col" ref={listParent}>
                {resultEntries.map(([filePath, results], i) => {
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
                            index={i}
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
                {/* Load More Button */}
                {sortedFilePaths.length > visibleResultsLimit && (
                    <div className="p-[10px] text-center">
                        <button className="bg-[var(--input-background)] border border-[var(--panel-view-border)] text-[var(--panel-tab-active-border)] px-3 py-[6px] rounded-[2px] cursor-pointer hover:border-[var(--panel-tab-active-border)]" onClick={loadMoreResults} disabled={isLoadingMore}>
                            {isLoadingMore ? 'Loading...' : `Load more results`}
                        </button>
                    </div>
                )}
            </div>
        );
    };

    const renderTreeViewResults = () => {
        if (!effectiveResultsByFile || Object.keys(effectiveResultsByFile).length === 0) {
            return currentStatus.running ? (
                <div className="p-[10px] text-center flex gap-2 justify-center"><span className="codicon codicon-loading codicon-modifier-spin" /><span>Searching...</span></div>
            ) : (
                <div className="p-[10px] text-center text-[var(--vscode-descriptionForeground)]">No matches found.</div>
            );
        }

        // Pass customOrderMap
        const paginatedFileTree = buildFileTree(effectiveResultsByFile, workspacePath, customOrderMap);

        return (
            <div className="flex flex-col" ref={treeParent}>
                {paginatedFileTree.children.length > 0 ? (
                    paginatedFileTree.children.map((node, i) => (
                        <TreeViewNode
                            key={node.relativePath}
                            node={node}
                            index={i}
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
            </div>
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
