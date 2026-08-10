/**
 * Publish the packaged extension to the Chrome Web Store: `npm run publish:store`.
 *
 * Uses the Chrome Web Store API v2, which supports service accounts (v1 did
 * not — it required a refresh token minted from a human account). No
 * third-party code: authentication, upload and publish are plain HTTPS calls
 * via Node's global fetch.
 *
 * Two things the API cannot do, both by design on Google's side:
 *
 *   1. It cannot create an item. `media.upload` targets an *existing* item, so
 *      version 1 has to be uploaded through the dashboard by hand. After that
 *      this script handles every update.
 *   2. It cannot bypass review. `:publish` submits; going live still waits on
 *      Google's review queue.
 *
 * Credentials, in order of preference:
 *
 *   CWS_ACCESS_TOKEN         An access token you already hold. Used as-is.
 *                            For local runs:
 *                              gcloud auth print-access-token \
 *                                --impersonate-service-account=$CWS_SERVICE_ACCOUNT \
 *                                --scopes=https://www.googleapis.com/auth/chromewebstore
 *   Workload identity        In GitHub Actions, with no stored credential:
 *   federation               GitHub mints an OIDC token, Google's STS trades it
 *                            for a federated token, and that impersonates the
 *                            service account. Needs CWS_WORKLOAD_IDENTITY_PROVIDER
 *                            and CWS_SERVICE_ACCOUNT.
 *
 * A service account JSON key is deliberately not supported. It would be a
 * long-lived publish credential sitting in GitHub, and federation removes the
 * need for one.
 */
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { buildPackage } from './package.js';

const CHROME_WEBSTORE_SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const STS_ENDPOINT = 'https://sts.googleapis.com/v1/token';
const IAM_CREDENTIALS_HOST = 'https://iamcredentials.googleapis.com';
const STORE_HOST = 'https://chromewebstore.googleapis.com';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/**
 * Read an HTTP error without leaking anything sensitive.
 *
 * Google's error bodies are safe to surface and usually name the exact
 * misconfiguration, which matters a lot for the federation setup. The request
 * we sent is never echoed, because for the token calls it contains the
 * credential itself.
 */
async function readError(response, what) {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error?.message ?? parsed.error_description ?? text;
    } catch {
      detail = text;
    }
  } catch {
    detail = '(no response body)';
  }
  return new Error(`${what} failed: HTTP ${response.status} ${response.statusText}\n${detail}`);
}

/** Ask the Actions runner for an OIDC token proving which workflow this is. */
async function fetchGitHubOidcToken(audience) {
  const url = required('ACTIONS_ID_TOKEN_REQUEST_URL');
  const token = required('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
  // The runner URL already carries a query string, hence & rather than ?.
  const response = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw await readError(response, 'Requesting GitHub OIDC token');
  const { value } = await response.json();
  if (!value) throw new Error('GitHub OIDC response contained no token');
  return value;
}

/** Trade the OIDC token for a federated Google access token. */
async function exchangeForFederatedToken({ provider, oidcToken }) {
  const response = await fetch(STS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: `//iam.googleapis.com/${provider}`,
      subjectToken: oidcToken,
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      // The exchange itself only issues cloud-platform; the narrower
      // chromewebstore scope is requested on the impersonation call below.
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    }),
  });
  if (!response.ok) throw await readError(response, 'STS token exchange');
  const { access_token: accessToken } = await response.json();
  if (!accessToken) throw new Error('STS exchange returned no access token');
  return accessToken;
}

/** Impersonate the service account, scoped to the Web Store only. */
async function impersonate({ federatedToken, serviceAccount }) {
  const url =
    `${IAM_CREDENTIALS_HOST}/v1/projects/-/serviceAccounts/` +
    `${encodeURIComponent(serviceAccount)}:generateAccessToken`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${federatedToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ scope: [CHROME_WEBSTORE_SCOPE], lifetime: '600s' }),
  });
  if (!response.ok) throw await readError(response, 'Service account impersonation');
  const { accessToken } = await response.json();
  if (!accessToken) throw new Error('Impersonation returned no access token');
  return accessToken;
}

