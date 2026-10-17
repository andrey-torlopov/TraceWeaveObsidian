# Installation and Updates

*[Русский](../ru/installation.md)*

## Requirements

Desktop Obsidian **1.14.4 or newer** and a writable local vault. Mobile is unsupported. The plugin uses Node.js/Electron filesystem APIs supplied by Obsidian; users do not install Node.js, Docker or a database.

Native checks have been performed on macOS with Obsidian 1.14.4. Windows, Linux, every media codec and large-vault performance have not all been verified. Begin with a test vault and keep a complete backup of valuable material.

## Find TraceWeave in Obsidian

**The Community plugins listing is pending; a GitHub release alone does not make the plugin searchable in Obsidian.** After Obsidian approves and publishes the listing:

1. Open **Settings → Community plugins** and enable community plugins if necessary.
2. Choose **Browse**, search **TraceWeave**, and open its entry.
3. Select **Install**, then **Enable**.
4. Run **TraceWeave: Open research** (**Открыть исследование** in Russian) from the command palette.

[Obsidian explains directory publication and updates](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin). Until approval, use a published release through BRAT or the manual method below.

## Install with BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) is an optional third-party plugin that installs and updates plugins from GitHub releases.

1. In **Settings → Community plugins → Browse**, find **BRAT**, install and enable it.
2. Open BRAT settings and choose **Add Beta plugin**.
3. Enter `andrey-torlopov/TraceWeaveObsidian` as the repository. Add the plugin using the published release.
4. Enable **TraceWeave** in Community plugins if it is not enabled automatically.
5. Fully restart Obsidian for this vault, then run **TraceWeave: Open research** (**Открыть исследование** in Russian).

BRAT requires a release containing `main.js`, `manifest.json` and `styles.css`. An empty repository or GitHub's source-code ZIP is insufficient. For changes in BRAT's interface, follow its linked documentation.

## Manual Fallback

1. Open [GitHub Releases](https://github.com/andrey-torlopov/TraceWeaveObsidian/releases) and download the installable `traceweave-0.1.3.zip`, or download the three compiled assets separately.
2. In your vault, create `.obsidian/plugins/traceweave/`.
3. Put `main.js`, `manifest.json` and `styles.css` directly in that folder. Avoid a second nested `traceweave/` directory.
4. Open Obsidian, enable TraceWeave under Community plugins, and restart the application for this vault.

Do not copy `node_modules`, your research data or the source tree into the plugin folder.

## Interface Language

The latest published version, **0.1.3**, uses Russian labels. English support belongs to **development version 0.1.4**, which is not yet released through the channels above.

In 0.1.4, TraceWeave follows Obsidian's language: Russian for Russian, English for other languages. Choose **Settings → TraceWeave → Interface language** to use **Automatic**, **Русский** or **English** independently. Switching the interface preserves research content and drafts; visible note and attachment paths remain unchanged.

## Updating and Uninstalling

Save edits, stop other writers and make a full filesystem copy of the closed vault, including hidden `.twdata/`, before an update. Update through your installation channel; when copying assets manually, replace the three compiled files. **Fully restart Obsidian after a plugin update.** Toggling the plugin alone is insufficient for the tested reload path.

Updating from 0.1.0/0.1.1 migrates service data into `.twdata/` and managed notes/files into visible `Исследования/` folders. Existing notes adopted elsewhere remain in place. Let the plugin perform the migration; do not rename old folders or remove its migration marker. See the [storage protocol](../storage.md). Returning to an old layout requires restoring the full pre-update vault backup.

Disabling or uninstalling the plugin leaves your notes, originals and `.twdata/` on disk. Keep `.twdata/`: the graph's relationships and attributes cannot be reconstructed from Markdown alone.

[Quick start](quick-start.md) · [Documentation](index.md) · [README](../../README.md)
