import type { Plugin } from 'esbuild';
export function restrictRenderer(source: string, mode: 'production' | 'development'): string;
export const rendererPolicy: Plugin;
