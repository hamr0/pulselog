// JSONL sink — one health record per line, in the same core shape flightlog uses
// for errors (ts, kind, name, message, + context), so the same tail/jq/uploader
// work across both streams. Writes to its OWN file (health.jsonl), never
// flightlog's errors.jsonl: two processes appending one file race rotation and
// trip over each other's perms. Synchronous (this runs as a short cron one-shot);
// a write failure is surfaced once to stderr and never crashes the run.
import { appendFileSync, statSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const FILE_MODE = 0o600; // owner-only: health lines can name hosts/paths/services

/**
 * @param {{ file?: string, maxBytes?: number }} [opts]
 * @returns {{ emit: (record: object) => void }}
 */
export function createSink({ file, maxBytes = 5_000_000 } = {}) {
  if (!file) {
    // No file → emit to stderr (visible under cron mail / journald), never throw.
    return {
      emit(record) {
        try {
          process.stderr.write(JSON.stringify(record) + '\n');
        } catch { /* last resort: stay silent rather than crash */ }
      },
    };
  }

  mkdirSync(dirname(file), { recursive: true });

  const rotateIfNeeded = (byteLength) => {
    if (!maxBytes) return;
    let size = 0;
    try { size = statSync(file).size; } catch { return; }
    if (size > 0 && size + byteLength > maxBytes) {
      rmSync(file + '.1', { force: true }); // keep one previous segment
      renameSync(file, file + '.1');
    }
  };

  let warned = false;
  return {
    emit(record) {
      try {
        const line = JSON.stringify(record) + '\n';
        rotateIfNeeded(Buffer.byteLength(line));
        appendFileSync(file, line, { mode: FILE_MODE });
        warned = false;
      } catch (err) {
        if (warned) return;
        warned = true;
        try {
          process.stderr.write(`pulselog: write to ${file} failed (${err.code || err.message})\n`);
        } catch { /* stderr gone too — give up quietly */ }
      }
    },
  };
}
