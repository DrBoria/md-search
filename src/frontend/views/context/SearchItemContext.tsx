import React, { createContext, useContext, useMemo } from 'react';
import { useSearchGlobal } from './SearchGlobalContext';
import { SearchReplaceViewValues } from '../../../model/SearchReplaceViewTypes';

export interface SearchItemViewModel {
    // State
    find: string;
    replace: string;
    matchCase: boolean;
    wholeWord: boolean;
    searchMode: SearchReplaceViewValues['searchMode'];
    isReplaceVisible: boolean;
    viewMode: 'list' | 'tree';
    isSearching: boolean;
    hasResults: boolean;
    include: string;
    exclude: string;

    // Actions
    setFind: (value: string) => void;
    setReplace: (value: string) => void;
    setInclude: (value: string) => void;
    setExclude: (value: string) => void;
    toggleMatchCase: () => void;
    toggleWholeWord: () => void;
    toggleRegex: () => void;
    toggleReplaceVisible: () => void;
    toggleViewMode: () => void;
    stopSearch: () => void;
    replaceAll: () => void;

    // Extra
    extraActions?: React.ReactNode;
    inputRef?: React.RefObject<HTMLTextAreaElement>;
}

const SearchItemContext = createContext<SearchItemViewModel | null>(null);

export const useSearchItem = () => {
    const context = useContext(SearchItemContext);
    if (!context) {
        throw new Error('useSearchItem must be used within a SearchItemProvider');
    }
    return context;
};

export const SearchItemProvider = SearchItemContext.Provider;

// --- Controller Hook ---

interface UseSearchItemControllerProps {
    levelIndex: number; // 0 for root, >0 for nested
    extraActions?: React.ReactNode;
    inputRef?: React.RefObject<HTMLTextAreaElement>;
}

