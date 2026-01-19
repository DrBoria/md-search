
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { cn } from '../utils';
import { SearchInputSection } from './SearchInputSection';
import SearchNestedView from './SearchNestedView';
import { Button } from '../components/ui/button';
import { FindInFoundButton } from './components/FindInFoundButton';
import { SearchGlobalProvider, useSearchGlobal } from './context/SearchGlobalContext';
import { SearchItemProvider, useSearchItemController } from './context/SearchItemContext';
import { MessageFromWebview, MessageToWebview, SearchReplaceViewValues, SerializedTransformResultEvent, SearchLevel } from '../../model/SearchReplaceViewTypes';
import { URI } from 'vscode-uri';
import * as path from 'path-browserify';
import { TreeViewNode, FileTreeNode, FileNode, FolderNode } from './TreeView';
import { VirtualizedListView } from './VirtualizedListView';
import { AnimatedCounter } from './components/AnimatedCounter';

// --- Interfaces ---

interface SearchReplaceViewProps {
    vscode: {
        postMessage(message: MessageFromWebview): void;
        getState(): { [key: string]: any } | undefined;
        setState(newState: { [key: string]: any }): void;
    };
}



// --- Helper Functions ---

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

    if (customOrder) {
        const sortNodeChildren = (node: FolderNode) => {
            node.children.sort((a, b) => {
                const aOrder = customOrder[a.relativePath] ?? 999999;
                const bOrder = customOrder[b.relativePath] ?? 999999;

                if (aOrder !== bOrder) {
                    return aOrder - bOrder;
                }
                if (a.type !== b.type) {
                    return a.type === 'folder' ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });
            node.children.forEach(child => {
                if (child.type === 'folder') {
                    sortNodeChildren(child);
                }
            });
        };
        sortNodeChildren(root);
    } else {
        const sortNodeChildren = (node: FolderNode) => {
            node.children.sort((a, b) => {
                if (a.type !== b.type) {
                    return a.type === 'folder' ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });
            node.children.forEach(child => {
                if (child.type === 'folder') {
                    sortNodeChildren(child);
                }
            });
        };
        sortNodeChildren(root);
    }

    return root;
}

function filterTreeForMatches(node: FileTreeNode): FileTreeNode | null {
    if (node.type === 'file') {
        const hasMatches = node.results.some(r => r.matches && r.matches.length > 0);
        return hasMatches ? node : null;
    } else {
        const filteredChildren = node.children
            .map(filterTreeForMatches)
            .filter(Boolean) as FileTreeNode[];

        if (filteredChildren.length > 0) {
            const stats = {
                numMatches: 0,
                numFilesWithMatches: 0
            };
            filteredChildren.forEach(child => {
                if (child.type === 'folder' && child.stats) {
                    stats.numMatches += child.stats.numMatches;
                    stats.numFilesWithMatches += child.stats.numFilesWithMatches;
                } else if (child.type === 'file') {
                    const fileMatches = child.results && child.results.length > 0
                        ? child.results.reduce((sum, r) => sum + (r.matches?.length || 0), 0)
                        : 0;
                    stats.numMatches += fileMatches;
                    if (fileMatches > 0) {
                        stats.numFilesWithMatches += 1;
                    }
                }
            });
            filteredChildren.sort((a, b) => {
                if (a.type !== b.type) {
                    return a.type === 'folder' ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });
            return { ...node, children: filteredChildren, stats };
        } else {
            return null;
        }
    }
}

// --- Tree View Component ---



// --- Styles & Keyframes ---
// Moved outside to avoid re-creation

const RootSearchSection = () => {
    const searchInputRef = useRef<HTMLTextAreaElement>(null);

    const {
        values,
        setSearchLevels,
        postValuesChange,
        status,
        vscode,
        resultsByFile,
        staleResultsByFile, // Added missing variable
        staleLevel,         // Added missing variable
        valuesRef
    } = useSearchGlobal();

    const handleFindInFound = useCallback(() => {
        // Read from ref to get the LATEST values, not stale closure values
        const currentValues = valuesRef.current;

        console.log('=== handleFindInFound START ===');
        console.log('Current values.searchInResults:', currentValues.searchInResults);
        console.log('Current values.find:', currentValues.find);

        // Create new level
        setSearchLevels(prev => {
            console.log('setSearchLevels called in handleFindInFound');
            console.log('Previous searchLevels:', JSON.stringify(prev.map(l => ({ find: l.values?.find, label: l.label }))));

            const currentLevel = prev[currentValues.searchInResults];
            if (!currentLevel) {
                console.log('ERROR: currentLevel is null/undefined');
                return prev;
            }

            console.log('currentLevel before update:', JSON.stringify({ find: currentLevel.values?.find, label: currentLevel.label }));

            // Sync the current global values.find into this level before transitioning
            const currentLevelWithStats = {
                ...currentLevel,
                values: { ...currentLevel.values, find: currentValues.find },
                stats: { numMatches: status.numMatches, numFilesWithMatches: status.numFilesWithMatches },
                label: currentValues.find || currentLevel.label || 'Root'
            };

            console.log('currentLevelWithStats after update:', JSON.stringify({ find: currentLevelWithStats.values?.find, label: currentLevelWithStats.label }));

            const updatedLevels = [...prev];
            updatedLevels[currentValues.searchInResults] = currentLevelWithStats;


            const newLevel: SearchLevel = {
                values: { ...currentValues, find: '', replace: '', matchCase: false, wholeWord: false, searchMode: 'text' },
                viewMode: 'tree',
                resultsByFile: {},
                matchCase: false, wholeWord: false, searchMode: 'text',
                isReplaceVisible: false,
                expandedFiles: new Set<string>(),
                expandedFolders: new Set<string>(),
                label: '' // Will be populated by user input
            };

            console.log('New level created with find:', newLevel.values.find, 'label:', newLevel.label);

            if (updatedLevels.length <= currentValues.searchInResults + 1) updatedLevels.push(newLevel);
            else updatedLevels[currentValues.searchInResults + 1] = newLevel;

            console.log('Updated searchLevels:', JSON.stringify(updatedLevels.map(l => ({ find: l.values?.find, label: l.label }))));

            setTimeout(() => {
                console.log('setTimeout postValuesChange called with searchInResults:', currentValues.searchInResults + 1);
                postValuesChange({
                    searchInResults: currentValues.searchInResults + 1,
                    find: '',
                    replace: '',
                    matchCase: false,
                    wholeWord: false,
                    searchMode: 'text'
                });
            }, 0);
            return updatedLevels;
        });

        if (status.running) vscode.postMessage({ type: 'stop' });
        console.log('=== handleFindInFound END ===');
    }, [postValuesChange, status, setSearchLevels, vscode]);

    const handleCopyFileNames = useCallback(() => {
        vscode.postMessage({ type: 'copyFileNames' });
    }, [vscode]);

    const hasResults = Object.keys(resultsByFile || {}).length > 0;
    const isStale = Object.keys(resultsByFile).length === 0 && staleResultsByFile !== null && (staleLevel === 0 || staleLevel === null || staleLevel === undefined);

    const extraActions = (
        <>
            <FindInFoundButton
                onClick={handleFindInFound}
                visible={hasResults || isStale}
                forceHide={!values.find} // Immediately hide if input is empty
            />
            <Button
                onClick={handleCopyFileNames}
                title="Copy file names"
                variant="ghost"
                size="icon"
                disabled={!hasResults && !isStale}
                className={cn("transition-opacity duration-300", (hasResults || isStale) ? "opacity-100" : "opacity-0 pointer-events-none")}
            >
                <span className="codicon codicon-copy" />
            </Button>
        </>
    );

    const controller = useSearchItemController({
        levelIndex: 0,
        extraActions,
        inputRef: searchInputRef
    });

    return (
        <SearchItemProvider value={controller}>
            <SearchInputSection
                className="flex-grow"
                summary={<SearchResultSummary />}
            />
        </SearchItemProvider>
    );


};

const SearchResultSummary = () => {
    const { status, staleStatus, values, vscode } = useSearchGlobal();

    // Use stale status if current status has 0 matches (e.g. during a re-search) to prevent flickering
    const effectiveStatus = (status.numMatches === 0 && staleStatus) ? staleStatus : status;

    if (!effectiveStatus.numMatches || effectiveStatus.numMatches === 0) return null;

    const handleOpenInEditor = () => {
        // Need to collect all file paths to open? Or just open a new search editor?
        // The screenshot says "Open in editor". In standard VS Code this usually opens a search editor.
        // For now, we might not have 'open search editor' capability easily, but let's implement the UI.
        // If the user meant "Open in editor" as a specific command, we might need to send a message.
        vscode.postMessage({ type: 'openNewSearchEditor' } as any);
    };

    return (
        <div className="px-0 py-1 text-xs text-[var(--vscode-descriptionForeground)] flex items-center justify-between">
            <span>
                <AnimatedCounter value={effectiveStatus.numMatches} suffix="results in" />
                &nbsp;
                <AnimatedCounter value={effectiveStatus.numFilesWithMatches} suffix=" files" />
            </span>
            {/* Open in editor link - mimicing VS Code style */}
            {/* <span
                className="cursor-pointer hover:text-[var(--vscode-textLink-activeForeground)] ml-2"
                onClick={handleOpenInEditor}
             >
                - Open in editor
             </span> */}
            {/* Commented out open in editor until backed support is confirmed/requested */}
        </div>
    );
};

// --- Styles & Keyframes ---
const STYLES = `
@keyframes slideInRight { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes slideInLeft { from { transform: translateX(-100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes slideOutRight { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
@keyframes slideOutLeft { from { transform: translateX(0); opacity: 1; } to { transform: translateX(-100%); opacity: 0; } }

.animate-slide-in-right { animation: slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
.animate-slide-in-left { animation: slideInLeft 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
.animate-slide-out-right { animation: slideOutRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
.animate-slide-out-left { animation: slideOutLeft 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
`;

const ViewSlideTransition = ({ showNested, children }: { showNested: boolean, children: [React.ReactNode, React.ReactNode] }) => {
    // children[0] = Root, children[1] = Nested
    const [animating, setAnimating] = useState(false);
    const [wasNested, setWasNested] = useState(showNested);

    if (showNested !== wasNested) {
        setWasNested(showNested);
        setAnimating(true);
    }

    useEffect(() => {
        if (animating) {
            const timer = setTimeout(() => setAnimating(false), 300);
            return () => clearTimeout(timer);
        }
    }, [animating]);

    // direction: if showing nested -> forward (Root slides out Left, Nested slides in Right)
    // if hiding nested -> backward (Nested slides out Right, Root slides in Left)
    const direction = showNested ? 'forward' : 'backward';

    return (
        <div className="relative w-full h-full overflow-hidden">
            {/* Root View */}
            <div className={cn(
                "absolute inset-0 w-full h-full transition-none",
                !showNested && !animating ? "block" : "", // Stable Root
                showNested && !animating ? "hidden" : "", // Stable Nested
                animating && direction === 'forward' ? "animate-slide-out-left" : "",
                animating && direction === 'backward' ? "animate-slide-in-left" : "",
                // If stable nested, hide root. If stable root, show root.
            )} style={{ display: (showNested && !animating) ? 'none' : 'block' }}>
                {children[0]}
            </div>

            {/* Nested View */}
            <div className={cn(
                "absolute inset-0 w-full h-full transition-none",
                showNested && !animating ? "block" : "",
                !showNested && !animating ? "hidden" : "",
                animating && direction === 'forward' ? "animate-slide-in-right" : "",
                animating && direction === 'backward' ? "animate-slide-out-right" : ""
            )} style={{ display: (!showNested && !animating) ? 'none' : 'block' }}>
                {children[1]}
            </div>
        </div>
    );
};

// --- Main Inner Component ---

function SearchReplaceViewInner({ vscode }: SearchReplaceViewProps) {
    const {
        values,
        resultsByFile,
        staleResultsByFile,
        setResultsByFile,
        setSearchLevels,
        handleMessage,
        isInNestedSearch,
        viewMode,
        searchLevels,
        isSearchRequested, // From Global Context
        setStatus, // Needed for updating stats on exclude
        status, // Needed for reading current stats for update
        staleLevel, // FROM CONTEXT
    } = useSearchGlobal();

    // Local UI State
    const [workspacePath, setWorkspacePath] = useState<string>('');
    // REMOVED shadowed isSearchRequested
    const [visibleResultsLimit, setVisibleResultsLimit] = useState(50);
    const [isLoadingMore, setIsLoadingMore] = useState(false);

    // Determine effective results (current or stale)
    // Determine effective results (current or stale)
    const effectiveResultsByFile = useMemo(() => {
        const hasCurrent = Object.keys(resultsByFile).length > 0;
        if (hasCurrent) return resultsByFile;

        // Only use stale results if they belong to the root level (level 0)
        // or if staleLevel is null/undefined (legacy behavior fallback, though we set it explicitly now)
        // But strictly for root view, we want staleLevel === 0.
        if (staleResultsByFile && Object.keys(staleResultsByFile).length > 0 && (staleLevel === 0 || staleLevel === undefined || staleLevel === null)) {
            return staleResultsByFile;
        }
        return resultsByFile;
    }, [resultsByFile, staleResultsByFile, staleLevel]);

    const isStale = Object.keys(resultsByFile).length === 0 && staleResultsByFile !== null && (staleLevel === 0 || staleLevel === null || staleLevel === undefined);

    // Derived State for Pagination
    const paginatedFilePaths = useMemo(() => {
        return Object.keys(effectiveResultsByFile).slice(0, visibleResultsLimit);
    }, [effectiveResultsByFile, visibleResultsLimit]);
    const [customFileOrder, setCustomFileOrder] = useState<{ [key: string]: number }>({});

    // Derived
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


    const [pausedState, setPausedState] = useState<{ limit: number; count: number } | null>(null);
    const [skippedCount, setSkippedCount] = useState<number>(0);

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const message = event.data as MessageToWebview;

            if (['initialData', 'status', 'values', 'clearResults', 'addBatchResults', 'fileUpdated', 'replacementComplete', 'focusReplaceInput'].includes(message.type)) {
                handleMessage(message);
            }

            switch (message.type) {
                case 'initialData':
                    if (message.workspacePath) setWorkspacePath(message.workspacePath);
                    setSkippedCount(0);
                    setPausedState(null);
                    break;
                case 'clearResults':
                    setSkippedCount(0);
                    setPausedState(null);
                    break;
                case 'search-paused':
                    setPausedState({ limit: message.limit, count: message.count });
                    break;
                case 'stop':
                    setPausedState(null);
                    break;
                case 'skipped-large-files':
                    setSkippedCount(message.count);
                    break;
            }
        };

        window.addEventListener('message', onMessage);
        vscode.postMessage({ type: 'mount' });
        const handleBlur = () => vscode.postMessage({ type: 'unmount' });
        window.addEventListener('blur', handleBlur);
        return () => {
            window.removeEventListener('message', onMessage);
            window.removeEventListener('blur', handleBlur);
        };
    }, [handleMessage, vscode]);

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
        vscode.postMessage({ type: 'replace', filePaths });
    }, [values.find, values.replace, vscode]);

    const handleExcludeFile = useCallback((filePath: string) => {
        vscode.postMessage({ type: 'excludeFile', filePath });

        let removedMatchesCount = 0;
        let removedFileCount = 0;

        if (isInNestedSearch && values.searchInResults > 0) {
            setSearchLevels(prev => {
                const newLevels = [...prev];
                const currentLevel = newLevels[values.searchInResults];
                if (currentLevel) {
                    const newResults = { ...currentLevel.resultsByFile };
                    Object.keys(newResults).forEach(key => {
                        // Check if key equals filePath (file) or starts with filePath/ (folder)
                        // keys are absolute paths
                        if (key === filePath || key.startsWith(filePath + path.sep)) {
                            const fileEvents = newResults[key];
                            const matches = fileEvents?.reduce((sum: number, e: any) => sum + (e.matches?.length || 0), 0) || 0;
                            removedMatchesCount += matches;
                            removedFileCount += 1;
                            delete newResults[key];
                        }
                    });
                    newLevels[values.searchInResults] = { ...currentLevel, resultsByFile: newResults };
                }
                return newLevels;
            });
        } else {
            setResultsByFile(prev => {
                const newResults = { ...prev };
                Object.keys(newResults).forEach(key => {
                    // Check if key equals filePath (file) or starts with filePath/ (folder)
                    if (key === filePath || key.startsWith(filePath + path.sep)) {
                        const fileEvents = newResults[key];
                        const matches = fileEvents?.reduce((sum, e) => sum + (e.matches?.length || 0), 0) || 0;
                        removedMatchesCount += matches;
                        removedFileCount += 1;
                        delete newResults[key];
                    }
                });
                return newResults;
            });
        }

        // Update global status for immediate UI feedback (Animation)
        if (removedMatchesCount > 0 || removedFileCount > 0) {
            setStatus(prev => ({
                ...prev,
                numMatches: Math.max(0, prev.numMatches - removedMatchesCount),
                numFilesWithMatches: Math.max(0, prev.numFilesWithMatches - removedFileCount)
            }));
        }

    }, [vscode, isInNestedSearch, values.searchInResults, setSearchLevels, setResultsByFile, setStatus]);

    const toggleFileExpansion = useCallback((relativePath: string) => {
        setSearchLevels(prev => {
            const index = isInNestedSearch ? values.searchInResults : 0;
            const newLevels = [...prev];
            if (newLevels[index]) {
                const newSet = new Set(newLevels[index].expandedFiles);
                if (newSet.has(relativePath)) newSet.delete(relativePath);
                else newSet.add(relativePath);
                newLevels[index] = { ...newLevels[index], expandedFiles: newSet };
            }
            return newLevels;
        });
    }, [isInNestedSearch, values.searchInResults, setSearchLevels]);

    const toggleFolderExpansion = useCallback((relativePath: string) => {
        setSearchLevels(prev => {
            const index = isInNestedSearch ? values.searchInResults : 0;
            const newLevels = [...prev];
            if (newLevels[index]) {
                const newSet = new Set(newLevels[index].expandedFolders);
                if (newSet.has(relativePath)) newSet.delete(relativePath);
                else newSet.add(relativePath);
                newLevels[index] = { ...newLevels[index], expandedFolders: newSet };
            }
            return newLevels;
        });
    }, [isInNestedSearch, values.searchInResults, setSearchLevels]);

    const handleDragStart = useCallback((e: React.DragEvent, node: FileTreeNode) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ relativePath: node.relativePath, type: node.type }));
        e.dataTransfer.effectAllowed = 'move';
    }, []);
    const handleDragOver = useCallback((e: React.DragEvent, targetNode: FileTreeNode) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }, []);
    const handleDrop = useCallback((e: React.DragEvent, targetNode: FileTreeNode) => { e.preventDefault(); }, []);

    const handleContinueSearch = useCallback(() => {
        setPausedState(null);
        vscode.postMessage({ type: 'continue-search' });
    }, [vscode]);

    const handleSearchLargeFiles = useCallback(() => {
        setSkippedCount(0); // Clear notification
        vscode.postMessage({ type: 'search-large-files' });
    }, [vscode]);

    // Render Helpers
    const currentExpandedFiles = useMemo((): Set<string> => {
        const level = searchLevels[isInNestedSearch ? values.searchInResults : 0];
        const files = level?.expandedFiles;
        return files instanceof Set ? files : new Set<string>(files || []);
    }, [searchLevels, isInNestedSearch, values.searchInResults]);

    const currentExpandedFolders = useMemo((): Set<string> => {
        const level = searchLevels[isInNestedSearch ? values.searchInResults : 0];
        const folders = level?.expandedFolders;
        return folders instanceof Set ? folders : new Set<string>(folders || []);
    }, [searchLevels, isInNestedSearch, values.searchInResults]);

    const renderListViewResults = () => {
        const resultEntries = Object.entries(paginatedResults);
        const hasResults = resultEntries.length > 0;

        if (!hasResults) {
            return isSearchRequested ? (
                <div className="p-[10px] text-[var(--vscode-descriptionForeground)] text-center flex justify-center items-center gap-2">
                    <span className="codicon codicon-loading codicon-modifier-spin"></span><span>Searching...</span>
                </div>
            ) : (
                <div className="p-[10px] text-[var(--vscode-descriptionForeground)] text-center">No matches found.</div>
            );
        }

        return (
            <>
                {resultEntries.map(([filePath, results]) => {
                    let displayPath = uriToPath(filePath);
                    const safeWorkspacePath = uriToPath(workspacePath);
                    if (safeWorkspacePath && displayPath.startsWith(safeWorkspacePath)) {
                        displayPath = displayPath.substring(safeWorkspacePath.length);
                        if (displayPath.startsWith('/') || displayPath.startsWith('\\')) {
                            displayPath = displayPath.substring(1);
                        }
                    }

                    const node: FileNode = {
                        type: 'file',
                        name: displayPath,
                        relativePath: displayPath, // Using display path as relative path for list view
                        absolutePath: filePath,
                        results: results
                    };

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

    const renderTreeViewResults = () => {
        if (!paginatedResults || Object.keys(paginatedResults).length === 0) {
            return isSearchRequested ? (
                <div className="p-[10px] text-center flex gap-2 justify-center"><span className="codicon codicon-loading codicon-modifier-spin" /><span>Searching...</span></div>
            ) : (
                <div className="p-[10px] text-center text-[var(--vscode-descriptionForeground)]">No matches found.</div>
            );
        }

        const paginatedFileTree = buildFileTree(paginatedResults, workspacePath, customFileOrder);

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
                {/* Only show Load More button in TreeView because ListView is virtualized */}
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

    const renderRootView = () => (
        <div className="flex flex-col h-full">
            <div className="flex flex-col gap-1.5 mb-2">
                <div className="flex items-start gap-1">
                    <RootSearchSection />
                </div>
            </div>

            {/* Pause Warning Banner */}
            {pausedState && (
                <div className="bg-[var(--vscode-inputValidation-warningBackground)] border border-[var(--vscode-inputValidation-warningBorder)] p-2 mb-2 rounded-sm flex flex-col gap-2 animate-in fade-in slide-in-from-top-1 duration-300">
                    <div className="flex items-center gap-2 text-[var(--vscode-inputValidation-warningForeground)]">
                        <span className="codicon codicon-warning" />
                        <span className="font-semibold text-xs">
                            Search paused at {pausedState.count.toLocaleString()} matches.
                        </span>
                    </div>
                    <div className="text-xs opacity-90">
                        Continuing may cause high CPU usage or instability.
                    </div>
                    <div className="flex gap-2 justify-end mt-1">
                        <button
                            className="bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)] px-3 py-1 rounded-sm text-xs border border-[var(--vscode-button-border)] cursor-pointer"
                            onClick={() => vscode.postMessage({ type: 'stop' })}
                        >
                            Stop
                        </button>
                        <button
                            className="bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] px-3 py-1 rounded-sm text-xs border border-[var(--vscode-button-border)] cursor-pointer font-medium"
                            onClick={handleContinueSearch}
                        >
                            Continue
                        </button>
                    </div>
                </div>
            )}

            <div className={cn("flex-grow overflow-auto relative", isStale ? "opacity-50 transition-opacity duration-200" : "transition-opacity duration-200")}>
                {viewMode === 'list' ? renderListViewResults() : renderTreeViewResults()}
            </div>

            {/* Skipped Files Notification */}
            {skippedCount > 0 && (
                <div className="p-2 text-xs flex justify-between items-center border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)] animate-in slide-in-from-bottom-2 fade-in duration-300">
                    <span className="opacity-80">Skipped {skippedCount} large files (&gt;1MB).</span>
                    <button
                        onClick={handleSearchLargeFiles}
                        className="text-[var(--vscode-textLink-foreground)] hover:underline cursor-pointer bg-transparent border-none p-0"
                    >
                        Search them
                    </button>
                </div>
            )}
        </div>
    );

    return (
        <div className="flex flex-col h-screen p-[5px] box-border overflow-hidden relative">
            <style>{STYLES}</style>

            <ViewSlideTransition showNested={isInNestedSearch}>
                {renderRootView()}
                <SearchNestedView />
            </ViewSlideTransition>
        </div>
    );
}


export default function SearchReplaceView({ vscode }: SearchReplaceViewProps): React.ReactElement {
    return (
        <SearchGlobalProvider vscode={vscode}>
            <SearchReplaceViewInner vscode={vscode} />
        </SearchGlobalProvider>
    );
}
