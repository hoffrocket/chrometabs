# Provenance: proving the published extension is this code

An extension in the Chrome Web Store is a black box. You can read the source on
GitHub, but nothing about the store listing tells you the two are related — the
publisher uploads a zip, and only they know what went into it. This document
covers what can actually be proved about that link, and how to check it.

**The short version:** there is no official Chrome Web Store mechanism for this.
What this repository does instead is a two-part chain, both parts publicly
verifiable by anyone, with no cooperation from the publisher:

```
git commit ──[GitHub build attestation]──> uploaded zip ──[store's signed hashes]──> what Chrome runs
```

- [What is not possible](#what-is-not-possible)
- [Verifying it yourself](#verifying-it-yourself)
- [Part 1: commit to package](#part-1-commit-to-package)
- [Part 2: package to installed extension](#part-2-package-to-installed-extension)
- [What this does not cover](#what-this-does-not-cover)
- [How to describe it in the store listing](#how-to-describe-it-in-the-store-listing)

## What is not possible

Worth stating first, because the obvious approach doesn't work and a check that
quietly compares something weaker than it claims is worse than no check at all.

**You cannot compare the published archive byte-for-byte with the uploaded one.**
The store repackages every upload. Taking apart three real published extensions
shows consistently that it:

- **rebuilds the ZIP container** — every entry ends up with a single uniform
  timestamp, and directory entries are added that the upload never had;
- **injects `_metadata/verified_contents.json`**, Google's own signed manifest of
  file hashes;
- **adds an `update_url` key to `manifest.json`**, pointing at Chrome's update
  endpoint.

So the download is never identical to the upload, and no amount of care in the
build makes it so.

**What the store does not change is file contents.** Every other file arrives
byte-for-byte as uploaded. That is the property the verification rests on.

There is also **no store-native provenance feature**: no reproducible-build
attestation, no way to publish a source hash alongside a listing, no field for
any of this. The store listing can only *describe* the chain and link here.

## Verifying it yourself

You need `git`, Node 22+, and nothing else. No credentials, no tokens, no
cooperation from the publisher.

```sh
git clone https://github.com/hoffrocket/chrometabs
cd chrometabs
git checkout v0.1.0                     # the version you want to check

node scripts/verify-provenance.js --item <store item id> --ref v0.1.0
```

This downloads the CRX from Google's own update endpoint — the same URL Chrome
uses — and compares every file against the git tag, twice: against the source,
and against the hashes Google signed. Output looks like:

```
Downloading item abcdefgh… from Google…
  63076 bytes
Comparing against v0.1.0 (a1b2c3d…), which declares v0.1.0

Store metadata: item abcdefgh… v0.1.0, signed by publisher + webstore

  ok   source  manifest.json (store added: update_url)
  ok   source  background.js (2140 bytes)
  ok   signed  background.js (store-signed hash)
  …
  note        _metadata/verified_contents.json — added by the store

VERIFIED — every file Chrome installs is byte-identical to a1b2c3d…, and
matches the store's own signed hashes.
```

It exits non-zero on any mismatch, so it can be scripted. To check the build
attestation as well:

```sh
npm run package                                     # rebuild the exact zip
gh attestation verify dist/tab-reaper-0.1.0.zip --repo hoffrocket/chrometabs
```

## Part 1: commit to package

`.github/workflows/release.yml` produces a **build attestation** for every
release: a [Sigstore](https://www.sigstore.dev/)-signed statement that says, in
effect, *"commit `<sha>` of `hoffrocket/chrometabs`, built by workflow run
`<id>`, produced a file with SHA-256 `<digest>`."*

What makes it worth anything:

- **The signing identity is GitHub's, not this repository's.** The key comes
  from GitHub's OIDC issuer at build time. A publisher cannot forge an
  attestation naming a commit that never built, because they never hold the key.
- **It is recorded in a public transparency log.** The claim cannot be quietly
  withdrawn or altered after the fact.
- **It names the commit and the workflow**, so it distinguishes "built by CI from
  this tag" from "built on somebody's laptop" — which is the whole question.

This follows [SLSA](https://slsa.dev/) v1.0 Build Level 2.

### Why the package has to be reproducible

An attestation covers a digest, so it is only useful if you can independently
produce that digest. `npm run package` is deterministic: entry order is fixed, no
timestamps vary, and — critically — **nothing is compressed**.

That last point was measured rather than assumed. With deflate enabled, the same
source produced *two different digests* across five Node versions:

| Node | zlib | digest |
| --- | --- | --- |
| 16, 26 | 1.2.11, 1.2.12 | `1195ee5b…` |
| 20, 22, 24 | 1.3.0.1-motley, 1.3.1 | `0c812d88…` |

Deflate output is not standardised, so a compressed archive's hash depends on the
toolchain that built it — and "rebuild it and compare" would fail for anyone on a
different Node, which is precisely the audience. Storing instead costs about 23%
more bytes (63 KB → 76 KB) and yields a digest reproducible on any machine,
forever. The store recompresses uploads anyway, so the compression never reached
users.

`test/unit/zip.test.js` asserts no entry is compressed, so re-enabling it fails
the build rather than silently breaking published digests.

### Why the attestation is signed in the `verify` job

`actions/attest-build-provenance` runs in `verify`, which holds **no store
credentials**, rather than in `publish`, which does. It needs `id-token: write`,
but that grants nothing toward Google: attestation identities are issued by
Sigstore and the job has no path to the store.

This is the one action in the release path that isn't `checkout` or
`setup-node`. It's GitHub's own, and hand-rolling it isn't a real option — the
value comes from the signature chaining to GitHub's identity, which cannot be
reproduced with `run:` steps. Keeping it out of the credential-bearing job is the
mitigation.

`publish` rebuilds the package and **fails if the digest doesn't match** the one
`verify` attested, so what gets published is always what was attested.

## Part 2: package to installed extension

The store signs what it serves. Inside every published CRX,
`_metadata/verified_contents.json` holds a Chrome **tree hash** of every file,
signed twice — once with a `publisher` key and once with a `webstore` key.

This is not a courtesy: it's the data **Chrome itself verifies** before executing
an extension, which is how the browser detects tampering with an installed copy
on disk. Recomputing those hashes and comparing them to the file contents means
checking the same thing the browser checks.

The tree hash is SHA-256 over 4096-byte blocks, combined into a Merkle tree with
a branch factor of `block_size / 32` = 128. `scripts/lib/treehash.js` implements
it. It was validated against a real published extension: **all 921 files matched
Google's signed hashes.**

`scripts/lib/provenance.js` then runs two checks, and both matter:

1. **Contents match the git ref.** Each file's bytes versus `git show <ref>:…`.
2. **Google signed those same contents.** The recomputed tree hashes versus the
   store's signed ones.

Neither is sufficient alone, which the tests demonstrate explicitly:

- A compromised publisher who modifies a file *and* signs it produces a package
  where check 2 passes and only check 1 fails.
- A file injected after signing produces the reverse.

`manifest.json` is compared as parsed JSON rather than bytes, since the store
reserializes it. It may gain `update_url` and nothing else; a changed value, a
removed key, or an added permission all fail. Any file in the CRX without a
counterpart in the repository fails too — code with no source at all is the more
alarming direction than code that merely differs.

## What this does not cover

Being precise about the gaps is the point; a provenance claim that overstates
itself is worthless.

- **The RSA signatures in `verified_contents.json` are not validated** against
  Google's public key. Doing so would mean pinning a key in this repository. The
  hashes are checked, not the signature over them — so this detects tampering
  between the store and you only insofar as the CRX is self-consistent.
- **A store-side compromise is out of scope.** If Google served a different CRX
  with matching, self-consistently signed metadata, the check would pass.
- **It says nothing about whether the code is good**, only that it is the code in
  the repository. Reviewing it is a separate exercise.
- **The first upload is manual.** The store API cannot create an item, so v1 is
  uploaded by hand and is not covered by an attestation. Every automated release
  after it is.
- **Only files in `scripts/package.js`'s `FILES` list are compared** — but the
  check runs in both directions, so anything extra in the CRX is a failure rather
  than something skipped.

## How to describe it in the store listing

Wording that is defensible, i.e. that doesn't claim byte-identity with a git
commit or imply Google endorses any of it:

> **Verifiable builds.** Every release is built by a public GitHub Actions
> workflow from a tagged commit, and the resulting package is signed with a
> build attestation recorded in a public transparency log. You can confirm that
> the code Chrome runs is exactly the code in the repository — every file, byte
> for byte — using the instructions and script here:
> https://github.com/hoffrocket/chrometabs/blob/master/docs/provenance.md

Things to avoid claiming:

- ❌ "The published extension is byte-identical to commit X." The store
  repackages, so the *archive* is not.
- ❌ "Verified by Google." Google's signature is used as evidence; Google is not
  attesting to any link with the repository.
- ❌ "Reproducible build" without qualification. The *package* is reproducible;
  the store's CRX is not.