async function resolveAccessToken() {
  if (process.env.CWS_ACCESS_TOKEN) {
    console.log('Auth: using CWS_ACCESS_TOKEN from the environment.');
    return process.env.CWS_ACCESS_TOKEN;
  }

  const provider = required('CWS_WORKLOAD_IDENTITY_PROVIDER');
  const serviceAccount = required('CWS_SERVICE_ACCOUNT');
  console.log(`Auth: workload identity federation as ${serviceAccount}`);

  const oidcToken = await fetchGitHubOidcToken(`//iam.googleapis.com/${provider}`);
  const federatedToken = await exchangeForFederatedToken({ provider, oidcToken });
  return impersonate({ federatedToken, serviceAccount });
}

async function uploadPackage({ accessToken, publisherId, itemId, zipPath }) {
  const body = await fs.readFile(zipPath);
  const name = `publishers/${publisherId}/items/${itemId}`;
  // Note the /upload/ segment: the same path without it is the metadata-only
  // endpoint and will not accept the package bytes.
  const response = await fetch(`${STORE_HOST}/upload/v2/${name}:upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/zip',
      'Content-Length': String(body.length),
    },
    body,
  });
  if (!response.ok) throw await readError(response, 'Package upload');
  return response.json();
}

async function fetchStatus({ accessToken, publisherId, itemId }) {
  const name = `publishers/${publisherId}/items/${itemId}`;
  const response = await fetch(`${STORE_HOST}/v2/${name}:fetchStatus`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw await readError(response, 'Fetching item status');
  return response.json();
}

/**
 * Wait out an upload the store chose to process asynchronously.
 *
 * Normally `media.upload` is synchronous and comes back SUCCEEDED, in which
 * case the caller skips this entirely. The store may instead return
 * IN_PROGRESS and finish afterwards; publishing during that window fails, or
 * worse, publishes the previous package — so settle the upload before
 * submitting.
 *
 * The state lives in `lastAsyncUploadState`, which fetchStatus only sets when
 * there has been an async upload in the past 24 hours. An absent value
 * therefore means "nothing in flight", not "still working", so anything other
 * than an explicit IN_PROGRESS ends the wait.
 *
 * The deadline stays inside the 600s impersonation token's lifetime; polling
 * past expiry would surface a confusing 401 instead of a timeout.
 */
async function waitForUpload({ accessToken, publisherId, itemId }) {
  const deadline = Date.now() + 8 * 60_000;
  let delay = 5_000;

  for (;;) {
    const status = await fetchStatus({ accessToken, publisherId, itemId });
    const state = status.lastAsyncUploadState;

    if (state === 'FAILED') {
      throw new Error('The store reports the upload failed; not publishing.');
    }
    if (state !== 'IN_PROGRESS') return status;

    if (Date.now() > deadline) {
      throw new Error('Upload still processing after 8 minutes; not publishing.');
    }
    console.log(`Upload still processing; retrying in ${delay / 1000}s.`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 30_000);
  }
}

/**
 * Every package version the store currently reports for an item.
 *
 * crxVersion is nested per release channel under the published and submitted
 * revisions, so there can be more than one (a live version plus one awaiting
 * review, say). Returned as a list rather than picking one, because which
 * revision holds a freshly uploaded draft depends on whether anything has been
 * submitted since the last publish.
 */
function storeVersions(status) {
  return [status.publishedItemRevisionStatus, status.submittedItemRevisionStatus]
    .flatMap((revision) => revision?.distributionChannels ?? [])
    .map((channel) => channel.crxVersion)
    .filter(Boolean);
}

async function publishItem({ accessToken, publisherId, itemId }) {
  const name = `publishers/${publisherId}/items/${itemId}`;
  const response = await fetch(`${STORE_HOST}/v2/${name}:publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    // DEFAULT_PUBLISH goes live once review passes. blockOnWarnings is left
    // false: warnings are reported below but should not strand an approved
    // build unpublished.
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
  });
  if (!response.ok) throw await readError(response, 'Publish');
  return response.json();
}

