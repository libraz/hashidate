import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Re-record native hash pairs for the Rust rig and motion batteries.
 * Usage: `tsx tools/rust-core/record-battery-expectations.ts --check|--write [--report FILE]`.
 * Both native runs must agree, and source plus corpus snapshots must stay fixed during replay.
 * Original TypeScript inputs are immutable; `--write` patches only affected expected hash pairs.
 * Keep the `--write` audit report: run the follow-up `--check` without `--report` or to another file.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CORE = resolve(ROOT, 'crates/hashidate-core');
const CORPORA = resolve(CORE, 'tests/corpora');
const TARGET = '/tmp/hashidate-battery-recorder';
const PREFIX = 'HASHIDATE_EXPECTATIONS ';
const HASH_FIELDS = new Set(['output', 'state', 'tree', 'armSolverOff']);
const EXPECTED_BATTERIES = {
  'rig-battery': { files: 8, fixtures: 4 },
  'motion-battery': { files: 13, fixtures: 6 },
} as const;

type Battery = keyof typeof EXPECTED_BATTERIES;
type ChangeEvent = {
  type: 'change';
  corpus: string;
  streamOffset: number;
  record: string;
  field: string;
  before: [string, string];
  after: [string, string];
};
type EndEvent = {
  type: 'end';
  battery: Battery;
  files: number;
  fixtures: number;
  changes: number;
};
type Event = ChangeEvent | EndEvent;
type CorpusIndex = {
  fn: string;
  cases: number;
  in: Array<{ name: string; len: number }>;
  out: Array<{ name: string; len: number }>;
  [key: string]: unknown;
};
type CorpusFile = {
  name: string;
  indexPath: string;
  binaryPath: string;
  indexOriginal: Buffer;
  indexValue: CorpusIndex;
  original: Buffer;
  streamFileOffset: number;
  streamLength: number;
};
type PlannedPatch = {
  corpus: string;
  streamOffset: number;
  byteOffset: number;
  before: [string, string];
  after: [string, string];
  record: string;
  field: string;
};
type SourceProvenance = {
  gitHead: string | null;
  rustc: string | null;
  cargoTargetDir: string;
  sourceSha256: Record<string, string>;
};

function die(message: string): never {
  throw new Error(message);
}

function parseArgs(args: string[]): { mode: 'check' | 'write'; report?: string } {
  let mode: 'check' | 'write' | undefined;
  let report: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--check' || arg === '--write') {
      if (mode) die('choose exactly one of --check or --write');
      mode = arg.slice(2) as 'check' | 'write';
    } else if (arg === '--report') {
      if (report) die('--report may be supplied only once');
      const value = args[i + 1];
      if (!value || value.startsWith('--')) die('--report requires a file path');
      report = resolve(value);
      i += 1;
    } else {
      die(`unknown argument: ${arg}`);
    }
  }
  if (!mode)
    die(
      'usage: tsx tools/rust-core/record-battery-expectations.ts --check|--write [--report FILE]',
    );
  return { mode, report };
}

function assertReportTargetAvailable(reportPath: string | undefined): void {
  if (!(reportPath && existsSync(reportPath))) return;
  const prior: unknown = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (
    isRecord(prior) &&
    prior.applied === true &&
    Array.isArray(prior.changes) &&
    prior.changes.length > 0
  ) {
    die(
      `refusing to overwrite an applied mutation report; use a new --report path instead: ${reportPath}`,
    );
  }
}

