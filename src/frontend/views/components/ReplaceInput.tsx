import React from 'react';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { useSearchItem } from '../context/SearchItemContext';

export const ReplaceInput = () => {
    const {
        replace, setReplace,
        isReplaceVisible,
        hasResults, replaceAll
    } = useSearchItem();

    if (!isReplaceVisible) return null;

    return (
        <div className="flex items-center gap-1 border border-[var(--vscode-input-border)] bg-[var(--vscode-input-background)] rounded-[2px] pr-0.5 focus-within:border-[var(--vscode-focusBorder)]">
            <Textarea
                placeholder="replace"
                aria-label="Replace Pattern"
                name="replace"
                rows={1}
                value={replace}
                onChange={(e) => setReplace(e.target.value)}
                className="border-none focus-visible:ring-0 px-[6px] py-[4px] bg-transparent"
            />
            <Button
                onClick={replaceAll}
                title={hasResults ? "Replace All" : "No results to replace"}
                disabled={!hasResults}
                variant="ghost"
                size="icon"
            >
                <span className="codicon codicon-replace-all" />
            </Button>
        </div>
    );
};
