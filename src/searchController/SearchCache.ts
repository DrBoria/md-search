import * as vscode from 'vscode'
import { TransformResultEvent } from './SearchRunnerTypes'

// Структура кеша поиска
export interface SearchCacheNode {
    // Поисковая строка, которой соответствует этот кеш
    query: string
    // Результаты поиска, хранящиеся в кеше
    results: Map<string, TransformResultEvent>
    // Родительский узел кеша (предыдущий поиск)
    parent: SearchCacheNode | null
    // Дочерние узлы кеша (последующие уточняющие поиски)
    children: Map<string, SearchCacheNode>
    // Флаг завершенности поиска
    isComplete: boolean
    // Дополнительные параметры поиска для проверки совместимости
    params: {
        matchCase: boolean
        wholeWord: boolean
        exclude: string | undefined
        include: string | undefined
    }
    // Исключенные файлы, которые не нужно перепроверять
    excludedFiles: Set<string>
    // Список обработанных файлов
    processedFiles: Set<string>
}

export class SearchCache {
    // Корневой узел кеша
    private root: SearchCacheNode | null = null
    // Текущий активный узел кеша
    private currentNode: SearchCacheNode | null = null
    // Максимальный размер кеша (количество запомненных запросов)
    private maxSize = 20
    // Счетчик для отслеживания размера кеша
    private size = 0
    // Ссылка на канал вывода для логирования
    private outputChannel: vscode.OutputChannel

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel
    }

    /**
     * Находит подходящий кеш для нового поиска
     * @param query строка поиска
     * @param matchCase учитывать регистр
     * @param wholeWord искать целые слова
     * @param exclude шаблон исключения файлов
     * @param include шаблон включения файлов
     * @returns подходящий узел кеша или null
     */
    findSuitableCache(
        query: string,
        matchCase: boolean,
        wholeWord: boolean,
        exclude: string | undefined,
        include: string | undefined = undefined
    ): SearchCacheNode | null {
        if (!this.root) {
            return null
        }

        // Проверяем, начинается ли текущий запрос с запроса из активного узла
        if (this.currentNode && this.isCacheCompatible(this.currentNode, query, matchCase, wholeWord, exclude, include)) {
            // Проверяем, есть ли у текущего узла ребенок, который соответствует запросу
            for (const [childQuery, childNode] of this.currentNode.children.entries()) {
                if (this.isCacheCompatible(childNode, query, matchCase, wholeWord, exclude, include)) {
                    this.outputChannel.appendLine(`[SearchCache] Используем дочерний кеш для запроса "${query}" от родителя "${childNode.query}"`);
                    this.currentNode = childNode;
                    return childNode;
                }
            }

            // Если нет подходящего дочернего, но текущий узел - частичное совпадение
            if (query.startsWith(this.currentNode.query)) {
                this.outputChannel.appendLine(`[SearchCache] Используем текущий кеш для запроса "${query}"`);
                return this.currentNode;
            }
        }

        // Если текущий узел не подходит, ищем в корне
        return this.findNodeFromRoot(query, matchCase, wholeWord, exclude, include);
    }

    /**
     * Выполняет поиск подходящего узла, начиная с корня
     */
    private findNodeFromRoot(
        query: string,
        matchCase: boolean,
        wholeWord: boolean,
        exclude: string | undefined,
        include: string | undefined = undefined
    ): SearchCacheNode | null {
        if (!this.root) {
            return null;
        }

        // Начинаем с корня и пытаемся найти самый длинный префикс
        let bestMatch: SearchCacheNode | null = null;

        const queue: SearchCacheNode[] = [this.root];
        while (queue.length > 0) {
            const node = queue.shift()!;

            if (this.isCacheCompatible(node, query, matchCase, wholeWord, exclude, include)) {
                // Если текущий узел является префиксом запроса и длиннее предыдущего лучшего совпадения
                if (query.startsWith(node.query) && (!bestMatch || node.query.length > bestMatch.query.length)) {
                    bestMatch = node;
                }

                // Добавляем детей в очередь для проверки
                for (const childNode of node.children.values()) {
                    queue.push(childNode);
                }
            }
        }

        if (bestMatch) {
            this.outputChannel.appendLine(`[SearchCache] Найден подходящий кеш для "${query}" в узле "${bestMatch.query}"`);
            this.currentNode = bestMatch;
            return bestMatch;
        }

        return null;
    }

    /**
     * Проверяет, совместим ли кеш с новым запросом
     */
    private isCacheCompatible(
        node: SearchCacheNode,
        query: string,
        matchCase: boolean,
        wholeWord: boolean,
        exclude: string | undefined,
        include: string | undefined = undefined
    ): boolean {
        // Проверяем, начинается ли запрос с запроса из кеша
        if (!query.startsWith(node.query)) {
            return false;
        }

        // Проверяем совместимость параметров поиска
        const sameCase = node.params.matchCase === matchCase;
        const sameWholeWord = node.params.wholeWord === wholeWord;
        const sameExclude = node.params.exclude === exclude;
        // Проверяем совпадение include-паттернов
        const sameInclude = node.params.include === include;

        // Обязательно проверяем совпадение include, так как это критично для результатов поиска
        return sameCase && sameWholeWord && sameExclude && sameInclude;
    }

    /**
     * Создает новый узел кеша для указанного запроса
     */
    createCacheNode(
        query: string,
        matchCase: boolean,
        wholeWord: boolean,
        exclude: string | undefined,
        include: string | undefined = undefined
    ): SearchCacheNode {
        // Ищем родительский узел
        const parentNode = this.findSuitableCache(query, matchCase, wholeWord, exclude, include);

        const newNode: SearchCacheNode = {
            query,
            results: new Map<string, TransformResultEvent>(),
            parent: parentNode,
            children: new Map<string, SearchCacheNode>(),
            isComplete: false,
            params: {
                matchCase,
                wholeWord,
                exclude,
                include
            },
            excludedFiles: new Set<string>(),
            processedFiles: new Set<string>()
        };

        // Если уже есть родительский узел, добавляем новый узел как ребенка
        if (parentNode) {
            parentNode.children.set(query, newNode);

            // Если родительский узел завершён, копируем его результаты в новый узел
            if (parentNode.isComplete) {
                // Копируем только файлы, которые соответствуют новому запросу
                let filteredFiles = 0;
                let excludedFiles = 0;

                for (const [uri, result] of parentNode.results.entries()) {
                    if (this.resultMatchesQuery(result, query, matchCase, wholeWord)) {
                        newNode.results.set(uri, result);
                        filteredFiles++;
                    } else {
                        newNode.excludedFiles.add(uri);
                        excludedFiles++;
                    }
                }

                this.outputChannel.appendLine(
                    `[SearchCache] Из родительского кеша "${parentNode.query}" отфильтровано ` +
                    `${filteredFiles} файлов, исключено ${excludedFiles} файлов для запроса "${query}"`
                );

                // Копируем список обработанных файлов
                parentNode.processedFiles.forEach(file => {
                    newNode.processedFiles.add(file);
                });
            } else {
                this.outputChannel.appendLine(
                    `[SearchCache] Родительский кеш "${parentNode.query}" не завершен, ` +
                    `дополнительный поиск будет выполнен для запроса "${query}"`
                );
            }
        } else {
            // Если родительский узел не найден, этот узел становится корнем
            this.root = newNode;
        }

        this.currentNode = newNode;
        this.size++;

        // Обрезаем кеш, если он слишком большой
        this.pruneCache();

        this.outputChannel.appendLine(`[SearchCache] Создан новый узел кеша для запроса "${query}" с include="${include || 'not set'}"`);
        return newNode;
    }

    /**
     * Добавляет результат в текущий кеш
     */
    addResult(result: TransformResultEvent): void {
        if (!this.currentNode || !result.file) {
            return;
        }

        const uri = result.file.toString();

        // Добавляем только если есть совпадения
        if (result.matches && result.matches.length > 0) {
            this.currentNode.results.set(uri, result);
            this.outputChannel.appendLine(`[SearchCache] Добавлен результат для файла ${uri}`);
        } else {
            this.currentNode.excludedFiles.add(uri);
        }

        // Добавляем файл в список обработанных
        this.currentNode.processedFiles.add(uri);
    }

    /**
     * Помечает текущий узел кеша как завершенный
     */
    markCurrentAsComplete(): void {
        if (this.currentNode) {
            this.currentNode.isComplete = true;
            this.outputChannel.appendLine(`[SearchCache] Узел "${this.currentNode.query}" помечен как завершенный`);
        }
    }

    /**
     * Проверяет, содержит ли результат искомую строку
     */
    private resultMatchesQuery(
        result: TransformResultEvent,
        query: string,
        matchCase: boolean,
        wholeWord: boolean
    ): boolean {
        if (!result.source || !result.matches || result.matches.length === 0) {
            return false;
        }

        // Проверяем каждое совпадение на точное соответствие новому запросу
        const hasMatch = result.matches.some(match => {
            const queryLength = query.length;
            const matchTextLength = match.end - match.start;
            const newMatchStart = Math.min(match.start - (queryLength - matchTextLength));
            const newMatchEnd = Math.max(match.end + (queryLength - matchTextLength));
            const matchText = result.source!.substring(newMatchStart, newMatchEnd);

            // Для строгого сравнения при уточняющем поиске
            if (!matchCase) {
                // При поиске без учета регистра используем toLowerCase для обоих строк
                const lowerText = matchText.toLowerCase();
                const lowerQuery = query.toLowerCase();

                if (wholeWord) {
                    // Для целых слов проверяем соответствие с учетом границ слов
                    const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(lowerQuery)}\\b`, "i");
                    return wordBoundaryRegex.test(lowerText);
                } else {
                    // Для обычного поиска проверяем, содержится ли запрос в совпадении
                    return lowerText.includes(lowerQuery);
                }
            } else {
                // Поиск с учетом регистра - прямое сравнение
                if (wholeWord) {
                    const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(query)}\\b`);
                    return wordBoundaryRegex.test(matchText);
                } else {
                    return matchText.includes(query);
                }
            }
        });

        // Логирование результата
        if (result.file) {
            const fileName = result.file.toString().split('/').pop() || result.file.toString();
            this.outputChannel.appendLine(
                `[SearchCache] Запрос "${query}" для файла ${fileName}: ` +
                `${hasMatch ? 'совпадение найдено' : 'совпадение НЕ найдено'}`
            );
        }

        return hasMatch;
    }

    /**
     * Очищает весь кеш
     */
    clearCache(): void {
        this.root = null;
        this.currentNode = null;
        this.size = 0;
        this.outputChannel.appendLine(`[SearchCache] Кеш очищен`);
    }

    /**
     * Очищает кеш для конкретного файла
     */
    clearCacheForFile(fileUri: vscode.Uri): void {
        if (!this.root) {
            return;
        }

        const filePath = fileUri.toString();
        this.outputChannel.appendLine(`[SearchCache] Очистка кеша для файла ${filePath}`);

        // Очищаем кеш рекурсивно для всех узлов
        const clearRecursive = (node: SearchCacheNode) => {
            // Удаляем файл из результатов
            node.results.delete(filePath);
            node.processedFiles.delete(filePath);
            node.excludedFiles.delete(filePath);

            // Очищаем для всех дочерних узлов
            for (const childNode of node.children.values()) {
                clearRecursive(childNode);
            }
        };

        clearRecursive(this.root);
    }

    /**
     * Проверяет, нужно ли обрабатывать файл при поиске
     */
    shouldProcessFile(filePath: string): boolean {
        if (!this.currentNode) {
            return true;
        }

        // Если файл уже обработан в текущем узле
        if (this.currentNode.processedFiles.has(filePath)) {
            return false;
        }

        // Если файл исключен в текущем узле
        if (this.currentNode.excludedFiles.has(filePath)) {
            return false;
        }

        return true;
    }

    /**
     * Обрезает кеш, если он стал слишком большим
     */
    private pruneCache(): void {
        if (this.size <= this.maxSize) {
            return;
        }

        this.outputChannel.appendLine(`[SearchCache] Обрезка кеша (текущий размер: ${this.size})`);

        // Находим листовые узлы и сортируем их по времени последнего использования
        const leafNodes: SearchCacheNode[] = [];

        const findLeafNodes = (node: SearchCacheNode) => {
            if (node.children.size === 0) {
                leafNodes.push(node);
            } else {
                for (const child of node.children.values()) {
                    findLeafNodes(child);
                }
            }
        };

        if (this.root) {
            findLeafNodes(this.root);
        }

        // Удаляем самые старые листовые узлы
        while (this.size > this.maxSize && leafNodes.length > 0) {
            const nodeToRemove = leafNodes.shift()!;

            if (nodeToRemove.parent) {
                nodeToRemove.parent.children.delete(nodeToRemove.query);
            } else if (nodeToRemove === this.root) {
                this.root = null;
            }

            this.size--;
            this.outputChannel.appendLine(`[SearchCache] Удален узел для запроса "${nodeToRemove.query}"`);
        }
    }

    /**
     * Получает результаты из текущего кеша
     */
    getCurrentResults(): Map<string, TransformResultEvent> | null {
        return this.currentNode ? this.currentNode.results : null;
    }

    /**
     * Получает текущий узел кеша
     */
    getCurrentNode(): SearchCacheNode | null {
        return this.currentNode;
    }

    /**
     * Получает список файлов, которые уже обработаны в текущем кеше
     */
    getProcessedFiles(): Set<string> {
        return this.currentNode ? this.currentNode.processedFiles : new Set<string>();
    }

    /**
     * Получает список исключенных файлов
     */
    getExcludedFiles(): Set<string> {
        return this.currentNode ? this.currentNode.excludedFiles : new Set<string>();
    }

    /**
     * Возвращает признак завершённости текущего поиска
     */
    isCurrentSearchComplete(): boolean {
        return this.currentNode ? this.currentNode.isComplete : false;
    }
}

/**
 * Экранирует спецсимволы регулярных выражений
 */
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
} 
