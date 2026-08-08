/**
 * Tests for the published-extension verifier.
 *
 * A verifier is only worth having if its failures are demonstrable. Passing on
 * a genuine build proves almost nothing on its own — a function that returns
 * `ok: true` unconditionally would pass that test too. So most of what follows
 * tampers with a known-good package one way at a time and asserts the
 * verification fails, and says how.
 *
 * The fixture reproduces what the Chrome Web Store actually does to an upload,
 * which was established by taking apart three real published extensions:
 * rebuild the ZIP container, add directory entries and a uniform timestamp,
 * inject `_metadata/verified_contents.json` with a tree hash of every file, and
 * add `update_url` to `manifest.json`. Verified against the real thing: the
 * treehash implementation matched all 921 signed hashes in a published CRX.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { diffManifest, readSignedHashes, verifyCrx } from '../../scripts/lib/provenance.js';
import { toBase64Url, treeHash } from '../../scripts/lib/treehash.js';
import { zip } from '../../scripts/lib/zip.js';
import { FILES as FILES_ON_DISK } from '../../scripts/package.js';

const EXTENSION_DIR = fileURLToPath(new URL('../../extension', import.meta.url));

const SOURCE = {
  'manifest.json': Buffer.from(
    JSON.stringify({ manifest_version: 3, name: 'Tab Reaper', version: '0.1.0' }),
  ),
  'background.js': Buffer.from('import "./lib/reaper.js";\n'),
  'lib/reaper.js': Buffer.from('export const decide = () => "keep";\n'.repeat(300)),
  'icons/icon-16.png': Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
};
const FILES = Object.keys(SOURCE);

const readSource = (file) => {
  if (!(file in SOURCE)) throw new Error(`no such source file ${file}`);
  return SOURCE[file];
};

/**
 * Build a CRX the way the store would, from a map of published file contents.
 *
 * `mutate` receives the file map and the metadata being signed, so a test can
 * tamper with either the payload or the signature over it — the two are
 * separately interesting, since a tampered file whose hash was also updated is
 * exactly what a compromised publisher would produce.
 */
function buildStoreCrx({ files = SOURCE, version = '0.1.0', mutate } = {}) {
  const published = new Map(Object.entries(files).map(([name, data]) => [name, Buffer.from(data)]));

  // The store adds update_url and reserializes the manifest.
  if (published.has('manifest.json')) {
    const manifest = JSON.parse(published.get('manifest.json').toString('utf8'));
    manifest.update_url = 'https://clients2.google.com/service/update2/crx';
    published.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  }

  const context = { published, version, hashedFiles: null };
  if (mutate) mutate(context);

  const hashSource = context.hashedFiles ?? context.published;
  const contentHashes = [
    {
      format: 'treehash',
      block_size: 4096,
      hash_block_size: 4096,
      files: [...hashSource].map(([name, data]) => ({
        path: name,
        root_hash: toBase64Url(treeHash(data, 4096)),
      })),
    },
  ];
  const payload = [
    {
      content_hashes: contentHashes,
      item_id: 'a'.repeat(32),
      item_version: context.version,
      protocol_version: 1,
    },
  ];
  const verifiedContents = [
    {
      description: 'treehash per file',
      signed_content: {
        payload: toBase64Url(Buffer.from(JSON.stringify(payload))),
        signatures: [
          { header: { kid: 'publisher' }, protected: 'eyJhbGciOiJSUzI1NiJ9', signature: 'x' },
          { header: { kid: 'webstore' }, protected: 'eyJhbGciOiJSUzI1NiJ9', signature: 'y' },
        ],
      },
    },
  ];
  context.published.set(
    '_metadata/verified_contents.json',
    Buffer.from(JSON.stringify(verifiedContents)),
  );

  const archive = zip([...context.published].map(([name, data]) => ({ name, data })));
  const header = Buffer.alloc(12 + 1309);
  header.write('Cr24', 0, 'latin1');
  header.writeUInt32LE(3, 4);
  header.writeUInt32LE(1309, 8);
  return Buffer.concat([header, archive]);
}

const verify = (crx, extra = {}) =>
  verifyCrx({ crx, files: FILES, readSource, expectVersion: '0.1.0', ...extra });

test('a genuine published build verifies', () => {
  const result = verify(buildStoreCrx());
  assert.deepEqual(result.problems, [], 'a matching build must report no problems');
  assert.equal(result.ok, true);
  assert.equal(result.publishedVersion, '0.1.0');
  assert.deepEqual(result.signed.signers, ['publisher', 'webstore']);

  // Every file must be checked twice: against source, and against the signature.
  for (const file of FILES) {
    const forFile = result.checks.filter((check) => check.file === file);
    assert.equal(forFile.length, 2, `${file} should be checked against source and signature`);
    assert.ok(forFile.every((check) => check.ok));
  }
  assert.deepEqual(result.notes, ['_metadata/verified_contents.json — added by the store']);
});

