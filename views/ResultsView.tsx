import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { useSearchGlobal } from './context/SearchGlobalContext';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { URI } from 'vscode-uri';
import * as path from 'path-browserify';
import { Button } from '../components/ui/button';
import { TreeViewNode } from './TreeView';
import { FileIcon } from '../components/icons';
import { getHighlightedMatchContext } from './TreeView/highligtedContext';
import { getHighlightedMatchContextWithReplacement } from './TreeView/highlightedContextWithReplacement';
import { SerializedTransformResultEvent, SearchLevel } from '../../model/SearchReplaceViewTypes';
import { cn } from "../utils";
import { VirtualTreeView } from './TreeView/VirtualTreeView';

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
    description?: string;
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
            // ALWAYS sort folders before files
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;

            if (customOrder) {
                // Try both absolute path and relative path for lookup
                const aOrder = customOrder[a.absolutePath] ?? customOrder[a.relativePath] ?? 999999;
                const bOrder = customOrder[b.absolutePath] ?? customOrder[b.relativePath] ?? 999999;

                if (aOrder !== bOrder) return aOrder - bOrder;
            }
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



    // Use Absolute Paths for the map since we now track them in FolderNode
    const customOrderMap = useMemo(() => {
        if (!customFileOrder || customFileOrder.length === 0) return {};
        const map: { [key: string]: number } = {};

        customFileOrder.forEach((path, index) => {
            map[path] = index;
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

    // Memoize the File Tree for TREE MODE
    const fileTree = useMemo(() => {
        if (!effectiveResultsByFile || Object.keys(effectiveResultsByFile).length === 0) {
            return null;
        }
        return buildFileTree(effectiveResultsByFile, workspacePath, customOrderMap);
    }, [effectiveResultsByFile, workspacePath, customOrderMap]);


    // Prepare data logic
    const status = currentStatus; // Alias for compatibility

    // Determine nodes to show based on view mode
    const nodesToShow = useMemo(() => {
        if (viewMode === 'list') {
            // For List Mode, we create a flat list of FileNodes
            // Using sortedFilePaths (reusing logic)
            return sortedFilePaths.map(filePath => {
                const displayPath = workspacePath
                    ? path.relative(uriToPath(workspacePath), uriToPath(filePath))
                    : uriToPath(filePath);

                let cleanDisplayPath = displayPath;
                if (cleanDisplayPath.startsWith('/') || cleanDisplayPath.startsWith('\\')) {
                    cleanDisplayPath = cleanDisplayPath.substring(1);
                }

                const node: FileNode = {
                    type: 'file',
                    name: path.basename(filePath),
                    description: path.dirname(cleanDisplayPath) !== '.' ? path.dirname(cleanDisplayPath) : undefined,
                    relativePath: cleanDisplayPath,
                    absolutePath: filePath,
                    results: effectiveResultsByFile[filePath] || []
                };
                return node;
            });
        }
        // Tree Mode
        return fileTree ? fileTree.children : [];
    }, [viewMode, sortedFilePaths, effectiveResultsByFile, workspacePath, fileTree]);


    const hasResults = nodesToShow.length > 0;

    if (!hasResults) {
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
        <div className={cn(
            "flex-grow overflow-hidden mt-2 transition-opacity duration-200 h-full", // Use overflow-hidden to let AutoSizer handle scroll
            isStale ? "opacity-50" : ""
        )}>
            <VirtualTreeView
                fileTree={nodesToShow}
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
        </div>
    );
};
