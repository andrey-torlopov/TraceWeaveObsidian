# Data, Network Access and Protection Boundaries

*[Русский](../ru/data-and-security.md)*

## Where Data Lives

All research data lives in the selected vault. Existing connected notes stay in their ordinary folders. The plugin's default layout is:

```text
Vault/
  existing notes and folders
  Исследования/
    Заметки/          new Markdown documents
    Вложения/        managed original files
  .twdata/           relationships, metadata and recovery data
    projects/        project JSON, history, drafts and report snapshots
    settings.json
    imports/
    exports/
    recovery/
```

`.twdata/` is a hidden service folder, not a temporary cache. It holds identities, relationships, attributes, file bindings, coordinates, history and snapshots. Notes receive no service YAML fields or adjacent JSON sidecars. Obsidian's normal file explorer and native editor use the visible notes and originals; the plugin reads hidden service data itself.

Do not delete `.twdata/` or expose managed paths through symlinks. Uninstalling the plugin does not remove research files. Technical details and old-layout migration are described in the [storage protocol, in Russian](../storage.md).

## What Leaves the Computer

TraceWeave adds no telemetry, analytics, LLM, automatic external collection or background network requests. Local research does not require a TraceWeave account or backend. Remote images in Markdown are not loaded automatically, and raw HTML is not executed in the plugin's preview.

Opening an external URL is an explicit action handled by the host application. Installing or updating the plugin through Obsidian/BRAT uses their network access. Other Obsidian plugins, operating-system backup services and your chosen sync tools have their own behavior.

When importing, TraceWeave reads only the files or ZIP selected by you, including selections outside the vault, and copies the required data into the vault. It does not mount a permanent external folder. To connect an editable note, first place that note and its relative resources inside the vault.

## Access and Integrity

Files are not encrypted by TraceWeave. Anyone with filesystem access to the vault can read notes, originals, exports and hidden metadata. Use the operating system's access controls and encryption where needed. Keep sensitive vaults and backup ZIPs out of public source repositories.

Hashes detect changes and validate transfers; they do not authenticate an author or make a source trustworthy. The author of the research is responsible for assessments and conclusions. An image/audio/video preview requires supported bytes and codecs; arbitrary files remain data rather than executable content.

Use one active writer for a vault. Do not open the same data for concurrent editing on multiple devices or processes; file sync does not provide a transaction coordinator.

## Obsidian Sync Does Not Transfer the Graph

**Obsidian Sync excludes `.twdata/`.** Dot-prefixed folders are excluded, except the vault's Obsidian configuration folder. Enabling additional file types does not remove that exclusion. Visible notes may arrive on another device without TraceWeave's relationships and history. See [Obsidian's Sync rules](https://help.obsidian.md/sync/settings).

Transfer a research project with a plugin backup, or copy the whole closed vault with hidden files included. For third-party sync, verify hidden-file coverage and keep one writer; do not assume safe concurrent editing.

[Backup and transfer](backup-import.md) · [Documentation](index.md) · [README](../../README.md)
