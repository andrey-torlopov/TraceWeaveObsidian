# Changelog

Plugin versions and portable archive format versions are independent.

## 0.1.6 — Readable vault reports — unreleased

- Export the entire active research into a visible vault folder containing `summary.md`, `scheme.canvas` and categorized copies under `Attachments/`.
- Configure the reports folder in plugin settings; an empty path uses the vault root. Repeated exports create numbered folders without overwriting earlier reports.
- Combine notes in creation order with creation/update dates, attributes, relationships, evidence and attachment links; original notes remain unchanged.
- Preserve graph positions and labeled, directed connections in native Obsidian Canvas, with links into the report.
- Rewrite local note/file links for the exported copy, preserve code, disable remote image embeds, and verify copied originals before publishing a complete folder.
- Read exported reports on mobile without TraceWeave after syncing the report folder and its files. The plugin itself remains desktop-only.

## 0.1.5 — Community review fixes — 2026-10-17

- Replace runtime schema compilation with build-time standalone validators, preserving archive and recovery validation.
- Reject script elements and executable resource preloads in the pinned React DOM bundle; preserve dependency licenses inside `main.js`.
- Add the official Obsidian ESLint checks with no warnings and a bundle check that disables string code generation.
- Use searchable declarative settings and window-owned timers; retain typed Electron integration for desktop.
- Protect the actual vault configuration directory, including visible custom locations, in notes, resources, imports and migrations.
- Correct false-success draft flushes, unsafe configured paths, imported filenames with whitespace and late work after plugin unload.
- Validate imported JSON and historical snapshot records without unsafe `any` propagation.
- Build and attest release assets in GitHub Actions. Releases contain only `main.js`, `manifest.json` and `styles.css`; local ZIP packaging remains available.

The Community directory approval is pending. Desktop-only operation, one writer, the `.twdata` backup requirement and existing ZIP link-rewriting limits remain applicable.

## 0.1.4 — English interface and screenshots — 2026-10-17

- English and Russian interfaces, following the Obsidian language with an override in plugin settings.
- Language changes preserve the current view, filters, selected material and unsaved metadata drafts.
- Localized dialogs, validation, accessibility labels and newly generated reports. Notes, custom names, stored paths and existing report bytes stay unchanged.
- Real light/dark screenshots with separate fictional English and Russian research projects.
- Include JPEG documentation images in local packages.

## 0.1.3 — First public distribution

- MIT license for the plugin code.
- English and Russian README and user guides, with shared TraceWeave artwork.
- Explicit links to the separate Docker-based TraceWeave web application.
- Documented GitHub/BRAT installation and the Community directory submission step.
- Publication file/link/version checks, Git history secret scanning in CI and explicit package contents.
- Removed a private component provenance reference; retained upstream license notices.
- Minimum Obsidian app version is now 1.14.4, the runtime used for native verification. Earlier installer-version reporting was not a native compatibility check.
- Moved static inline media styles into scoped CSS and simplified the settings layout.

Known limits: desktop, one active writer, no Obsidian Sync coverage for `.twdata`, and incomplete rewriting of ordinary wikilinks/relative file paths during ZIP import. See [backup and transfer](docs/en/backup-import.md). The Community listing remains pending until its submission and approval; a GitHub release does not register it automatically.

## 0.1.2 — Hidden service data

- Store metadata, relationships, settings, history and immutable reports in `.twdata`.
- Keep notes and originals visible under `Исследования/Заметки` and `Исследования/Вложения`.
- Resume proof-checked migration from both earlier layouts, retaining originals and snapshot bytes.
- Open hidden reports in a read-only view; protect registered originals from accidental note adoption.
- Fix archive 2.0 conversion of empty origins and attribute ownership.

## 0.1.1 — Vault integration and graph readability

- Connect ordinary vault notes in place and resolve local links/media from the note's source path.
- Consolidate the earlier service folders into `TWData` (superseded by 0.1.2).
- Show circular graph nodes at distant zoom, optional relationship labels and dashed hypotheses.

## 0.1.0 — Initial local desktop plugin

- Research graph, dossier, typed attributes, evidence, groups, trash and registered materials.
- Transaction journals, local history, integrity-checked reports and project transfer.
