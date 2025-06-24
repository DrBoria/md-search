import React from 'react';
import path from 'path-browserify' // Use path-browserify for web compatibility

export function getFileIcon(filePath: string): React.ReactNode {
    // Проверяем доступность MaterialIcons
    const materialIcons = (window as any).MaterialIcons;
    if (!materialIcons) {
        // Возвращаем codicon как запасной вариант
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

    try {
        // Используем путь к иконкам из window
        const materialIconsPath = window.materialIconsPath || '/material-icons';
        // Получаем URL иконки с учетом пути к иконкам
        const iconUrl = materialIcons.getIconUrlForFilePath(filePath, materialIconsPath);

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
            />
        );
    } catch (error) {
        // Запасной вариант в случае ошибки
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
}
