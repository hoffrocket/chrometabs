# Publishing to the Chrome Web Store

Releases are automated: push a `v1.2.3` tag, approve the run, and the extension
is submitted to the store. This document covers the one-time setup, then the
per-release routine.

No secrets are stored in GitHub. Authentication uses workload identity
federation, so the workflow proves its identity with a short-lived OIDC token
that GitHub mints per run, and Google trades that for an access token valid for
ten minutes. There is no key to leak or rotate.

Releases also carry a cryptographic link back to the commit they were built
from, which anyone can check — see [`provenance.md`](provenance.md).

- [What the API cannot do](#what-the-api-cannot-do)
- [One-time setup](#one-time-setup)
- [Releasing](#releasing)
- [How the workflow is put together](#how-the-workflow-is-put-together)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)

## What the API cannot do

Two limits are Google's, not this repo's, and both need a human:

1. **It cannot create a store item.** `media.upload` uploads to an item that
   already exists, so **version 1 must be uploaded through the dashboard by
   hand**. Every version after that can be automated.
2. **It cannot skip review.** Publishing submits the item; going live still
   waits on Google's review queue, which usually takes hours to a few days.

Also worth knowing: the API always publishes with the item's **existing
visibility**. If you change visibility in the dashboard, publish manually once
before going back to automated releases.

## One-time setup

### 1. Create the item by hand

Build the package and upload it once through the dashboard:

```sh
npm run package     # writes dist/tab-reaper-<version>.zip
```

At [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole):
**Add new item** → upload the zip → fill in the **Store listing** and
**Privacy practices** tabs → publish. Both tabs must be complete before any
publish, automated or not, will succeed.

For the listing's **Store icon** field, upload `assets/store/store-icon-128.png`
— *not* one of the `extension/icons/` files. The store wants 128x128 overall with
the art inset to 96x96, leaving 16px of transparent padding per side, whereas
the manifest icons are deliberately full-bleed. `npm run icons` writes both.

The **Privacy practices** tab wants a justification for each of `tabs`,
`storage`, and `alarms`, plus a privacy policy URL.
[`privacy.md`](privacy.md) has all four: paste the per-permission sections into
the justification fields, and use its GitHub URL as the policy link —

```
https://github.com/hoffrocket/chrometabs/blob/master/docs/privacy.md
```

Declare **no data collection** for every category; the extension makes no network
requests, so there is nothing to disclose.

Then copy the **item ID** from the dashboard URL — it's the 32-character string
in `.../devconsole/.../items/<ITEM_ID>/edit`.

### 2. Link the service account to the publisher

In the dashboard under **Account**, add the service account email:

```
itemupdater@tab-reaper.iam.gserviceaccount.com
```

This is what grants it authority over your items. Only **one** service account
can be linked per publisher.

> Google requires 2-Step Verification on the developer account that owns the
> items before it will accept a publish.

### 3. Enable the APIs

```sh
gcloud config set project tab-reaper

gcloud services enable \
  chromewebstore.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  iam.googleapis.com
```

### 4. Set up workload identity federation

This is what lets GitHub authenticate with no stored key. Create a pool and a
provider that trusts GitHub's OIDC issuer:

```sh
gcloud iam workload-identity-pools create github \
  --location=global \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc chrometabs \
  --location=global \
  --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
  --attribute-condition='assertion.repository == "hoffrocket/chrometabs"'
```

The `--attribute-condition` is the security boundary. Without it, **any** GitHub
repository anywhere could ask Google for a token for this pool. Do not omit it.

Now allow only this repository's workflows to impersonate the service account:

```sh
PROJECT_NUMBER="$(gcloud projects describe tab-reaper --format='value(projectNumber)')"

gcloud iam service-accounts add-iam-policy-binding \
  itemupdater@tab-reaper.iam.gserviceaccount.com \
  --role=roles/iam.serviceAccountTokenCreator \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/hoffrocket/chrometabs"
```

Print the provider resource name for the next step:

```sh
echo "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/chrometabs"
```

#### Tightening it further (optional)

The binding above trusts any workflow in the repository, including one on a
branch. To restrict publishing to tags, bind on `google.subject` instead:

```sh
--member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/subject/repo:hoffrocket/chrometabs:ref:refs/tags/v1.2.3"
```

That's per-tag, so it isn't practical on its own. The `release` environment gate
in step 5 is the more usable control: environment protection rules are enforced
by GitHub before the job starts, so a workflow on a branch can't reach the
credentials without your approval either way.

### 5. Configure the GitHub environment

Create an environment named `release` under **Settings → Environments**:

- Add yourself under **Required reviewers**. This is the approval gate — a tag
  push pauses here until you approve.
- Optionally restrict **Deployment branches and tags** to `v*`.

Then add these four **environment variables** (Settings → Environments →
release → Variables). They are `vars`, not `secrets`: none is sensitive, and
keeping them visible makes failures debuggable.

| Variable | Value |
| --- | --- |
| `CWS_PUBLISHER_ID` | `73a9b026-a5e4-4792-a88c-1c20772bbc2c` |
| `CWS_ITEM_ID` | the 32-character item ID from step 1 |
| `CWS_SERVICE_ACCOUNT` | `itemupdater@tab-reaper.iam.gserviceaccount.com` |
| `CWS_WORKLOAD_IDENTITY_PROVIDER` | the `projects/…/providers/chrometabs` string from step 4 |

### 6. Verify without publishing

Run the **Release** workflow manually from the Actions tab with **dry run**
left checked. It runs the tests, builds the package, authenticates, and reads
the item's current state back from the store — submitting nothing. If the
federation setup or the dashboard link is wrong, this is where you find out.

You can do the same locally, if you have permission to impersonate the account:

```sh
export CWS_PUBLISHER_ID=73a9b026-a5e4-4792-a88c-1c20772bbc2c
export CWS_ITEM_ID=<your item id>
export CWS_ACCESS_TOKEN="$(gcloud auth print-access-token \
  --impersonate-service-account=itemupdater@tab-reaper.iam.gserviceaccount.com \
  --scopes=https://www.googleapis.com/auth/chromewebstore)"

node scripts/publish.js --check-auth
```

## Releasing

1. **Bump the version in `extension/manifest.json`.** The store rejects an
   upload whose version isn't higher than the published one.
2. Commit, then tag and push:

   ```sh
   git commit -am "Release v0.2.0"
   git tag v0.2.0
   git push origin master --tags
   ```

3. The workflow runs the full suite, checks the tag against the manifest, and
   then waits for your approval on the `release` environment.
4. Approve it. The package is uploaded and submitted; it goes live once Google's
   review passes.
5. **Once it's live, confirm what shipped is what you tagged:**

   ```sh
   node scripts/verify-provenance.js --item "$CWS_ITEM_ID" --ref v0.2.0
   ```

   This is worth doing on every release, not just for outsiders' benefit — it is
   the only check that looks at what the store is actually serving, rather than
   at what was sent. See [`provenance.md`](provenance.md).

The tag and `extension/manifest.json` must agree, or the run fails before
anything is sent. The manifest is the source of truth — it's what the store
versions releases by — so the tag has to match it.

## How the workflow is put together

`.github/workflows/release.yml` has two jobs, split deliberately:

- **`verify`** runs the tests, builds the package, and signs its build
  attestation. It holds **no store credentials** and cannot authenticate to
  Google. This is also where every GitHub-authored action runs (`checkout`,
  `setup-node`, `cache`, `upload-artifact`, `attest-build-provenance`).
- **`publish`** requests the OIDC token and talks to the store. It runs only
  after `verify` passes and only after the environment gate is approved. It
  rebuilds the package and refuses to continue unless the digest matches the one
  `verify` attested, so what ships is always what was attested.

`verify` does hold `id-token: write` and `attestations: write`, for signing the
attestation. Neither grants anything towards Google: attestation identities come
from Sigstore, and that job has no federation binding. Attesting there rather
than in `publish` keeps the credential-bearing job free of any action that
handles keys. See [`provenance.md`](provenance.md).

`scripts/publish.js` does the work in plain `fetch` calls:

1. Ask the Actions runner for an OIDC token (`ACTIONS_ID_TOKEN_REQUEST_URL`).
2. Exchange it at `sts.googleapis.com` for a federated token.
3. Impersonate the service account via `iamcredentials.googleapis.com`,
   requesting **only** the `chromewebstore` scope and a 10-minute lifetime.
4. `POST` the zip to the upload endpoint (note the `/upload/` path segment —
   the same path without it is metadata-only and won't take the bytes).
5. Poll `:fetchStatus` until the upload settles. Publishing while the store
   still reports `UPLOAD_IN_PROGRESS` can submit the *previous* package.
6. `POST :publish` with `publishType: DEFAULT_PUBLISH`.

Step 5 also checks the version the store reports against the version just
built, and refuses to publish on a mismatch.

**No third-party actions are used anywhere.** Publishing credentials are the
most dangerous thing in this repository, and a third-party action is arbitrary
code with access to the job it runs in. The only actions used are GitHub's own,
and they all run in the job that holds nothing.

`attest-build-provenance` is the one that came closest to being a judgement
call. It's GitHub's, like `checkout`, but unlike the others it exists to handle
signing — so hand-rolling it was considered and rejected: the attestation is
worth something *because* it chains to GitHub's own OIDC identity, which `run:`
steps cannot reproduce. Keeping it in `verify`, away from the store credentials,
is the mitigation.

## Security model

What protects the publish capability, roughly in order of importance:

- **No stored credential.** Tokens are minted per run and expire in ten
  minutes. There is nothing in GitHub to steal, and nothing to rotate.
- **Scoped impersonation.** The access token carries only
  `https://www.googleapis.com/auth/chromewebstore` — not `cloud-platform` —
  so a leaked token cannot touch the rest of the GCP project.
- **Repository-bound federation.** The attribute condition and the IAM binding
  both name `hoffrocket/chrometabs`; another repository's OIDC token is
  rejected by Google.
- **Human approval.** The `release` environment requires a reviewer, so a tag
  push alone cannot publish.
- **Least privilege in `verify`.** The job that runs tests and builds cannot
  authenticate at all.
- **An explicit file allowlist.** `scripts/package.js` ships a fixed list of
  files rather than walking the tree with exclusions, so a stray local file
  cannot end up published. `test/unit/package.test.js` asserts the archive
  contains exactly that list and nothing else.
- **Detection, not just prevention.** Everything above is preventive, and
  preventive controls fail silently. `scripts/verify-provenance.js` checks the
  published extension against the source after the fact, and anyone can run it —
  so a compromise that got past all of this is still discoverable by a third
  party.

Rotating access, if you ever need to: delete the IAM policy binding from step 4.
That revokes the workflow's access immediately, without touching the service
account or the store listing.

## Troubleshooting

**`Permission 'iam.serviceAccounts.getAccessToken' denied`** — the binding in
step 4 is missing or its `principalSet` doesn't match. Check the project
*number* (not ID) and that the repository in the member string is exact.

**`Unable to acquire impersonated credentials` / invalid subject token** — the
attribute condition rejected the token. Confirm `--attribute-mapping` includes
`attribute.repository=assertion.repository` and that the condition names this
repository.

**`The caller does not have permission` from the store API** — the service
account isn't linked in the dashboard's **Account** section (step 2), or
`CWS_PUBLISHER_ID` is wrong. Remember only one service account can be linked.

**`Invalid manifest version` / version not higher** — bump
`extension/manifest.json`. The store refuses a re-upload of a version it
already has.

**`Item not found`** — `CWS_ITEM_ID` is wrong, or the item was never created by
hand (see [What the API cannot do](#what-the-api-cannot-do)).

**Store listing incomplete** — fill in the **Store listing** and **Privacy
practices** tabs in the dashboard. The API can't supply them.

**`id-token: write` errors** — the `permissions` block must be on the job that
runs the publish script; a workflow-level `contents: read` alone won't do.