export const useSearchItemController = ({ levelIndex, extraActions, inputRef }: UseSearchItemControllerProps): SearchItemViewModel => {
    const global = useSearchGlobal();

    const isRoot = levelIndex === 0;
    const isNested = levelIndex > 0;

    // Derived State based on Level
    // For Root (0), we use global.values directly for some things, and global.searchLevels[0] for others if needed.
    // However, existing logic updates `values` for root.
    // For Nested (>0), we use `global.searchLevels[levelIndex]`.

    const currentLevel = global.searchLevels[levelIndex] || {};
    // Fallback values
    const values = isRoot ? global.values : (currentLevel.values || {});

    // Extract individual values ensuring defaults
    const find = values.find || '';
    const replace = values.replace || '';
    const matchCase = isRoot ? global.values.matchCase : (currentLevel.values?.matchCase || false);
    const wholeWord = isRoot ? global.values.wholeWord : (currentLevel.values?.wholeWord || false);
    const searchMode = (isRoot ? global.values.searchMode : (currentLevel.values?.searchMode || 'text')) as "text" | "regex";

    // View Mode & Replace Visibility are stored in `searchLevels` or local state in the previous impl.
    // Root `isReplaceVisible` was local state in Layout. 
    // Nested `isReplaceVisible` was local state in NestedView.
    // Creating a unified controller means we might need to hoist this or manage it via the global store if we want "pure" logic.
    // Ideally, `useSearchState` should manage this. 
    // BUT, for now, we can keep it local to the "View" and pass setters? 
    // NO, the user wants "MobX-like" where the component just calls an action.
    // `useSearchState` ALREADY manages `searchLevels` which has `isReplaceVisible`.
    // Let's use `searchLevels[index].isReplaceVisible`.

    // NOTE: The previous `useSearchState` had `isReplaceVisible` in `searchLevels` but the Layout used a separate `useState`.
    // We should probably rely on `searchLevels` for consistency if possible, or we might need to modify `useSearchState`.
    // Let's check `useSearchState.ts`... it initializes `isReplaceVisible: false` in `searchLevels`.

    const isReplaceVisible = currentLevel.isReplaceVisible || false;
    const viewMode = currentLevel.viewMode || 'tree';

    // Actions
    const setFind = (val: string) => {
        if (global.status.running) global.vscode.postMessage({ type: 'stop' });
        // Use postValuesChange for both root and nested levels
        // This ensures valuesRef is updated synchronously
        global.postValuesChange({ find: val });
    };

    // ... Implementing all other actions similarly is complex without modifying `useSearchState` to expose unified actions.
    // HOWEVER, `SearchReplaceViewLayout` had local functions like `toggleReplace`.
    // To decouple, we need valid implementations here.

    const toggleReplaceVisible = () => {
        global.setSearchLevels(prev => {
            const newLevels = [...prev];
            if (newLevels[levelIndex]) {
                newLevels[levelIndex] = {
                    ...newLevels[levelIndex],
                    isReplaceVisible: !newLevels[levelIndex].isReplaceVisible
                };
            }
            return newLevels;
        });
    };

    const setReplace = (val: string) => {
        if (isRoot) {
            global.postValuesChange({ replace: val });
        } else {
            global.setSearchLevels(prev => {
                const newLevels = [...prev];
                if (levelIndex < newLevels.length) {
                    newLevels[levelIndex] = {
                        ...newLevels[levelIndex],
                        values: { ...newLevels[levelIndex].values, replace: val }
                    };
                }
                return newLevels;
            });
        }
    };

    // Include / Exclude
    const include = values.include || '';
    const exclude = values.exclude || '';

    const setInclude = (val: string) => {
        if (isRoot) {
            global.postValuesChange({ include: val });
        } else {
            global.setSearchLevels(prev => {
                const newLevels = [...prev];
                if (levelIndex < newLevels.length) {
                    newLevels[levelIndex] = {
                        ...newLevels[levelIndex],
                        values: { ...newLevels[levelIndex].values, include: val }
                    };
                }
                return newLevels;
            });
        }
    };

    const setExclude = (val: string) => {
        if (isRoot) {
            global.postValuesChange({ exclude: val });
        } else {
            global.setSearchLevels(prev => {
                const newLevels = [...prev];
                if (levelIndex < newLevels.length) {
                    newLevels[levelIndex] = {
                        ...newLevels[levelIndex],
                        values: { ...newLevels[levelIndex].values, exclude: val }
                    };
                }
                return newLevels;
            });
        }
    };

    // View Mode
    const toggleViewMode = () => {
        const newMode = viewMode === 'tree' ? 'list' : 'tree';
        if (isRoot) global.setViewMode(newMode); // Root uses specific state?
        // Actually `useSearchState` has `viewMode`. 
        // But nested levels also have `viewMode`.

        // Unified:
        global.setSearchLevels(prev => {
            const newLevels = [...prev];
            if (newLevels[levelIndex]) {
                newLevels[levelIndex] = { ...newLevels[levelIndex], viewMode: newMode };
            }
            return newLevels;
        });

        if (isRoot) global.setViewMode(newMode); // Sync for root
    };

    // Matches logic
    const toggleMatchCase = () => {
        const newVal = !matchCase;
        if (isRoot) global.postValuesChange({ matchCase: newVal });
        else {
            // Nested update
            global.setSearchLevels(prev => {
                const newLevels = [...prev];
                if (newLevels[levelIndex]) {
                    const nextValues = { ...newLevels[levelIndex].values, matchCase: newVal };
                    newLevels[levelIndex] = { ...newLevels[levelIndex], values: nextValues };
                    global.vscode.postMessage({ type: 'values', values: { ...nextValues, searchInResults: levelIndex } });
                    // Trigger search
                    global.vscode.postMessage({ type: 'search', ...nextValues, searchInResults: levelIndex });
                }
                return newLevels;
            });
        }
    };

    const toggleWholeWord = () => {
        const newVal = !wholeWord;
        if (isRoot) global.postValuesChange({ wholeWord: newVal });
        else {
            // Nested update
            // ... similar to matchCase
            global.setSearchLevels(prev => {
                const newLevels = [...prev];
                if (newLevels[levelIndex]) {
                    const nextValues = { ...newLevels[levelIndex].values, wholeWord: newVal };
                    newLevels[levelIndex] = { ...newLevels[levelIndex], values: nextValues };
                    global.vscode.postMessage({ type: 'values', values: { ...nextValues, searchInResults: levelIndex } });
                    global.vscode.postMessage({ type: 'search', ...nextValues, searchInResults: levelIndex });
                }
                return newLevels;
            });
        }
    };

    const toggleRegex = () => {
        const newVal: "text" | "regex" = searchMode === 'regex' ? 'text' : 'regex';
        if (isRoot) global.postValuesChange({ searchMode: newVal });
        else {
            // ... similar
            global.setSearchLevels(prev => {
                const newLevels = [...prev];
                if (newLevels[levelIndex]) {
                    const nextValues = { ...newLevels[levelIndex].values, searchMode: newVal };
                    newLevels[levelIndex] = { ...newLevels[levelIndex], values: nextValues };
                    global.vscode.postMessage({ type: 'values', values: { ...nextValues, searchInResults: levelIndex } });
                    global.vscode.postMessage({ type: 'search', ...nextValues, searchInResults: levelIndex });
                }
                return newLevels;
            });
        }
    };

    const stopSearch = () => {
        global.vscode.postMessage({ type: 'stop' });
        global.setIsSearchRequested(false);
    };

    const replaceAll = () => {
        // Logic depends on Root vs Nested
        const filePaths = Object.keys(currentLevel.resultsByFile || {});
        if (filePaths.length === 0) return;

        if (isRoot) {
            global.vscode.postMessage({ type: 'replace', filePaths });
        } else {
            // Nested Replace Logic
            const originalValues = { ...global.values };

            // 1. Set global values to match nested values temporarily
            global.vscode.postMessage({
                type: 'values',
                values: {
                    ...global.values,
                    isReplacement: true,
                    find: values.find,
                    replace: values.replace,
                    matchCase,
                    wholeWord,
                    searchMode
                }
            });

            // 2. Trigger replace
            global.vscode.postMessage({ type: 'replace', filePaths });

            // Wait for replace completion to restore state and close nested level
            const handleReplaceDone = (event: MessageEvent) => {
                const message = event.data;
                if (message.type === 'replaceDone' || message.type === 'stop') {
                    global.vscode.postMessage({ type: 'values', values: originalValues });
                    global.setIsSearchRequested(true);
                    global.setSearchLevels(prev => prev.slice(0, levelIndex));
                    window.removeEventListener('message', handleReplaceDone);
                }
            };
            window.addEventListener('message', handleReplaceDone);
        }
    };

    return {
        find, setFind,
        replace, setReplace,
        include, setInclude,
        exclude, setExclude,
        matchCase, toggleMatchCase,
        wholeWord, toggleWholeWord,
        searchMode, toggleRegex,
        isReplaceVisible, toggleReplaceVisible,
        viewMode, toggleViewMode,
        isSearching: global.status.running,
        hasResults: Object.keys(currentLevel.resultsByFile || {}).length > 0,
        stopSearch,
        replaceAll,
        extraActions,
        inputRef
    };
};
