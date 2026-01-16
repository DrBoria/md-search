const createOutputChannel = (): any => ({
  appendLine: (): void => {
    // mock
  },
  replace: (): void => {
    // mock
  },
  clear: (): void => {
    // mock
  },
  show: (): void => {
    // mock
  },
  hide: (): void => {
    // mock
  },
  dispose: (): void => {
    // mock
  },
})

export const window = {
  createOutputChannel,
  showErrorMessage: (): void => {
    // mock
  },
  showInformationMessage: (): void => {
    // mock
  },
}

export const workspace = {
  workspaceFolders: [],
  getConfiguration: (): any => ({
    get: (): undefined => undefined,
  }),
  findFiles: (): Promise<string[]> => Promise.resolve([]),
}

export const Uri = {
  file: (path: string): { fsPath: string; toString: () => string } => ({
    fsPath: path,
    toString: () => path,
  }),
  parse: (path: string): { fsPath: string; toString: () => string } => ({
    fsPath: path,
    toString: () => path,
  }),
  joinPath: (): { fsPath: string; toString: () => string } => ({
    fsPath: 'joined',
    toString: () => 'joined',
  }),
}

export const Range = class {
  constructor(
    public startLine: number,
    public startChar: number,
    public endLine: number,
    public endChar: number
  ) {}
}

export const Position = class {
  constructor(public line: number, public char: number) {}
}

export const RelativePattern = class {
  constructor(public base: unknown, public pattern: string) {}
}

export enum ViewColumn {
  One = 1,
}
