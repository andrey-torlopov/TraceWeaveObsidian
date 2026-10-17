import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileStore } from '../src/storage/files';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-large-probe-'));
try {
  const source = path.join(root, 'original.bin');
  const file = await fs.open(source, 'wx'); await file.truncate(536_870_912); await file.close();
  const before = process.memoryUsage().rss; let peak = before, maxChunk = 0, previous = 0;
  const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  const start = performance.now();
  const store = new FileStore(root);
  const result = await store.importFile(source, randomUUID(), [], { onProgress(completed) { maxChunk = Math.max(maxChunk, completed - previous); previous = completed; peak = Math.max(peak, process.memoryUsage().rss); } });
  clearInterval(sample);
  const verified = await store.verify(result.blob);
  const delta = Math.max(0, peak - before);
  console.log(JSON.stringify({ fileBytes: result.blob.byteSize, elapsedMilliseconds: performance.now() - start, rssBeforeBytes: before, peakRssBytes: peak, additionalRssFormula: `(${peak} - ${before}) / 1048576 = ${delta / 1048576} MiB`, maxTransferChunkBytes: maxChunk, sha256: result.blob.sha256, integrity: verified }, null, 2));
  if (result.blob.byteSize !== 536_870_912 || verified !== 'ok' || maxChunk > 65_536 || delta > 67_108_864) throw new Error('512 MiB streaming memory/integrity target failed');
} finally { await fs.rm(root, { recursive: true, force: true }); }
