import React, { useState, useEffect } from 'react';
import path from 'path-browserify'
import * as MaterialIcons from 'vscode-icons-js'

export const FileIcon: React.FC<{ filePath: string }> = ({ filePath }) => {
    const [iconUrl, setIconUrl] = useState<string | null>(null);

    useEffect(() => {
        const materialIconsPath = (window as any).materialIconsPath;
        if (materialIconsPath) {
            let filename = MaterialIcons.getIconForFile(path.basename(filePath));
            if (filename) {
                // vscode-icons-js returns 'file_type_name.svg', but vscode-material-icons has 'name.svg'
                // Mapping: file_type_light_name.svg -> name_light.svg, file_type_name.svg -> name.svg
                if (filename.startsWith('file_type_')) {
                    filename = filename.replace('file_type_', '');
                    if (filename.startsWith('light_')) {
                        filename = filename.replace('light_', '') + '_light';
                    }
                }
                const url = `${materialIconsPath}/generated/${filename}`;
                setIconUrl(url);
            }
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
