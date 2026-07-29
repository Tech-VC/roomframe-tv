import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discoverGithubUpdate,
  downloadGithubUpdate,
} from '../src/github-update-poller.mjs';
import {
  normalizeGithubRepository,
  normalizeUpdateChannel,
} from '../src/update-source.mjs';

const repository = 'example/roomframe';
const assetUrl = 'https://api.github.com/repos/example/roomframe/releases/assets/202';

const release = ({
  id = 101,
  prerelease = false,
  tagName = null,
  assets = [{
    id: 202,
    name: 'roomframe-tv-v0.4.0.rfupdate',
    state: 'uploaded',
    size: 6,
    digest: `sha256:${crypto.createHash('sha256').update('bundle').digest('hex')}`,
    updated_at: '2026-07-28T12:00:00Z',
    url: assetUrl,
  }],
} = {}) => ({
  id,
  tag_name: tagName ?? (prerelease ? 'v0.4.0-rc.1' : 'v0.4.0'),
  draft: false,
  prerelease,
  published_at: '2026-07-28T11:00:00Z',
  assets,
});

test('la découverte GitHub respecte le canal stable et les ETag', async () => {
  let requestHeaders;
  const discovered = await discoverGithubUpdate({
    repository,
    channel: 'stable',
    etag: '"previous"',
    maximumBytes: 1024,
    version: '0.3.0',
    timeoutMs: 5_000,
    fetchImpl: async (_url, options) => {
      requestHeaders = options.headers;
      return new Response(JSON.stringify([
        release({ id: 100, prerelease: true }),
        release(),
      ]), {
        status: 200,
        headers: { etag: '"next"', 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(requestHeaders['If-None-Match'], '"previous"');
  assert.equal(requestHeaders['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(discovered.status, 'candidate');
  assert.equal(discovered.etag, '"next"');
  assert.equal(discovered.candidate.release.id, 101);
  assert.equal(discovered.candidate.asset.id, 202);

  const unchanged = await discoverGithubUpdate({
    repository,
    channel: 'stable',
    etag: '"next"',
    maximumBytes: 1024,
    version: '0.3.0',
    timeoutMs: 5_000,
    fetchImpl: async () => new Response(null, {
      status: 304,
      headers: { etag: '"next"' },
    }),
  });
  assert.deepEqual(unchanged, {
    status: 'not-modified',
    etag: '"next"',
    candidate: null,
  });
});

test('les dépôts, canaux et assets GitHub ambigus sont refusés', async () => {
  assert.equal(normalizeGithubRepository('Owner/RoomFrame'), 'owner/roomframe');
  assert.equal(normalizeUpdateChannel('PREVIEW'), 'preview');
  assert.throws(() => normalizeGithubRepository('https://github.com/a/b'));
  assert.throws(() => normalizeGithubRepository('owner/../repo'));
  assert.throws(() => normalizeUpdateChannel('nightly'));

  await assert.rejects(
    discoverGithubUpdate({
      repository,
      channel: 'preview',
      maximumBytes: 1024,
      version: '0.3.0',
      timeoutMs: 5_000,
      fetchImpl: async () => new Response(JSON.stringify([
        release({
          assets: [
            release().assets[0],
            { ...release().assets[0], id: 203, name: 'other.rfupdate' },
          ],
        }),
      ]), { status: 200 }),
    }),
    /ambiguous_rfupdate_assets/,
  );
  await assert.rejects(
    discoverGithubUpdate({
      repository,
      channel: 'stable',
      maximumBytes: 1024,
      version: '0.3.0',
      timeoutMs: 5_000,
      fetchImpl: async () => new Response(JSON.stringify([
        release({ tagName: 'latest' }),
      ]), { status: 200 }),
    }),
    /invalid_github_release_tag/,
  );
});

test('le téléchargement suit uniquement les redirections GitHub et contrôle taille et hash', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'roomframe-github-download-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const candidate = {
    release: { id: 101 },
    asset: {
      id: 202,
      name: 'roomframe-tv-v0.4.0.rfupdate',
      size: 6,
      digest: crypto.createHash('sha256').update('bundle').digest('hex'),
      updatedAt: '2026-07-28T12:00:00.000Z',
      apiUrl: assetUrl,
    },
  };
  let calls = 0;
  const downloaded = await downloadGithubUpdate({
    candidate,
    repository,
    processingDir: temporary,
    maximumBytes: 1024,
    reserveBytes: 0,
    version: '0.3.0',
    timeoutMs: 5_000,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://release-assets.githubusercontent.com/github-production-release-asset/file',
          },
        });
      }
      return new Response('bundle', {
        status: 200,
        headers: { 'content-length': '6' },
      });
    },
  });
  assert.equal(calls, 2);
  assert.equal(await readFile(downloaded.file, 'utf8'), 'bundle');

  await assert.rejects(
    downloadGithubUpdate({
      candidate,
      repository,
      processingDir: temporary,
      maximumBytes: 1024,
      reserveBytes: 0,
      version: '0.3.0',
      timeoutMs: 5_000,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.invalid/release.rfupdate' },
      }),
    }),
    /github_redirect_not_allowed/,
  );
});
