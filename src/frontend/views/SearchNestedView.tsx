import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { Button } from '../components/ui/button';
import { cn } from "../utils";
import { SearchLevel } from "../../model/SearchReplaceViewTypes";
import { SearchInputSection } from './SearchInputSection';
import { useSearchGlobal } from './context/SearchGlobalContext';
import { useSearchItemController, SearchItemProvider } from './context/SearchItemContext';
import { ResultsView } from './ResultsView';
import { FindInFoundButton } from './components/FindInFoundButton';
import { AnimatedCounter } from './components/AnimatedCounter';

// Inline styles for animations - avoids external CSS dependency
const STYLES = `
@keyframes slideInRight { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes slideInLeft { from { transform: translateX(-100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes slideOutRight { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
@keyframes slideOutLeft { from { transform: translateX(0); opacity: 1; } to { transform: translateX(-100%); opacity: 0; } }
@keyframes scaleIn { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes fadeOut { from { opacity: 1; } to { opacity: 0; } }
@keyframes expandWidth { from { max-width: 0; opacity: 0; } to { max-width: 200px; opacity: 1; } }

.animate-slide-in-right { animation: slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
.animate-slide-in-left { animation: slideInLeft 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
.animate-slide-out-right { animation: slideOutRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
.animate-slide-out-left { animation: slideOutLeft 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
.animate-scale-in { animation: scaleIn 0.2s ease-out forwards; }
.animate-fade-in { animation: fadeIn 0.3s ease-out forwards; }
.animate-fade-out { animation: fadeOut 0.3s ease-out forwards; }
.animate-expand { animation: expandWidth 0.4s ease-out forwards; }

.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
`;

// --- Components ---

/**
 * Helper to reduce match count from array of arrays of events
 */
const reduceMatches = (resultsByFile: any) => {
    return Object.values(resultsByFile || {}).reduce((acc: number, r: any) => {
        // resultsByFile value is an array of SerializedTransformResultEvent
        if (Array.isArray(r)) {
            // Each file has an array of events
            return acc + r.reduce((sum: number, event: any) => sum + (event.matches?.length || 0), 0);
        }
        return acc;
    }, 0);
};

/**
 * Live Stats Widget
 * Displays the current number of files and matches for the active results.
 * Uses CSS transitions for smooth expand/collapse.
 */
const LiveStatsWidget = ({ resultsByFile }: { resultsByFile: any }) => {
    const stats = useMemo(() => {
        const fileCount = Object.keys(resultsByFile || {}).length;
        const matchCount = reduceMatches(resultsByFile);
        return { fileCount, matchCount };
    }, [resultsByFile]);

    const hasStats = stats.fileCount > 0;

    return (
        <span
            className={cn(
                "text-xs text-[var(--vscode-descriptionForeground)] transition-all duration-300 ease-out overflow-hidden inline-block align-middle whitespace-nowrap",
                hasStats ? "max-w-[200px] opacity-100 ml-2" : "max-w-0 opacity-0 ml-0"
            )}
        >
            (<AnimatedCounter value={stats.fileCount} suffix=" files" />, <AnimatedCounter value={stats.matchCount} suffix=" matches" />)
        </span>
    );
};

/**
 * SlideTransition
 * Manages the slide animations for switching between search levels.
 */
/**
 * SlideTransition
 * Manages the slide animations for switching between search levels.
 */
