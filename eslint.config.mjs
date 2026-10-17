import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  { ignores: ['node_modules/**', 'release/**', 'var/**', 'main.js', 'src/generated/**', 'tests/**', 'scripts/**', 'eslint.config.mjs'] },
  ...obsidianmd.configs.recommended,
  { files: ['src/**/*.{ts,tsx}'], languageOptions: { parserOptions: { projectService: true } } },
]);
