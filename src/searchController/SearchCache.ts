import * as vscode from 'vscode'
import { TransformResultEvent } from './SearchRunnerTypes'

// Search cache structure
export interface SearchCacheNode {
    // Search string corresponding to this cache
    query: string
    // Search results stored in the cache
    results: Map<string, TransformResultEvent>
    // Parent cache node (previous search)
    parent: SearchCacheNode | null
    // Child cache nodes (subsequent refined searches)
    children: Map<string, SearchCacheNode>
    // Search completion flag
    isComplete: boolean
    // Additional search parameters for compatibility checking
    params: {
        matchCase: boolean
        wholeWord: boolean
        exclude: string | undefined
        include: string | undefined
    }
    // Excluded files that don't need to be rechecked
    excludedFiles: Set<string>
    // List of processed files
    processedFiles: Set<string>
}

export class SearchCache {
    // Root cache node
    private root: SearchCacheNode | null = null
    // Current active cache node
    private currentNode: SearchCacheNode | null = null
    // Maximum cache size (number of remembered queries)
    private maxSize = 20
    // Counter for tracking cache size
    private size = 0
    // Reference to output channel for logging
    private outputChannel: vscode.OutputChannel

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel
    }

    /**
     * Finds a suitable cache for a new search
     * @param query search string
     * @param matchCase match case
     * @param wholeWord search whole words
     * @param exclude file exclusion pattern
     * @param include file inclusion pattern
     * @returns suitable cache node or null
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

        // Check if current query starts with query from active node
        if (this.currentNode && this.isCacheCompatible(this.currentNode, query, matchCase, wholeWord, exclude, include)) {
            // Check if current node has a child that matches the query
            for (const [childQuery, childNode] of this.currentNode.children.entries()) {
                if (this.isCacheCompatible(childNode, query, matchCase, wholeWord, exclude, include)) {
                    this.outputChannel.appendLine(`[SearchCache] Using child cache for query "${query}" from parent "${childNode.query}"`);
                    this.currentNode = childNode;
                    return childNode;
                }
            }

            // If no suitable child, but current node is a partial match
            if (query.startsWith(this.currentNode.query)) {
                this.outputChannel.appendLine(`[SearchCache] Using current cache for query "${query}"`);
                return this.currentNode;
            }
        }

        // If current node is not suitable, search from the root
        return this.findNodeFromRoot(query, matchCase, wholeWord, exclude, include);
    }

    /**
     * Searches for a suitable node, starting from the root
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

        // Start from the root and try to find the longest prefix
        let bestMatch: SearchCacheNode | null = null;

        const queue: SearchCacheNode[] = [this.root];
        while (queue.length > 0) {
            const node = queue.shift()!;

            if (this.isCacheCompatible(node, query, matchCase, wholeWord, exclude, include)) {
                // If current node is a prefix of the query and longer than the previous best match
                if (query.startsWith(node.query) && (!bestMatch || node.query.length > bestMatch.query.length)) {
                    bestMatch = node;
                }

                // Add children to the queue for checking
                for (const childNode of node.children.values()) {
                    queue.push(childNode);
                }
            }
        }

        if (bestMatch) {
            this.outputChannel.appendLine(`[SearchCache] Found suitable cache for "${query}" in node "${bestMatch.query}"`);
            this.currentNode = bestMatch;
            return bestMatch;
        }

        return null;
    }

    /**
     * Checks if the cache is compatible with a new query
     */
    private isCacheCompatible(
        node: SearchCacheNode,
        query: string,
        matchCase: boolean,
        wholeWord: boolean,
        exclude: string | undefined,
        include: string | undefined = undefined
    ): boolean {
        // Check if query starts with cache query
        if (!query.startsWith(node.query)) {
            return false;
        }

        // Check search parameter compatibility
        const sameCase = node.params.matchCase === matchCase;
        const sameWholeWord = node.params.wholeWord === wholeWord;
        const sameExclude = node.params.exclude === exclude;
        // Check include pattern match
        const sameInclude = node.params.include === include;

        // Must check include match, as it is critical for search results
        return sameCase && sameWholeWord && sameExclude && sameInclude;
    }

    /**
     * Creates a new cache node for the specified query
     */
    createCacheNode(
        query: string,
        matchCase: boolean,
        wholeWord: boolean,
        exclude: string | undefined,
        include: string | undefined = undefined
    ): SearchCacheNode {
        // Find the parent node
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

        // If there's already a parent node, add the new node as a child
        if (parentNode) {
            parentNode.children.set(query, newNode);

            // If the parent node is complete, copy its results to the new node
            if (parentNode.isComplete) {
                // Copy only files that match the new query
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
                    `[SearchCache] From parent cache "${parentNode.query}" filtered ` +
                    `${filteredFiles} files, excluded ${excludedFiles} files for query "${query}"`
                );

                // Copy the list of processed files
                parentNode.processedFiles.forEach(file => {
                    newNode.processedFiles.add(file);
                });
            } else {
                this.outputChannel.appendLine(
                    `[SearchCache] Parent cache "${parentNode.query}" is not complete, ` +
                    `additional search will be performed for query "${query}"`
                );
            }
        } else {
            // If no parent node found, this node becomes the root
            this.root = newNode;
        }

        this.currentNode = newNode;
        this.size++;

        // Trim the cache if it's too large
        this.pruneCache();

        this.outputChannel.appendLine(`[SearchCache] Created new cache node for query "${query}" with include="${include || 'not set'}"`);
        return newNode;
    }

    /**
     * Adds a result to the current cache
     */
    addResult(result: TransformResultEvent): void {
        if (!this.currentNode || !result.file) {
            return;
        }

        const uri = result.file.toString();

        // Add only if there are matches
        if (result.matches && result.matches.length > 0) {
            this.currentNode.results.set(uri, result);
            this.outputChannel.appendLine(`[SearchCache] Added result for file ${uri}`);
        } else {
            this.currentNode.excludedFiles.add(uri);
        }

        // Add file to the list of processed files
        this.currentNode.processedFiles.add(uri);
    }

    /**
     * Marks the current cache node as complete
     */
    markCurrentAsComplete(): void {
        if (this.currentNode) {
            this.currentNode.isComplete = true;
            this.outputChannel.appendLine(`[SearchCache] Node "${this.currentNode.query}" marked as complete`);
        }
    }

    /**
     * Checks if the result contains the search string
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

        // Check each match for exact match with the new query
        const hasMatch = result.matches.some(match => {
            const queryLength = query.length;
            const matchTextLength = match.end - match.start;
            const newMatchStart = Math.min(match.start - (queryLength - matchTextLength));
            const newMatchEnd = Math.max(match.end + (queryLength - matchTextLength));
            const matchText = result.source!.substring(newMatchStart, newMatchEnd);

            // For strict comparison in refined search
            if (!matchCase) {
                // When searching without case consideration, use toLowerCase for both strings
                const lowerText = matchText.toLowerCase();
                const lowerQuery = query.toLowerCase();

                if (wholeWord) {
                    // For whole words, check word boundary match with case consideration
                    const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(lowerQuery)}\\b`, "i");
                    return wordBoundaryRegex.test(lowerText);
                } else {
                    // For regular search, check if query is included in the match
                    return lowerText.includes(lowerQuery);
                }
            } else {
                // Case-sensitive search - direct comparison
                if (wholeWord) {
                    const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(query)}\\b`);
                    return wordBoundaryRegex.test(matchText);
                } else {
                    return matchText.includes(query);
                }
            }
        });

        // Logging result
        if (result.file) {
            const fileName = result.file.toString().split('/').pop() || result.file.toString();
            this.outputChannel.appendLine(
                `[SearchCache] Query "${query}" for file ${fileName}: ` +
                `${hasMatch ? 'match found' : 'match NOT found'}`
            );
        }

        return hasMatch;
    }

    /**
     * Clears the entire cache
     */
    clearCache(): void {
        this.root = null;
        this.currentNode = null;
        this.size = 0;
        this.outputChannel.appendLine(`[SearchCache] Cache cleared`);
    }

    /**
     * Clears the cache for a specific file
     */
    clearCacheForFile(fileUri: vscode.Uri): void {
        if (!this.root) {
            return;
        }

        const filePath = fileUri.toString();
        this.outputChannel.appendLine(`[SearchCache] Clearing cache for file ${filePath}`);

        // Clear cache recursively for all nodes
        const clearRecursive = (node: SearchCacheNode) => {
            // Remove file from results
            node.results.delete(filePath);
            node.processedFiles.delete(filePath);
            node.excludedFiles.delete(filePath);

            // Clear for all child nodes
            for (const childNode of node.children.values()) {
                clearRecursive(childNode);
            }
        };

        clearRecursive(this.root);
    }

    /**
     * Checks if a file needs to be processed when searching
     */
    shouldProcessFile(filePath: string): boolean {
        if (!this.currentNode) {
            return true;
        }

        // If file is already processed in the current node
        if (this.currentNode.processedFiles.has(filePath)) {
            return false;
        }

        // If file is excluded in the current node
        if (this.currentNode.excludedFiles.has(filePath)) {
            return false;
        }

        return true;
    }

    /**
     * Trims the cache if it's too large
     */
    private pruneCache(): void {
        if (this.size <= this.maxSize) {
            return;
        }

        this.outputChannel.appendLine(`[SearchCache] Cache trimming (current size: ${this.size})`);

        // Find leaf nodes and sort them by last usage time
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

        // Remove the oldest leaf nodes
        while (this.size > this.maxSize && leafNodes.length > 0) {
            const nodeToRemove = leafNodes.shift()!;

            if (nodeToRemove.parent) {
                nodeToRemove.parent.children.delete(nodeToRemove.query);
            } else if (nodeToRemove === this.root) {
                this.root = null;
            }

            this.size--;
            this.outputChannel.appendLine(`[SearchCache] Removed node for query "${nodeToRemove.query}"`);
        }
    }

    /**
     * Gets results from the current cache
     */
    getCurrentResults(): Map<string, TransformResultEvent> | null {
        return this.currentNode ? this.currentNode.results : null;
    }

    /**
     * Gets the current cache node
     */
    getCurrentNode(): SearchCacheNode | null {
        return this.currentNode;
    }

    /**
     * Gets the list of files that have already been processed in the current cache
     */
    getProcessedFiles(): Set<string> {
        return this.currentNode ? this.currentNode.processedFiles : new Set<string>();
    }

    /**
     * Gets the list of excluded files
     */
    getExcludedFiles(): Set<string> {
        return this.currentNode ? this.currentNode.excludedFiles : new Set<string>();
    }

    /**
     * Returns the completion flag of the current search
     */
    isCurrentSearchComplete(): boolean {
        return this.currentNode ? this.currentNode.isComplete : false;
    }
}

/**
 * Escapes special characters from regular expressions
 */
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
} 
