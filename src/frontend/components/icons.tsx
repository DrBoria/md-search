import React, { useState, useEffect } from 'react';
import path from 'path-browserify'
import { getIconUrlForFilePath } from 'vscode-material-icons'

declare global {
    interface Window {
        materialIconsPath?: string;
    }
}

export const FileIcon: React.FC<{ filePath: string }> = ({ filePath }) => {
    const [iconUrl, setIconUrl] = useState<string | null>(null);

    useEffect(() => {
        const basePath = window.materialIconsPath;
        if (basePath) {
            // The icons are copied to 'out/icons/generated', but materialIconsPath points to 'out/icons'
            // We need to append '/generated' for the library to find them.
            const iconsBase = `${basePath}/generated`;
            const url = getIconUrlForFilePath(filePath, iconsBase);
            setIconUrl(url);
        }
    }, [filePath]);

    if (!iconUrl) {
        // Fallback to codicon if url not ready or failed
        return (
            <span
                className="codicon codicon-file"
                style={{
                    width: '16px',
                    height: '16px',
                    marginRight: '4px',
                    verticalAlign: 'middle'
                }}
                title={path.basename(filePath)}
            />
        );
    }

    return (
        <img
            src={iconUrl}
            alt={path.basename(filePath)}
            style={{
                width: '16px',
                height: '16px',
                marginRight: '4px',
                verticalAlign: 'middle'
            }}
            title={path.basename(filePath)}
            onError={(e) => {
                // Determine if we should hide it or show fallback
                // e.currentTarget.style.display = 'none';
                // Fallback to codicon on error is tricky in img, usually we just hide or replace src
                e.currentTarget.style.display = 'none';
                // We could render a span next to it? No, simpler to just hide broken image
            }}
        />
    );
}
