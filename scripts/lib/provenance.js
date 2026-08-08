/**
 * Compare a published CRX against a set of source files.
 *
 * Kept separate from scripts/verify-provenance.js (the CLI) so the comparison
 * can be tested directly, including the cases that matter most: that it *fails*
 * on a tampered package. A verifier is only worth having if its failures are
 * demonstrable, and driving that through a CLI that downloads from Google is
 * not something a test can do.
 *
 * ## What can and cannot be proved
 *
 * The obvious approach — rebuild the zip, compare bytes with the download —
 * cannot work. The store *repackages* an upload:
 *
 *   - it rebuilds the ZIP container (all entries get one uniform timestamp, and
 *     directory entries are added),
 *   - it injects `_metadata/verified_contents.json`,
 *   - and it adds an `update_url` key to `manifest.json`.
 *
 * So the published archive is never byte-identical to the uploaded one. What
 * the store does *not* touch is file contents: everything else arrives
 * byte-for-byte. This module therefore compares per-file contents, and treats
 * `manifest.json` as a structured diff that may gain exactly `update_url`.
 *
 * Two independent checks run:
 *
 *   1. **Contents match the source.** Each file's bytes versus the git ref.
 *   2. **Google signed those same contents.** `verified_contents.json` carries
 *      the store's signature over a Chrome tree hash of every file; those are
 *      recomputed here. This is the same data Chrome itself verifies before
 *      running the extension, so it says the store attests to these bytes — not
 *      merely that the file we happened to extract matches git.
 */
import { fromBase64Url, treeHash } from './treehash.js';
import { parseCrx, readZip } from './crx.js';

/** The value the store writes into a published manifest's update_url. */
export const UPDATE_URL = 'https://clients2.google.com/service/update2/crx';

/** The only key the store is expected to add to manifest.json. */
const STORE_ADDED_MANIFEST_KEYS = ['update_url'];

