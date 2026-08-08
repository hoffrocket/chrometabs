/**
 * Tests for Chrome's tree hash.
 *
 * The stakes here are unusual: this is the algorithm that decides whether the
 * published extension is declared to match the source. A subtly wrong
 * implementation would report VERIFIED for something it never actually checked,
 * which is worse than having no verifier at all. So the expectations below are
 * derived from the algorithm's definition rather than from this module's own
 * output — a test that records whatever the code happens to produce would pass
 * just as happily with the code wrong.
 *
 * The real proof is external: run against a published extension, this
 * implementation matched all 921 of Google's signed per-file hashes.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { fromBase64Url, toBase64Url, treeHash } from '../../scripts/lib/treehash.js';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

test('an empty file hashes as SHA-256 of nothing', () => {
  assert.deepEqual(treeHash(Buffer.alloc(0)), sha256(Buffer.alloc(0)));
});

test('a file smaller than one block is just its SHA-256', () => {
  const data = Buffer.from('hello world');
  assert.deepEqual(treeHash(data), sha256(data));
});

test('a file of exactly one block is just its SHA-256', () => {
  const data = crypto.randomBytes(4096);
  assert.deepEqual(treeHash(data), sha256(data));
});

test('one byte past a block boundary combines two leaf hashes', () => {
  const data = Buffer.concat([Buffer.alloc(4096, 0xaa), Buffer.from([0xbb])]);
  const expected = sha256(
    Buffer.concat([sha256(data.subarray(0, 4096)), sha256(data.subarray(4096))]),
  );
  assert.deepEqual(treeHash(data), expected);
  assert.notDeepEqual(treeHash(data), sha256(data), 'must not degenerate to a flat hash');
});

test('the tree branches at 128 leaves, not before', () => {
  // Branch factor is blockSize / 32 = 128 digests per node. With exactly 128
  // blocks the tree is one level deep; 129 forces a second level. Getting this
  // boundary wrong is the most likely way to build a hash that looks right on
  // small files and diverges on large ones.
  const block = (fill) => Buffer.alloc(4096, fill);

  const exactly128 = Buffer.concat(Array.from({ length: 128 }, (_, i) => block(i)));
  const leaves128 = Array.from({ length: 128 }, (_, i) => sha256(block(i)));
  assert.deepEqual(treeHash(exactly128), sha256(Buffer.concat(leaves128)));

  const oneMore = Buffer.concat([exactly128, block(200)]);
  const leaves129 = [...leaves128, sha256(block(200))];
  const level2 = [sha256(Buffer.concat(leaves129.slice(0, 128))), sha256(leaves129[128])];
  assert.deepEqual(treeHash(oneMore), sha256(Buffer.concat(level2)));
});

test('a smaller block size changes both the split and the branch factor', () => {
  // blockSize is read from the store's metadata rather than hardcoded, so it
  // has to drive the branch factor too (64 / 32 = 2 here) and not just the
  // leaf split.
  const data = Buffer.concat([Buffer.alloc(64, 1), Buffer.alloc(64, 2), Buffer.alloc(64, 3)]);
  const leaves = [Buffer.alloc(64, 1), Buffer.alloc(64, 2), Buffer.alloc(64, 3)].map(sha256);
  const level2 = [sha256(Buffer.concat([leaves[0], leaves[1]])), sha256(leaves[2])];
  assert.deepEqual(treeHash(data, 64), sha256(Buffer.concat(level2)));
});

test('a single flipped bit anywhere changes the hash', () => {
  const data = crypto.randomBytes(4096 * 5 + 17);
  const before = treeHash(data);
  for (const at of [0, 4096, 4097, data.length - 1]) {
    const tampered = Buffer.from(data);
    tampered[at] ^= 0x01;
    assert.notDeepEqual(treeHash(tampered), before, `flipping byte ${at} went unnoticed`);
  }
});

test('base64url round-trips and uses no padding or +/ characters', () => {
  // verified_contents.json encodes hashes this way; decoding them with plain
  // base64 silently produces wrong bytes for some digests, so every comparison
  // would fail for the wrong reason.
  for (let i = 0; i < 50; i += 1) {
    const raw = sha256(Buffer.from([i]));
    const encoded = toBase64Url(raw);
    assert.doesNotMatch(encoded, /[+/=]/, `${encoded} is not base64url`);
    assert.deepEqual(fromBase64Url(encoded), raw);
  }
});

test('base64url decodes what the standard alphabet would mangle', () => {
  const raw = Buffer.from('fbff3e', 'hex'); // encodes to characters requiring - and _
  assert.equal(toBase64Url(raw), '-_8-');
  assert.deepEqual(fromBase64Url('-_8-'), raw);
});
