/** Desktop bridge supplied by Obsidian's Electron host; never bundled. */
declare module 'electron' {
  export const shell: { showItemInFolder(path: string): void };
  export const webUtils: { getPathForFile(file: File): string } | undefined;
}
