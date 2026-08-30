import type { Stats } from 'node:fs';
import { lstatSync } from 'node:fs';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { basename, dirname, extname, join, parse, relative, resolve, sep } from 'node:path';

/**
 * The small set of checks every file-backed surface has to agree on.
 *
 * A path is trusted only while every directory entry between the configured
 * root and the file is a real directory and the final entry is a real file.
 * `stat` is deliberately not used here: following a symlink for the check and
 * then reading the path is the escape this module exists to prevent.
 */

export interface SafeFileOptions {
  /** Extensions accepted by this surface, including the leading dot. */
  readonly extensions?: readonly string[];
  /** Maximum bytes to permit before a caller reads the file. */
  readonly maxBytes?: number;
  /** A logical id may fall back to one NFC-equivalent directory entry. */
  readonly logical?: boolean;
  /** An exact nested path may normalize-match only its final entry. */
  readonly logicalPath?: boolean;
  /** Maximum length of the logical id or filename's stem. */
  readonly maxIdLength?: number;
  /** Permit path separators in an exact request, as the static server needs. */
  readonly allowNested?: boolean;
}

export type SafeFileErrorCode =
  | 'invalid'
  | 'missing'
  | 'outside-root'
  | 'symlink'
  | 'not-directory'
  | 'not-file'
  | 'ambiguous'
  | 'too-large'
  | 'read-error';

export interface SafeFileError {
  readonly ok: false;
  readonly code: SafeFileErrorCode;
  readonly error: string;
}

export interface SafePath {
  readonly ok: true;
  readonly path: string;
  readonly info: Stats;
}

export type SafePathResult = SafePath | SafeFileError;

export interface SafeFile extends SafePath {
  readonly info: Stats & { isFile(): true };
}

export type SafeFileResult = SafeFile | SafeFileError;

export interface SafeRead {
  readonly ok: true;
  readonly path: string;
  readonly info: Stats & { isFile(): true };
  readonly bytes: Buffer;
}

export type SafeReadResult = SafeRead | SafeFileError;

const DEFAULT_MAX_ID_LENGTH = 255;
const CONTROL_OR_SEPARATOR = /[/\\]|\p{Cc}/u;

/** Type guard shared by all call sites so errors cannot be mistaken for paths. */
export function isSafeFile(result: SafeFileResult): result is SafeFile {
  return result.ok;
}

/** Type guard for an inspected path, including directories. */
export function isSafePath(result: SafePathResult): result is SafePath {
  return result.ok;
}

/** Read a trusted root's direct entries, treating a missing optional root as empty. */
export async function readSafeDirectory(root: string): Promise<string[] | null> {
  const checked = await inspectDirectory(resolve(root));
  if (!checked.ok) return checked.code === 'missing' ? [] : null;
  try {
    return await readdir(resolve(root));
  } catch {
    return null;
  }
}

/**
 * Resolve one file below a trusted root.
 *
 * Exact requests are never normalised or looked up by another spelling. A
 * logical request is a bare id: its exact `<id><extension>` candidates win,
 * and only when none exists do we inspect the directory for one NFC-equivalent
 * candidate. More than one equivalent candidate is an error, never a choice.
 */
