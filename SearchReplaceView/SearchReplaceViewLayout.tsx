import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import {
    VSCodeTextArea,
    VSCodeTextField,
    VSCodeButton,
} from '@vscode/webview-ui-toolkit/react'
import { css, keyframes } from '@emotion/css'
import useEvent from '../react/useEvent'
import {
    MessageToWebview,
    MessageFromWebview,
    SerializedTransformResultEvent,
    SearchReplaceViewStatus,
    SearchReplaceViewValues,
    SearchLevel,
} from './SearchReplaceViewTypes'
import path from 'path-browserify' // Use path-browserify for web compatibility
import { URI } from 'vscode-uri'; // Import URI library
// Используем file-icons-js через window.FileIcons. Импорт файла CSS происходит в SearchReplaceViewEntry.tsx
import { debounce } from 'lodash';
import { getHighlightedMatchContextWithReplacement } from './TreeView/highlightedContextWithReplacement';
import { getHighlightedMatchContext } from './TreeView/highligtedContext';
import { TreeViewNode } from './TreeView';
import { SearchNestedView } from './SearchNestedView';
import { getLineFromSource } from './utils';
import { getFileIcon } from '../components/icons'
// Объявление типа для глобальной переменной
declare global {
    interface Window {
        activeSearchReplaceValues?: SearchReplaceViewValues;
        getDisplayedFileOrder?: () => string[];
        iconsPath?: string;
        MaterialIcons?: {
            getIconForFilePath: (filePath: string) => string;
            getIconUrlForFilePath: (filePath: string, iconsBasePath?: string) => string;
        };
        materialIconsPath?: string;
    }
}

// --- Types for File Tree ---
interface FileTreeNodeBase {
    name: string
    relativePath: string
}

interface FolderNode extends FileTreeNodeBase {
    type: 'folder'
    children: FileTreeNode[]
    stats?: {
        numMatches: number
        numFilesWithMatches: number
    }
}

interface FileNode extends FileTreeNodeBase {
    type: 'file'
    absolutePath: string
    results: SerializedTransformResultEvent[]
}

type FileTreeNode = FolderNode | FileNode

// Helper function to convert file URI to path, handling potential Windows drive letters
function uriToPath(uriString: string | undefined): string {
    if (!uriString) return ''; // Return empty string instead of undefined
    try {
        const uri = URI.parse(uriString);
        if (uri.scheme === 'file') {
            // fsPath handles drive letters correctly (e.g., /c:/Users -> c:\Users)
            return uri.fsPath;
        }
        // Return original string if it's not a file URI or parsing fails
        return uriString;
    } catch (e) {
        // Fallback to returning the original string on error
        return uriString;
    }
}

