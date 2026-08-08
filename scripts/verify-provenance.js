/**
 * Check that the extension Chrome installs is built from this repository:
 *
 *   node scripts/verify-provenance.js --item <store id> --ref v0.2.0
 *
 * Anyone can run this from a clean checkout. It needs no credentials and
 * nothing from the publisher: the CRX comes from Google, the signed per-file
 * hashes inside it come from Google, and the source comes from git.
 *
 * The comparison itself lives in scripts/lib/provenance.js, which documents
 * what it can and cannot establish — in short, whole-archive byte-identity is
 * impossible because the store repackages uploads, but per-file contents are
 * preserved and individually signed. This file is only the command line around
 * it: fetch the CRX, read the source out of a git ref, print the result.
 *
 * The other half of the chain is the GitHub build attestation, which ties the
 * uploaded zip to a commit and a workflow run. See docs/provenance.md.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';

import { UPDATE_URL, verifyCrx } from './lib/provenance.js';
import { FILES } from './package.js';

// The version Chrome sends when asking for an update. Any recent value works;
// the endpoint uses it to decide what formats it may return.
const CHROME_VERSION = '121.0.0.0';

function usage() {
  console.log(`Check that a published extension matches this source.

Usage: node scripts/verify-provenance.js [options]

  --item <id>     Chrome Web Store item ID (default: $CWS_ITEM_ID)
  --ref <ref>     git ref to compare against (default: HEAD)
  --crx <path>    verify a local .crx instead of downloading
  --save <path>   keep the downloaded .crx
  --allow-unsigned
                  accept a CRX with no store metadata (self-packed builds).
                  This drops the check that Google signed these bytes.
  --help

Exit status is 0 only if every file matches.
`);
}

function parseArgs(argv) {
  const options = { ref: 'HEAD', item: process.env.CWS_ITEM_ID };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg === '--ref') options.ref = next();
    else if (arg === '--item') options.item = next();
    else if (arg === '--crx') options.crx = next();
    else if (arg === '--save') options.save = next();
    else if (arg === '--allow-unsigned') options.allowUnsigned = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  return options;
}

/**
 * Read a file out of a git ref, without touching the working tree.
 *
 * A path missing from the ref is reported as such rather than as a git failure:
 * it means the published package contains a file this ref never had, which is a
 * verification result, not a tooling error.
 */
function gitShow(ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:extension/${file}`], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`extension/${file} does not exist in ${ref}`);
  }
}

async function downloadCrx(itemId) {
  const url =
    `${UPDATE_URL}?response=redirect&acceptformat=crx2,crx3` +
    `&prodversion=${CHROME_VERSION}&x=id%3D${itemId}%26uc`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(
      `Downloading the CRX failed: HTTP ${response.status} ${response.statusText}. ` +
        'Check the item ID, and that the extension is published and public.',
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();

  let crx;
  if (options.crx) {
    crx = await fs.readFile(options.crx);
    console.log(`Reading ${options.crx} (${crx.length} bytes)`);
  } else {
    if (!options.item) {
      throw new Error('Pass --item <store item id>, set CWS_ITEM_ID, or use --crx <path>');
    }
    console.log(`Downloading item ${options.item} from Google…`);
    crx = await downloadCrx(options.item);
    console.log(`  ${crx.length} bytes`);
    if (options.save) {
      await fs.writeFile(options.save, crx);
      console.log(`  saved to ${options.save}`);
    }
  }

  const commit = execFileSync('git', ['rev-parse', options.ref], { encoding: 'utf8' }).trim();
  const sourceVersion = JSON.parse(gitShow(options.ref, 'manifest.json').toString()).version;
  console.log(`Comparing against ${options.ref} (${commit}), which declares v${sourceVersion}\n`);

  const result = verifyCrx({
    crx,
    files: FILES,
    readSource: (file) => gitShow(options.ref, file),
    expectVersion: sourceVersion,
    requireStoreSignature: !options.allowUnsigned,
  });

  if (result.signed) {
    console.log(
      `Store metadata: item ${result.signed.itemId} v${result.signed.itemVersion}, ` +
        `signed by ${result.signed.signers.join(' + ')}\n`,
    );
  }
  for (const check of result.checks) {
    const label = check.signed ? 'signed' : 'source';
    console.log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${label}  ${check.file} (${check.detail})`);
  }
  for (const note of result.notes) console.log(`  note        ${note}`);

  if (!result.ok) {
    console.error(`\nFAILED — ${result.problems.length} problem(s):\n`);
    for (const problem of result.problems) console.error(`  - ${problem}`);
    console.error(
      '\nThe published extension does not match this source. Do not trust it until ' +
        'that is explained.',
    );
    process.exit(1);
  }

  console.log(
    `\nVERIFIED — every file Chrome installs is byte-identical to ${commit}, and matches ` +
      "the store's own signed hashes.",
  );
}

main().catch((error) => {
  console.error(`\nVerification could not complete: ${error.message}`);
  process.exit(1);
});