export async function resolveSafeFile(
  root: string,
  request: string,
  options: SafeFileOptions = {},
): Promise<SafeFileResult> {
  const policy = normaliseOptions(options);
  const rootPath = resolve(root);
  if (!validRequest(request, policy)) return failure('invalid', 'invalid file name');

  if (policy.logical) {
    const rootCheck = await inspectDirectory(rootPath);
    if (!rootCheck.ok) return rootCheck;
    const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => []);
    // Compare directory entry strings before lstat. Some filesystems treat NFC
    // and NFD as the same lookup while still returning one spelling from
    // readdir; using lstat as the exact test would then lose the on-disk name.
    for (const extension of policy.extensions) {
      const exactName = `${request}${extension}`;
      if (!entries.some((entry) => entry.name === exactName)) continue;
      const inspected = await inspectTarget(rootPath, resolve(rootPath, exactName), policy);
      if (!inspected.ok) {
        if (inspected.code === 'missing') continue;
        return inspected;
      }
      if (!inspected.info.isFile()) return failure('not-file', 'not a regular file');
      return withSize(inspected as SafeFile, policy.maxBytes);
    }

    const wanted = request.normalize('NFC');
    for (const extension of policy.extensions) {
      const candidates = entries
        .map((entry) => entry.name)
        .filter(
          (name) =>
            normaliseExtension(extname(name)) === extension &&
            stem(name, extension).normalize('NFC') === wanted,
        );
      if (candidates.length === 0) continue;
      if (candidates.length > 1) return failure('ambiguous', ambiguousMessage(candidates));
      const inspected = await inspectTarget(rootPath, resolve(rootPath, candidates[0]), policy);
      if (!inspected.ok) return inspected;
      if (!inspected.info.isFile()) return failure('not-file', 'not a regular file');
      return withSize(inspected as SafeFile, policy.maxBytes);
    }
    return failure('missing', 'not found');
  }

  const names = [request];
  const exact: SafeFile[] = [];
  for (const name of names) {
    const target = resolve(rootPath, name);
    const inspected = await inspectTarget(rootPath, target, policy);
    if (!inspected.ok) {
      if (inspected.code === 'missing') continue;
      return inspected;
    }
    if (inspected.info.isDirectory()) return failure('not-file', 'not a regular file');
    if (!inspected.info.isFile()) return failure('not-file', 'not a regular file');
    exact.push(inspected as SafeFile);
  }
  if (exact.length > 1) return failure('ambiguous', ambiguousMessage(names));
  if (exact.length === 1) return withSize(exact[0], policy.maxBytes);
  return failure('missing', 'not found');
}

/**
 * Inspect an exact relative path, allowing the final entry to be a directory.
 * This is used by the static server before it decides whether to redirect a
 * directory or append its `index.html`.
 */
export async function inspectSafePath(
  root: string,
  request: string,
  options: SafeFileOptions = {},
): Promise<SafePathResult> {
  const policy = normaliseOptions(options);
  const rootPath = resolve(root);
  if (!validRequest(request, policy)) return failure('invalid', 'invalid file name');
  if (policy.logicalPath) return inspectLogicalPath(rootPath, request, policy);
  const target = resolve(rootPath, request);
  return inspectTarget(rootPath, target, policy);
}

/** Read an exact absolute path while checking all of its path components. */
export async function readExactFile(
  target: string,
  options: SafeFileOptions = {},
): Promise<SafeReadResult> {
  const absolute = resolve(target);
  const policy = normaliseOptions({ ...options, allowNested: true });
  if (!validExactRequest(absolute, policy)) return failure('invalid', 'invalid file name');
  const inspected = await inspectExactTarget(absolute, policy);
  if (!inspected.ok) return inspected;
  if (!inspected.info.isFile()) return failure('not-file', 'not a regular file');
  const loaded = await readInspected(inspected as SafeFile, policy.maxBytes);
  return loaded.ok ? { ...loaded, path: absolute } : loaded;
}

/** Read a file below a trusted root, with its size checked before `readFile`. */
export async function readSafeFile(
  root: string,
  request: string,
  options: SafeFileOptions = {},
): Promise<SafeReadResult> {
  const resolved = await resolveSafeFile(root, request, options);
  if (!resolved.ok) return resolved;
  return readInspected(resolved, normaliseOptions(options).maxBytes);
}

/** Read a previously resolved absolute path after rechecking its components. */
export async function readSafePath(
  root: string,
  target: string,
  options: SafeFileOptions = {},
): Promise<SafeReadResult> {
  const policy = normaliseOptions({ ...options, allowNested: true });
  const rootPath = resolve(root);
  const absolute = resolve(target);
  const relativePath = relative(rootPath, absolute);
  if (!validRequest(relativePath, policy)) return failure('invalid', 'invalid file name');
  const inspected = await inspectTarget(rootPath, absolute, policy);
  if (!inspected.ok) return inspected;
  if (!inspected.info.isFile()) return failure('not-file', 'not a regular file');
  return readInspected(inspected as SafeFile, policy.maxBytes);
}

/**
 * Synchronous candidate guard for legacy `path()` helpers.
 *
 * `path()` is a candidate API and cannot await a directory scan. Existing
 * callers still get the lexical path when its final entry is missing, but an
 * existing symlink or non-directory component is refused immediately.
 */