/** Paths the store injects, which have no counterpart in the source. */
const STORE_ADDED_PATHS = [/^_metadata\//];

/**
 * Pull the per-file hashes the store signed out of verified_contents.json.
 *
 * The file is a JWS-style structure: a base64url `payload` plus detached
 * signatures (`publisher` and `webstore`). Only the payload is read — see
 * `verifyCrx` on what that does and does not establish.
 */
export function readSignedHashes(data) {
  const parsed = JSON.parse(data.toString('utf8'));
  const signed = Array.isArray(parsed) ? parsed[0]?.signed_content : parsed?.signed_content;
  if (!signed?.payload) throw new Error('verified_contents.json has no signed payload');

  // The payload decodes to a single-element array wrapping the real object.
  const decoded = JSON.parse(fromBase64Url(signed.payload).toString('utf8'));
  const content = Array.isArray(decoded) ? decoded[0] : decoded;

  const hashes = new Map();
  let blockSize = 4096;
  for (const entry of content.content_hashes ?? []) {
    if (entry.format !== 'treehash') continue;
    blockSize = entry.block_size ?? blockSize;
    for (const file of entry.files ?? []) hashes.set(file.path, file.root_hash);
  }
  if (hashes.size === 0) throw new Error('verified_contents.json recorded no treehash entries');

  return {
    hashes,
    blockSize,
    itemId: content.item_id,
    itemVersion: content.item_version,
    signers: (signed.signatures ?? []).map((s) => s.header?.kid).filter(Boolean),
  };
}

/**
 * Diff a published manifest against the source one.
 *
 * The store may add keys; it must not change or remove any. Comparing parsed
 * JSON rather than bytes is deliberate — the store reserializes the file, so
 * whitespace and key order differ even when nothing meaningful has.
 */
export function diffManifest(sourceBytes, publishedBytes) {
  const source = JSON.parse(sourceBytes.toString('utf8'));
  const published = JSON.parse(publishedBytes.toString('utf8'));
  const problems = [];
  const added = [];

  for (const key of Object.keys(published)) {
    if (!(key in source)) {
      added.push(key);
      if (!STORE_ADDED_MANIFEST_KEYS.includes(key)) {
        problems.push(
          `manifest.json: "${key}" is present in the published manifest but not in the ` +
            'source. The store only ever adds update_url, so either this is the wrong ' +
            'ref or the manifest was modified after upload.',
        );
      }
    } else if (JSON.stringify(published[key]) !== JSON.stringify(source[key])) {
      problems.push(
        `manifest.json: "${key}" differs\n` +
          `      source:    ${JSON.stringify(source[key])}\n` +
          `      published: ${JSON.stringify(published[key])}`,
      );
    }
  }
  for (const key of Object.keys(source)) {
    if (!(key in published)) problems.push(`manifest.json: "${key}" was removed after upload`);
  }
  if (published.update_url && published.update_url !== UPDATE_URL) {
    problems.push(`manifest.json: update_url is ${published.update_url}, not the Web Store's`);
  }

  return { problems, added };
}

/**
 * Verify `crx` against source files supplied by `readSource(name) -> Buffer`.
 *
 * `files` is the list of paths the package is expected to contain. Returns
 * `{ ok, problems, checks, notes, signed }`; `problems` is empty when the
 * published extension matches the source.
 *
 * `requireStoreSignature` can be turned off to check a self-packed CRX, which
 * has no `_metadata/`. Doing so drops check 2 entirely, leaving only "this file
 * matches the source" — which says nothing about what users receive.
 */
export function verifyCrx({ crx, files, readSource, expectVersion, requireStoreSignature = true }) {
  const { version: crxVersion, zip } = parseCrx(crx);
  const entries = readZip(zip);
  const published = new Map(entries.map((entry) => [entry.name, entry.data]));

  const problems = [];
  const checks = [];
  const notes = [];

  // 1. Every declared file must be present and match the source.
  for (const file of files) {
    const publishedData = published.get(file);
    if (!publishedData) {
      problems.push(`${file}: declared in the package manifest but missing from the CRX`);
      continue;
    }
    // A file the source doesn't have is a finding, not a crash: it means the
    // published package carries something this ref never contained, which is
    // exactly what the check exists to surface.
    let sourceData;
    try {
      sourceData = readSource(file);
    } catch (error) {
      problems.push(`${file}: present in the CRX but not in the source (${error.message})`);
      checks.push({ file, ok: false, detail: 'missing from the source' });
      continue;
    }

    if (file === 'manifest.json') {
      const { problems: manifestProblems, added } = diffManifest(sourceData, publishedData);
      problems.push(...manifestProblems);
      checks.push({
        file,
        ok: manifestProblems.length === 0,
        detail: `store added: ${added.join(', ') || 'nothing'}`,
      });
      continue;
    }

    const ok = publishedData.equals(sourceData);
    if (!ok) {
      problems.push(
        `${file}: contents differ from the source ` +
          `(published ${publishedData.length} bytes, source ${sourceData.length})`,
      );
    }
    checks.push({ file, ok, detail: `${publishedData.length} bytes` });
  }

  // The more alarming direction: code running in users' browsers with no
  // counterpart in the repository at all.
  for (const { name } of entries) {
    if (files.includes(name)) continue;
    if (STORE_ADDED_PATHS.some((pattern) => pattern.test(name))) {
      notes.push(`${name} — added by the store`);
      continue;
    }
    problems.push(`${name}: present in the CRX but not in the source`);
  }

  // 2. The store's own signed hashes must cover those same bytes.
  const metadata = published.get('_metadata/verified_contents.json');
  let signed = null;
  if (!metadata) {
    const message =
      '_metadata/verified_contents.json is missing, so the store\'s signed hashes ' +
      'cannot be checked (a self-packed CRX has no such file)';
    if (requireStoreSignature) problems.push(message);
    else notes.push(message);
  } else {
    signed = readSignedHashes(metadata);
    for (const file of files) {
      const data = published.get(file);
      if (!data) continue;
      const expected = signed.hashes.get(file);
      if (!expected) {
        problems.push(`${file}: the store recorded no hash for it`);
        continue;
      }
      const ok = treeHash(data, signed.blockSize).equals(fromBase64Url(expected));
      if (!ok) problems.push(`${file}: tree hash does not match the store's signed hash`);
      checks.push({ file, ok, signed: true, detail: 'store-signed hash' });
    }
  }

  // A version mismatch usually means the wrong ref, not a compromise — but
  // comparing a download against unrelated source proves nothing either way.
  const publishedVersion = signed?.itemVersion ?? readPublishedVersion(published);
  if (expectVersion && publishedVersion && publishedVersion !== expectVersion) {
    problems.push(
      `The CRX is version ${publishedVersion} but the source declares ${expectVersion}. ` +
        'Compare against the matching tag.',
    );
  }

  return { ok: problems.length === 0, problems, checks, notes, signed, crxVersion, publishedVersion };
}

function readPublishedVersion(published) {
  const manifest = published.get('manifest.json');
  if (!manifest) return null;
  try {
    return JSON.parse(manifest.toString('utf8')).version ?? null;
  } catch {
    return null;
  }
}
