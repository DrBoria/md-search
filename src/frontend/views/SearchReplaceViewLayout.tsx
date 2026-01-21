
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';

import { cn } from '../utils';
import { SearchInputSection } from './SearchInputSection';
import SearchNestedView from './SearchNestedView';
import { Button } from '../components/ui/button';
import { FindInFoundButton } from './components/FindInFoundButton';
import { ClipboardFeedbackOverlay } from './components/ClipboardFeedbackOverlay';
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
    const workspacePath = uriToPath(workspacePathUri);
    const root: FolderNode = { name: '', relativePath: '', type: 'folder', absolutePath: workspacePath || '', children: [], stats: { numMatches: 0, numFilesWithMatches: 0 } };

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

        const safeAbsolutePath = parent.absolutePath && !parent.absolutePath.endsWith('/')
            ? `${parent.absolutePath}/${segment}`
            : `${parent.absolutePath}${segment}`;

        const newFolder: FolderNode = {
            name: segment,
            relativePath: currentRelativePath,
            type: 'folder',
            absolutePath: safeAbsolutePath, // Store absolute path
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
                const aPath = (a as any).absolutePath || a.relativePath;
                const bPath = (b as any).absolutePath || b.relativePath;
                const aOrder = customOrder[aPath] ?? 999999;
                const bOrder = customOrder[bPath] ?? 999999;

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
        staleResultsByFile,
        staleLevel,
        valuesRef,
        setValues,
        customFileOrder, // Added
        setCustomFileOrder, // Added
        setResultsByFile // Need setter to remove items on Cut
    } = useSearchGlobal();

    // -- Clipboard Overlay State --
    const [feedbackState, setFeedbackState] = useState<{
        visible: boolean;
        message: string;
        subMessage?: string;
        type: 'copy' | 'cut' | 'paste' | 'info';
    }>({ visible: false, message: '', type: 'info' });

    const showFeedback = useCallback((message: string, subMessage: string | undefined, type: 'copy' | 'cut' | 'paste' | 'info') => {
        setFeedbackState({ visible: true, message, subMessage, type });
    }, []);

    // -- Handlers --

    const handleCopyMatches = useCallback(() => {
        // Send message to backend to Copy, respecting custom order if present
        // If resultsByFile is empty, maybe nothing to copy? (Or use stale?)
        if (Object.keys(resultsByFile).length === 0) return;

        // Construct file order based on customFileOrder or default keys
        // Note: customFileOrder might contain keys not in resultsByFile if results changed, 
        // OR resultsByFile might have keys not in customFileOrder (new results).
        // Logic: Use customFileOrder filtered by existence in resultsByFile, then append remaining unique results keys.

        const currentKeys = Object.keys(resultsByFile);
        let orderedKeys = currentKeys;

        if (customFileOrder && customFileOrder.length > 0) {
            const keysSet = new Set(currentKeys);
            const ordered = customFileOrder.filter(k => keysSet.has(k));
            const remaining = currentKeys.filter(k => !ordered.includes(k)); // simplified check
            // Set-based check for remaining for performance
            const orderedSet = new Set(ordered);
            const remainingOptimized = currentKeys.filter(k => !orderedSet.has(k));
            orderedKeys = [...ordered, ...remainingOptimized];
        }

        vscode.postMessage({
            type: 'copyMatches',
            fileOrder: orderedKeys
        });
        // We catch 'copyMatchesComplete' to show feedback
    }, [resultsByFile, customFileOrder, vscode]);

    const handleCutMatches = useCallback(() => {
        if (Object.keys(resultsByFile).length === 0) return;

        // Similar order logic
        const currentKeys = Object.keys(resultsByFile);
        let orderedKeys = currentKeys;
        if (customFileOrder && customFileOrder.length > 0) {
            const ordered = customFileOrder.filter(k => resultsByFile[k]); // simple existence check works for obj keys
            const orderedSet = new Set(ordered);
            const remaining = currentKeys.filter(k => !orderedSet.has(k));
            orderedKeys = [...ordered, ...remaining];
        }

        vscode.postMessage({
            type: 'cutMatches',
            fileOrder: orderedKeys
        });

        // Optimistic UI update? Or wait for backend 'cutMatchesComplete'?
        // The backend processes the Cut (Copy + probably tells us to remove specific files or just remove all?)
        // Wait, "Cut All Matches" usually implies clearing them from the view?
        // Or adding to exclude?
        // Let's assume Backend will handle the logic and send us a "remove keys" or we clear them?
        // The original task plan said "Remove from resultsByFile locally".
        // Let's do that cleanly after confirmation or optimistically.
        // For 'undo' support, best to let backend orchestrate or handle Undo independently.
        // We'll rely on backend sending 'cutMatchesComplete' then we clear?
        // Actually, `cutMatches` message implies the backend does the work.
        // Let's assume backend sends a response.
    }, [resultsByFile, customFileOrder, vscode]);

    const handlePasteMatches = useCallback(() => {
        // Trigger paste logic in backend (which reads clipboard and potentially merges results)

        // Construct file order based on customFileOrder or default keys
        const currentKeys = Object.keys(resultsByFile);
        let orderedKeys = currentKeys;

        if (customFileOrder && customFileOrder.length > 0) {
            const ordered = customFileOrder.filter(k => resultsByFile[k]);
            const orderedSet = new Set(ordered);
            const remaining = currentKeys.filter(k => !orderedSet.has(k));
            orderedKeys = [...ordered, ...remaining];
        }

        vscode.postMessage({
            type: 'pasteToMatches',
            fileOrder: orderedKeys
        });
    }, [resultsByFile, customFileOrder, vscode]);


    // -- Message Listener for Feedback --
    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const message = event.data;
            switch (message.type) {
                case 'copyMatchesComplete':
                    showFeedback(`Copied ${message.count} matches`, undefined, 'copy');
                    break;
                case 'cutMatchesComplete':
                    showFeedback(`Cut ${message.count} matches`, undefined, 'cut');
                    // Perform local removal if backend doesn't trigger a full refresh
                    // Assuming 'cut' clears the current view results?
                    setResultsByFile({});
                    // Also clear stale to avoid ghosting
                    // setStaleResultsByFile({}); // We don't have access to this setter here via context destructuring yet? 
                    // Actually we do via useSearchGlobal if checking updated destructuring.
                    break;
                case 'pasteToMatchesComplete':
                    showFeedback(`Pasted ${message.count} matches`, undefined, 'paste');
                    break;
                case 'copyFileNamesComplete':
                    showFeedback(`Copied ${message.count} file paths`, undefined, 'copy');
                    break;
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [showFeedback, setResultsByFile]);


    // -- Keybindings --
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Check for Ctrl+Shift (Mac: Cmd+Shift)
            const isCmd = e.metaKey || e.ctrlKey;
            const isShift = e.shiftKey;

            if (isCmd && isShift) {
                switch (e.key.toLowerCase()) {
                    case 'c':
                        e.preventDefault();
                        handleCopyMatches();
                        break;
                    case 'x':
                        e.preventDefault();
                        handleCutMatches();
                        break;
                    case 'v':
                        e.preventDefault();
                        handlePasteMatches();
                        break;
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleCopyMatches, handleCutMatches, handlePasteMatches]);

    const handleFindInFound = useCallback(() => {
        // Read from ref to get the LATEST values, not stale closure values
        const currentValues = valuesRef.current;
        // ... (rest of logic same) ...
        const currentSearchInResults = currentValues.searchInResults; // captured for closure if needed, but safer to use valuesRef or updater

        console.log('=== handleFindInFound START ===');
        console.log('Current values.searchInResults:', currentValues.searchInResults);
        console.log('Current values.find:', currentValues.find);

        // ... (omitting huge block logs for brevity in replacement if possible, but ReplaceFileContent replaces exact block)
        // I will just copy the existing Logic since I am replacing the surrounding block.

        // Create new level
        setSearchLevels(prev => {
            // ... existing logic ...
            const currentLevel = prev[currentValues.searchInResults];
            if (!currentLevel) {
                return prev;
            }

            // Sync the current global values.find into this level before transitioning
            const currentLevelWithStats = {
                ...currentLevel,
                values: { ...currentLevel.values, find: currentValues.find },
                stats: { numMatches: status.numMatches, numFilesWithMatches: status.numFilesWithMatches },
                label: currentValues.find || currentLevel.label || 'Root'
            };

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

            if (updatedLevels.length <= currentValues.searchInResults + 1) updatedLevels.push(newLevel);
            else updatedLevels[currentValues.searchInResults + 1] = newLevel;

            // Optimistic update to prevent "ghosting" of previous level results during transition
            const nextValues = {
                ...currentValues,
                searchInResults: currentValues.searchInResults + 1,
                find: '',
                replace: '',
                matchCase: false,
                wholeWord: false,
                searchMode: 'text' as const
            };
            setValues(nextValues);

            setTimeout(() => {
                postValuesChange(nextValues);
            }, 0);
            return updatedLevels;
        });

        if (status.running) vscode.postMessage({ type: 'stop' });
        console.log('=== handleFindInFound END ===');
    }, [postValuesChange, status, setSearchLevels, vscode, valuesRef, setValues]);

    const handleCopyFileNames = useCallback(() => {
        // Use custom order for copy file names too? User didn't specify but likely yes.
        // If resultsByFile is used by backend, we should pass order.
        // 'copyFileNames' message unfortunately doesn't accept order in current Type def, 
        // BUT we can update the type or just let it depend on resultsByFile keys.
        // Actually, backend usually iterates map. Map iteration order is insertion order? 
        // Or if it iterates `Object.keys`, it's not guaranteed.
        // Let's check `SearchReplaceViewProvider.ts` -> it doesn't handle `copyFileNames` logic, `MessageHandler.ts` does.
        // For now, standard copy.
        vscode.postMessage({ type: 'copyFileNames' });
    }, [vscode]);

    const hasResults = Object.keys(resultsByFile || {}).length > 0;
    const isStale = Object.keys(resultsByFile).length === 0 && staleResultsByFile !== null && (staleLevel === 0 || staleLevel === null || staleLevel === undefined);

    const extraActions = (
        <>
            <FindInFoundButton
                onClick={handleFindInFound}
                visible={hasResults || isStale}
                forceHide={!values.find}
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
            <ClipboardFeedbackOverlay
                visible={feedbackState.visible}
                message={feedbackState.message}
                subMessage={feedbackState.subMessage}
                type={feedbackState.type}
                onClose={() => setFeedbackState(prev => ({ ...prev, visible: false }))}
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

/* TreeView Styles */
@keyframes fadeIn { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: translateY(0); } }
.animate-fade-in { animation: fadeIn 0.2s ease-out forwards; }
/* Fix for Sticky Jump: behaviors sticky elements as relative during animation */
.collapsible-animating .tree-node-sticky-header {
    position: relative !important;
    top: auto !important;
}
`;

const ViewSlideTransition = ({ showNested, children }: { showNested: boolean, children: [React.ReactNode, React.ReactNode] }) => {
    // We track the "active" view index (0=root, 1=nested)
    // and the "previous" view index to handle the exit animation.
    const targetIndex = showNested ? 1 : 0;
    const [currentIndex, setCurrentIndex] = useState(targetIndex);
    const [prevIndex, setPrevIndex] = useState<number | null>(null);
    const [animating, setAnimating] = useState(false);

    useEffect(() => {
        if (targetIndex !== currentIndex) {
            setPrevIndex(currentIndex);
            setCurrentIndex(targetIndex);
            setAnimating(true);
        }
    }, [targetIndex, currentIndex]);

    useEffect(() => {
        if (animating) {
            const timer = setTimeout(() => {
                setAnimating(false);
                setPrevIndex(null);
            }, 300); // Match CSS duration
            return () => clearTimeout(timer);
        }
    }, [animating]);

    // Direction:
    // If going to Nested (1) -> Forward (Root exits Left, Nested enters Right)
    // If going to Root (0)   -> Backward (Nested exits Right, Root enters Left)
    const direction = targetIndex === 1 ? 'forward' : 'backward';

    return (
        <div className="relative w-full h-full overflow-hidden bg-[var(--vscode-sideBar-background)]">
            {/* Exiting View (Absolute) - Stays beneath or above? 
                If we want standard "Push":
                Forward: Old slides LEFT (out), New slides LEFT (in).
                Backward: Old slides RIGHT (out), New slides RIGHT (in).
            */}
            {animating && prevIndex !== null && (
                <div
                    key={`exiting-${prevIndex}`}
                    className={cn(
                        "absolute inset-0 w-full h-full pointer-events-none z-0",
                        direction === 'forward' ? 'animate-slide-out-left' : 'animate-slide-out-right'
                    )}
                >
                    {children[prevIndex]}
                </div>
            )}

            {/* Current/Entering View - Z-index higher to slide OVER if needed, or just same layer.
                Since both animate, Z-index matters less unless they overlap with transparency.
            */}
            <div
                key={`entering-${currentIndex}`}
                className={cn(
                    "w-full h-full z-10 relative",
                    animating
                        ? (direction === 'forward' ? 'animate-slide-in-right' : 'animate-slide-in-left')
                        : ""
                )}
            >
                {children[currentIndex]}
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
        customFileOrder,
        setCustomFileOrder
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

    const paginatedFilePaths = useMemo(() => {
        let paths = Object.keys(effectiveResultsByFile);

        // Apply custom sort if available
        if (customFileOrder && customFileOrder.length > 0) {
            paths.sort((a, b) => {
                const orderA = customOrderMap[a] ?? Number.MAX_SAFE_INTEGER;
                const orderB = customOrderMap[b] ?? Number.MAX_SAFE_INTEGER;
                // standard string sort if neither in map or same order (unlikely)
                if (orderA === orderB) return a.localeCompare(b);
                return orderA - orderB;
            });
        }

        return paths.slice(0, visibleResultsLimit);
    }, [effectiveResultsByFile, visibleResultsLimit, customOrderMap, customFileOrder]);

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

    const paginatedFileTree = useMemo(() => {
        if (!paginatedResults || Object.keys(paginatedResults).length === 0) return null;
        return buildFileTree(paginatedResults, workspacePath, customOrderMap);
    }, [paginatedResults, workspacePath, customOrderMap]);


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
        console.log('[SearchReplaceViewLayout] handleReplaceSelectedFiles called with:', filePaths);
        console.log('[SearchReplaceViewLayout] Values:', { find: values?.find, replace: values?.replace });
        if (!values?.find || values.replace === undefined || filePaths.length === 0) {
            console.error('[SearchReplaceViewLayout] Replace aborted: validations failed', { find: !!values?.find, replace: values?.replace, paths: filePaths.length });
            return;
        }
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
        const path = (node as any).absolutePath || node.relativePath;
        e.dataTransfer.setData('text/plain', path);
        e.dataTransfer.effectAllowed = 'move';
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent, targetNode: FileTreeNode) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }, []);


    const handleDrop = useCallback((e: React.DragEvent, targetNode: FileTreeNode) => {
        console.error('[SearchReplaceViewLayout] handleDrop ENTERED');
        try {
            e.preventDefault();
            const sourcePath = e.dataTransfer.getData('text/plain');

            // Try to get absolute path from target node
            const targetPath = (targetNode as any).absolutePath || targetNode.relativePath;

            console.error('[SearchReplaceViewLayout] Handle Drop Data:', {
                sourcePath,
                targetPath,
                targetNodeType: targetNode.type,
                targetNodePath: targetNode.relativePath
            });

            if (!sourcePath || !targetPath || sourcePath === targetPath) {
                console.error('[SearchReplaceViewLayout] Drop ignored: validation failed or same source/target');
                return;
            }

            // Helper to flatten the current visual tree
            const flattenTree = (nodes: FileTreeNode[]): string[] => {
                let paths: string[] = [];
                nodes.forEach(node => {
                    const p = (node as any).absolutePath || node.relativePath;
                    paths.push(p);
                    if (node.type === 'folder' && node.children) {
                        paths = paths.concat(flattenTree(node.children));
                    }
                });
                return paths;
            };

            const currentVisualOrder = paginatedFileTree ? flattenTree(paginatedFileTree.children) : [];

            // If the tree is empty or doesn't contain our items (edge case), fallback
            if (currentVisualOrder.length === 0) {
                const currentFilePaths = Object.keys(effectiveResultsByFile);
                currentVisualOrder.push(...currentFilePaths.sort());
            }

            // Ensure source and target are in the list (they should be if they were dragged)
            if (!currentVisualOrder.includes(sourcePath)) currentVisualOrder.push(sourcePath);
            if (!currentVisualOrder.includes(targetPath)) currentVisualOrder.push(targetPath);


            const sourceIndex = currentVisualOrder.indexOf(sourcePath);
            const targetIndex = currentVisualOrder.indexOf(targetPath);

            if (sourceIndex === -1 || targetIndex === -1) {
                console.error('[SearchReplaceViewLayout] Source or Target index not found');
                return;
            }

            // Reorder Logic on the Visual List
            currentVisualOrder.splice(sourceIndex, 1);
            let adjustedTargetIndex = currentVisualOrder.indexOf(targetPath);

            // Adjust insertion point based on direction
            if (sourceIndex < targetIndex) {
                // Dragging Down: Insert AFTER target
                adjustedTargetIndex += 1;
            }
            currentVisualOrder.splice(adjustedTargetIndex, 0, sourcePath);

            // Merge with existing hidden items
            let finalOrder = currentVisualOrder;
            if (customFileOrder && customFileOrder.length > 0) {
                const hiddenItems = customFileOrder.filter(p => !currentVisualOrder.includes(p));
                finalOrder = [...currentVisualOrder, ...hiddenItems];
            }

            console.error('[SearchReplaceViewLayout] NEW ORDER Generated:', finalOrder.slice(0, 5));
            setCustomFileOrder(finalOrder);
        } catch (err) {
            console.error('[SearchReplaceViewLayout] DATA DROP ERROR:', err);
        }
    }, [customFileOrder, effectiveResultsByFile, setCustomFileOrder, paginatedFileTree]);

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
        // Use visible paginatedFilePaths which are already sorted by customOrderMap
        const resultEntries = paginatedFilePaths.map(path => [path, effectiveResultsByFile[path]] as [string, SerializedTransformResultEvent[]]);
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
            <div className="flex flex-col">
                {resultEntries.map(([filePath, results], i) => {
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
                {Object.keys(resultsByFile).length > visibleResultsLimit && (
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
        if (!paginatedResults || Object.keys(paginatedResults).length === 0) {
            return isSearchRequested ? (
                <div className="p-[10px] text-center flex gap-2 justify-center"><span className="codicon codicon-loading codicon-modifier-spin" /><span>Searching...</span></div>
            ) : (
                <div className="p-[10px] text-center text-[var(--vscode-descriptionForeground)]">No matches found.</div>
            );
        }



        return (
            <div className="flex flex-col">
                {paginatedFileTree && paginatedFileTree.children.length > 0 ? (
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
                {/* Only show Load More button in TreeView because ListView is virtualized */}
                {Object.keys(resultsByFile).length > visibleResultsLimit && (
                    <div className="p-[10px] text-center">
                        <button className="bg-[var(--input-background)] border border-[var(--panel-view-border)] text-[var(--panel-tab-active-border)] px-3 py-[6px] rounded-[2px] cursor-pointer hover:border-[var(--panel-tab-active-border)]" onClick={loadMoreResults} disabled={isLoadingMore}>
                            {isLoadingMore ? 'Loading...' : `Load more results`}
                        </button>
                    </div>
                )}
            </div>
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

            <div className="flex-grow overflow-hidden relative">
                <ViewSlideTransition showNested={isInNestedSearch}>
                    {renderRootView()}
                    <SearchNestedView />
                </ViewSlideTransition>
            </div>
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

