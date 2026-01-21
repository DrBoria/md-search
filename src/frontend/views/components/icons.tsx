import React, { memo } from 'react';
import { getIconForFile } from 'vscode-icons-js';

declare global {
    interface Window {
        materialIconsPath?: string;
    }
}

export const FileIcon = memo(({ filePath }: { filePath: string }) => {
    // vscode-icons-js returns the icon filename (e.g. "javascript.svg")
    // Sometimes it might return with a prefix that duplicates our base path.
    let iconName = getIconForFile(filePath) || 'file.svg';

    // Safety check for double generated path: remove ALL 'generated/' prefixes recursively/repeatedly
    while (iconName.startsWith('generated/')) {
        iconName = iconName.replace('generated/', '');
    }

    // Use the path injected by the backend
    let basePath = window.materialIconsPath || '';

    // Safety check: remove trailing slashes
    if (basePath.endsWith('/')) basePath = basePath.slice(0, -1);

    // If iconName already includes 'generated/', ensuring we don't duplicate if basePath also ends in it?
    // But basePath points to folder. iconName is "file.svg".

    const src = `${basePath}/${iconName}`;

    return (
        <img
            src={src}
            alt={iconName}
            className="w-4 h-4 mr-1.5 shrink-0"
            onError={(e) => {
                // Fallback and log to help debug
                e.currentTarget.style.display = 'none';
                console.warn(`[FileIcon] Failed to load icon: ${src}`);
            }}
        />
    );
});

export const getFileIcon = (filePath: string) => {
    return <FileIcon filePath={filePath} />;
};