export function trustedPathSync(
  root: string,
  target: string,
  options: SafeFileOptions = {},
): string | null {
  const policy = normaliseOptions({ ...options, allowNested: true });
  const rootPath = resolve(root);
  const absolute = resolve(target);
  const rel = relative(rootPath, absolute);
  if (!validRequest(rel, policy)) return null;
  let rootInfo: Stats;
  try {
    rootInfo = lstatSync(rootPath);
  } catch {
    return absolute;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return null;
  let cursor = rootPath;
  const parts = rel === '' ? [] : rel.split(sep);
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    let info: Stats;
    try {
      info = lstatSync(cursor);
    } catch {
      return absolute;
    }
    if (info.isSymbolicLink()) return null;
    if (index < parts.length - 1 && !info.isDirectory()) return null;
    if (index === parts.length - 1 && !info.isFile()) return null;
  }
  return absolute;
}

function normaliseOptions(options: SafeFileOptions): Required<SafeFileOptions> {
  return {
    extensions: (options.extensions ?? []).map(normaliseExtension),
    maxBytes: options.maxBytes ?? Number.POSITIVE_INFINITY,
    logical: options.logical ?? false,
    logicalPath: options.logicalPath ?? false,
    maxIdLength: options.maxIdLength ?? DEFAULT_MAX_ID_LENGTH,
    allowNested: options.allowNested ?? false,
  };
}

function normaliseExtension(extension: string): string {
  const lower = extension.toLowerCase();
  return lower.startsWith('.') ? lower : `.${lower}`;
}

function validExactRequest(target: string, policy: Required<SafeFileOptions>): boolean {
  if (/\p{Cc}/u.test(target)) return false;
  if (policy.extensions.length === 0) return true;
  return policy.extensions.includes(normaliseExtension(extname(basename(target))));
}

function validRequest(request: string, policy: Required<SafeFileOptions>): boolean {
  if (request.length === 0 && !policy.allowNested) return false;
  if (request.includes('\\')) return false;
  const parts = policy.allowNested ? request.split('/').filter((part) => part !== '') : [request];
  if (parts.length === 0 && request !== '') return false;
  for (const part of parts) {
    const extension = normaliseExtension(extname(part));
    const id = policy.extensions.includes(extension) ? stem(part, extension) : part;
    if (id.length === 0 || id.length > policy.maxIdLength || part.startsWith('.')) return false;
    if (CONTROL_OR_SEPARATOR.test(part)) return false;
  }
  if (policy.logical) {
    if (parts.length !== 1 || policy.extensions.length === 0) return false;
    if (policy.extensions.includes(normaliseExtension(extname(request)))) return false;
  } else if (policy.extensions.length > 0) {
    const extension = normaliseExtension(extname(basename(request)));
    if (!policy.extensions.includes(extension)) return false;
  }
  return true;
}

function stem(name: string, extension: string): string {
  return extension === '' ? name : name.slice(0, -extension.length);
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

async function inspectDirectory(root: string): Promise<SafePathResult> {
  let info: Stats;
  try {
    info = await lstat(root);
  } catch {
    return failure('missing', 'not found');
  }
  if (info.isSymbolicLink()) return failure('symlink', 'symbolic links are not allowed');
  if (!info.isDirectory()) return failure('not-directory', 'not a directory');
  return { ok: true, path: root, info };
}

/**
 * Inspect an explicit absolute path without following user-created links.
 *
 * macOS exposes `/etc`, `/tmp` and `/var` as stable aliases into `/private`.
 * They are the only symlink components accepted here, and only when they point
 * at their matching `/private/*` directory. Every other component is lstat'ed
 * in place, including the final entry.
 */
async function inspectExactTarget(
  target: string,
  policy: Required<SafeFileOptions>,
): Promise<SafePathResult> {
  const root = parse(target).root;
  const rel = relative(root, target);
  const parts = rel === '' ? [] : rel.split(sep);
  let cursor = root;
  if (parts.length === 0) return inspectDirectory(root);
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    let info: Stats;
    try {
      info = await lstat(cursor);
    } catch {
      return failure('missing', 'not found');
    }
    const alias = info.isSymbolicLink() && (await isMacRootAlias(cursor, part));
    if (info.isSymbolicLink() && !alias) {
      return failure('symlink', 'symbolic links are not allowed');
    }
    if (index < parts.length - 1 && !info.isDirectory() && !alias) {
      return failure('not-directory', 'not a directory');
    }
    if (index === parts.length - 1 && info.isFile() && policy.extensions.length > 0) {
      const extension = normaliseExtension(extname(part));
      if (!policy.extensions.includes(extension)) return failure('invalid', 'invalid file name');
    }
    if (index === parts.length - 1) return { ok: true, path: target, info };
  }
  return failure('missing', 'not found');
}

