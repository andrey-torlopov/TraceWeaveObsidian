# Changelog

Plugin versions and portable archive format versions are independent.

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