// --- Helper Function to Build File Tree ---
function buildFileTree(
    resultsByFile: Record<string, SerializedTransformResultEvent[]>,
    workspacePathUri: string, // No longer undefined - it's a required parameter
    customOrder?: { [key: string]: number }, // Add custom order parameter
): FolderNode {
    const root: FolderNode = { name: '', relativePath: '', type: 'folder', children: [], stats: { numMatches: 0, numFilesWithMatches: 0 } }
    const workspacePath = uriToPath(workspacePathUri); // Convert workspace URI to path
    
    // Helper to find or create folder nodes
    const findOrCreateFolder = (
        parent: FolderNode,
        segment: string,
        currentRelativePath: string
    ): FolderNode => {
        const existing = parent.children?.find(
            (child) => child.type === 'folder' && child.name === segment
        ) as FolderNode | undefined
        if (existing) {
            return existing
        }
        const newFolder: FolderNode = {
            name: segment,
            relativePath: currentRelativePath,
            type: 'folder',
            children: [],
            stats: { numMatches: 0, numFilesWithMatches: 0 }
        }
        parent.children.push(newFolder)
        return newFolder
    }

    // Use absolute path as key initially
    Object.entries(resultsByFile).forEach(([absoluteFilePathOrUri, fileResults]) => {
        // Convert file URI/path to a standard path
        const absoluteFilePath = uriToPath(absoluteFilePathOrUri);

        // Calculate relative path if workspacePath is available
        const displayPath = workspacePath
            ? path.relative(workspacePath, absoluteFilePath)
            : absoluteFilePath; // Fallback to absolute if no workspace

        // Ensure consistent POSIX separators for internal logic
        const posixDisplayPath = displayPath.replace(/\\/g, '/'); // Replace backslashes with forward slashes
        const segments = posixDisplayPath.split('/').filter(Boolean);
        let currentNode = root;
        let currentRelativePath = '';

        // Calculate file statistics
        const fileMatches = fileResults?.length > 0 && fileResults[0]?.matches
            ? fileResults.reduce((sum, r) => sum + (r.matches?.length || 0), 0)
            : 0; // Защита от undefined в matches
        const hasMatches = fileMatches > 0;

        // Update root stats for this file
        if (hasMatches) {
            root.stats!.numMatches += fileMatches;
            root.stats!.numFilesWithMatches += 1;
        }

        segments.forEach((segment, index) => {
            // Use posix.join for consistency in relative path construction
            currentRelativePath = currentRelativePath ? path.posix.join(currentRelativePath, segment) : segment;
            if (index === segments.length - 1) {
                // It's a file
                const fileNode: FileNode = {
                    name: path.basename(absoluteFilePath), // Basename from the actual path
                    relativePath: posixDisplayPath, // Store POSIX relative path
                    absolutePath: absoluteFilePathOrUri, // Keep original URI/path for opening
                    type: 'file',
                    results: fileResults
                }
                currentNode.children.push(fileNode)
            } else {
                // It's a folder
                currentNode = findOrCreateFolder(currentNode, segment, currentRelativePath);

                // Update folder stats as we traverse
                if (hasMatches) {
                    currentNode.stats!.numMatches += fileMatches;
                    currentNode.stats!.numFilesWithMatches += 1;
                }
            }
        })
    })

    // Apply custom sorting if provided
    if (customOrder) {
        const sortNodeChildren = (node: FolderNode) => {
            node.children.sort((a, b) => {
                const aOrder = customOrder[a.relativePath] ?? 999999;
                const bOrder = customOrder[b.relativePath] ?? 999999;
                
                if (aOrder !== bOrder) {
                    return aOrder - bOrder;
                }
                
                // Fallback to type and name sorting
                if (a.type !== b.type) {
                    return a.type === 'folder' ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });
            
            // Recursively sort children of folder nodes
            node.children.forEach(child => {
                if (child.type === 'folder') {
                    sortNodeChildren(child);
                }
            });
        };
        
        sortNodeChildren(root);
    } else {
        // Default sorting: folders first, then files, alphabetically
        const sortNodeChildren = (node: FolderNode) => {
            node.children.sort((a, b) => {
                if (a.type !== b.type) {
                    return a.type === 'folder' ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });
            
            // Recursively sort children of folder nodes
            node.children.forEach(child => {
                if (child.type === 'folder') {
                    sortNodeChildren(child);
                }
            });
        };
        
        sortNodeChildren(root);
    }

    return root
}

// --- Helper Function to Filter Tree for Matches ---
function filterTreeForMatches(node: FileTreeNode): FileTreeNode | null {
    if (node.type === 'file') {
        // Keep file only if it has matches
        const hasMatches = node.results.some(r => r.matches && r.matches.length > 0);
        return hasMatches ? node : null;
    } else { // node.type === 'folder'
        // Recursively filter children
        const filteredChildren = node.children
            .map(filterTreeForMatches)
            .filter(Boolean) as FileTreeNode[]; // Filter out nulls

        // Keep folder only if it has children after filtering
        if (filteredChildren.length > 0) {
            // Recalculate stats for the filtered folder
            const stats = {
                numMatches: 0,
                numFilesWithMatches: 0
            };

            // Calculate stats by summing up stats from children
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

            // Sort children again after filtering
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

const leftAnim = keyframes`
  from, 20% {
    left: 0%;
  }
  to {
    left: 100%;
  }
`
const rightAnim = keyframes`
  from {
    right: 100%;
  }
  80%, to {
    right: 0%;
  }
`

// Define props including the vscode api from controller
interface SearchReplaceViewProps {
    vscode: {
        postMessage(message: MessageFromWebview): void
        getState(): { [key: string]: any } | undefined;
        setState(newState: { [key: string]: any }): void;
    }
}

// --- Helper function to get all folder paths from a tree ---
function getAllFolderPaths(node: FileTreeNode | null): string[] {
    if (!node || node.type === 'file') {
        return [];
    }
    // For a folder, return its own path plus paths from all children
    const childPaths = node.children.flatMap(getAllFolderPaths);
    // Add current node's path unless it's the root (which has an empty relativePath)
    return node.relativePath ? [node.relativePath, ...childPaths] : childPaths;
}


export default function SearchReplaceView({ vscode }: SearchReplaceViewProps): React.ReactElement {
    // --- State Initialization using VS Code Webview API ---
    const initialState = {};
    const initialStateSearchLevelsLength = 0;
    const [values, setValues] = useState<SearchReplaceViewValues>({
        // Default values first
        find: '', replace: '', paused: false, include: '', exclude: '',
        parser: 'babel', prettier: true, babelGeneratorHack: false, preferSimpleReplacement: false,
        searchMode: 'text', matchCase: false, wholeWord: false,
        // Then override with loaded state if available
        searchInResults: Math.max(initialStateSearchLevelsLength - 1, 0)
    });
    const [status, setStatus] = useState<SearchReplaceViewStatus>({
        running: false, completed: 0, total: 0, numMatches: 0,
        numFilesThatWillChange: 0, numFilesWithMatches: 0, numFilesWithErrors: 0,
    });
    // Store results keyed by absolute path initially
    const [resultsByFile, setResultsByFile] = useState<Record<string, SerializedTransformResultEvent[]>>({});
    const [workspacePath, setWorkspacePath] = useState<string>('');

    // State to track when a search is requested but results haven't arrived yet
    const [isSearchRequested, setIsSearchRequested] = useState(false);

    // Состояние для пагинации и постепенной загрузки результатов
    const [visibleResultsLimit, setVisibleResultsLimit] = useState(50);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [paginatedFilePaths, setPaginatedFilePaths] = useState<string[]>([]);

    // Прокси объект для отображения только части результатов (оптимизация рендеринга)
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

    // Обновляем видимые пути файлов при изменении результатов
    useEffect(() => {
        const allFilePaths = Object.keys(resultsByFile);
        setPaginatedFilePaths(allFilePaths.slice(0, visibleResultsLimit));
    }, [resultsByFile, visibleResultsLimit]);

    // Функция для загрузки большего количества результатов
    const loadMoreResults = useCallback(() => {
        if (isLoadingMore) return;

        setIsLoadingMore(true);
        // Отложенная загрузка следующей порции данных
        setTimeout(() => {
            setVisibleResultsLimit(prev => prev + 50);
            setIsLoadingMore(false);
        }, 50);
    }, [isLoadingMore]);

    // Состояние для отображения результатов замены
    const [replacementResult, setReplacementResult] = useState<{
        totalReplacements: number;
        totalFilesChanged: number;
        show: boolean;
    }>({
        totalReplacements: 0,
        totalFilesChanged: 0,
        show: false
    });

    // --- UI State ---
    const [isReplaceVisible, setIsReplaceVisible] = useState(false);
    const [showSettings, setShowSettings] = useState(true);
    const [viewMode, setViewMode] = useState<'list' | 'tree'>('tree');
    // Store expanded paths (relative paths) as Sets
    const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set([]));
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set([]));
    const [currentSearchMode, setCurrentSearchMode] = useState<SearchReplaceViewValues['searchMode']>(values?.searchMode);
    const [matchCase, setMatchCase] = useState(values?.matchCase);
    const [wholeWord, setWholeWord] = useState(values?.wholeWord);

    // State for dropdown menu
    const [optionsMenuOpen, setOptionsMenuOpen] = useState(false);

    // Ref для меню опций
    const optionsMenuRef = useRef<HTMLDivElement>(null);

    // Ref для поля поиска вложенного поиска
    const nestedSearchInputRef = useRef<any>(null);
    const searchInputRef = useRef<any>(null);
    const includeInputRef = useRef<any>(null); // New ref for include
    const excludeInputRef = useRef<any>(null); // New ref for exclude
    const mainReplaceInputRef = useRef<any>(null); // New ref for main replace
    // Добавляем ref для кнопки настроек
    const optionsButtonRef = useRef<HTMLDivElement>(null);

    // Закрыть меню при клике вне его области или нажатии клавиши Escape
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            // Проверяем, не является ли цель клика самой кнопкой настроек или ее дочерним элементом
            const isClickOnOptionsButton = optionsButtonRef.current &&
                (optionsButtonRef.current === event.target ||
                    optionsButtonRef.current.contains(event.target as Node));

            // Клик вне меню И не на кнопке настроек закрывает меню
            if (optionsMenuRef.current &&
                !optionsMenuRef.current.contains(event.target as Node) &&
                !isClickOnOptionsButton) {
                setOptionsMenuOpen(false);
            }
        };

        const handleEscapeKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOptionsMenuOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleEscapeKey);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEscapeKey);
        };
    }, []);

    // --- Throttling для обновления результатов ---
    const throttleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const pendingResultsRef = useRef<Record<string, SerializedTransformResultEvent[]>>({});
    const throttleDelayRef = useRef<number>(100); // Начальная задержка 100мс
    const lastUpdateTimeRef = useRef<number>(Date.now());

    // --- Multi-level Nested Search (Find in Found) States ---
    // Initializing searchLevels as an array of search levels, with the base search as the first level
    const [searchLevels, setSearchLevels] = useState<SearchLevel[]>(() => {
        // Check if we have saved search levels in state
        const savedLevels: any[] = [];

        if (savedLevels.length === 0) {
            // Initialize with the base search level only
            return [{
                values,
                resultsByFile,
                matchCase: values?.matchCase,
                wholeWord: values?.wholeWord,
                searchMode: values?.searchMode,
                isReplaceVisible,
                expandedFiles: new Set(),
                expandedFolders: new Set(),
                label: values?.find || 'Initial search'
            }];
        }

        // Convert any saved levels from plain objects to proper SearchLevel objects
        return savedLevels.map((level: any) => ({
            ...level,
            // Convert arrays back to Sets for expandedFiles and expandedFolders
            expandedFiles: level.expandedFiles instanceof Set
                ? level.expandedFiles
                : new Set(Array.isArray(level.expandedFiles) ? level.expandedFiles : []),
            expandedFolders: level.expandedFolders instanceof Set
                ? level.expandedFolders
                : new Set(Array.isArray(level.expandedFolders) ? level.expandedFolders : [])
        }));
    });

    // Convenience flag to check if we're in a nested search
    const isInNestedSearch = searchLevels.length > 1;

    // Keep track of whether replace interface is showing in the active nested search
    const [isNestedReplaceVisible, setIsNestedReplaceVisible] = useState(false);

    // Debounce ref for postValuesChange
    const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

    // Add custom file order state for drag and drop
    const [customFileOrder, setCustomFileOrder] = useState<{ [key: string]: number }>({});

    // Функция для применения накопленных результатов с адаптивным троттлингом
    const flushPendingResults = useCallback(() => {
        const resultCount = Object.keys(pendingResultsRef.current).length;
        if (resultCount === 0) return;

        const now = Date.now();

        // Адаптивный throttling: увеличиваем задержку на основе общего числа совпадений
        let totalMatches = 0;
        for (const results of Object.values(pendingResultsRef.current)) {
            totalMatches += results.reduce((sum, result) => sum + (result.matches?.length || 0), 0);
        }

        if (totalMatches > 1000) {
            throttleDelayRef.current = 500; // Очень большая задержка для огромного количества совпадений
        } else if (totalMatches > 500) {
            throttleDelayRef.current = 400; // Большая задержка
        } else if (totalMatches > 100) {
            throttleDelayRef.current = 300; // Средняя задержка
        } else {
            throttleDelayRef.current = 150; // Стандартная задержка
        }

        // Обнаружение файлов с большим количеством совпадений для автоматического сворачивания
        const filesToCollapse = new Set<string>();

        for (const [filePath, results] of Object.entries(pendingResultsRef.current)) {
            const matchCount = results.reduce((sum, result) => sum + (result.matches?.length || 0), 0);
            if (matchCount > 20) {
                // Если в файле больше 20 совпадений, автоматически сворачиваем его
                // Используем относительный путь, так как expandedFiles хранит относительные пути
                const relativePath = workspacePath
                    ? path.relative(uriToPath(workspacePath), uriToPath(filePath))
                    : uriToPath(filePath);
                filesToCollapse.add(relativePath);
            }
        }

        // Для вложенного поиска обновляем только текущий уровень searchLevels
        // Для обычного поиска обновляем resultsByFile
        if (isInNestedSearch && values.searchInResults > 0) {
            // Обновляем только текущий уровень поиска
            setSearchLevels(prev => {
                // Если нет уровней поиска или неверный индекс, возвращаем как есть
                if (prev.length === 0 || values.searchInResults < 0 || values.searchInResults >= prev.length) {
                    return prev;
                }

                // Создаем копию массива уровней
                const newLevels = [...prev];

                // Получаем текущий уровень
                const level = newLevels[values.searchInResults];
                const updatedResultsByFile = { ...level.resultsByFile };

                // Обрабатываем небольшими порциями для предотвращения блокировки UI
                const entries = Object.entries(pendingResultsRef.current);
                const batchSize = totalMatches > 500 ? 10 : 50;

                for (let i = 0; i < Math.min(batchSize, entries.length); i++) {
                    const [filePath, results] = entries[i];
                    // Пропускаем файлы без результатов
                    if (results.length === 0) continue;

                    // Добавляем результаты в текущий уровень
                    if (!updatedResultsByFile[filePath]) {
                        updatedResultsByFile[filePath] = [...results];
                    } else {
                        updatedResultsByFile[filePath] = [
                            ...updatedResultsByFile[filePath],
                            ...results
                        ];
                    }
                }

                // Если остались необработанные файлы, запланируем следующий вызов
                if (entries.length > batchSize) {
                    const remainingEntries = entries.slice(batchSize);
                    pendingResultsRef.current = Object.fromEntries(remainingEntries);

                    // Запланировать следующую обработку
                    setTimeout(flushPendingResults, 10);
                } else {
                    // Все обработано, очищаем очередь
                    pendingResultsRef.current = {};
                }

                // Обновляем текущий уровень с новыми результатами
                newLevels[values.searchInResults] = {
                    ...level,
                    resultsByFile: updatedResultsByFile
                };

                return newLevels;
            });
        } else {
            // Стандартная обработка для основного поиска
            setResultsByFile(prev => {
                // Если накопленных результатов нет, возвращаем предыдущее состояние без изменений
                if (Object.keys(pendingResultsRef.current).length === 0) {
                    return prev;
                }

                // Создаем новый объект только если есть накопленные результаты
                const newResults = { ...prev };

                // Обрабатываем небольшими порциями для предотвращения блокировки UI
                const entries = Object.entries(pendingResultsRef.current);
                const batchSize = totalMatches > 500 ? 10 : 50; // Меньший размер пакета для больших наборов данных

                for (let i = 0; i < Math.min(batchSize, entries.length); i++) {
                    const [filePath, results] = entries[i];
                    // Пропускаем файлы без результатов
                    if (results.length === 0) continue;

                    // Оптимизация: если файла еще нет, просто назначаем массив напрямую
                    if (!newResults[filePath]) {
                        newResults[filePath] = results;
                    } else {
                        // Используем push вместо spread для эффективности
                        const existingResults = newResults[filePath];
                        results.forEach(result => existingResults.push(result));
                    }
                }

                // Если остались необработанные файлы, запланируем следующий вызов
                if (entries.length > batchSize) {
                    const remainingEntries = entries.slice(batchSize);
                    pendingResultsRef.current = Object.fromEntries(remainingEntries);

                    // Запланировать следующую обработку
                    setTimeout(flushPendingResults, 10);
                } else {
                    // Все обработано, очищаем очередь
                    pendingResultsRef.current = {};
                }

                lastUpdateTimeRef.current = now;

                return newResults;
            });
        }

        // Обновляем состояние развернутых файлов, чтобы автоматически свернуть файлы с большим количеством совпадений
        if (filesToCollapse.size > 0) {
            setExpandedFiles(prev => {
                const newSet = new Set(prev);
                filesToCollapse.forEach(file => {
                    newSet.delete(file);
                });
                return newSet;
            });
        }
    }, [workspacePath, values.searchInResults, isInNestedSearch]);


    // Очистка таймера throttling при размонтировании
    useEffect(() => {
        return () => {
            if (throttleTimeoutRef.current) {
                clearTimeout(throttleTimeoutRef.current);
            }
        };
    }, []);

    // --- Message Listener ---
    useEffect(() => {
        const handleMessage = (event: MessageEvent<MessageToWebview>) => {
            if (!event?.data?.type) {
                return
            }
            const message = event.data;
            switch (message.type) {
                case 'initialData':
                    setWorkspacePath(message.workspacePath); // Store original workspacePath (might be URI)
                    // Устанавливаем параметры, если они переданы
                    if (message.values) {
                        if (searchInputRef.current) {
                            searchInputRef.current.value = message.values.find;
                        }
                        if (mainReplaceInputRef.current && message.values.replace !== undefined) {
                            mainReplaceInputRef.current.value = message.values.replace;
                        }
                        if (includeInputRef.current && message.values.include !== undefined) {
                            includeInputRef.current.value = message.values.include;
                        }
                        if (excludeInputRef.current && message.values.exclude !== undefined) {
                            excludeInputRef.current.value = message.values.exclude;
                        }
                        // Populate nested search input if applicable
                        if (nestedSearchInputRef.current && message.values.searchInResults && message.values.searchInResults > 0) {
                            const activeNestedLevelIndex = message.values.searchInResults;
                            // searchLevels is the component's state, initialized from vscode.getState()
                            if (searchLevels && searchLevels[activeNestedLevelIndex] && searchLevels[activeNestedLevelIndex].values && searchLevels[activeNestedLevelIndex].values.find !== undefined) {
                                nestedSearchInputRef.current.value = searchLevels[activeNestedLevelIndex].values.find;
                            }
                        }
                    }
                    break;
                case 'status':
                    setStatus(prev => ({ ...prev, ...message.status }));
                    break;

                case 'values':
                    setValues(prev => ({ ...prev, ...message.values }));
                    break;
                case 'clearResults':
                    setStatus(prev => ({
                        ...prev,
                        numMatches: 0,
                        numFilesWithMatches: 0,
                        numFilesWithErrors: 0,
                        numFilesThatWillChange: 0,
                        completed: 0,
                        total: 0,
                    }));
                    setExpandedFiles(new Set()); // Clear expanded state
                    setExpandedFolders(new Set());
                    setReplacementResult({ totalReplacements: 0, totalFilesChanged: 0, show: false });
                    pendingResultsRef.current = {}; // Очищаем накопленные результаты
                    setIsSearchRequested(false); // Reset search requested flag
                    if (throttleTimeoutRef.current) {
                        clearTimeout(throttleTimeoutRef.current);
                        throttleTimeoutRef.current = null;
                    }

                    // Clear results for the currently active search level
                    if (isInNestedSearch && values.searchInResults > 0) {
                        setSearchLevels(prev => {
                            const newLevels = [...prev];
                            const currentIndex = values.searchInResults;
                            if (currentIndex >= 0 && currentIndex < newLevels.length) {
                                newLevels[currentIndex] = {
                                    ...newLevels[currentIndex],
                                    resultsByFile: {} // Clear results for the current nested level
                                };
                            }
                            return newLevels;
                        });
                    } else {
                        // This is a base search (or values.searchInResults is 0)
                        setResultsByFile({});
                        // Also ensure searchLevels[0] is cleared if it exists
                        setSearchLevels(prev => {
                            const newLevels = [...prev];
                            if (newLevels.length > 0 && newLevels[0]) { // Check if level 0 exists
                                newLevels[0] = {
                                    ...newLevels[0],
                                    resultsByFile: {} // Clear results for the base level in searchLevels
                                };
                            }
                            return newLevels;
                        });
                    }
                    break;
                case 'addBatchResults': {
                    // Получаем массив результатов
                    const batchResults = message.data;

                    // Если это начало нового поиска, очищаем предыдущие результаты
                    if (message.isSearchRunning) {
                        if (isInNestedSearch && values.searchInResults > 0) {
                            setResultsByFile({});
                            // Если мы во вложенном поиске, очищаем только результаты текущего уровня
                            setSearchLevels(prev => {
                                const newLevels = [...prev];
                                if (values.searchInResults >= 0 && values.searchInResults < newLevels.length) {
                                    newLevels[values.searchInResults] = {
                                        ...newLevels[values.searchInResults],
                                        resultsByFile: {} // Очищаем результаты для текущего уровня
                                    };
                                }
                                return newLevels;
                            });
                        } else {
                            // Если это основной поиск, очищаем основные результаты
                            setResultsByFile({});
                        }
                        setIsSearchRequested(false);
                    }

                    // Проверяем и добавляем результаты в накопитель
                    let hasRelevantResults = false;

                    for (const newResult of batchResults) {
                        // Проверяем, есть ли совпадения
                        const hasMatches = newResult.matches && newResult.matches.length > 0;

                        // Если результат без совпадений и не ошибка, пропускаем
                        if (!hasMatches && !newResult.error) {
                            continue;
                        }

                        hasRelevantResults = true;

                        // Добавляем результат в накопитель
                        if (!pendingResultsRef.current[newResult.file]) {
                            pendingResultsRef.current[newResult.file] = [];
                        }
                        pendingResultsRef.current[newResult.file].push(newResult);
                    }

                    // Если был хотя бы один релевантный результат, обрабатываем их
                    if (hasRelevantResults) {
                        flushPendingResults();
                    }

                    break;
                }
                case 'fileUpdated': {
                    // Обновляем source в результатах поиска и во всех searchLevels
                    const { filePath, newSource } = message;

                    // Обновляем source в основных результатах
                    setResultsByFile(prev => {
                        if (!prev[filePath] || prev[filePath].length === 0) {
                            return prev;
                        }

                        // Создаем новый массив результатов с обновленным source
                        const updatedResults = prev[filePath].map(result => ({
                            ...result,
                            source: newSource
                        }));

                        return {
                            ...prev,
                            [filePath]: updatedResults
                        };
                    });

                    // Обновляем source во всех уровнях поиска
                    setSearchLevels(prev => {
                        // Если нет уровней поиска, возвращаем как есть
                        if (prev.length === 0) return prev;

                        // Обновляем каждый уровень поиска
                        return prev.map(level => {
                            // Если в данном уровне нет результатов для этого файла, оставляем как есть
                            if (!level.resultsByFile[filePath] || level.resultsByFile[filePath].length === 0) {
                                return level;
                            }

                            // Обновляем source в результатах для этого файла
                            const updatedResults = level.resultsByFile[filePath].map(result => ({
                                ...result,
                                source: newSource
                            }));

                            // Создаем новый объект уровня с обновленными результатами
                            return {
                                ...level,
                                resultsByFile: {
                                    ...level.resultsByFile,
                                    [filePath]: updatedResults
                                }
                            };
                        });
                    });

                    break;
                }
                case 'focusSearchInput': {
                    try {
                        if (isInNestedSearch) {
                            // Если мы во вложенном поиске, фокусируем поле вложенного поиска
                            if (nestedSearchInputRef.current) {
                                nestedSearchInputRef.current.select()
                                vscode.postMessage({
                                    type: 'log',
                                    level: 'info',
                                    message: 'Focused nested search input via ref'
                                })
                            } else {
                                // Запасной вариант поиска элемента в DOM
                                const nestedInput = document.querySelector('textarea[name="nestedSearch"]')
                                if (nestedInput) {
                                    (nestedInput as HTMLTextAreaElement).select()
                                    vscode.postMessage({
                                        type: 'log',
                                        level: 'info',
                                        message: 'Focused nested search input via DOM'
                                    })
                                } else {
                                    vscode.postMessage({
                                        type: 'log',
                                        level: 'error',
                                        message: 'Could not find nested search input'
                                    })
                                }
                            }
                        } else {
                            // Используем основное поле поиска
                            if (searchInputRef.current) {
                                searchInputRef.current.select()
                                vscode.postMessage({
                                    type: 'log',
                                    level: 'info',
                                    message: 'Focused main search input via ref'
                                })
                            } else {
                                // Запасной вариант поиска элемента в DOM
                                const mainInput = document.querySelector('textarea[name="search"]')
                                if (mainInput) {
                                    (mainInput as HTMLTextAreaElement).select()
                                    vscode.postMessage({
                                        type: 'log',
                                        level: 'info',
                                        message: 'Focused main search input via DOM'
                                    })
                                } else {
                                    vscode.postMessage({
                                        type: 'log',
                                        level: 'error',
                                        message: 'Could not find main search input'
                                    })
                                }
                            }
                        }
                    } catch (e) {
                        vscode.postMessage({
                            type: 'log',
                            level: 'error',
                            message: `Error focusing search input: ${e}`
                        })
                    }
                    break
                }
                case 'focusReplaceInput': {
                    // Показываем панель замены, если она не видна
                    if (isInNestedSearch) {
                        setIsNestedReplaceVisible(true)
                    } else {
                        setIsReplaceVisible(true)
                    }

                    // Устанавливаем фокус на поле ввода с небольшой задержкой, чтобы DOM успел обновиться
                    setTimeout(() => {
                        try {
                            if (isInNestedSearch) {
                                // Ищем поле замены вложенного поиска
                                const nestedReplaceInput = document.querySelector('textarea[name="nestedReplace"]') as HTMLTextAreaElement
                                if (nestedReplaceInput) {
                                    nestedReplaceInput.focus()
                                    vscode.postMessage({
                                        type: 'log',
                                        level: 'info',
                                        message: 'Focused nested replace input'
                                    })
                                } else {
                                    vscode.postMessage({
                                        type: 'log',
                                        level: 'warn',
                                        message: 'Nested replace input not found'
                                    })
                                }
                            } else {
                                // Ищем основное поле замены
                                const replaceInput = document.querySelector('textarea[name="replace"]') as HTMLTextAreaElement
                                if (replaceInput) {
                                    replaceInput.focus()
                                    vscode.postMessage({
                                        type: 'log',
                                        level: 'info',
                                        message: 'Focused main replace input'
                                    })
                                } else {
                                    vscode.postMessage({
                                        type: 'log',
                                        level: 'warn',
                                        message: 'Main replace input not found'
                                    })
                                }
                            }
                        } catch (e) {
                            vscode.postMessage({
                                type: 'log',
                                level: 'error',
                                message: `Error focusing replace input: ${e}`
                            })
                        }
                    }, 150)
                    break
                }
                case 'replacementComplete': {
                    // При получении сообщения о завершении замены, очищаем дерево и показываем результат
                    setResultsByFile({});
                    setStatus(prev => ({
                        ...prev,
                        numMatches: 0,
                        numFilesWithMatches: 0,
                        completed: 0,
                        total: 0,
                    }));
                    setExpandedFiles(new Set());
                    setExpandedFolders(new Set());
                    pendingResultsRef.current = {}; // Очищаем накопленные результаты

                    // Устанавливаем результаты замены для отображения
                    setReplacementResult({
                        totalReplacements: message.totalReplacements,
                        totalFilesChanged: message.totalFilesChanged,
                        show: true
                    });
                    break;
                }
                case 'undoComplete': {
                    // Обработка завершения операции отката
                    if (message.restored) {
                        // Если файлы были восстановлены, показываем уведомление через vscode
                        vscode.postMessage({
                            type: 'log',
                            level: 'info',
                            message: 'Undo operation completed successfully'
                        });
                        // Очищаем состояние замены, если оно отображается
                        setReplacementResult({ totalReplacements: 0, totalFilesChanged: 0, show: false });
                    } else {
                        vscode.postMessage({
                            type: 'log',
                            level: 'warn',
                            message: 'No operation to undo or undo failed'
                        });
                    }
                    break;
                }
            }
        };

        window.addEventListener('message', handleMessage);

        // Request initial data on mount
        vscode.postMessage({ type: 'mount' });

        const handleBlur = () => {
            vscode.postMessage({ type: 'unmount' });
        }
        window.addEventListener('blur', handleBlur);

        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, [vscode, flushPendingResults, isInNestedSearch, values.searchInResults]); // Добавили isInNestedSearch и values.searchInResults в зависимости

    // --- Callbacks ---
    const postValuesChange = debounce(useCallback((changed: Partial<SearchReplaceViewValues>) => {
        // Immediately update local state for responsiveness
        setValues(prev => {
            const next = {
                ...prev,
                find: changed?.searchInResults !== undefined ? searchLevels[changed.searchInResults]?.values?.find ?? '' : prev.find,
                ...changed,
                isReplacement: false
            };
            // Update dependent local state right away
            if (changed?.searchMode !== undefined) setCurrentSearchMode(changed?.searchMode);
            if (changed?.matchCase !== undefined) setMatchCase(changed?.matchCase);
            if (changed?.wholeWord !== undefined) setWholeWord(changed?.wholeWord);
            if (changed?.searchInResults !== undefined) setSearchLevels(prev => prev.slice(0, (changed?.searchInResults ?? 0) + 1));

            // Post the complete updated values
            vscode.postMessage({ type: 'values', values: next });
            setIsSearchRequested(Boolean(changed?.find));
            return next;
        });
    }, [vscode, status.running]), 300);

    // execute after postValuesChange
    const updateSearchLevelsLength = debounce(useCallback((searchLevelsLength: number) => {
        setSearchLevels(prev => prev.slice(0, searchLevelsLength + 1));
        if (nestedSearchInputRef.current && searchLevels[searchLevelsLength]) {
            nestedSearchInputRef.current.value = searchLevels[searchLevelsLength].values?.find || '';
        }
    }, [vscode]), 301);

    // Cleanup debounce timer on unmount
    useEffect(() => {
        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
        };
    }, []);

    const toggleReplace = useCallback(() => setIsReplaceVisible((v: boolean) => !v), []);
    const toggleSettings = useCallback(() => setShowSettings((v: boolean) => !v), []);

    const handleFindChange = useCallback(
        debounce((e: any) => {
            const newValue = e.target.value;

            // Если поиск выполняется, отменяем его перед запуском нового
            if (status.running) {
                // Отправляем сообщение отмены текущего поиска
                vscode.postMessage({ type: 'stop' });

                // Сбрасываем результаты, оставляя интерфейс чистым для нового поиска
                setResultsByFile({});
                pendingResultsRef.current = {};

                if (throttleTimeoutRef.current) {
                    clearTimeout(throttleTimeoutRef.current);
                    throttleTimeoutRef.current = null;
                }

                // Обновляем статус чтобы показать, что поиск остановлен
                setStatus(prev => ({
                    ...prev,
                    running: false,
                    numMatches: 0,
                    numFilesWithMatches: 0,
                    numFilesWithErrors: 0,
                    numFilesThatWillChange: 0,
                    completed: 0,
                    total: 0,
                }));
            }

            postValuesChange({ find: newValue });

            // If search field is cleared (empty), clear the search results
            if (newValue.trim() === '') {
                // Clear results directly in the local state
                setResultsByFile({});
                setStatus(prev => ({
                    ...prev,
                    numMatches: 0,
                    numFilesWithMatches: 0,
                    numFilesWithErrors: 0,
                    numFilesThatWillChange: 0,
                    completed: 0,
                    total: 0,
                }));
                setExpandedFiles(new Set()); // Clear expanded state
                setExpandedFolders(new Set());
            }
        }, 300, { leading: false, trailing: true }),
        [postValuesChange, status.running, vscode]
    );

    const handleReplaceChange = useCallback((e: any) => {
        postValuesChange({ replace: e.target.value });
    }, [postValuesChange]);

    const toggleMatchCase = useCallback(() => {
        const next = !matchCase;
        setMatchCase(next); // Update local state immediately
        postValuesChange({ matchCase: next });
    }, [matchCase, postValuesChange]);

    const toggleWholeWord = useCallback(() => {
        const next = !wholeWord;
        setWholeWord(next); // Update local state immediately
        postValuesChange({ wholeWord: next });
    }, [wholeWord, postValuesChange]);

    const handleModeChange = useCallback((newMode: SearchReplaceViewValues['searchMode']) => {
        const finalMode = (newMode === currentSearchMode && newMode !== 'text') ? 'text' : newMode;
        setCurrentSearchMode(finalMode); // Update local state immediately
        postValuesChange({ searchMode: finalMode });
    }, [currentSearchMode, postValuesChange]);

    const handleIncludeChange = useCallback((e: any) => {
        postValuesChange({ include: e.target.value });
    }, [postValuesChange]);

    const handleExcludeChange = useCallback((e: any) => {
        postValuesChange({ exclude: e.target.value });
    }, [postValuesChange]);

    const handleReplaceAllClick = useCallback(() => {
        // Собираем списки файлов из текущих результатов
        const currentResultFileList = Object.keys(resultsByFile);

        vscode.postMessage({
            type: 'replace',
            filePaths: currentResultFileList
        });
    }, [vscode, resultsByFile]);

    const handleKeyDown = useEvent((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.ctrlKey || e.metaKey) { /* Potential future shortcuts */ }
    });

    // Toggle expansion for files (uses relative path)
    const toggleFileExpansion = useCallback((relativePath: string) => {
        setExpandedFiles((prev) => {
            const next = new Set(prev);
            if (next.has(relativePath)) next.delete(relativePath);
            else next.add(relativePath);
            return next;
        });
    }, []);

    // Toggle expansion for folders (uses relative path)
    const toggleFolderExpansion = useCallback((relativePath: string) => {
        setExpandedFolders((prev) => {
            const next = new Set(prev);
            if (next.has(relativePath)) next.delete(relativePath);
            else next.add(relativePath);
            return next;
        });
    }, []);

    // Open file (uses absolute path/URI)
    const handleFileClick = useCallback((absolutePathOrUri: string) => {
        vscode.postMessage({ type: 'openFile', filePath: absolutePathOrUri });
    }, [vscode]);

    // Open file to specific match (uses absolute path/URI)
    const handleResultItemClick = useCallback((absolutePathOrUri: string, range?: { start: number; end: number }) => {
        vscode.postMessage({ type: 'openFile', filePath: absolutePathOrUri, ...(range && { range }) });
    }, [vscode]);

    // --- Memoized Data ---
    // Build the initial, unfiltered tree
    const unfilteredFileTree = useMemo(() => {
        // Determine which results to use based on whether we're in nested search
        const activeResults = isInNestedSearch && searchLevels.length > 0
            ? searchLevels[searchLevels.length - 1].resultsByFile
            : resultsByFile;

        return buildFileTree(activeResults, workspacePath, customFileOrder);
    }, [resultsByFile, searchLevels, isInNestedSearch, workspacePath, customFileOrder]);

    // Filter the tree for nodes with matches
    const filteredFileTree = useMemo(() => {
        // Filter the children of the root node
        const rootChildren = unfilteredFileTree.children
            .map(filterTreeForMatches)
            .filter(Boolean) as FileTreeNode[]; // Filter out nulls
        // Sort root children again after filtering
        rootChildren.sort((a, b) => {
            if (a.type !== b.type) {
                return a.type === 'folder' ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });
        // Return a new root node with filtered children
        return { ...unfilteredFileTree, children: rootChildren };
    }, [unfilteredFileTree]);

    // Calculate result counts from status
    const {
        running, numMatches,
        numFilesWithMatches
    } = status;
    const hasResults = filteredFileTree.children.length > 0;

    // --- Derived State ---
    const isAstxMode = currentSearchMode === 'astx';

    // --- Effect to expand all folders AND FILES in FILTERED Tree View by default ---
    useEffect(() => {
        if (viewMode === 'tree' && filteredFileTree && filteredFileTree.children.length > 0) {
            const allFolderPaths = getAllFolderPaths(filteredFileTree);


            const filesToExpand = new Set<string>();

            // Проверяем количество совпадений в каждом файле и развернем только если их <= 20
            const processNode = (node: FileTreeNode) => {
                if (node.type === 'file') {
                    const totalMatches = node.results.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
                    if (totalMatches <= 20) {
                        filesToExpand.add(node.relativePath);
                    }
                } else if (node.type === 'folder') {
                    node.children.forEach(child => processNode(child));
                }
            };

            filteredFileTree.children.forEach(node => processNode(node));

            setExpandedFolders(new Set(allFolderPaths));
            setExpandedFiles(filesToExpand); // Теперь развернем только файлы с небольшим числом совпадений
        }
    }, [filteredFileTree, viewMode]); // Depend on filteredFileTree

    // --- Find in Found Handlers ---
    const handleFindInFound = useCallback(() => {
        // Clear the nested search input value if ref exists
        if (nestedSearchInputRef.current) {
            nestedSearchInputRef.current.value = '';
        }

        // Create a new nested search level with state from current results
        setSearchLevels(prev => {
            // Get current level's state
            const currentLevel = prev[values.searchInResults];

            // Create stats object for the current level before pushing a new one
            const currentLevelWithStats = {
                ...currentLevel,
                stats: {
                    numMatches: status.numMatches,
                    numFilesWithMatches: status.numFilesWithMatches
                }
            };

            // Replace the current level with the one containing stats
            const updatedLevels = [...prev];
            updatedLevels[values.searchInResults] = currentLevelWithStats;

            // Add a new empty level for the next search
            const newLevel: SearchLevel = {
                values: {
                    ...values,
                    find: '', // Start with empty search
                    replace: '' // Always start with empty replace
                },
                viewMode,
                resultsByFile: {},
                matchCase: values?.matchCase,
                wholeWord: values?.wholeWord,
                searchMode: values?.searchMode,
                isReplaceVisible,
                expandedFiles: new Set<string>(),
                expandedFolders: new Set<string>(),
                label: `Search ${updatedLevels.length + 1}`
            };

            // Add new level if needed
            if (updatedLevels.length <= values.searchInResults + 1) {
                updatedLevels.push(newLevel);
            } else {
                updatedLevels[values.searchInResults + 1] = newLevel;
            }

            // Обновляем searchInResults, чтобы указать на новый уровень
            setTimeout(() => {
                postValuesChange({ searchInResults: values.searchInResults + 1 });
            }, 0);

            return updatedLevels;
        });

        // Clear the replace input field
        setIsNestedReplaceVisible(false);

        if (status.running) {
            vscode.postMessage({ type: 'stop' });
        }
    }, [values, postValuesChange, status, isReplaceVisible]);

    const handleCloseNestedSearch = useCallback(() => {
        // Если текущий уровень - 0, ничего не делаем
        if (values.searchInResults === 0) {
            return;
        }

        // Определяем новый уровень поиска
        const newSearchInResults = Math.max(0, values.searchInResults - 1);

        // Обновляем searchInResults
        postValuesChange({ searchInResults: newSearchInResults });
        updateSearchLevelsLength(newSearchInResults);
    }, [postValuesChange, vscode, values.searchInResults, searchLevels]);

    const handleNestedFindChange = useCallback(
        debounce((e: any) => {
            // Если поиск выполняется, отменяем его перед запуском нового
            if (status.running) {
                vscode.postMessage({ type: 'stop' });

                // Очищаем накопленные результаты
                pendingResultsRef.current = {};

                if (throttleTimeoutRef.current) {
                    clearTimeout(throttleTimeoutRef.current);
                    throttleTimeoutRef.current = null;
                }

                // Обновляем статус
                setStatus(prev => ({
                    ...prev,
                    running: false,
                    completed: 0,
                    total: 0,
                }));
            }

            // Обновляем локальное состояние
            setSearchLevels((prev: SearchLevel[]) => {
                // Создаем копию массива
                const newLevels = [...prev];

                // Обновляем активный уровень поиска
                if (values.searchInResults < newLevels.length) {
                    newLevels[values.searchInResults] = {
                        ...newLevels[values.searchInResults],
                        values: {
                            ...newLevels[values.searchInResults].values,
                            find: e.target.value
                        }
                    };

                    // Отправляем обновленные значения в расширение
                    setTimeout(() => {
                        vscode.postMessage({
                            type: 'values',
                            values: {
                                ...newLevels[values.searchInResults].values,
                                searchInResults: values.searchInResults
                            }
                        });
                    }, 0);
                }

                return newLevels;
            });
        }, 300),
        [status.running, vscode, values.searchInResults]
    );


    // Effect to update the base search level when values change
    useEffect(() => {
        if (!isInNestedSearch && searchLevels.length > 0) {
            // Update only the base search level (index 0) with the current values
            setSearchLevels(prev => [
                {
                    ...prev[0],
                    values,
                    matchCase: values?.matchCase,
                    wholeWord: values?.wholeWord,
                    searchMode: values?.searchMode,
                    isReplaceVisible,
                    label: values?.find || 'Initial search'
                },
                ...prev.slice(1)
            ]);
        }
    }, [values, isReplaceVisible, isInNestedSearch]);

    // Function to get file order as displayed in UI
    const getDisplayedFileOrder = useCallback((): string[] => {
        // Determine which results to use based on whether we're in nested search
        const activeResults = isInNestedSearch && searchLevels.length > 0
            ? searchLevels[searchLevels.length - 1].resultsByFile
            : resultsByFile;

        if (viewMode === 'tree') {
            // For tree view, get files in tree traversal order
            const fileOrder: string[] = [];
            const traverseTree = (node: FileTreeNode) => {
                if (node.type === 'file') {
                    fileOrder.push(node.absolutePath);
                } else if (node.type === 'folder') {
                    // Sort children same way as in buildFileTree
                    const sortedChildren = [...node.children];
                    if (Object.keys(customFileOrder).length > 0) {
                        sortedChildren.sort((a, b) => {
                            const aOrder = customFileOrder[a.relativePath] ?? 999999;
                            const bOrder = customFileOrder[b.relativePath] ?? 999999;
                            
                            if (aOrder !== bOrder) {
                                return aOrder - bOrder;
                            }
                            
                            // Fallback to type and name sorting
                            if (a.type !== b.type) {
                                return a.type === 'folder' ? -1 : 1;
                            }
                            return a.name.localeCompare(b.name);
                        });
                    } else {
                        sortedChildren.sort((a, b) => {
                            if (a.type !== b.type) {
                                return a.type === 'folder' ? -1 : 1;
                            }
                            return a.name.localeCompare(b.name);
                        });
                    }
                    sortedChildren.forEach(traverseTree);
                }
            };

            // Build tree and traverse it
            const tree = buildFileTree(activeResults, workspacePath, customFileOrder);
            const filteredTree = filterTreeForMatches(tree);
            if (filteredTree && filteredTree.type === 'folder') {
                filteredTree.children.forEach(traverseTree);
            }
            return fileOrder;
        } else {
            // For list view, sort files by custom order or alphabetically
            const filesWithPaths = Object.keys(activeResults).map(filePath => {
                const displayPath = workspacePath
                    ? path.relative(uriToPath(workspacePath), uriToPath(filePath))
                    : uriToPath(filePath);
                return { filePath, displayPath };
            });

            // Sort by custom order if available, otherwise by display path
            if (Object.keys(customFileOrder).length > 0) {
                filesWithPaths.sort((a, b) => {
                    const aOrder = customFileOrder[a.displayPath] ?? 999999;
                    const bOrder = customFileOrder[b.displayPath] ?? 999999;
                    
                    if (aOrder !== bOrder) {
                        return aOrder - bOrder;
                    }
                    
                    return a.displayPath.localeCompare(b.displayPath);
                });
            } else {
                filesWithPaths.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
            }
            
            return filesWithPaths.map(item => item.filePath);
        }
    }, [viewMode, isInNestedSearch, searchLevels, resultsByFile, workspacePath, customFileOrder]);

    // Хранение текущих значений поиска в глобальной переменной для доступа из разных компонентов
    useEffect(() => {
        window.activeSearchReplaceValues = values;
        // Also store the file order function
        (window as any).getDisplayedFileOrder = getDisplayedFileOrder;
    }, [values, getDisplayedFileOrder]);

    // Функция-обработчик для замены в выбранных файлах
    const handleReplaceSelectedFiles = (filePaths: string[]) => {
        // Проверяем, что у нас есть что заменять
        if (!values?.find || !values.replace || filePaths.length === 0) {
            return;
        }

        // Если поиск в режиме замены, отправляем сообщение с путями файлов
        vscode.postMessage({
            type: 'replace',
            filePaths
        });
    };

    // Функция-обработчик для исключения файла из поиска
    const handleExcludeFile = useCallback((filePath: string) => {
        // Отправляем сообщение в расширение для исключения файла из кэша
        vscode.postMessage({
            type: 'excludeFile',
            filePath
        });

        // Удаляем файл из локального состояния results
        if (isInNestedSearch && values.searchInResults > 0) {
            setSearchLevels(prev => {
                const newLevels = [...prev];
                const currentLevel = newLevels[values.searchInResults];
                if (currentLevel && currentLevel.resultsByFile[filePath]) {
                    const updatedResultsByFile = { ...currentLevel.resultsByFile };
                    delete updatedResultsByFile[filePath];
                    newLevels[values.searchInResults] = {
                        ...currentLevel,
                        resultsByFile: updatedResultsByFile
                    };
                }
                return newLevels;
            });
        } else {
            setResultsByFile(prev => {
                const newResults = { ...prev };
                delete newResults[filePath];
                return newResults;
            });
        }
    }, [vscode, isInNestedSearch, values.searchInResults]);

    // Модифицированное отображение результатов в режиме списка
    const renderListViewResults = () => {
        const resultEntries = Object.entries(paginatedResults);

        return (
            <>
                {resultEntries.length > 0 ? (
                    resultEntries.map(([filePath, results]) => {
                        const displayPath = workspacePath
                            ? path.relative(uriToPath(workspacePath), uriToPath(filePath))
                            : uriToPath(filePath);

                        const totalMatches = results.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
                        if (totalMatches === 0) return null;

                        const filePathKey = filePath;
                        const isExpanded = expandedFiles.has(displayPath);

                        return (
                            <div key={filePathKey} className={css`
                                margin-bottom: 8px;
                                border-radius: 3px;
                                overflow: hidden;
                            `}>
                                {/* File Header */}
                                <div
                                    className={css`
                                        display: flex;
                                        align-items: center;
                                        padding: 2px 2px;
                                        gap: 8px;
                                        cursor: pointer;
                                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                                    `}
                                    onClick={() => toggleFileExpansion(displayPath)}
                                >   
                                    <span className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`} />
                                    {getFileIcon(filePath)}
                                    <span
                                        className={css`font-weight: bold; cursor: pointer;`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleFileClick(filePath);
                                        }}
                                        title={`Click to open ${displayPath}`}
                                    >
                                        {displayPath}
                                    </span>
                                    <span className={css`
                                        margin-left: auto;
                                        color: var(--vscode-descriptionForeground);
                                        margin-right: 8px;
                                    `}>
                                        {totalMatches} matches
                                    </span>
                                    {/* Exclude button for file */}
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleExcludeFile(filePath);
                                        }}
                                        title={`Exclude ${displayPath} from search`}
                                        className={css`
                                            background: transparent;
                                            border: none;
                                            padding: 2px;
                                            cursor: pointer;
                                            display: flex;
                                            align-items: center;
                                            color: #bcbbbc;
                                            border-radius: 3px;
                                            &:hover {
                                                background-color: rgba(128, 128, 128, 0.2);
                                                color: var(--vscode-errorForeground);
                                            }
                                        `}
                                    >
                                        <span className="codicon codicon-close" />
                                    </button>
                                </div>

                                {/* Expanded Matches */}
                                {isExpanded && (
                                    <div className={css`
                                        padding: 4px 0;
                                        background-color: var(--vscode-editor-background);
                                    `}>
                                        {results.map((result, resultIdx) =>
                                            result.matches?.map((match, matchIdx) => (
                                                <div
                                                    key={`${resultIdx}-${matchIdx}`}
                                                    className={css`
                                                        padding: 2px 24px;
                                                        /*  */
                                                        
                                                        cursor: pointer;
                                                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                                                    `}
                                                    onClick={() => handleResultItemClick(filePath, match)}
                                                    title={getLineFromSource(result.source, match.start, match.end)}
                                                    onMouseEnter={(e) => {
                                                        // Set hovering state for the match item
                                                        (e.currentTarget as HTMLElement).dataset.hovered = 'true';
                                                    }}
                                                    onMouseLeave={(e) => {
                                                        // Clear hovering state
                                                        delete (e.currentTarget as HTMLElement).dataset.hovered;
                                                    }}
                                                >
                                                    {values.replace && values.replace.length > 0
                                                        ? getHighlightedMatchContextWithReplacement(
                                                            result.source,
                                                            match,
                                                            values?.find,
                                                            values.replace,
                                                            values?.searchMode,
                                                            values?.matchCase,
                                                            values?.wholeWord
                                                        )
                                                        : getHighlightedMatchContext(result.source, match)}

                                                    {/* Replace button for individual match */}
                                                    {values.replace && (
                                                        <div
                                                            className={css`
                                                                position: absolute;
                                                                right: 5px;
                                                                top: 50%;
                                                                transform: translateY(-50%);
                                                                opacity: 0;
                                                                transition: opacity 0.2s;
                                                                [data-hovered="true"] & {
                                                                    opacity: 1;
                                                                }
                                                            `}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                // For now, just replace all matches in this file
                                                                handleReplaceSelectedFiles([filePath]);
                                                            }}
                                                        >
                                                            <button
                                                                className={css`
                                                                    background-color: var(--vscode-button-background);
                                                                    color: var(--vscode-button-foreground);
                                                                    border: none;
                                                                    border-radius: 2px;
                                                                    cursor: pointer;
                                                                    padding: 2px 6px;
                                                                    font-size: 12px;
                                                                    &:hover {
                                                                        background-color: var(--vscode-button-hoverBackground);
                                                                    }
                                                                `}
                                                                title="Replace this match"
                                                            >
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
                    })
                ) : isSearchRequested ? (
                    <div className={css`
                        padding: 10px;
                        color: var(--vscode-descriptionForeground);
                        text-align: center;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        gap: 8px;
                    `}>
                        <span className="codicon codicon-loading codicon-modifier-spin"></span>
                        <span>Searching...</span>
                    </div>
                ) : (
                    <div className={css`
                        padding: 10px;
                        color: var(--vscode-descriptionForeground);
                        text-align: center;
                    `}>
                        No matches found. Try adjusting your search terms or filters.
                    </div>
                )}

                {/* Кнопка для загрузки дополнительных результатов */}
                {Object.keys(resultsByFile).length > visibleResultsLimit ? (
                    <div className={css`
                        padding: 10px;
                        text-align: center;
                    `}>
                        <button
                            className={css`
                                background-color: var(--vscode-button-background);
                                color: var(--vscode-button-foreground);
                                border: none;
                                padding: 6px 12px;
                                border-radius: 2px;
                                cursor: pointer;
                                &:hover {
                                    background-color: var(--vscode-button-hoverBackground);
                                }
                                &:disabled {
                                    opacity: 0.5;
                                    cursor: not-allowed;
                                }
                            `}
                            onClick={loadMoreResults}
                            disabled={isLoadingMore}
                        >
                            {isLoadingMore ? 'Loading...' : `Load more results (${Object.keys(resultsByFile).length - visibleResultsLimit} remaining)`}
                        </button>
                    </div>
                ) : status.running ? (
                    <div className={css`
                        padding: 10px;
                        color: var(--vscode-descriptionForeground);
                        text-align: center;
                    `}>
                        Searching... {status.completed} / {status.total} files
                    </div>
                ) : null}
            </>
        );
    };

    // Модифицированное отображение древовидного представления
    const renderTreeViewResults = () => {
        // Проверяем, что paginatedResults существует и не пуст
        if (!paginatedResults || Object.keys(paginatedResults).length === 0) {
            return (
                <>
                    {isSearchRequested ? (
                        <div className={css`
                            padding: 10px;
                            color: var(--vscode-descriptionForeground);
                            text-align: center;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            gap: 8px;
                        `}>
                            <span className="codicon codicon-loading codicon-modifier-spin"></span>
                            <span>Searching...</span>
                        </div>
                    ) : status.running ? (
                        <div className={css`
                            padding: 10px;
                            color: var(--vscode-descriptionForeground);
                            text-align: center;
                        `}>
                            Searching... {status.completed} / {status.total} files
                        </div>
                    ) : (
                        <div className={css`
                            padding: 10px;
                            color: var(--vscode-descriptionForeground);
                            text-align: center;
                        `}>
                            No matches found. Try adjusting your search terms or filters.
                        </div>
                    )}
                </>
            );
        }

        // Создаем дерево только из видимых файлов для оптимизации производительности
        const paginatedFileTree = buildFileTree(paginatedResults, workspacePath, customFileOrder);

        return (
            <>
                {paginatedFileTree.children.length > 0 ? (
                    paginatedFileTree.children.map(node => (
                        <TreeViewNode
                            key={node.relativePath}
                            node={node}
                            level={0}
                            expandedFolders={expandedFolders}
                            toggleFolderExpansion={toggleFolderExpansion}
                            expandedFiles={expandedFiles}
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
                ) : status.running ? (
                    <div className={css`
                        padding: 10px;
                        color: var(--vscode-descriptionForeground);
                        text-align: center;
                    `}>
                        Searching... {status.completed} / {status.total} files
                    </div>
                )
                    : isSearchRequested ? (
                        <div className={css`
                        padding: 10px;
                        color: var(--vscode-descriptionForeground);
                        text-align: center;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        gap: 8px;
                    `}>
                            <span className="codicon codicon-loading codicon-modifier-spin"></span>
                            <span>Searching...</span>
                        </div>
                    ) : !status.running ? (
                        <div className={css`
                        padding: 10px;
                        color: var(--vscode-descriptionForeground);
                        text-align: center;
                    `}>
                            No matches found. Try adjusting your search terms or filters.
                        </div>
                    ) : null}

                {/* Кнопка для загрузки дополнительных результатов */}
                {Object.keys(resultsByFile).length > visibleResultsLimit && (
                    <div className={css`
                        padding: 10px;
                        text-align: center;
                    `}>
                        <button
                            className={css`
                               background-color: var(--input-background);
                                border: 1px solid var(--panel-view-border);
                                color: var(--panel-tab-active-border);
                                padding: 6px 12px;
                                border-radius: 2px;
                                cursor: pointer;
                                &:hover {
                                    border: 1px solid var(--panel-tab-active-border);
                                }
                                &:disabled {
                                    opacity: 0.5;
                                    cursor: not-allowed;
                                }
                            `}
                            onClick={loadMoreResults}
                            disabled={isLoadingMore}
                        >
                            {isLoadingMore ? 'Loading...' : `Load more results (${Object.keys(resultsByFile).length - visibleResultsLimit} remaining)`}
                        </button>
                    </div>
                )}
            </>
        );
    };

    // Добавим обработчики для кнопок остановки и возобновления поиска
    const handleStopSearch = useCallback(() => {
        vscode.postMessage({ type: 'abort' });
        setIsSearchRequested(false);
    }, [vscode]);

    // Drag and drop handlers
    const handleDragStart = useCallback((e: React.DragEvent, node: FileTreeNode) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({
            relativePath: node.relativePath,
            type: node.type,
            parentPath: node.relativePath.includes('/') ? node.relativePath.substring(0, node.relativePath.lastIndexOf('/')) : ''
        }));
        e.dataTransfer.effectAllowed = 'move';
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent, targetNode: FileTreeNode) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    }, []);

    const handleDrop = useCallback((e: React.DragEvent, targetNode: FileTreeNode) => {
        e.preventDefault();
        
        try {
            const dragData = JSON.parse(e.dataTransfer.getData('text/plain'));
            const { relativePath: draggedPath, type: draggedType, parentPath: draggedParentPath } = dragData;
            
            // Don't drop on self
            if (draggedPath === targetNode.relativePath) {
                return;
            }
            
            // Get target parent path
            const targetParentPath = targetNode.relativePath.includes('/') 
                ? targetNode.relativePath.substring(0, targetNode.relativePath.lastIndexOf('/'))
                : '';
            
            // Only allow reordering within the same parent
            if (draggedParentPath !== targetParentPath) {
                return;
            }
            
            // Only allow same type reordering (file with file, folder with folder)
            if (draggedType !== targetNode.type) {
                return;
            }
            
            // Get all siblings in the same parent
            const activeResults = isInNestedSearch && searchLevels.length > 0
                ? searchLevels[searchLevels.length - 1].resultsByFile
                : resultsByFile;
            
            const tree = buildFileTree(activeResults, workspacePath, customFileOrder);
            const filteredTree = filterTreeForMatches(tree);
            
            // Find the parent node
            const findParentNode = (node: FileTreeNode, parentPath: string): FolderNode | null => {
                if (node.type === 'folder') {
                    if (node.relativePath === parentPath) {
                        return node;
                    }
                    for (const child of node.children) {
                        const result = findParentNode(child, parentPath);
                        if (result) return result;
                    }
                }
                return null;
            };
            
            const parentNode = targetParentPath 
                ? findParentNode(filteredTree as FolderNode, targetParentPath)
                : filteredTree as FolderNode;
            
            if (!parentNode) return;
            
            // Get siblings of the same type
            const siblings = parentNode.children.filter(child => child.type === draggedType);
            
            // Sort siblings by current custom order to ensure correct positioning
            const sortedSiblings = [...siblings].sort((a, b) => {
                const aOrder = customFileOrder[a.relativePath] ?? 999999;
                const bOrder = customFileOrder[b.relativePath] ?? 999999;
                
                if (aOrder !== bOrder) {
                    return aOrder - bOrder;
                }
                
                // Fallback to name sorting for items without custom order
                return a.name.localeCompare(b.name);
            });
            
            // Create new order
            const newOrder = { ...customFileOrder };
            const baseOrder = sortedSiblings.length * 100; // Give some spacing
            
            // Find positions in the sorted array
            const draggedIndex = sortedSiblings.findIndex(s => s.relativePath === draggedPath);
            const targetIndex = sortedSiblings.findIndex(s => s.relativePath === targetNode.relativePath);
            
            if (draggedIndex === -1 || targetIndex === -1) return;
            
            // Reorder siblings
            const reorderedSiblings = [...sortedSiblings];
            const [draggedItem] = reorderedSiblings.splice(draggedIndex, 1);
            reorderedSiblings.splice(targetIndex, 0, draggedItem);
            
            // Assign new order values
            reorderedSiblings.forEach((sibling, index) => {
                newOrder[sibling.relativePath] = baseOrder + index * 100;
            });
            
            setCustomFileOrder(newOrder);
            
            // Send updated order to extension
            vscode.postMessage({
                type: 'updateFileOrder',
                customOrder: newOrder
            });
            
                 } catch (error) {
            vscode.postMessage({
                type: 'log',
                level: 'error',
                message: `Error handling drop: ${error}`
            });
         }
    }, [customFileOrder, isInNestedSearch, searchLevels, resultsByFile, workspacePath, vscode]);

    // В секции где раньше отображались результаты в режиме списка
    return (
        <div
            onKeyDown={handleKeyDown}
            className={css`
            display: flex;
            flex-direction: column;
            height: 100vh; /* Make main container fill viewport height */
            padding: 5px; /* Add some padding around the whole view */
            box-sizing: border-box; /* Include padding in height calculation */
            --input-background: transparent;
            --dropdown-border: #3c3c3c;
          `}
        >
            {/* Show Find in Found Search Interface when activated */}
            {isInNestedSearch && (
                <SearchNestedView
                    handleNestedFindChange={handleNestedFindChange}
                    setSearchLevels={setSearchLevels}
                    postValuesChange={postValuesChange}
                    values={values}
                    searchLevels={searchLevels}
                    updateSearchLevelsLength={updateSearchLevelsLength}
                    handleCloseNestedSearch={handleCloseNestedSearch}
                    vscode={vscode}
                    viewMode={viewMode}
                    setViewMode={setViewMode}
                    handleStopSearch={handleStopSearch}
                    setIsSearchRequested={setIsSearchRequested}
                    handleFindInFound={handleFindInFound}
                    nestedSearchInputRef={nestedSearchInputRef} />
            )}

            {/* Original Search Interface */}
            <div className={css`
            ${isInNestedSearch ? 'display: none;' : ''} /* Hide completely rather than making opaque */
          `}>
                {/* --- Search/Replace/Actions Row --- */}
                <div className={css` display: flex; align-items: flex-start; gap: 4px; `}>
                    {/* Toggle Replace Button */}
                    <VSCodeButton appearance="icon" onClick={toggleReplace} title="Toggle Replace" className={css` margin-top: 5px; flex-shrink: 0; `}>
                        <span className={`codicon codicon-chevron-${isReplaceVisible ? 'down' : 'right'}`}></span>
                    </VSCodeButton>
                    {/* Search/Replace Text Areas & Options */}
                    <div className={css` flex-grow: 1; display: flex; flex-direction: column; gap: 4px; `}>
                        {/* --- Search Input Row with Options --- */}
                        <div className={css` display: flex; align-items: center; gap: 2px; `}>
                            <VSCodeTextArea
                                placeholder="search"
                                aria-label="Search Pattern"
                                name="search"
                                rows={1}
                                resize="vertical"
                                ref={searchInputRef}
                                defaultValue={values?.find}
                                onInput={handleFindChange}
                                className={css` flex-grow: 1; `} // Make text area grow
                            />

                            {/* Кнопка Pause/Play для управления поиском */}
                            {values.find && (
                                status.running ? (
                                    <VSCodeButton
                                        appearance="icon"
                                        onClick={handleStopSearch}
                                        title="Stop search"
                                        className={css` flex-shrink: 0; `}
                                    >
                                        <span className="codicon codicon-debug-pause"></span>
                                    </VSCodeButton>
                                ) : null
                            )}

                            {/* Search Options Buttons */}
                            <div className={css` position: relative; `}>
                                <VSCodeButton
                                    appearance="icon"
                                    onClick={(e) => {
                                        // Добавляем обработчик, который останавливает всплытие события
                                        e.stopPropagation();
                                        setOptionsMenuOpen(!optionsMenuOpen);
                                    }}
                                    title="Search Options"
                                    className={css`
                                        position: relative;
                                        ${(matchCase || wholeWord || currentSearchMode !== 'text') ? 'color: var(--vscode-button-foreground);' : ''}
                                        ${(matchCase || wholeWord || currentSearchMode !== 'text') ? 'background-color: var(--vscode-button-secondaryBackground);' : ''}
                                    `}
                                >
                                    <span
                                        className="codicon codicon-settings-gear"
                                        ref={optionsButtonRef} // Используем ref на внутреннем элементе
                                    />
                                    {(matchCase || wholeWord || currentSearchMode !== 'text') && (
                                        <span className={css`
                                            position: absolute;
                                            bottom: 0;
                                            right: 0;
                                            width: 6px;
                                            height: 6px;
                                            border-radius: 50%;
                                            background-color: var(--vscode-activityBarBadge-background);
                                        `} />
                                    )}
                                </VSCodeButton>

                                {optionsMenuOpen && (
                                    <div ref={optionsMenuRef} className={css`
                                        position: absolute;
                                        right: 0;
                                        top: 100%;
                                        background-color: var(--vscode-dropdown-background);
                                        border: 1px solid var(--vscode-dropdown-border);
                                        z-index: 10;
                                        display: flex;
                                        flex-direction: column;
                                        min-width: 200px;
                                        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
                                    `}>
                                        <div className={css`
                                            padding: 6px 8px;
                                            display: flex;
                                            align-items: center;
                                            cursor: pointer;
                                            &:hover {
                                                background-color: var(--vscode-list-hoverBackground);
                                            }
                                        `} onClick={toggleMatchCase}>
                                            <span className={css`
                                                visibility: ${matchCase ? 'visible' : 'hidden'};
                                                margin-right: 8px;
                                            `}>✓</span>
                                            <span className="codicon codicon-case-sensitive" style={{ marginRight: '8px' }}></span>
                                            <span>Match Case (Aa)</span>
                                        </div>

                                        <div className={css`
                                            padding: 6px 8px;
                                            display: flex;
                                            align-items: center;
                                            cursor: pointer;
                                            &:hover {
                                                background-color: var(--vscode-list-hoverBackground);
                                            }
                                        `} onClick={toggleWholeWord}>
                                            <span className={css`
                                                visibility: ${wholeWord ? 'visible' : 'hidden'};
                                                margin-right: 8px;
                                            `}>✓</span>
                                            <span className="codicon codicon-whole-word" style={{ marginRight: '8px' }}></span>
                                            <span>Match Whole Word (Ab)</span>
                                        </div>

                                        <div className={css`
                                            padding: 6px 8px;
                                            display: flex;
                                            align-items: center;
                                            cursor: pointer;
                                            &:hover {
                                                background-color: var(--vscode-list-hoverBackground);
                                            }
                                        `} onClick={() => { handleModeChange('regex'); setOptionsMenuOpen(false); }}>
                                            <span className={css`
                                                visibility: ${currentSearchMode === 'regex' ? 'visible' : 'hidden'};
                                                margin-right: 8px;
                                            `}>✓</span>
                                            <span className="codicon codicon-regex" style={{ marginRight: '8px' }}></span>
                                            <span>Use Regular Expression (.*)</span>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                        {/* --- Replace Input Row --- */}
                        {isReplaceVisible && (
                            <div className={css` display: flex; align-items: center; gap: 2px; `}>
                                <VSCodeTextArea
                                    placeholder={isAstxMode ? "replace" : "replace"} // Adjusted placeholder
                                    aria-label="Replace Pattern"
                                    name="replace"
                                    rows={1}
                                    resize="vertical"
                                    ref={mainReplaceInputRef} // Assign ref
                                    defaultValue={values.replace}
                                    onInput={handleReplaceChange}
                                    className={css` flex-grow: 1; `} // Make textarea grow
                                />
                                {/* Moved Replace All button here */}
                                <VSCodeButton
                                    appearance="icon"
                                    onClick={handleReplaceAllClick}
                                    disabled={!hasResults || running} // Simplified disabled logic (assuming replace is visible)
                                    title={!hasResults || running ? "Replace All" : `Replace ${values.replace} in ${numFilesWithMatches} files`}
                                    className={css` flex-shrink: 0; `} // Prevent shrinking
                                >
                                    <span className="codicon codicon-replace-all" />
                                </VSCodeButton>
                            </div>
                        )}
                    </div>
                </div>

                {/* --- Settings Toggle & Result Summary/View Mode --- */}
                <div className={css` display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 0 5px; `}>
                    <div className={css` display: flex; align-items: center; gap: 4px; `}>
                        <VSCodeButton appearance="icon" onClick={toggleSettings} title="Toggle Search Details">
                            <span className={`codicon codicon-ellipsis ${showSettings ? 'codicon-close' : ''}`} />
                        </VSCodeButton>
                        {hasResults && (
                            <span className={css` color: var(--vscode-descriptionForeground); `}>
                                {`${numMatches} results in ${numFilesWithMatches} files`}
                            </span>
                        )}
                    </div>
                    {/* View Mode Toggle Buttons + Find in Found Button */}
                    {hasResults && (
                        <div className={css` display: flex; align-items: center; gap: 4px; `}>
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
                                onClick={() => vscode.postMessage({ type: 'copyFileNames' })}
                                title="Copy file names"
                                className={css` margin-right: 5px; `}
                            >
                                <span className="codicon codicon-files"></span>
                            </VSCodeButton>

                            {/* View Mode Toggle Buttons for nested search */}
                            <div className={css` display: flex; align-items: center; gap: 4px; `}>
                                {/* Show only one button based on current view mode */}
                                {viewMode === 'list' ? (
                                    <VSCodeButton
                                        appearance="icon"
                                        onClick={() => setViewMode('tree')}
                                        title="View as tree"
                                    >
                                        <span className="codicon codicon-list-tree"></span>
                                    </VSCodeButton>
                                ) : (
                                    <VSCodeButton
                                        appearance="icon"
                                        onClick={() => setViewMode('list')}
                                        title="View as list"
                                    >
                                        <span className="codicon codicon-list-flat"></span>
                                    </VSCodeButton>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {!isInNestedSearch && showSettings && (
                    <div className={css` display: flex; flex-direction: column; gap: 5px; padding: 5px; border-top: 1px solid var(--vscode-divider-background); margin-top: 4px;`}>
                        <VSCodeTextField name="filesToInclude" ref={includeInputRef} defaultValue={values.include || ''} onInput={handleIncludeChange}> files to include </VSCodeTextField>
                        <VSCodeTextField name="filesToExclude" ref={excludeInputRef} defaultValue={values.exclude || ''} onInput={handleExcludeChange}> files to exclude </VSCodeTextField>
                    </div>
                )}
            </div>

            {/* --- Results Section --- */}
            <div className={css`
                ${running ? 'position: relative;' : ''}
                padding: 4px;
                flex-grow: 1;
                overflow: auto;
            `}>
                {/* Progress Indicator (during run) */}
                {running && (
                    <div className={css`
                        position: absolute;
                        top: 0px;
                        left: 0px;
                        width: 100%;
                        height: 2px;
                        background-color: var(--vscode-progressBar-background);
                        overflow: hidden;
                        z-index: 2;
                    `}>
                        <div className={css`
                            position: absolute;
                            width: 100%;
                            height: 2px;
                            background-color: var(--vscode-progressBar-foreground);
                            animation: ${leftAnim} 2s infinite ease-in-out,
                                      ${rightAnim} 2s infinite ease-in-out;
                        `} />
                    </div>
                )}

                {/* Display replacement results */}
                {replacementResult.show && (
                    <div className={css`
                        display: flex;
                        flex-direction: column;
                        justify-content: center;
                        align-items: center;
                        height: 100%;
                        text-align: center;
                        padding: 20px;
                    `}>
                        <div className={css`
                            font-size: 1.2em;
                            margin-bottom: 10px;
                            color: var(--vscode-gitDecoration-addedResourceForeground);
                        `}>
                            <span className="codicon codicon-check-all" style={{ marginRight: '8px' }}></span>
                            Replacement completed successfully
                        </div>
                        <div className={css`
                            margin-bottom: 5px;
                            color: var(--vscode-foreground);
                        `}>
                            Replaced <strong>{replacementResult.totalReplacements}</strong> matches
                            in <strong>{replacementResult.totalFilesChanged}</strong> files
                        </div>
                        <VSCodeButton
                            appearance="secondary"
                            onClick={() => {
                                // Reset replacement results state
                                setReplacementResult({
                                    totalReplacements: 0,
                                    totalFilesChanged: 0,
                                    show: false
                                });
                                // Launch new search
                                if (values?.find) {
                                    vscode.postMessage({
                                        type: 'search',
                                        ...values
                                    });
                                }
                            }}
                        >
                            OK
                        </VSCodeButton>
                    </div>
                )}

                {/* Show either nested results or regular results based on state */}
                {!replacementResult.show && isInNestedSearch ? (
                    // Nested search results view
                    Object.keys(searchLevels[values.searchInResults].resultsByFile).length > 0 ? (
                        <div>
                            {viewMode === 'tree' ? (
                                // Tree view for nested results
                                <div>
                                    {filteredFileTree.children.length > 0 ? (
                                        filteredFileTree.children.map(node => (
                                            <TreeViewNode
                                                key={node.relativePath}
                                                node={node}
                                                level={0}
                                                expandedFolders={expandedFolders}
                                                toggleFolderExpansion={toggleFolderExpansion}
                                                expandedFiles={expandedFiles}
                                                toggleFileExpansion={toggleFileExpansion}
                                                handleFileClick={handleFileClick}
                                                handleResultItemClick={handleResultItemClick}
                                                handleReplace={handleReplaceSelectedFiles}
                                                currentSearchValues={searchLevels[values.searchInResults].values}
                                                handleExcludeFile={handleExcludeFile}
                                            />
                                        ))
                                    ) : !status.running ? (
                                        <div className={css`
                                            padding: 10px;
                                            color: var(--vscode-descriptionForeground);
                                            text-align: center;
                                        `}>
                                            No matches found in tree view.
                                        </div>
                                    ) : null}
                                </div>
                            ) : (
                                // List view for nested results
                                <div>
                                    {/* Group results by file */}
                                    {Object.entries(searchLevels[values.searchInResults].resultsByFile).map(([filePath, results]) => {
                                        const displayPath = workspacePath
                                            ? path.relative(uriToPath(workspacePath), uriToPath(filePath))
                                            : uriToPath(filePath);

                                        const totalMatches = results.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
                                        if (totalMatches === 0) return null; // Don't show files without matches

                                        const filePathKey = filePath; // Use original path as key
                                        const isExpanded = expandedFiles.has(displayPath);

                                        return (
                                            <div key={filePathKey} className={css`
                                                margin-bottom: 8px;
                                                border-radius: 3px;
                                                overflow: hidden;
                                            `}>
                                                {/* File Header */}
                                                <div
                                                    className={css`
                                                        display: flex;
                                                        align-items: center;
                                                        padding: 2px 2px;
                                                        gap: 8px;
                                                        cursor: pointer;
                                                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                                                    `}
                                                    onClick={() => toggleFileExpansion(displayPath)}
                                                >
                                                    <span className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`} />
                                                    {getFileIcon(filePath)}
                                                    <span
                                                        className={css`font-weight: bold; cursor: pointer;`}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleFileClick(filePath);
                                                        }}
                                                        title={`Click to open ${displayPath}`}
                                                    >
                                                        {displayPath}
                                                    </span>
                                                    <span className={css`
                                                        margin-left: auto;
                                                        color: var(--vscode-descriptionForeground);
                                                    `}>
                                                        {totalMatches} matches
                                                    </span>
                                                    {/* Exclude button for file in nested search */}
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleExcludeFile(filePath);
                                                        }}
                                                        title={`Exclude ${displayPath} from search`}
                                                        className={css`
                                                            background: transparent;
                                                            border: none;
                                                            padding: 2px;
                                                            cursor: pointer;
                                                            display: flex;
                                                            align-items: center;
                                                            color: #bcbbbc;
                                                            border-radius: 3px;
                                                            margin-left: 8px;
                                                            &:hover {
                                                                background-color: rgba(128, 128, 128, 0.2);
                                                                color: var(--vscode-errorForeground);
                                                            }
                                                        `}
                                                    >
                                                        <span className="codicon codicon-close" />
                                                    </button>
                                                </div>

                                                {/* Expanded Matches */}
                                                {isExpanded && (
                                                    <div className={css`
                                                        padding: 4px 0;
                                                        background-color: var(--vscode-editor-background);
                                                    `}>
                                                        {results.map((result, resultIdx) =>
                                                            result.matches?.map((match, matchIdx) => (
                                                                <div
                                                                    key={`${resultIdx}-${matchIdx}`}
                                                                    className={css`
                                                                        padding: 2px 24px;
                                                                        
                                                                        
                                                                        cursor: pointer;
                                                                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                                                                    `}
                                                                    onClick={() => handleResultItemClick(filePath, match)}
                                                                    title={getLineFromSource(result.source, match.start, match.end)}
                                                                    onMouseEnter={(e) => {
                                                                        // Set hovering state for the match item
                                                                        (e.currentTarget as HTMLElement).dataset.hovered = 'true';
                                                                    }}
                                                                    onMouseLeave={(e) => {
                                                                        // Clear hovering state
                                                                        delete (e.currentTarget as HTMLElement).dataset.hovered;
                                                                    }}
                                                                >
                                                                    {searchLevels[values.searchInResults].values.replace && searchLevels[values.searchInResults].values.replace.length > 0
                                                                        ? getHighlightedMatchContextWithReplacement(
                                                                            result.source,
                                                                            match,
                                                                            searchLevels[values.searchInResults].values?.find,
                                                                            searchLevels[values.searchInResults].values.replace,
                                                                            searchLevels[values.searchInResults].values?.searchMode,
                                                                            searchLevels[values.searchInResults].values?.matchCase,
                                                                            searchLevels[values.searchInResults].values?.wholeWord
                                                                        )
                                                                        : getHighlightedMatchContext(result.source, match)}

                                                                    {/* Replace button for individual match */}
                                                                    {searchLevels[values.searchInResults].values.replace && (
                                                                        <div
                                                                            className={css`
                                                                                position: absolute;
                                                                                right: 5px;
                                                                                top: 50%;
                                                                                transform: translateY(-50%);
                                                                                opacity: 0;
                                                                                transition: opacity 0.2s;
                                                                                [data-hovered="true"] & {
                                                                                    opacity: 1;
                                                                                }
                                                                            `}
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                // For now, just replace all matches in this file
                                                                                // In the future we could implement single match replacement
                                                                                handleReplaceSelectedFiles([filePath]);
                                                                            }}
                                                                        >
                                                                            <button
                                                                                className={css`
                                                                                    background-color: var(--vscode-button-background);
                                                                                    color: var(--vscode-button-foreground);
                                                                                    border: none;
                                                                                    border-radius: 2px;
                                                                                    cursor: pointer;
                                                                                    padding: 2px 6px;
                                                                                    font-size: 12px;
                                                                                    &:hover {
                                                                                        background-color: var(--vscode-button-hoverBackground);
                                                                                    }
                                                                                `}
                                                                                title="Replace this match"
                                                                            >
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
                                </div>
                            )}
                        </div>
                    ) : searchLevels[values.searchInResults].values?.find && !status.running ? (
                        <div className={css`
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100px;
                            color: var(--vscode-descriptionForeground);
                        `}>
                            No matches found for "{searchLevels[values.searchInResults].values?.find}"
                        </div>
                    ) : (
                        <div className={css`
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100px;
                            color: var(--vscode-descriptionForeground);
                        `}>
                            Enter a search term to find within the results
                        </div>
                    )
                ) : !replacementResult.show ? (
                    // Original results view - замена только здесь
                    <>
                        {/* Regular Results View */}
                        {viewMode === 'tree' ? (
                            // Tree view of results (оптимизированный)
                            <div>
                                {renderTreeViewResults()}
                            </div>
                        ) : (
                            // List view of results (оптимизированный)
                            <div>
                                {renderListViewResults()}
                            </div>
                        )}
                    </>
                ) : null}
            </div>
        </div>
    )
}
