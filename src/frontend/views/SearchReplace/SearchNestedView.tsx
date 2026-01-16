import React, { useCallback, useRef, useState } from 'react';
import { css } from "@emotion/css";
import { MessageToWebview, SearchLevel, SearchReplaceViewValues } from "../../../model/SearchReplaceViewTypes";
import { useEffect } from "react";
import { VSCodeButton, VSCodeTextArea } from '@vscode/webview-ui-toolkit/react';

export const SearchNestedView = ({
    handleNestedFindChange,
    setSearchLevels,
    postValuesChange,
    values,
    searchLevels,
    updateSearchLevelsLength,
    handleCloseNestedSearch,
    vscode,
    viewMode,
    setViewMode,
    handleStopSearch,
    setIsSearchRequested,
    handleFindInFound,
    nestedSearchInputRef
}: any) => {
    const [isNestedReplaceVisible, setIsNestedReplaceVisible] = useState(false);

    const toggleNestedReplace = useCallback(() => {
        setIsNestedReplaceVisible((prev: boolean) => !prev);
    }, []);

    const breadcrumbsContainerRef = useRef<HTMLDivElement>(null);

    // Add copy file names handler for nested search
    const handleCopyFileNames = useCallback(() => {
        vscode.postMessage({ type: 'copyFileNames' });
    }, [vscode]);

    const toggleNestedMatchCase = useCallback(() => {
        setSearchLevels((prev: SearchLevel[]) => {
            const newLevels = [...prev];
            const currentLevel = newLevels[values.searchInResults];

            if (currentLevel) {
                const currentVals = currentLevel.values || {};
                const nextMatchCase = !currentVals.matchCase;

                const nextValues = {
                    ...currentVals,
                    matchCase: nextMatchCase
                };

                newLevels[values.searchInResults] = {
                    ...currentLevel,
                    values: nextValues
                };

                // Send immediately using the calculated nextValues
                vscode.postMessage({
                    type: 'log',
                    level: 'info',
                    message: `[SearchNestedView] Toggling matchCase to ${nextMatchCase} for level ${values.searchInResults}`
                });

                vscode.postMessage({
                    type: 'values',
                    values: {
                        ...nextValues,
                        searchInResults: values.searchInResults
                    }
                });

                // Trigger search immediately
                vscode.postMessage({
                    type: 'search',
                    ...nextValues,
                    searchInResults: values.searchInResults
                });
            }

            return newLevels;
        });
    }, [values.searchInResults, vscode]);


    const handleNestedModeChange = useCallback((newMode: SearchReplaceViewValues['searchMode']) => {
        setSearchLevels((prev: SearchLevel[]) => {
            const newLevels = [...prev];
            const currentLevel = newLevels[values.searchInResults];

            if (currentLevel) {
                const currentVals = currentLevel.values || {};
                const currentMode = currentVals.searchMode;
                const modeToSet = (newMode === currentMode && newMode !== 'text') ? 'text' : newMode;

                const nextValues = {
                    ...currentVals,
                    searchMode: modeToSet
                };

                newLevels[values.searchInResults] = {
                    ...currentLevel,
                    values: nextValues
                };

                vscode.postMessage({
                    type: 'log',
                    level: 'info',
                    message: `[SearchNestedView] Setting searchMode to ${modeToSet}`
                });

                vscode.postMessage({
                    type: 'values',
                    values: {
                        ...nextValues,
                        searchInResults: values.searchInResults
                    }
                });

                // Trigger search immediately
                vscode.postMessage({
                    type: 'search',
                    ...nextValues,
                    searchInResults: values.searchInResults
                });
            }

            return newLevels;
        });
    }, [values.searchInResults, vscode]);

    const handleNestedReplaceAllClick = useCallback(() => {
        // First, update the main values with nested values temporarily
        const originalValues = { ...values };
        const currentLevel = searchLevels[searchLevels.length - 1];

        // Собираем списки файлов из вложенного поиска
        const nestedResultFileList = Object.keys(currentLevel.resultsByFile);

        // Set the main search values to match the nested search values
        vscode.postMessage({
            type: 'values',
            values: {
                ...values,
                isReplacement: true,
                find: currentLevel.values?.find,
                replace: currentLevel.values.replace,
                matchCase: currentLevel.values?.matchCase,
                wholeWord: currentLevel.values?.wholeWord,
                searchMode: currentLevel.values?.searchMode
            }
        });

        // Then trigger replace with file list
        vscode.postMessage({
            type: 'replace',
            filePaths: nestedResultFileList
        });

        // Listen for replace completion
        const handleReplaceDone = (event: MessageEvent<MessageToWebview>) => {
            const message = event.data;
            if (message.type === 'replaceDone' || message.type === 'stop') {
                // Restore original values
                vscode.postMessage({
                    type: 'values',
                    values: originalValues
                });
                setIsSearchRequested(true);
                // Close nested search mode after replace is done
                setSearchLevels((prev: SearchLevel[]) => prev.slice(0, -1));

                // Clean up event listener
                window.removeEventListener('message', handleReplaceDone);
            }
        };

        // Add event listener for replace completion
        window.addEventListener('message', handleReplaceDone);

    }, [vscode, values, searchLevels]);


    const toggleNestedWholeWord = useCallback(() => {
        setSearchLevels((prev: SearchLevel[]) => {
            const newLevels = [...prev];
            const currentLevel = newLevels[values.searchInResults];

            if (currentLevel) {
                const currentVals = currentLevel.values || {};
                const nextWholeWord = !currentVals.wholeWord;

                const nextValues = {
                    ...currentVals,
                    wholeWord: nextWholeWord
                };

                newLevels[values.searchInResults] = {
                    ...currentLevel,
                    values: nextValues
                };

                vscode.postMessage({
                    type: 'log',
                    level: 'info',
                    message: `[SearchNestedView] Toggling wholeWord to ${nextWholeWord}`
                });

                vscode.postMessage({
                    type: 'values',
                    values: {
                        ...nextValues,
                        searchInResults: values.searchInResults
                    }
                });

                // Trigger search immediately
                vscode.postMessage({
                    type: 'search',
                    ...nextValues,
                    searchInResults: values.searchInResults
                });
            }

            return newLevels;
        });
    }, [values.searchInResults, vscode]);



    const handleNestedReplaceChange = useCallback((e: any) => {
        setSearchLevels((prev: SearchLevel[]) => {
            // Создаем копию массива
            const newLevels = [...prev];

            // Обновляем активный уровень поиска
            if (values.searchInResults < newLevels.length) {
                newLevels[values.searchInResults] = {
                    ...newLevels[values.searchInResults],
                    values: {
                        ...newLevels[values.searchInResults].values,
                        replace: e.target.value
                    }
                };
            }

            return newLevels;
        });
    }, [values.searchInResults]);

    // Добавляем новый эффект для автоматической прокрутки
    useEffect(() => {
        // Прокрутка к последнему активному поисковому уровню
        if (breadcrumbsContainerRef.current && searchLevels.length > 1) {
            // Установка максимального значения scrollLeft для прокрутки вправо
            breadcrumbsContainerRef.current.scrollLeft = breadcrumbsContainerRef.current.scrollWidth;
        }
    }, [searchLevels.length]); // Зависимость только от количества уровней поиска

    return (
        <div className={css`
  background-color: var(--vscode-editor-background);
  padding: 5px;
  border-radius: 3px;
  margin-bottom: 10px;
  position: relative;
  z-index: 10;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.3);
`}>
            {/* Navigation Breadcrumbs for Nested Searches */}
            <div className={css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  `}>
                {/* Search level breadcrumbs */}
                <div
                    ref={breadcrumbsContainerRef}
                    className={css`
        display: flex;
        align-items: center;
        overflow-x: auto;
        flex-grow: 1;
        padding: 3px;
        gap: 4px;
      `}
                >
                    {/* Base search level - Show truncated search query instead of "Root search" */}
                    <span
                        className={css`
          padding: 2px 6px;
          border-radius: 3px;
          font-size: 12px;
          cursor: pointer;
          color: var(--vscode-descriptionForeground);
          &:hover { text-decoration: underline; }
        `}
                        onClick={() => {
                            // Jump back to root search
                            setSearchLevels((prev: SearchLevel[]) => [prev[0]]);
                            postValuesChange({ searchInResults: 0 });
                            // Trigger a new search to update results
                            if (values?.find) {
                                // Небольшая задержка, чтобы интерфейс успел обновиться
                                setTimeout(() => {
                                    vscode.postMessage({
                                        type: 'search',
                                        ...values,
                                        searchInResults: 0
                                    });
                                }, 100);
                            }
                        }}
                    >
                        {/* Показываем текст первого поискового запроса вместо "Initial" */}
                        {searchLevels[0].values?.find
                            ? (searchLevels[0].values?.find.length > 10
                                ? `${searchLevels[0].values?.find.substring(0, 10)}...`
                                : searchLevels[0].values?.find)
                            : values?.find || 'Root'}
                    </span>

                    {/* @ts-ignore Show each search level as a breadcrumb */}
                    {searchLevels.slice(1).map((level, index) => (
                        <React.Fragment key={index + 1}>
                            {/* Иконка стрелки вместо символа > */}
                            <span className="codicon codicon-arrow-right" style={{ color: 'var(--vscode-descriptionForeground)' }}></span>
                            <span
                                className={css`
              padding: 2px 6px;
              border-radius: 3px;
              font-size: 12px;
              cursor: pointer;
              ${index === searchLevels.length - 2 ? 'font-weight: bold;' : 'color: var(--vscode-descriptionForeground);'}
              ${index === searchLevels.length - 2 ? 'background-color: var(--vscode-badge-background);' : ''}
              &:hover { text-decoration: underline; }
            `}
                                onClick={() => {
                                    // Means - not current search level
                                    if (index <= values.searchInResults - 1) {
                                        const targetLevel = index + 1;

                                        postValuesChange({ searchInResults: targetLevel });
                                        updateSearchLevelsLength(targetLevel);
                                    }
                                }}
                            >
                                {/* Truncate search query if longer than 10 chars */}
                                {level.values?.find
                                    ? (level.values?.find.length > 10
                                        ? `${level.values?.find.substring(0, 10)}...`
                                        : level.values?.find)
                                    : `Search ${index + 1}`}
                                {level.stats && (
                                    <span className={css`
                margin-left: 4px;
                font-size: 10px;
                opacity: 0.8;
              `}>
                                        ({level.stats.numFilesWithMatches} files, {level.stats.numMatches} matches)
                                    </span>
                                )}
                            </span>
                        </React.Fragment>
                    ))}
                </div>

                {/* Close button for the current nested search */}
                <VSCodeButton
                    appearance="icon"
                    onClick={handleCloseNestedSearch}
                    title="Close Find in Found"
                >
                    <span className="codicon codicon-close"></span>
                </VSCodeButton>
            </div>

            {/* Nested Search/Replace Interface */}
            <div className={css` display: flex; align-items: flex-start; gap: 4px; `}>
                {/* Toggle Replace Button */}
                <VSCodeButton appearance="icon" onClick={toggleNestedReplace} title="Toggle Replace" className={css` margin-top: 5px; flex-shrink: 0; `}>
                    <span className={`codicon codicon-chevron-${isNestedReplaceVisible ? 'down' : 'right'}`}></span>
                </VSCodeButton>

                {/* Search/Replace Text Areas & Options */}
                <div className={css` flex-grow: 1; display: flex; flex-direction: column; gap: 4px; `}>
                    {/* --- Search Input Row with Options --- */}
                    <div className={css` display: flex; align-items: center; gap: 2px; `}>
                        <VSCodeTextArea
                            ref={nestedSearchInputRef}
                            placeholder="search"
                            aria-label="Nested Search Pattern"
                            name="nestedSearch"
                            rows={1}
                            resize="vertical"
                            defaultValue={searchLevels[values.searchInResults].values?.find}
                            onInput={handleNestedFindChange}
                            className={css` flex-grow: 1; `} // Make text area grow
                        />
                        {/* Search Options Buttons */}
                        <VSCodeButton
                            appearance={searchLevels[values.searchInResults].values?.matchCase ? "secondary" : "icon"}
                            onClick={toggleNestedMatchCase}
                            title="Match Case (Aa)"
                        >
                            <span className="codicon codicon-case-sensitive" />
                        </VSCodeButton>
                        <VSCodeButton
                            appearance={searchLevels[values.searchInResults].values?.wholeWord ? "secondary" : "icon"}
                            onClick={toggleNestedWholeWord}
                            title="Match Whole Word (Ab)"
                        >
                            <span className="codicon codicon-whole-word" />
                        </VSCodeButton>
                        <VSCodeButton
                            appearance={searchLevels[values.searchInResults].values?.searchMode === 'regex' ? "secondary" : "icon"}
                            onClick={() => handleNestedModeChange('regex')}
                            title="Use Regular Expression (.*)"
                        >
                            <span className="codicon codicon-regex" />
                        </VSCodeButton>
                    </div>

                    {/* --- Nested Replace Input Row --- */}
                    {isNestedReplaceVisible && (
                        <div className={css` display: flex; align-items: center; gap: 2px; `}>
                            <VSCodeTextArea placeholder="replace"
                                aria-label="Nested Replace Pattern"
                                name="nestedReplace"
                                rows={1}
                                resize="vertical"
                                value={values.searchInResults < searchLevels.length ? searchLevels[values.searchInResults].values.replace : ""}
                                onInput={handleNestedReplaceChange}
                                className={css` flex-grow: 1; `} // Make textarea grow
                            />
                            {/* Кнопка Replace All для вложенного поиска */}
                            <VSCodeButton
                                appearance="icon"
                                onClick={handleNestedReplaceAllClick}
                                disabled={!Object.keys(searchLevels[values.searchInResults].resultsByFile).length}
                                title={!Object.keys(searchLevels[values.searchInResults].resultsByFile).length ? "Replace All" : `Replace ${searchLevels[values.searchInResults].values.replace} in matched files`}
                                className={css` flex-shrink: 0; `} // Prevent shrinking
                            >
                                <span className="codicon codicon-replace-all" />
                            </VSCodeButton>
                        </div>
                    )}
                </div>
            </div>

            {/* Button to add another level of nested search */}
            {Object.keys(searchLevels[values.searchInResults]?.resultsByFile).length > 0 && (
                <div className={css`
        display: flex;
        justify-content: flex-end;
        margin-top: 8px;
        margin-bottom: 8px;
    `}>
                    {/* @ts-ignore Кнопка Pause/Play для управления поиском */}
                    {status.running && (
                        <VSCodeButton
                            appearance="icon"
                            onClick={handleStopSearch}
                            title="Stop search"
                            className={css` margin-right: 5px; `}
                        >
                            <span className="codicon codicon-debug-pause"></span>
                        </VSCodeButton>
                    )}

                    {/* Find in Found Button */}
                    <VSCodeButton
                        appearance="icon"
                        onClick={handleFindInFound}
                        title="Search within these results"
                        className={css` margin-right: 5px; `}
                    >
                        <span className="codicon codicon-filter-filled"></span>
                    </VSCodeButton>

                    {/* Copy File Names Button */}
                    <VSCodeButton
                        appearance="icon"
                        onClick={handleCopyFileNames}
                        title="Copy file names with # prefix"
                        className={css` margin-right: 5px; `}
                    >
                        <span className="codicon codicon-files"></span>
                    </VSCodeButton>

                    {/* View Mode Toggle Button */}
                    <VSCodeButton
                        appearance="icon"
                        onClick={() => setViewMode(viewMode === 'tree' ? 'list' : 'tree')}
                        title={viewMode === 'tree' ? 'Switch to list view' : 'Switch to tree view'}
                        className={css`
                            margin-left: 4px;
                        `}
                    >
                        <span className={`codicon ${viewMode === 'tree' ? 'codicon-list-flat' : 'codicon-list-tree'}`}></span>
                    </VSCodeButton>
                </div>
            )}
        </div>
    )
}