function cargoRecorderRun(): Event[] {
  const result = spawnSync(
    'cargo',
    [
      'test',
      '-p',
      'hashidate-core',
      '--lib',
      'record_current_',
      '--',
      '--ignored',
      '--nocapture',
      '--test-threads=1',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CARGO_TARGET_DIR: TARGET },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    die(`cargo recorder run failed with status ${String(result.status)}`);
  }

  const events: Event[] = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    const prefixAt = line.indexOf(PREFIX);
    if (prefixAt < 0) continue;
    if (line.indexOf(PREFIX, prefixAt + PREFIX.length) >= 0) {
      die('recorder emitted multiple machine events on one line');
    }
    const value: unknown = JSON.parse(line.slice(prefixAt + PREFIX.length));
    events.push(validateEvent(value));
  }
  validateRun(events);
  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateEvent(value: unknown): Event {
  if (!isRecord(value) || typeof value.type !== 'string') die('recorder emitted a malformed event');
  if (value.type === 'end') {
    if (
      (value.battery !== 'rig-battery' && value.battery !== 'motion-battery') ||
      !Number.isSafeInteger(value.files) ||
      !Number.isSafeInteger(value.fixtures) ||
      !Number.isSafeInteger(value.changes)
    ) {
      die('recorder emitted an invalid battery end event');
    }
    return value as EndEvent;
  }
  if (value.type !== 'change') die(`recorder emitted unsupported event type ${value.type}`);
  const pair = (field: unknown): field is [string, string] =>
    Array.isArray(field) &&
    field.length === 2 &&
    field.every((item) => typeof item === 'string' && /^[0-9a-f]{16}$/u.test(item));
  if (
    typeof value.corpus !== 'string' ||
    !/^(rig|motion)-battery-[a-z]$/u.test(value.corpus) ||
    !Number.isSafeInteger(value.streamOffset) ||
    Number(value.streamOffset) < 0 ||
    typeof value.record !== 'string' ||
    value.record.length === 0 ||
    typeof value.field !== 'string' ||
    !HASH_FIELDS.has(value.field) ||
    !pair(value.before) ||
    !pair(value.after)
  ) {
    die('recorder emitted an invalid hash change event');
  }
  const before = value.before as [string, string];
  const after = value.after as [string, string];
  for (const half of [...before, ...after]) validateHashHalf(half);
  if (before.every((half, i) => half === after[i])) {
    die(`${value.corpus} ${value.record} reported an unchanged hash pair`);
  }
  return { ...value, before, after } as ChangeEvent;
}

function validateHashHalf(bits: string): void {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64LE(BigInt(`0x${bits}`));
  const value = bytes.readDoubleLE();
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    die(`hash half ${bits} does not encode a u32 f64`);
  }
}

function validateRun(events: Event[]): void {
  const ends = new Map<Battery, EndEvent>();
  const changeCounts = new Map<Battery, number>();
  for (const event of events) {
    if (event.type === 'end') {
      if (ends.has(event.battery)) die(`duplicate end event for ${event.battery}`);
      ends.set(event.battery, event);
      continue;
    }
    const battery = event.corpus.startsWith('rig-') ? 'rig-battery' : 'motion-battery';
    changeCounts.set(battery, (changeCounts.get(battery) ?? 0) + 1);
  }
  for (const [battery, expected] of Object.entries(EXPECTED_BATTERIES) as [
    Battery,
    (typeof EXPECTED_BATTERIES)[Battery],
  ][]) {
    const end = ends.get(battery);
    if (!end) die(`recorder did not emit an end event for ${battery}`);
    if (end.files !== expected.files || end.fixtures !== expected.fixtures) {
      die(`${battery} coverage changed: files=${end.files}, fixtures=${end.fixtures}`);
    }
    if (end.changes !== (changeCounts.get(battery) ?? 0)) {
      die(
        `${battery} reports ${end.changes} changes but emitted ${changeCounts.get(battery) ?? 0}`,
      );
    }
  }
  if (ends.size !== Object.keys(EXPECTED_BATTERIES).length)
    die('recorder emitted an unexpected battery');
}

function sameRun(first: Event[], second: Event[]): void {
  const a = JSON.stringify(first);
  const b = JSON.stringify(second);
  if (a !== b) {
    die(
      `native recorder is nondeterministic between runs (${first.length} vs ${second.length} events)`,
    );
  }
}

function readCorpus(name: string): CorpusFile {
  const indexPath = resolve(CORPORA, `${name}.json`);
  const binaryPath = resolve(CORPORA, `${name}.bin`);
  const indexOriginal = readFileSync(indexPath);
  const index = JSON.parse(indexOriginal.toString('utf8')) as CorpusIndex;
  if (index.fn !== name || index.cases !== 1)
    die(`${name}: expected one case with matching function name`);
  if (!(Array.isArray(index.in) && Array.isArray(index.out))) die(`${name}: invalid field index`);
  const inputLength = index.in.reduce((sum, field) => sum + checkedLength(field, name), 0);
  let streamFieldOffset = 0;
  let outputOffset = 0;
  let streamLength: number | undefined;
  for (const field of index.out) {
    const len = checkedLength(field, name);
    if (field.name === 'stream') {
      streamFieldOffset = outputOffset;
      streamLength = len;
      break;
    }
    outputOffset += len;
  }
  if (streamLength === undefined) die(`${name}: expected output field "stream"`);
  const original = readFileSync(binaryPath);
  const outputLength = index.out.reduce((sum, field) => sum + checkedLength(field, name), 0);
  if (original.length % 8 !== 0 || original.length !== (inputLength + outputLength) * 8) {
    die(`${name}: binary length does not match its JSON index`);
  }
  return {
    name,
    indexPath,
    binaryPath,
    indexOriginal,
    indexValue: index,
    original,
    streamFileOffset: inputLength + streamFieldOffset,
    streamLength,
  };
}

