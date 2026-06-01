// Curated safe-default DB dumps for the common OSS engines (sqlite, postgres,
// mysql/MariaDB). Each default ENCODES THE CONSISTENCY OPINION — the value
// pulselog adds over "just run your own command" (D16). pulselog never owns an
// engine matrix: postgres/mysql shell out to the standard tools (a missing or
// wrong-version tool fails loud), sqlite uses the Node-bundled engine, and
// anything exotic stays the adopter's `command` opt-out + the dump cookbook.
import { spawnSync } from 'node:child_process';

/**
 * One `db` source in the backup config — a curated dump of a single database.
 * @typedef {object} DbEntry
 * @property {'sqlite' | 'postgres' | 'mysql'} engine Which built-in dumper to run.
 * @property {string} [name] Label; drives the output filename (else `<engine>-<index>`).
 * @property {string} [path] sqlite only: filesystem path to the `.db` file.
 * @property {string} [url] postgres/mysql: connection URL (any password is routed via env, never argv).
 * @property {string} [passwordEnv] Name of an env var holding the password (preferred over an in-URL password).
 * @property {boolean} [optional] sqlite only: a missing `path` is skipped+recorded instead of failing.
 */

/**
 * Filename a dump lands under in the staging dir.
 * @param {DbEntry} entry
 * @param {number} i Zero-based index of this entry, for the fallback label.
 * @returns {string}
 */
export function dbDest(entry, i) {
  const label = entry.name || `${entry.engine}-${i + 1}`;
  // The label becomes a filename joined into the stage — reject path separators / ".."
  // so a config typo (or a crafted name) can't escape the stage dir.
  if (/[/\\]|\.\./.test(label)) throw new Error(`db name "${label}" must not contain "/", "\\", or ".."`);
  // Explicit per engine — never a catch-all `.sql`, so an unknown engine fails
  // loud here (the earliest point) instead of being mislabeled, mirroring dumpDb.
  const ext = entry.engine === 'sqlite' ? 'db'
    : entry.engine === 'postgres' ? 'dump'
      : entry.engine === 'mysql' ? 'sql'
        : null;
  if (!ext) throw new Error(`unknown db engine: ${entry.engine} (built-in: sqlite, postgres, mysql; else use command)`);
  return `${label}.${ext}`;
}

/**
 * `pg_dump -Fc` — custom format: compressed, consistent, selective restore. The
 * password is stripped from the URL (routed via PGPASSWORD env in dumpDb) so it
 * never lands in argv, where any local user could read it from the process table.
 * @param {{ url: string, dest: string }} opts
 * @returns {string[]} argv for `pg_dump`.
 */
export function pgDumpArgs({ url, dest }) {
  let conn = url;
  try { const u = new URL(url); u.password = ''; conn = u.toString(); } catch { /* not a URL (e.g. a keyword conninfo) — pass as-is */ }
  return ['-Fc', '-f', dest, conn];
}

/**
 * `mysqldump --single-transaction …` — `--single-transaction` is the InnoDB
 * consistency opinion most people forget; `--quick` streams large tables.
 * Connection comes from a `mysql://user@host:port/db` URL (password via env).
 * @param {{ url: string }} opts
 * @returns {string[]} argv for `mysqldump` (excluding `--result-file`, added by the caller).
 */
export function mysqlDumpArgs({ url }) {
  const u = new URL(url);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!db) throw new Error(`mysql url has no database: ${url}`);
  const args = ['--single-transaction', '--quick', '--routines', '--triggers'];
  if (u.hostname) args.push('--host', u.hostname);
  if (u.port) args.push('--port', u.port);
  if (u.username) args.push('--user', decodeURIComponent(u.username));
  args.push('--databases', db);
  return args;
}

/** node:sqlite VACUUM INTO — online, lock-safe, checkpoints WAL into one clean
 * file, and dodges the too-old system `sqlite3` CLI (plato's lesson). Needs
 * Node >= 22.5; older Node fails loud (upgrade, or use a `command` dump).
 * @param {{ path: string, dest: string }} opts
 * @returns {Promise<void>}
 */
async function sqliteDump({ path, dest }) {
  // Suppress only node:sqlite's ExperimentalWarning so a cron run stays quiet.
  const origEmit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (String(warning).includes('SQLite is an experimental')) return;
    return origEmit.call(process, warning, ...rest);
  };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error('sqlite engine needs Node >= 22.5 (node:sqlite); upgrade Node or use a `command` dump');
  } finally {
    process.emitWarning = origEmit;
  }
  const db = new DatabaseSync(path);
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

/**
 * Run the safe-default dump for one `db` entry, writing into `dest`. Throws on
 * any failure (caught by the orchestrator → record fail, alert, exit 1).
 * @param {DbEntry} entry
 * @param {string} dest Absolute path the dump is written to, inside the stage.
 * @returns {Promise<void>}
 */
export async function dumpDb(entry, dest) {
  const env = { ...process.env };
  // Resolve the password from `passwordEnv`, else from a password embedded in the
  // URL — and route it through env (PGPASSWORD/MYSQL_PWD), never argv (process-table leak).
  let pw = entry.passwordEnv ? process.env[entry.passwordEnv] : undefined;
  if (!pw && (entry.engine === 'postgres' || entry.engine === 'mysql') && entry.url) {
    try { const u = new URL(entry.url); if (u.password) pw = decodeURIComponent(u.password); } catch { /* not a URL */ }
  }
  // Hand the password ONLY to the var the engine's tool reads — don't also expose it
  // in the other (a postgres dump has no business carrying MYSQL_PWD in its child env).
  if (pw) {
    if (entry.engine === 'postgres') env.PGPASSWORD = pw;
    else if (entry.engine === 'mysql') env.MYSQL_PWD = pw;
  }
  switch (entry.engine) {
    case 'sqlite': {
      if (!entry.path) throw new Error('sqlite db entry needs "path"');
      return sqliteDump({ path: entry.path, dest });
    }
    case 'postgres': {
      if (!entry.url) throw new Error('postgres db entry needs "url"');
      const r = spawnSync('pg_dump', pgDumpArgs({ url: entry.url, dest }), { env, encoding: 'utf8' });
      if (r.error) { const e = /** @type {NodeJS.ErrnoException} */ (r.error); throw new Error(`pg_dump failed to start (${e.code || e.message}); is it on PATH?`); }
      if (r.status !== 0) throw new Error(`pg_dump exited ${r.status}: ${(r.stderr || '').trim()}`);
      return;
    }
    case 'mysql': {
      if (!entry.url) throw new Error('mysql db entry needs "url"');
      // --result-file streams the dump straight to disk → constant memory (vs.
      // buffering a multi-GB dump in a Node stdout buffer, which OOMs small VPSes).
      const args = [...mysqlDumpArgs({ url: entry.url }), '--result-file', dest];
      const r = spawnSync('mysqldump', args, { env, encoding: 'utf8' });
      if (r.error) { const e = /** @type {NodeJS.ErrnoException} */ (r.error); throw new Error(`mysqldump failed to start (${e.code || e.message}); is it on PATH?`); }
      if (r.status !== 0) throw new Error(`mysqldump exited ${r.status}: ${(r.stderr || '').trim()}`);
      return;
    }
    default:
      throw new Error(`unknown db engine: ${entry.engine} (built-in: sqlite, postgres, mysql; else use command)`);
  }
}
