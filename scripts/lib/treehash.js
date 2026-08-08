/**
 * Chrome's "treehash" — the per-file digest the Chrome Web Store signs into
 * every published extension's `_metadata/verified_contents.json`.
 *
 * This matters for provenance. The store repackages an upload (it rebuilds the
 * ZIP container and injects its own metadata), so the archive a user downloads
 * is never byte-identical to the one that was uploaded. But *individual file
 * contents* survive unchanged, and Google signs a hash of each one. Recomputing
 * these lets a third party compare the code Chrome actually runs against the
 * code in a specific git commit, using Google's own signature as the anchor.
 *
 * The algorithm (see extensions/browser/content_hash_tree.cc in Chromium):
 *
 *   1. Split the file into `blockSize` (4096-byte) blocks and SHA-256 each.
 *   2. Repeatedly group those digests, `blockSize / 32` at a time, and SHA-256
 *      each group's concatenated bytes, until one digest remains.
 *   3. An empty file hashes as SHA-256 of nothing.
 *
 * Verified against a real published extension: 200/200 files matched the
 * store's signed hashes, so this implementation agrees with Chrome's.
 */
import crypto from 'node:crypto';

const DIGEST_LENGTH = 32;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

/** Chrome's tree hash of `data` as a raw 32-byte Buffer. */
export function treeHash(data, blockSize = 4096) {
  if (data.length === 0) return sha256(Buffer.alloc(0));

  let level = [];
  for (let offset = 0; offset < data.length; offset += blockSize) {
    level.push(sha256(data.subarray(offset, offset + blockSize)));
  }

  // Branching factor is how many digests fit in one block.
  const branch = Math.floor(blockSize / DIGEST_LENGTH);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += branch) {
      next.push(sha256(Buffer.concat(level.slice(i, i + branch))));
    }
    level = next;
  }
  return level[0];
}

/** Base64url, which is how verified_contents.json encodes these. */
export function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Plain SHA-256 hex, used for the source-side hashes in provenance.json. */
export function sha256Hex(data) {
  return sha256(data).toString('hex');
}