async function main() {
  const publisherId = required('CWS_PUBLISHER_ID');
  const itemId = required('CWS_ITEM_ID');
  const dryRun = process.argv.includes('--dry-run');
  // Authenticate and read the item back, but change nothing. This exercises
  // every part of the setup that is easy to get wrong — the federation
  // binding, the service account link in the dashboard, the publisher and item
  // IDs — without submitting anything, so it is safe to run at any time.
  const checkAuth = process.argv.includes('--check-auth');

  const pkg = await buildPackage();

  // Guard against the tag and the manifest disagreeing. The store versions
  // releases by the manifest, so a mismatch means the tag points at something
  // other than what users receive.
  const expectedVersion = process.env.CWS_EXPECT_VERSION;
  if (expectedVersion && expectedVersion !== pkg.version) {
    throw new Error(
      `Version mismatch: expected ${expectedVersion} (from the tag) but ` +
        `extension/manifest.json declares ${pkg.version}.`,
    );
  }

  if (dryRun) {
    console.log(`Dry run: built ${pkg.path} (v${pkg.version}); not contacting the store.`);
    return;
  }

  const accessToken = await resolveAccessToken();

  if (checkAuth) {
    const status = await fetchStatus({ accessToken, publisherId, itemId });
    const versions = storeVersions(status);
    console.log('Authentication works and the item is reachable.');
    console.log(`  item:           ${status.itemId ?? itemId}`);
    console.log(`  store versions: ${versions.join(', ') || '(none published yet)'}`);
    console.log(`  published:      ${status.publishedItemRevisionStatus?.state ?? '(not published)'}`);
    console.log(`  submitted:      ${status.submittedItemRevisionStatus?.state ?? '(nothing pending)'}`);
    console.log(`  last upload:    ${status.lastAsyncUploadState ?? '(none in the past 24h)'}`);
    console.log(`  local version:  ${pkg.version}`);
    console.log('\nNothing was uploaded or published.');
    return;
  }

  console.log(`Uploading v${pkg.version} to item ${itemId}…`);
  const upload = await uploadPackage({ accessToken, publisherId, itemId, zipPath: pkg.path });
  const uploadState = upload.uploadState ?? 'unknown';
  console.log(`Upload accepted (state: ${uploadState}).`);

  if (uploadState === 'FAILED') {
    throw new Error('The store rejected the upload; not publishing.');
  }
  // SUCCEEDED means processing is already done, which is the normal case — only
  // an asynchronous upload needs waiting out.
  if (uploadState === 'IN_PROGRESS') {
    await waitForUpload({ accessToken, publisherId, itemId });
    console.log('Upload finished processing.');
  }

  // Look, but do not block. The intent is to catch the store holding a package
  // other than the one just uploaded, but an uploaded draft is not necessarily
  // reported yet: submittedItemRevisionStatus stays unset until something is
  // actually submitted, so "not found here" is expected rather than wrong. The
  // assertion that can be trusted happens after publishing, below.
  const before = storeVersions(await fetchStatus({ accessToken, publisherId, itemId }));
  if (before.length && !before.includes(pkg.version)) {
    console.warn(
      `Note: the store reports ${before.join(', ')} and not v${pkg.version} yet; ` +
        'this is normal for a draft that has not been submitted.',
    );
  }

  const result = await publishItem({ accessToken, publisherId, itemId });
  for (const warning of result.warningInfo?.warnings ?? []) {
    console.warn(`Store warning [${warning.reason}]: ${warning.description}`);
  }
  console.log(`Submitted v${pkg.version} for review (state: ${result.state ?? 'unknown'}).`);

  // Now the version guard can be asserted: the submission exists, so the store
  // reports the version under review. If that is not the version this run
  // built, something else was submitted and the release needs a human.
  const submitted = storeVersions(await fetchStatus({ accessToken, publisherId, itemId }));
  if (submitted.length && !submitted.includes(pkg.version)) {
    throw new Error(
      `Submitted v${pkg.version} but the store reports ${submitted.join(', ')}. ` +
        'Check the dashboard before trusting this release.',
    );
  }

  console.log('It goes live automatically once Google approves it.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nPublish failed: ${error.message}`);
    process.exit(1);
  });
}