function checkedLength(field: { name: string; len: number }, corpus: string): number {
  if (!Number.isSafeInteger(field.len) || field.len < 0)
    die(`${corpus}: invalid length for ${field.name}`);
  return field.len;
}

function loadCorpora(): Map<string, CorpusFile> {
  const names = readdirSync(CORPORA)
    .filter((name) => /^(rig|motion)-battery-[a-z]\.json$/u.test(name))
    .map((name) => name.slice(0, -'.json'.length));
  const expectedNames = Object.entries(EXPECTED_BATTERIES).flatMap(([prefix, expected]) =>
    Array.from(
      { length: expected.files },
      (_, index) => `${prefix}-${String.fromCharCode(97 + index)}`,
    ),
  );
  if (
    names.length !== expectedNames.length ||
    expectedNames.some((name) => !names.includes(name))
  ) {
    die('battery corpus file set does not match the recorder coverage contract');
  }
  return new Map(names.map((name) => [name, readCorpus(name)]));
}

function assertCorpusSnapshots(corpora: Map<string, CorpusFile>): void {
  for (const corpus of corpora.values()) {
    if (!readFileSync(corpus.binaryPath).equals(corpus.original)) {
      die(`${corpus.name}: corpus binary changed during recorder runs`);
    }
    if (!readFileSync(corpus.indexPath).equals(corpus.indexOriginal)) {
      die(`${corpus.name}: corpus index changed during recorder runs`);
    }
  }
}

function planPatches(events: Event[], corpora: Map<string, CorpusFile>): PlannedPatch[] {
  const patches: PlannedPatch[] = [];
  const intervals = new Map<string, Array<[number, number]>>();
  for (const event of events) {
    if (event.type !== 'change') continue;
    const corpus = corpora.get(event.corpus);
    if (!corpus) die(`${event.corpus}: recorder named a corpus outside the approved batteries`);
    if (event.streamOffset + 2 > corpus.streamLength) {
      die(`${event.corpus} ${event.record}: hash pair exceeds stream bounds`);
    }
    const byteOffset = (corpus.streamFileOffset + event.streamOffset) * 8;
    if (!Number.isSafeInteger(byteOffset)) die(`${event.corpus}: byte offset exceeds safe range`);
    const interval: [number, number] = [byteOffset, byteOffset + 16];
    const prior = intervals.get(event.corpus) ?? [];
    if (prior.some(([start, end]) => interval[0] < end && start < interval[1])) {
      die(`${event.corpus}: overlapping recorded hash patches at byte ${byteOffset}`);
    }
    intervals.set(event.corpus, [...prior, interval]);
    for (let i = 0; i < 2; i += 1) {
      const before = corpus.original
        .readBigUInt64LE(byteOffset + i * 8)
        .toString(16)
        .padStart(16, '0');
      if (before !== event.before[i]) {
        die(
          `${event.corpus} ${event.record}: old bits mismatch at stream offset ${event.streamOffset + i}`,
        );
      }
    }
    patches.push({
      corpus: event.corpus,
      streamOffset: event.streamOffset,
      byteOffset,
      before: event.before,
      after: event.after,
      record: event.record,
      field: event.field,
    });
  }
  return patches;
}

function preservedBytesSha256(bytes: Buffer, patches: PlannedPatch[]): string {
  const preserved = Buffer.from(bytes);
  for (const patch of patches) preserved.fill(0, patch.byteOffset, patch.byteOffset + 16);
  return sha256(preserved);
}