test('a modified source file is caught', () => {
  // The case the whole exercise exists for: shipped code that is not the code
  // in the repository.
  const crx = buildStoreCrx({
    files: { ...SOURCE, 'lib/reaper.js': Buffer.from('export const decide = () => "close";\n') },
  });
  const result = verify(crx);
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((p) => p.startsWith('lib/reaper.js: contents differ')),
    `expected a contents-differ problem, got ${JSON.stringify(result.problems)}`,
  );
});

test('a single flipped byte is caught', () => {
  const tweaked = Buffer.from(SOURCE['lib/reaper.js']);
  tweaked[10] ^= 0x01;
  const result = verify(buildStoreCrx({ files: { ...SOURCE, 'lib/reaper.js': tweaked } }));
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('lib/reaper.js')));
});

test('a file whose hash was updated to match is still caught', () => {
  // A compromised publisher would sign the tampered file, so the signature
  // check agrees and only the comparison against git dissents. This is why both
  // checks exist: neither alone is sufficient.
  const tweaked = Buffer.from('export const decide = () => "close";\n');
  const result = verify(buildStoreCrx({ files: { ...SOURCE, 'lib/reaper.js': tweaked } }));
  assert.equal(result.ok, false);
  const signedCheck = result.checks.find((c) => c.file === 'lib/reaper.js' && c.signed);
  assert.equal(signedCheck.ok, true, 'the signature covers the tampered bytes');
  const sourceCheck = result.checks.find((c) => c.file === 'lib/reaper.js' && !c.signed);
  assert.equal(sourceCheck.ok, false, 'but the source comparison must still fail');
});

