# md-search

VSCode extension for advanced code search and replace functionality

![Screenshot](screenshot.png)

## Features

- Powerful search and replace in found matches
- Multiple search modes: text, regex, and structural search
- Live preview of search results
- Support for code transformations in found matches
- Filter results by file or pattern

<sub>Based on [astx](https://github.com/codemodsquad/astx) structural search technology</sub>

## Installation

### From Marketplace

You can install this extension directly from the Visual Studio Code Marketplace:

1. Open VSCode
2. Go to Extensions view (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "md-search"
4. Click "Install"

### Manual Installation

For manual installation:

1. Download the latest `.vsix` file from the [Releases](/releases) page
2. Run: `code --install-extension path/to/md-search-x.x.x.vsix`

## Usage

1. Open the Search panel from the Activity Bar
2. Enter your search query
3. Optionally configure search settings:
   - Search mode (text, regex, astx)
   - Include/exclude patterns
   - Case sensitivity
   - Search in results
4. Review matches in the results panel
5. Enter replacement text if needed
6. Preview changes before applying
7. Apply changes to selected files

## Requirements

- Visual Studio Code 1.60.0 or higher

## License

MIT
