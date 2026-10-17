<p align="center">
  <img src="docs/banner.png" alt="TraceWeave — connect documents, reveal relationships" width="960"/>
</p>

# TraceWeave for Obsidian

*[Русский](README-ru.md)*

## Why This Project Exists

<p align="center">
  <img src="docs/why-traceweave.png" alt="TraceWeave: it is all connected" width="560"/>
</p>

Research grows across notes, documents and recordings. TraceWeave adds a graph of explicit relationships to your Obsidian vault so you can follow sources, distinguish hypotheses and return to your conclusions.

Use existing Markdown notes in place, create documents, attach images, PDFs, audio, video, archives or other binary files, and connect them in a graph or read them as a dossier. Notes remain ordinary Obsidian files. Relationships, attributes and history stay together in one hidden `.twdata/` folder, without extra files beside your notes.

The images above are shared TraceWeave illustrations, not screenshots of the plugin. The plugin interface currently uses Russian labels; the English guides include the exact labels to look for.

## Quick Start

**Desktop Obsidian 1.14.4 or newer.** No server, Docker, TraceWeave account or runtime internet connection is required.

TraceWeave is **not yet listed in the Obsidian Community plugins directory**. Install a published [GitHub release](https://github.com/andrey-torlopov/TraceWeaveObsidian/releases) through [BRAT](docs/en/installation.md#install-with-brat), or follow the manual fallback in the [installation guide](docs/en/installation.md). After directory approval, search **TraceWeave** under **Settings → Community plugins → Browse**, then install and enable it.

1. Open the command palette and run **TraceWeave: Открыть исследование**.
2. Choose **Создать исследование** (Create research).
3. Use **Подключить заметку из vault** to add an existing note, or **+ Документ** to create one.
4. Connect two cards and enter an optional relationship label. Set **Оценка → Гипотеза** for a dashed line.

[Continue the quick start](docs/en/quick-start.md).

## Documentation

- [Installation, BRAT and updates](docs/en/installation.md)
- [Features and supported files](docs/en/features.md)
- **[Data storage, network access and protection boundaries](docs/en/data-and-security.md)**
- [Backup, reports and project import/export](docs/en/backup-import.md)
- [All user documentation](docs/en/index.md)
- [Storage and migration protocol, in Russian](docs/storage.md)
- [Build and publication guide, in Russian](docs/publishing.md)

**Backups must include `.twdata`. Obsidian Sync excludes this hidden folder**, so syncing notes alone does not transfer your graph. Work with one active writer. ZIP import creates a separate research copy; ordinary wikilinks and relative Markdown file paths may need repair after import. See [backup and import limits](docs/en/backup-import.md).

## Prefer a Web Application?

[TraceWeave web](https://github.com/andrey-torlopov/TraceWeave) runs on your own computer or server using Docker containers. Follow its [installation guide](https://github.com/andrey-torlopov/TraceWeave/blob/main/docs/en/installation.md). It stores its own data outside the Obsidian vault and offers a different interface. Transfer projects explicitly with the supported TraceWeave archive; there is no live synchronization between the applications.

## Development

Use the Node.js version range declared in `package.json`. From this repository:

```sh
npm ci
npm run typecheck
npm test
npm run package
```

Packaging builds the bundle, creates `release/traceweave-0.1.3.zip` and places individual release assets in `release/0.1.3/`. Users install the compiled plugin, without Node.js or this source tree. The plugin is licensed under [MIT](LICENSE); bundled components retain their [own licenses](THIRD_PARTY_NOTICES.md).