function applyPatches(
  corpora: Map<string, CorpusFile>,
  patches: PlannedPatch[],
): Map<string, Buffer> {
  const updated = new Map<string, Buffer>();
  for (const patch of patches) {
    const corpus = corpora.get(patch.corpus);
    if (!corpus) die(`missing corpus ${patch.corpus}`);
    const bytes = updated.get(patch.corpus) ?? Buffer.from(corpus.original);
    for (let i = 0; i < 2; i += 1) {
      const before = bytes
        .readBigUInt64LE(patch.byteOffset + i * 8)
        .toString(16)
        .padStart(16, '0');
      if (before !== patch.before[i])
        die(`${patch.corpus}: patch input changed while preparing output`);
      bytes.writeBigUInt64LE(BigInt(`0x${patch.after[i]}`), patch.byteOffset + i * 8);
    }
    updated.set(patch.corpus, bytes);
  }
  for (const [name, bytes] of updated) {
    const original = corpora.get(name)?.original;
    if (!original || bytes.length !== original.length) die(`${name}: patch changed file length`);
    const ranges = patches.filter((patch) => patch.corpus === name);
    const allowed = new Set<number>();
    for (const patch of ranges) for (let i = 0; i < 16; i += 1) allowed.add(patch.byteOffset + i);
    for (let i = 0; i < bytes.length; i += 1) {
      if (!allowed.has(i) && bytes[i] !== original[i])
        die(`${name}: unexpected byte change at ${i}`);
    }
    if (preservedBytesSha256(original, ranges) !== preservedBytesSha256(bytes, ranges)) {
      die(`${name}: non-patch bytes changed`);
    }
  }
  return updated;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function stageIndexMetadata(
  corpora: Map<string, CorpusFile>,
  updated: Map<string, Buffer>,
  patches: PlannedPatch[],
  source: SourceProvenance,
): Map<string, Buffer> {
  const indexes = new Map<string, Buffer>();
  const sourceSnapshotSha256 = sha256(JSON.stringify(source));
  const names = new Set(patches.map((patch) => patch.corpus));
  for (const name of names) {
    const corpus = corpora.get(name);
    const binary = updated.get(name);
    if (!(corpus && binary))
      die(`${name}: cannot stage expectation metadata without a binary update`);
    const corpusPatches = patches.filter((patch) => patch.corpus === name);
    const preservedSha = preservedBytesSha256(binary, corpusPatches);
    const prior = isRecord(corpus.indexValue.expectations) ? corpus.indexValue.expectations : {};
    const priorNativeOutput = isRecord(prior.nativeOutput) ? prior.nativeOutput : {};
    const metadata = {
      ...prior,
      schemaVersion: 1,
      generator: 'yarn tsx tools/rust-core/record-battery-expectations.ts --write',
      nativeOutput: {
        ...priorNativeOutput,
        runtime: 'native-rust',
        gitHead: source.gitHead,
        rustc: source.rustc,
        sourceSnapshotSha256,
        corpusBinarySha256: sha256(binary),
        deterministicRuns: 2,
      },
      originalInputs: {
        marker: 'preserved; caller inputs embedded in out.stream remain in unpatched bytes',
        method: 'SHA-256 of the full corpus binary with patched 16-byte hash pairs zeroed',
        preservedBytesSha256: preservedSha,
      },
    };
    indexes.set(
      name,
      Buffer.from(`${JSON.stringify({ ...corpus.indexValue, expectations: metadata }, null, 1)}\n`),
    );
  }
  return indexes;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith('.rs') ? [path] : [];
    })
    .sort();
}

function captureSourceProvenance(): SourceProvenance {
  const tracked = [
    ...sourceFiles(resolve(CORE, 'src')),
    resolve(CORE, 'Cargo.toml'),
    resolve(ROOT, 'Cargo.lock'),
    resolve(ROOT, 'rust-toolchain.toml'),
    fileURLToPath(import.meta.url),
  ];
  const sourceHashes = Object.fromEntries(
    tracked.map((path) => [path.slice(ROOT.length + 1), sha256(readFileSync(path))]),
  );
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const rustc = spawnSync('rustc', ['--version'], { cwd: ROOT, encoding: 'utf8' });
  return {
    gitHead: head.status === 0 ? head.stdout.trim() : null,
    rustc: rustc.status === 0 ? rustc.stdout.trim() : null,
    cargoTargetDir: TARGET,
    sourceSha256: sourceHashes,
  };
}

function assertSourceSnapshot(expected: SourceProvenance): void {
  if (JSON.stringify(captureSourceProvenance()) !== JSON.stringify(expected)) {
    die('Rust source or toolchain metadata changed during recorder runs');
  }
}

