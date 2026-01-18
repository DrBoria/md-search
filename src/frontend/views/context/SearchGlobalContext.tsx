import React, { createContext, useContext, useMemo } from 'react';
import { useSearchState } from '../hooks/useSearchState';

export type SearchGlobalState = ReturnType<typeof useSearchState> & { vscode: any };

const SearchGlobalContext = createContext<SearchGlobalState | null>(null);

export const useSearchGlobal = () => {
    const context = useContext(SearchGlobalContext);
    if (!context) {
        throw new Error('useSearchGlobal must be used within a SearchGlobalProvider');
    }
    return context;
};

interface SearchGlobalProviderProps {
    children: React.ReactNode;
    vscode: any;
}

export const SearchGlobalProvider: React.FC<SearchGlobalProviderProps> = ({ children, vscode }) => {
    const state = useSearchState({ vscode });

    const value = useMemo(() => ({
        ...state,
        vscode
    }), [state, vscode]);

    return (
        <SearchGlobalContext.Provider value={value}>
            {children}
        </SearchGlobalContext.Provider>
    );
};