test('a file that matches git but was not signed is caught', () => {
  // The mirror image: the ZIP entry is genuine but the store never attested to
  // it, which is what a post-signing injection would look like.
  const result = verify(
    buildStoreCrx({
      mutate: (context) => {
        context.hashedFiles = new Map(context.published);
        context.hashedFiles.delete('lib/reaper.js');
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p === 'lib/reaper.js: the store recorded no hash for it'));
});

test('a payload whose signed hash disagrees with the bytes is caught', () => {
  const result = verify(
    buildStoreCrx({
      mutate: (context) => {
        const wrong = new Map(context.published);
        wrong.set('background.js', Buffer.from('something else entirely'));
        context.hashedFiles = wrong;
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((p) => p.includes("background.js: tree hash does not match the store's")),
    JSON.stringify(result.problems),
  );
});

test('an extra file with no counterpart in the source is caught', () => {
  // Worse than a modified file: code in users' browsers that the repository
  // does not contain at all.
  const crx = buildStoreCrx({
    files: { ...SOURCE, 'analytics.js': Buffer.from('fetch("https://example.com/beacon")') },
  });
  const result = verify(crx);
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((p) => p === 'analytics.js: present in the CRX but not in the source'),
    JSON.stringify(result.problems),
  );
});

test('a file absent from the source ref is reported, not thrown', () => {
  // Comparing against an older ref that predates a file (an icon added later,
  // say) must produce a finding. Letting readSource's exception escape would
  // abort the whole run and report nothing about the other nine files.
  const result = verifyCrx({
    crx: buildStoreCrx(),
    files: FILES,
    readSource: (file) => {
      if (file === 'icons/icon-16.png') throw new Error(`extension/${file} does not exist in v0.0.1`);
      return readSource(file);
    },
    expectVersion: '0.1.0',
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((p) => p.startsWith('icons/icon-16.png: present in the CRX but not in')),
    JSON.stringify(result.problems),
  );
  // The rest of the files must still have been checked.
  assert.ok(result.checks.filter((c) => c.ok).length >= FILES.length);
});

test('a missing file is caught', () => {
  const withoutIcon = { ...SOURCE };
  delete withoutIcon['icons/icon-16.png'];
  const result = verify(buildStoreCrx({ files: withoutIcon }));
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('icons/icon-16.png')));
});

test('a version mismatch is caught rather than compared anyway', () => {
  // Comparing a download against unrelated source proves nothing, so this must
  // fail loudly instead of reporting whatever the file-by-file result happened
  // to be.
  const result = verify(buildStoreCrx({ version: '0.9.9' }));
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('version 0.9.9')));
});

test('a self-packed CRX with no store metadata is rejected by default', () => {
  const archive = zip(FILES.map((name) => ({ name, data: SOURCE[name] })));
  const header = Buffer.alloc(12);
  header.write('Cr24', 0, 'latin1');
  header.writeUInt32LE(3, 4);
  header.writeUInt32LE(0, 8);
  const crx = Buffer.concat([header, archive]);

  const strict = verifyCrx({ crx, files: FILES, readSource });
  assert.equal(strict.ok, false, 'without store metadata there is no proof of what users receive');
  assert.ok(strict.problems.some((p) => p.includes('verified_contents.json is missing')));

  // Opting out downgrades it to a note. The manifest then has no update_url,
  // which is consistent — that key is added by the store.
  const relaxed = verifyCrx({ crx, files: FILES, readSource, requireStoreSignature: false });
  assert.equal(relaxed.ok, true, JSON.stringify(relaxed.problems));
  assert.ok(relaxed.notes.some((n) => n.includes('verified_contents.json is missing')));
});

test('diffManifest accepts update_url and nothing else', () => {
  const source = Buffer.from(JSON.stringify({ name: 'Tab Reaper', version: '1.0' }));

  const expected = Buffer.from(
    JSON.stringify({
      name: 'Tab Reaper',
      version: '1.0',
      update_url: 'https://clients2.google.com/service/update2/crx',
    }),
  );
  assert.deepEqual(diffManifest(source, expected), {
    problems: [],
    added: ['update_url'],
  });

  // Reserialization must not register as a difference — the store rewrites the
  // JSON, so byte comparison would fail on every real build.
  const reformatted = Buffer.from(
    JSON.stringify(
      { version: '1.0', name: 'Tab Reaper', update_url: 'https://clients2.google.com/service/update2/crx' },
      null,
      4,
    ),
  );
  assert.deepEqual(diffManifest(source, reformatted).problems, []);

  const changed = Buffer.from(JSON.stringify({ name: 'Tab Reaper', version: '9.9' }));
  assert.ok(diffManifest(source, changed).problems[0].includes('"version" differs'));

  const removed = Buffer.from(JSON.stringify({ name: 'Tab Reaper' }));
  assert.ok(diffManifest(source, removed).problems[0].includes('"version" was removed'));

  // An added permission is the dangerous kind of injection.
  const escalated = Buffer.from(
    JSON.stringify({ name: 'Tab Reaper', version: '1.0', permissions: ['<all_urls>'] }),
  );
  assert.ok(diffManifest(source, escalated).problems[0].includes('permissions'));

  const hijacked = Buffer.from(
    JSON.stringify({ name: 'Tab Reaper', version: '1.0', update_url: 'https://evil.example/crx' }),
  );
  assert.ok(diffManifest(source, hijacked).problems.some((p) => p.includes('not the Web Store')));
});

test('readSignedHashes rejects metadata it cannot read', () => {
  assert.throws(() => readSignedHashes(Buffer.from('[{}]')), /no signed payload/);
  const noTreehash = JSON.stringify([
    {
      signed_content: {
        payload: toBase64Url(Buffer.from(JSON.stringify([{ content_hashes: [] }]))),
        signatures: [],
      },
    },
  ]);
  assert.throws(() => readSignedHashes(Buffer.from(noTreehash)), /no treehash entries/);
});

test('the real extension/ tree verifies against a store-style package of itself', () => {
  // The fixtures above are synthetic. This runs the same comparison over the
  // actual shipped files, so a real file that trips the verifier — an encoding
  // quirk, a manifest key the diff mishandles — shows up here rather than on
  // release day.
  const realSource = {};
  for (const name of FILES_ON_DISK) {
    realSource[name] = fs.readFileSync(path.join(EXTENSION_DIR, name));
  }
  const crx = buildStoreCrx({
    files: realSource,
    version: JSON.parse(realSource['manifest.json'].toString()).version,
  });
  const result = verifyCrx({
    crx,
    files: FILES_ON_DISK,
    readSource: (file) => realSource[file],
    expectVersion: JSON.parse(realSource['manifest.json'].toString()).version,
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test('the CLI reports a foreign extension as a failure', () => {
  // Exercises the script end to end, including its exit status: a verifier that
  // prints problems but exits 0 is useless in CI or a shell pipeline.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-cli-'));
  try {
    const crxPath = path.join(dir, 'foreign.crx');
    fs.writeFileSync(
      crxPath,
      buildStoreCrx({
        files: { ...SOURCE, 'lib/reaper.js': Buffer.from('// not our code\n') },
      }),
    );
    const result = spawnCli(['--crx', crxPath, '--ref', 'HEAD']);
    assert.equal(result.status, 1, `expected a non-zero exit; output:\n${result.output}`);
    assert.match(result.output, /FAILED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function spawnCli(args) {
  const script = fileURLToPath(new URL('../../scripts/verify-provenance.js', import.meta.url));
  try {
    const output = execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, output };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
}
