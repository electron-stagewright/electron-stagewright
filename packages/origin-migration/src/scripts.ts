/**
 * Scripts main runs in the hidden migration pages. They stay strings so a bundler's minifier
 * cannot rename or wrap what runs in another realm. Arguments are spliced in with `call`, as JSON.
 */

export const STAGING_SUFFIX = '.origin-migration-staging'

/** Every key and value of the page's localStorage, or null when the page may not read it. */
export const READ_LOCAL_STORAGE = `(() => {
  try {
    void localStorage.length;
  } catch {
    return null;
  }
  const entries = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    const value = key === null ? null : localStorage.getItem(key);
    if (key !== null && value !== null) entries.push([key, value]);
  }
  return entries;
})()`

/** Sets each key the page does not hold yet; resolves with how many it set. */
export const WRITE_LOCAL_STORAGE = `((entries) => {
  let written = 0;
  for (const [key, value] of entries) {
    if (localStorage.getItem(key) !== null) continue;
    localStorage.setItem(key, value);
    written += 1;
  }
  return written;
})`

/** Every file in the origin private file system, with its size. Skips swap and staging files. */
export const LIST_FILES = `(async () => {
  const files = [];
  const pending = [{ dir: await navigator.storage.getDirectory(), path: [] }];
  while (pending.length > 0) {
    const { dir, path } = pending.pop();
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') pending.push({ dir: handle, path: [...path, name] });
      else if (!name.endsWith('.crswap') && !name.endsWith(${JSON.stringify(STAGING_SUFFIX)})) files.push({ path: [...path, name], size: (await handle.getFile()).size });
    }
  }
  return files;
})()`

const OPEN_PARENT = `let dir = await navigator.storage.getDirectory();
  for (const name of path.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create });`

/** `length` bytes of a file from `offset`. */
export const READ_CHUNK = `(async (path, offset, length) => {
  const create = false;
  ${OPEN_PARENT}
  const file = await (await dir.getFileHandle(path[path.length - 1])).getFile();
  return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
})`

/** A file's size, or null when the page has no file at that path. */
export const FILE_SIZE = `(async (path) => {
  const create = false;
  try {
    ${OPEN_PARENT}
    return (await (await dir.getFileHandle(path[path.length - 1])).getFile()).size;
  } catch (error) {
    if (error && error.name === 'NotFoundError') return null;
    throw error;
  }
})`

// The writable commits on close, so an interrupted copy never leaves partial content.
export const BEGIN_FILE = `(async (path) => {
  const create = true;
  ${OPEN_PARENT}
  const handle = await dir.getFileHandle(path[path.length - 1], { create: true });
  globalThis.__originMigrationWritable = await handle.createWritable({ keepExistingData: false });
})`

export const WRITE_CHUNK = `(async (data) => {
  let bytes;
  if (typeof Uint8Array.fromBase64 === 'function') {
    bytes = Uint8Array.fromBase64(data);
  } else {
    const binary = atob(data);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  }
  await globalThis.__originMigrationWritable.write(bytes);
})`

export const END_FILE = `(async () => {
  const writable = globalThis.__originMigrationWritable;
  globalThis.__originMigrationWritable = undefined;
  await writable.close();
})()`

export const ABORT_FILE = `(async () => {
  const writable = globalThis.__originMigrationWritable;
  globalThis.__originMigrationWritable = undefined;
  if (writable) await writable.abort();
})()`

export const COMMIT_FILE = `(async (path, name) => {
  const create = false;
  ${OPEN_PARENT}
  await (await dir.getFileHandle(path[path.length - 1])).move(name);
})`

export const REMOVE_FILE = `(async (path) => {
  const create = false;
  try {
    ${OPEN_PARENT}
    await dir.removeEntry(path[path.length - 1]);
  } catch (error) {
    if (!error || error.name !== 'NotFoundError') throw error;
  }
})`

/** A call of one of the function scripts above. */
export function call(script: string, ...args: unknown[]): string {
  return `${script}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`
}
