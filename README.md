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

The images above are shared TraceWeave illustrations, not screenshots of the plugin.

**TraceWeave 0.1.6 supports English and Russian interfaces.** The language follows Obsidian automatically, with an override under **Settings → TraceWeave → Interface language**. Notes, relationship labels and custom types keep their original text.

Use **Export report** to read a research project on your phone without the plugin: a visible folder contains `summary.md`, a native `scheme.canvas`, and copied attachments. Set the destination under **Settings → TraceWeave → Reports folder**; an empty path uses the vault root. [Report instructions](docs/en/backup-import.md#readable-report-for-desktop-and-mobile).

## Screenshots

Real Obsidian views of a fictional **Lighthouse Archive** research project with English demonstration content and synthetic attachments.

**Follow the evidence.** Connect documents and sources in the graph; dashed lines mark hypotheses.

![Research graph with English demonstration content in the light theme](docs/screenshots/graph-light-en.jpg)

**Read the research as a dossier.** Browse document cards without losing the surrounding investigation.

![Research dossier with English demonstration content in the dark theme](docs/screenshots/dossier-dark-en.jpg)

**Keep the original materials together.** Find images, PDFs, recordings, video and other attached files in one research library.

![Research materials with English demonstration content in the light theme](docs/screenshots/materials-light-en.jpg)

[View all three scenes in light and dark themes, with English and Russian demonstration content](docs/screenshots/README.md).

## Quick Start

**Desktop Obsidian 1.14.4 or newer.** No server, Docker, TraceWeave account or runtime internet connection is required.

Install from the [Obsidian Community directory](https://community.obsidian.md/plugins/traceweave): **Settings → Community plugins → Browse → TraceWeave → Install → Enable**. [BRAT and manual installation](docs/en/installation.md) remain available for testing and fallback.

1. Open the command palette and run **TraceWeave: Open research** (**Открыть исследование** in Russian).
2. Choose **Create research** (**Создать исследование**).
3. Use **Link vault note** (**Подключить заметку из vault**) to add an existing note, or **+ Document** (**+ Документ**) to create one.
4. Connect two cards and enter an optional relationship label. Set **Assessment → Hypothesis** (**Оценка → Гипотеза**) for a dashed line.

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
npm run generate:validators
npm run lint
npm run typecheck
npm test
npm run package
```

Packaging builds the bundle, creates a local `release/traceweave-0.1.5.zip` and places individual release assets in `release/0.1.5/`. GitHub releases publish only `main.js`, `manifest.json` and `styles.css`, with build provenance attestations. Users install the compiled plugin, without Node.js or this source tree. The plugin is licensed under [MIT](LICENSE); `main.js` includes the bundled components' [license notices](THIRD_PARTY_NOTICES.md).
