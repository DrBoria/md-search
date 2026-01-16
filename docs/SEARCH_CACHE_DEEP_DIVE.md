# Advanced Search & Regex Guide

This guide explains how to leverage the advanced search capabilities of MD Search, specifically focusing on **Search Modes** and **Targeted Regex Searching**.

## 1. Search Modes

The extension supports three distinct search modes:

- **Text**: Simple string matching. Exact match or case-insensitive text search.
- **Regex**: Regular expression search. Supports standard JS regex syntax.
- **Structure (astx)**: Structural search for code patterns (advanced usage).

### Switching Modes

Toggle the mode using the buttons in the search interface.

> **Note:** Switching between "Text" and "Regex" modes forces a fresh search, ensuring that a query like `(foo)` is interpreted correctly in each context (as literal text vs. capture group).

## 2. Targeted Regex Search (Capture Groups `$N`)

Standard regex search highlights the _entire_ match. However, MD Search allows you to **target and highlight only a specific part** of the match using **Capture Groups**.

### How it works

Append `$1`, `$2`, `$3`, etc., to the end of your regex query to tell the system:
_"Find the full pattern, but only show/return the content of this specific group."_

- `$0` (Default): Shows the entire match.
- `$1`: Shows only the content of the first capture group `(...)`.
- `$2`: Shows only the content of the second capture group.

### Real-World Example: React Components

Consider the following React component code:

```typescript
export default function Layout({ params }: { params: { tab: string } }) {
  const { user, loading } = useAuth()

  // ... implementation ...
}
```

We want to find and extract specific parts of this function definition.

#### Complex Regex Pattern

We can use the following regex to match the function export:

```regex
(export\s+default\s+function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{[\s\S]*?\n\})
```

**Breakdown:**

1.  **Group 0 (Full Match):** The entire string starting from `export default`...
2.  **Group 1**: `(export\s+default...)` - Wraps the whole declaration.
3.  **Group 2**: `(\w+)` - Matches the **Function Name** (e.g., `Layout`).
4.  **Group 3**: `([^)]*)` - Matches the **Parameters** inside parentheses.

#### Use Case Scenarios

**1. Find the Function Name ($2)**
To find just the name of the component for renaming or listing:

- **Query:** `(export\s+default\s+function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{[\s\S]*?\n\}) $2`
- **Result:** `Layout`
- **Why?** The regex finds the whole function, but the search result highlights _only_ the word "Layout".

**2. Find the Parameters ($3)**
To inspect or extract just the props/arguments:

- **Query:** `(export\s+default\s+function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{[\s\S]*?\n\}) $3`
- **Result:** `{ params }: { params: { tab: string } }`
- **Why?** It isolates the content within the function parentheses.

**3. Find the Entire Component ($0 or $1)**
To select the whole definition:

- **Query:** `(export\s+default\s+function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{[\s\S]*?\n\})`
- **Result:**
  ```typescript
  export default function Layout({ params }: { params: { tab: string } }) {
    const { user, loading } = useAuth()
    // ...
  }
  ```

### Strict Matching Rule

If you specify a group that does not exist or is empty in a particular match, that match is **skipped**.

- _Example:_ If you search for `(foo)?(bar) $1` and the text is just "bar":
  - Group 1 is empty.
  - The result is **SKIPPED** (it will NOT fallback to showing "bar").
  - This ensures you only get exactly what you asked for.
