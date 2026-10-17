# Third-party notices

The Unicode Emoji 17.0 fully qualified sequence table is derived from [emoji-test.txt](https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt), copyright 2025 Unicode, Inc.

Unicode 17.0 default full case folding uses the C/F mappings from [CaseFolding.txt](https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt), copyright 2025 Unicode, Inc. The source SHA-256 is `ff8d8fefbf123574205085d6714c36149eb946d717a0c585c27f0f4ef58c4183`. `scripts/generate-casefold.mjs` generates `src/casefold.ts`; S/T mappings are excluded, and unlisted code points map to themselves.

Both Unicode datasets are covered by Unicode License V3, included as [UNICODE-LICENSE.txt](UNICODE-LICENSE.txt).

Bundled packages include React/ReactDOM (MIT), React Flow/@xyflow (MIT), react-markdown and remark-gfm (MIT), Ajv (MIT), jsonc-parser (MIT), yauzl and yazl (MIT). Their exact versions, authors and license text are present in package-lock.json and the license files installed with each package. Obsidian API is an external runtime dependency and is not bundled. The packaging script includes collected dependency licenses.
