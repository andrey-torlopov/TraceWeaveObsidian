# Data, Network Access and Protection Boundaries

*[Русский](../ru/data-and-security.md)*

## Where Data Lives

All research data lives in the selected vault. Existing connected notes stay in their ordinary folders. The plugin's default layout is:

```text
Vault/
  ordinary notes and folders
  TWData/                          configurable visible data folder
    projects/<research folder>/    registered originals by media type
    exports/<research folder>/     readable reports, ZIPs and snapshots
  .twdata/                         technical data, not a note editor
    projects/                      project JSON, history, journals and drafts
    settings.json
    imports/
    recovery/
```

Existing node notes stay in their folders. New notes follow Obsidian's configured new-note location; choosing an existing note does not duplicate it. **Settings → TraceWeave → Data folder** controls visible materials and exports only. Project folder names are stable after renaming a research project; collisions receive numbered suffixes.

`.twdata/` is a hidden service folder, not a temporary cache. It holds identities, relationships, attributes, file bindings, coordinates, history, settings, technical staging and recovery records. Notes receive no service YAML fields or adjacent JSON sidecars. Their current text is read from the bound vault file. Historical journals/recovery copies can contain past text, and old immutable snapshots/source ZIPs remain where earlier versions saved them; these are preserved history rather than a second current note. New snapshots and retained import sources use the visible data tree.

When upgrading to 0.2.0, valid registered originals are copied into the visible project folders with the same bytes and hashes. Previous files remain for existing note links. Missing or changed originals retain their old bindings for diagnostics. Node notes are not moved. Changing the data-folder setting similarly copies originals and updates their bindings; completed reports and historical snapshots stay where they were created. The folder-change journal is retained until recovery completes if the process is interrupted.

Do not delete `.twdata/` or expose managed paths through symlinks. Uninstalling the plugin does not remove research files. **Returning to 0.1.6 after upgrading requires a full pre-upgrade vault copy, including hidden metadata; reinstalling the older binary alone is insufficient.** Technical details and old-layout migration are described in the [storage protocol, in Russian](../storage.md).

## What Leaves the Computer

TraceWeave adds no telemetry, analytics, LLM, automatic external collection or background network requests. Local research does not require a TraceWeave account or backend. Remote images in Markdown are not loaded automatically, and raw HTML is not executed in the plugin's preview.

Opening an external URL is an explicit action handled by the host application. Installing or updating the plugin through Obsidian/BRAT uses their network access. Other Obsidian plugins, operating-system backup services and your chosen sync tools have their own behavior.

When importing, TraceWeave reads only the files or ZIP selected by you, including selections outside the vault, and copies the required data into the vault. It does not mount a permanent external folder. To connect an editable note, first place that note and its relative resources inside the vault.

The desktop plugin uses Node.js filesystem APIs for hidden metadata, atomic journals, hashing and streaming archives. The vault-note picker enumerates Markdown file paths through the public Vault API; it does not upload their contents. Configuration files are excluded using the vault's actual configuration directory, including custom visible locations. These capabilities can appear as informational filesystem-access or vault-enumeration notices during review. Schema validators are compiled at build time; the installed bundle has no runtime schema compiler, and its React renderer rejects script elements and executable preloads.

## Access and Integrity

Files are not encrypted by TraceWeave. Anyone with filesystem access to the vault can read notes, originals, exports and hidden metadata. Use the operating system's access controls and encryption where needed. Keep sensitive vaults and backup ZIPs out of public source repositories.

Hashes detect changes and validate transfers; they do not authenticate an author or make a source trustworthy. The author of the research is responsible for assessments and conclusions. An image/audio/video preview requires supported bytes and codecs; arbitrary files remain data rather than executable content.

Use one active writer for a vault. Do not open the same data for concurrent editing on multiple devices or processes; file sync does not provide a transaction coordinator.

## Obsidian Sync Does Not Transfer the Graph

**Obsidian Sync excludes `.twdata/`.** Dot-prefixed folders are excluded, except the vault's Obsidian configuration folder. Enabling additional file types does not remove that exclusion. Visible notes may arrive on another device without TraceWeave's relationships and history. See [Obsidian's Sync rules](https://help.obsidian.md/sync/settings).

Transfer a research project with a plugin backup, or copy the whole closed vault with hidden files included. For third-party sync, verify hidden-file coverage and keep one writer; do not assume safe concurrent editing.

[Backup and transfer](backup-import.md) · [Documentation](index.md) · [README](../../README.md)