const SlideTransition = ({ children, itemKey, direction }: { children: React.ReactNode, itemKey: number, direction: 'forward' | 'backward' }) => {
    const [prevChild, setPrevChild] = React.useState<React.ReactNode>(null);
    const [prevKey, setPrevKey] = React.useState(itemKey);
    const [animating, setAnimating] = React.useState(false);

    // Use ref to hold the last valid children snapshot for exit animation
    const lastChildrenRef = useRef(children);
    useEffect(() => { lastChildrenRef.current = children; }, [children]);

    // Detect key change to trigger animation
    if (itemKey !== prevKey) {
        setPrevKey(itemKey);
        setPrevChild(lastChildrenRef.current);
        setAnimating(true);
    }

    // Cleanup after animation
    useEffect(() => {
        if (animating) {
            const timer = setTimeout(() => {
                setPrevChild(null);
                setAnimating(false);
            }, 300); // Must match CSS animation duration
            return () => clearTimeout(timer);
        }
    }, [animating]);

    return (
        <div className="relative w-full h-full overflow-hidden">
            {/* Exiting Item (Snapshot) */}
            {animating && prevChild && (
                <div
                    className={cn(
                        "absolute inset-0 w-full h-full pointer-events-none flex flex-col", // Disable interaction on exiting
                        direction === 'forward' ? 'animate-slide-out-left' : 'animate-slide-out-right'
                    )}
                >
                    {prevChild}
                </div>
            )}

            {/* Entering/Current Item (Live Props) */}
            <div
                className={cn(
                    "w-full h-full flex flex-col",
                    animating && (direction === 'forward' ? 'animate-slide-in-right' : 'animate-slide-in-left')
                )}
            >
                {/* Always render children directly to preserve input state/focus */}
                {children}
            </div>
        </div>
    );
};


const NestedSearchInputContent = () => {
    const {
        values,
        searchLevels,
        setSearchLevels,
        postValuesChange,
        vscode,
        status,
        valuesRef,
        skipSearchUntilRef,
    } = useSearchGlobal();

    const levelIndex = values.searchInResults;
    const currentLevel = searchLevels[levelIndex];

    const handleFindInFound = useCallback(() => {
        // Read from ref to get the LATEST values, not stale closure values
        const currentValues = valuesRef.current;

        console.log('=== NestedSearchInputContent handleFindInFound START ===');
        console.log('currentValues.searchInResults:', currentValues.searchInResults);
        console.log('currentValues.find:', currentValues.find);

        setSearchLevels(prev => {
            const currentLevel = prev[currentValues.searchInResults];
            if (!currentLevel) return prev;

            // Snapshot stats for the current level before moving deeper
            const fileCount = Object.keys(currentLevel.resultsByFile || {}).length;
            const matchCount = reduceMatches(currentLevel.resultsByFile);

            const currentLevelWithStats = {
                ...currentLevel,
                values: { ...currentLevel.values, find: currentValues.find },
                label: currentValues.find || currentLevel.label || '',
                stats: { numMatches: matchCount, numFilesWithMatches: fileCount }
            };

            console.log('NestedSearchInputContent: Saved level', currentValues.searchInResults, 'with find:', currentValues.find);

            const updatedLevels = [...prev];
            updatedLevels[currentValues.searchInResults] = currentLevelWithStats;

            const newLevel: SearchLevel = {
                // Initialize new level with defaults
                values: { ...currentValues, find: '', replace: '', matchCase: false, wholeWord: false, searchMode: 'text' },
                viewMode: 'tree',
                resultsByFile: {},
                matchCase: false, wholeWord: false, searchMode: 'text',
                isReplaceVisible: false,
                expandedFiles: new Set<string>(),
                expandedFolders: new Set<string>(),
                label: '' // Label will be populated by the search query later
            };

            if (updatedLevels.length <= currentValues.searchInResults + 1) updatedLevels.push(newLevel);
            else updatedLevels[currentValues.searchInResults + 1] = newLevel;

            setTimeout(() => postValuesChange({
                searchInResults: currentValues.searchInResults + 1,
                find: '',
                replace: '',
                matchCase: false,
                wholeWord: false,
                searchMode: 'text'
            }), 0);
            return updatedLevels;
        });

        if (status.running) vscode.postMessage({ type: 'stop' });
        console.log('=== NestedSearchInputContent handleFindInFound END ===');
    }, [postValuesChange, status, setSearchLevels, vscode]);

    const handleCopyFileNames = useCallback(() => {
        vscode.postMessage({ type: 'copyFileNames' });
    }, [vscode]);

    const hasResults = currentLevel?.resultsByFile && Object.keys(currentLevel.resultsByFile).length > 0;

    // Handle debounced search for nested levels
    const findValue = currentLevel?.values?.find;
    useEffect(() => {
        if (findValue === undefined) return;

        // Skip if we're within the skip window (navigation happened recently)
        const now = Date.now();
        if (now < skipSearchUntilRef.current) {
            console.log('NestedSearchInputContent useEffect: within skip window, skipping search');
            return;
        }

        const timer = setTimeout(() => {
            // Double-check we're not in skip window
            if (Date.now() < skipSearchUntilRef.current) {
                console.log('NestedSearchInputContent setTimeout: within skip window, skipping search');
                return;
            }

            const currentValues = searchLevels[levelIndex]?.values;
            if (currentValues) {
                vscode.postMessage({
                    type: 'values',
                    values: { ...currentValues, searchInResults: levelIndex }
                });
                vscode.postMessage({
                    type: 'search',
                    ...currentValues,
                    searchInResults: levelIndex
                });
            }
        }, 300);

        return () => clearTimeout(timer);
    }, [findValue, levelIndex, vscode, skipSearchUntilRef]);

    const extraActions = (
        <>
            {/* Animated Find in Found Button */}
            <FindInFoundButton
                key={levelIndex} // Key by level index so state resets on level change
                onClick={handleFindInFound}
                visible={hasResults}
                forceHide={!findValue} // Immediately hide if input is empty
            />

            <Button
                onClick={handleCopyFileNames}
                title="Copy file names"
                variant="ghost"
                size="icon"
                disabled={!hasResults}
                className={cn("transition-opacity duration-300", hasResults ? "opacity-100" : "opacity-0 pointer-events-none")}
            >
                <span className="codicon codicon-copy" />
            </Button>
        </>
    );

    const controller = useSearchItemController({
        levelIndex,
        extraActions,
    });

    return (
        <SearchItemProvider value={controller}>
            <div className="flex flex-col gap-2">
                <SearchInputSection className="flex-grow" />
            </div>
        </SearchItemProvider>
    );
};