function makeReport(
  events: Event[],
  patches: PlannedPatch[],
  corpora: Map<string, CorpusFile>,
  updated: Map<string, Buffer>,
  updatedIndexes: Map<string, Buffer>,
  source: SourceProvenance,
  mode: 'check' | 'write',
  applied: boolean,
): Record<string, unknown> {
  const batteries = Object.fromEntries(
    [...(Object.keys(EXPECTED_BATTERIES) as Battery[])].map((battery) => {
      const end = events.find(
        (event): event is EndEvent => event.type === 'end' && event.battery === battery,
      );
      const changes = patches.filter((patch) =>
        patch.corpus.startsWith(battery === 'rig-battery' ? 'rig-' : 'motion-'),
      );
      return [battery, { files: end?.files, fixtures: end?.fixtures, changes: changes.length }];
    }),
  );
  return {
    schemaVersion: 1,
    mode,
    provenance: {
      ...source,
      expectationInputs:
        'caller inputs are embedded in out.stream; all bytes outside expected-hash patches are preserved',
      expectationHashes: 'two identical current native Rust replay runs',
    },
    batteries,
    corpora: Object.fromEntries(
      [...corpora]
        .filter(([name]) => patches.some((patch) => patch.corpus === name))
        .map(([name, corpus]) => {
          const after = updated.get(name) ?? corpus.original;
          const corpusPatches = patches.filter((patch) => patch.corpus === name);
          const preservedBefore = preservedBytesSha256(corpus.original, corpusPatches);
          const preservedAfter = preservedBytesSha256(after, corpusPatches);
          if (preservedBefore !== preservedAfter) die(`${name}: preserved-byte hash differs`);
          return [
            name,
            {
              indexBeforeSha256: sha256(corpus.indexOriginal),
              indexAfterSha256: sha256(updatedIndexes.get(name) ?? corpus.indexOriginal),
              preservedBytesSha256: preservedBefore,
              binaryBeforeSha256: sha256(corpus.original),
              binaryAfterSha256: sha256(after),
            },
          ];
        }),
    ),
    changes: patches.map((patch) => ({
      corpus: patch.corpus,
      record: patch.record,
      field: patch.field,
      streamOffset: patch.streamOffset,
      byteOffset: patch.byteOffset,
      before: patch.before,
      after: patch.after,
    })),
    applied,
  };
}

function writeAtomically(files: Array<{ path: string; contents: Buffer }>): void {
  const staged: Array<{ temp: string; path: string }> = [];
  try {
    for (const file of files) {
      const temp = `${file.path}.recorder-${process.pid}.tmp`;
      writeFileSync(temp, file.contents, { flag: 'wx' });
      staged.push({ temp, path: file.path });
    }
    for (const file of staged) renameSync(file.temp, file.path);
  } catch (error) {
    for (const file of staged) rmSync(file.temp, { force: true });
    throw error;
  }
}

function main(): void {
  const { mode, report: reportPath } = parseArgs(process.argv.slice(2));
  assertReportTargetAvailable(reportPath);
  const corpora = loadCorpora();
  const source = captureSourceProvenance();
  const first = cargoRecorderRun();
  assertCorpusSnapshots(corpora);
  assertSourceSnapshot(source);
  const second = cargoRecorderRun();
  assertCorpusSnapshots(corpora);
  assertSourceSnapshot(source);
  sameRun(first, second);
  const patches = planPatches(first, corpora);
  const updated = applyPatches(corpora, patches);
  const updatedIndexes = stageIndexMetadata(corpora, updated, patches, source);
  const binaryFiles = [...updated].map(([name, contents]) => ({
    path: corpora.get(name)?.binaryPath ?? die(`missing corpus metadata for ${name}`),
    contents,
  }));
  const indexFiles = [...updatedIndexes].map(([name, contents]) => ({
    path: corpora.get(name)?.indexPath ?? die(`missing corpus metadata for ${name}`),
    contents,
  }));
  const files = [...binaryFiles, ...indexFiles];

  if (mode === 'write' && binaryFiles.length > 0) {
    writeAtomically(files);
    process.stdout.write(
      `Wrote ${patches.length} expected hash pairs and expectation metadata for ${binaryFiles.length} corpus files.\n`,
    );
  } else if (patches.length === 0) {
    process.stdout.write('All recorded native hash pairs match the current corpora.\n');
  } else {
    process.stdout.write(
      `${patches.length} expected hash pairs differ across ${binaryFiles.length} corpus files.\n`,
    );
  }

  if (reportPath) {
    const report = makeReport(
      first,
      patches,
      corpora,
      updated,
      updatedIndexes,
      source,
      mode,
      mode === 'write' && binaryFiles.length > 0,
    );
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Wrote recorder report to ${reportPath}.\n`);
  }
  if (mode === 'check' && patches.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