async function isMacRootAlias(path: string, part: string): Promise<boolean> {
  if (dirname(path) !== parse(path).root || !['etc', 'tmp', 'var'].includes(part)) return false;
  try {
    const link = await readlink(path);
    return resolve(dirname(path), link) === `/private/${part}`;
  } catch {
    return false;
  }
}

async function inspectTarget(
  root: string,
  target: string,
  policy: Required<SafeFileOptions>,
): Promise<SafePathResult> {
  if (!contained(root, target)) return failure('outside-root', 'outside trusted root');
  const rootCheck = await inspectDirectory(root);
  if (!rootCheck.ok) return rootCheck;
  const rel = relative(root, target);
  if (rel === '') return rootCheck;
  let cursor = root;
  const parts = rel.split(sep);
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    let info: Stats;
    try {
      info = await lstat(cursor);
    } catch {
      return failure('missing', 'not found');
    }
    if (info.isSymbolicLink()) return failure('symlink', 'symbolic links are not allowed');
    if (index < parts.length - 1 && !info.isDirectory()) {
      return failure('not-directory', 'not a directory');
    }
    if (index === parts.length - 1 && info.isFile() && policy.extensions.length > 0) {
      const extension = normaliseExtension(extname(part));
      if (!policy.extensions.includes(extension)) return failure('invalid', 'invalid file name');
    }
    if (index === parts.length - 1) return { ok: true, path: target, info };
  }
  return failure('missing', 'not found');
}

/** Resolve a logical final entry while retaining the spelling returned by readdir. */
async function inspectLogicalPath(
  root: string,
  request: string,
  policy: Required<SafeFileOptions>,
): Promise<SafePathResult> {
  const parts = request.split('/').filter((part) => part !== '');
  const name = parts.at(-1);
  if (name === undefined) return failure('missing', 'not found');
  const parentRequest = parts.slice(0, -1).join('/');
  const parent = resolve(root, parentRequest);
  const parentInfo = await inspectTarget(root, parent, policy);
  if (!parentInfo.ok) return parentInfo;
  if (!parentInfo.info.isDirectory()) return failure('not-directory', 'not a directory');
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  const exact = entries.find((entry) => entry.name === name);
  if (exact !== undefined) {
    return inspectTarget(root, resolve(parent, exact.name), policy);
  }
  const wanted = name.normalize('NFC');
  const candidates = entries
    .map((entry) => entry.name)
    .filter((entry) => {
      const extension = normaliseExtension(extname(entry));
      return policy.extensions.includes(extension) && entry.normalize('NFC') === wanted;
    });
  if (candidates.length === 0) return failure('missing', 'not found');
  if (candidates.length > 1) return failure('ambiguous', ambiguousMessage(candidates));
  return inspectTarget(root, resolve(parent, candidates[0]), policy);
}

function withSize(file: SafeFile, maxBytes: number): SafeFileResult {
  if (file.info.size > maxBytes) return failure('too-large', `larger than ${maxBytes} bytes`);
  return file;
}

async function readInspected(file: SafeFile, maxBytes: number): Promise<SafeReadResult> {
  // `withSize` ran before this function for resolver-based reads. Keep the
  // check here as a second explicit guard for callers that use a path reader.
  if (file.info.size > maxBytes) return failure('too-large', `larger than ${maxBytes} bytes`);
  try {
    const bytes = await readFile(file.path);
    if (bytes.byteLength > maxBytes) return failure('too-large', `larger than ${maxBytes} bytes`);
    return { ok: true, path: file.path, info: file.info, bytes };
  } catch (error) {
    return failure('read-error', error instanceof Error ? error.message : String(error));
  }
}

function failure(code: SafeFileErrorCode, error: string): SafeFileError {
  return { ok: false, code, error };
}

function ambiguousMessage(names: readonly string[]): string {
  return `ambiguous normalization-equivalent files: ${names.join(', ')}`;
}