export default function SearchNestedView() {
    const {
        values,
        setValues,
        searchLevels,
        setSearchLevels,
        postValuesChange,
        vscode,
        valuesRef,
        skipSearchUntilRef,
    } = useSearchGlobal();

    const breadcrumbsContainerRef = useRef<HTMLDivElement>(null);

    // Track previous index to determine transition direction
    const prevSearchInResults = useRef(values.searchInResults);
    const direction = values.searchInResults > prevSearchInResults.current ? 'forward' : 'backward';

    useEffect(() => {
        prevSearchInResults.current = values.searchInResults;
    }, [values.searchInResults]);

    // Sync current values to searchLevels to ensure breadcrumbs are always up to date
    useEffect(() => {
        setSearchLevels(prev => {
            const currentLevel = prev[values.searchInResults];
            if (!currentLevel) return prev;

            // Only update if changes to avoid render loops (check find string)
            if (currentLevel.values.find === values.find && currentLevel.label === values.find) return prev;

            const newLevels = [...prev];
            newLevels[values.searchInResults] = {
                ...currentLevel,
                values: values,
                label: values.find
            };
            return newLevels;
        });
    }, [values, setSearchLevels]);


    const updateSearchLevelsLength = useCallback((searchLevelsLength: number) => {
        setSearchLevels(prev => prev.slice(0, searchLevelsLength + 1));
    }, [setSearchLevels]);

    const handleCloseNestedSearch = useCallback(() => {
        if (values.searchInResults === 0) return;
        const newSearchInResults = Math.max(0, values.searchInResults - 1);
        postValuesChange({ searchInResults: newSearchInResults });
        updateSearchLevelsLength(newSearchInResults);
    }, [postValuesChange, values.searchInResults, updateSearchLevelsLength]);


    // Auto-scroll breadcrumbs
    useEffect(() => {
        if (breadcrumbsContainerRef.current && searchLevels.length > 1) {
            const timer = setTimeout(() => {
                if (breadcrumbsContainerRef.current) {
                    breadcrumbsContainerRef.current.scrollTo({
                        left: breadcrumbsContainerRef.current.scrollWidth,
                        behavior: 'smooth'
                    });
                }
            }, 100);
            return () => clearTimeout(timer);
        }
    }, [searchLevels.length]);


    // Helper to jump to a level (just updates UI, doesn't trigger new search)
    const jumpToLevel = (index: number) => {
        if (index === values.searchInResults) return; // Already here

        const level = searchLevels[index];
        const levelFindValue = level?.values?.find || level?.label || '';

        // Set timestamp to skip search for the next 500ms
        skipSearchUntilRef.current = Date.now() + 500;

        // Update values with the level's find value restored
        postValuesChange({ searchInResults: index, find: levelFindValue });

        updateSearchLevelsLength(index);
    };

    return (
        <div className="flex flex-col h-full overflow-hidden relative">
            <style>{STYLES}</style>

            <div className="bg-[var(--vscode-editor-background)] p-[5px] rounded-[3px] mb-2.5 relative z-10 shadow-[0_2px_5px_rgba(0,0,0,0.3)] flex-shrink-0 transition-all duration-300">
                {/* Breadcrumbs */}
                <div className="flex justify-between items-start mb-2 overflow-hidden">
                    <div
                        ref={breadcrumbsContainerRef}
                        className="flex items-center overflow-x-auto flex-grow p-[3px] gap-1 no-scrollbar mask-image-fade"
                    >
                        {/* Root Breadcrumb */}
                        <span
                            className={cn(
                                "px-1.5 py-0.5 rounded-[3px] text-xs cursor-pointer hover:underline flex-shrink-0 transition-colors duration-200",
                                0 === Math.min(values.searchInResults, searchLevels.length - 1)
                                    ? "font-bold text-[var(--vscode-foreground)]"
                                    : "text-[var(--vscode-descriptionForeground)]"
                            )}
                            onClick={() => jumpToLevel(0)}
                        >
                            {searchLevels[0]?.values?.find
                                ? (searchLevels[0].values.find.length > 10
                                    ? `${searchLevels[0].values.find.substring(0, 10)}...`
                                    : searchLevels[0].values.find)
                                : 'Root'}
                        </span>

                        {/* Nested Levels */}
                        {searchLevels.slice(1).map((level, index) => {
                            const actualIndex = index + 1;
                            const isCurrent = actualIndex === values.searchInResults;
                            return (
                                <React.Fragment key={actualIndex}>
                                    <span className="codicon codicon-arrow-right flex-shrink-0 scale-75 opacity-50 animate-fade-in" />
                                    <span
                                        className={cn(
                                            "px-1.5 py-0.5 rounded-[3px] text-xs cursor-pointer hover:underline flex-shrink-0 animate-scale-in origin-left whitespace-nowrap",
                                            isCurrent
                                                ? "font-bold bg-[var(--vscode-badge-background)] text-[var(--vscode-badge-foreground)]"
                                                : "text-[var(--vscode-descriptionForeground)] opacity-80"
                                        )}
                                        onClick={() => jumpToLevel(actualIndex)}
                                        title={level.values?.find || `Search ${actualIndex}`}
                                    >
                                        {/* Name */}
                                        {level.values?.find
                                            ? (level.values.find.length > 15
                                                ? `${level.values.find.substring(0, 15)}...`
                                                : level.values.find)
                                            : level.label || `Search ${actualIndex}`}

                                        {/* Stored Stats (Snapshot) */}
                                        {!isCurrent && level.stats && (
                                            <span className="ml-1 opacity-70 font-normal">
                                                ({level.stats.numMatches})
                                            </span>
                                        )}
                                        {/* Live Stats (Current) */}
                                        {isCurrent && (
                                            <LiveStatsWidget resultsByFile={level.resultsByFile} />
                                        )}
                                    </span>
                                </React.Fragment>
                            );
                        })}
                    </div>

                    <Button
                        onClick={handleCloseNestedSearch}
                        title="Close Find in Found"
                        variant="ghost"
                        size="icon"
                        className="flex-shrink-0 ml-1"
                    >
                        <span className="codicon codicon-close"></span>
                    </Button>
                </div>

                {/* Input Section - Animated */}
                <div className="relative overflow-visible min-h-[30px]">
                    <SlideTransition itemKey={values.searchInResults} direction={direction}>
                        <NestedSearchInputContent />
                    </SlideTransition>
                </div>
            </div>

            {/* Results Section - Animated */}
            <div className="flex-grow overflow-hidden relative flex flex-col">
                <SlideTransition itemKey={values.searchInResults} direction={direction}>
                    <ResultsView levelIndex={values.searchInResults} />
                </SlideTransition>
            </div>
        </div>
    );
}
