# Local and frozen TraceWeave contracts

`obsidian-project.schema.json` describes `traceweave.obsidian-project/1.0`; `history.schema.json` and `journal.schema.json` describe local history and write-ahead records with `formatVersion: 1`. They are strict structural schemas. Runtime validation additionally checks references, global ID uniqueness, NFC, byte limits, Emoji sequences and domain invariants. `tests/schema.test.ts` validates real repository files against all three schemas.

Historical archive schemas are pinned byte-for-byte to the [public TraceWeave contracts](https://github.com/andrey-torlopov/TraceWeave/tree/a4ebc5188b7c7fee5339168a7242d01ce416bb4f/contracts) on 2026-10-16. The name archive2.0.schema.json corresponds to index entry 2.0.schema.json. SHA-256: 2f003d91477f8513e3f183350037c55a4ffd0cd3d6d43c6358c6acf115583068. Do not change historical schemas. Plugin backup and vault state have separate format identities.
