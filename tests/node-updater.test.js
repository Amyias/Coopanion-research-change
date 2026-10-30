/**
 * The Node-backed update check, download and install command: a real local release server, a real
 * temporary cache, and a spawn that records instead of installing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createNodeUpdater, channelInfo, isNewer, releaseSource, cancellationToken } = require('../app/node-updater.cjs');
const { manageUpdates } = require('../app/updater.cjs');

const installers = [];
const closing = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
  installers.splice(0);
});

/**
 * A release answer, and optionally its latest.yml and installer, served from a real local server.
 * `digest: false` models an older API answer without digests, where latest.yml has to be read.
 */
async function releaseServer(options = {}) {
  const version = options.version ?? '1.1.0';
  const body = options.body ?? Buffer.from('installer-bytes');
  const name = `Coopanion-Setup-${version}.exe`;
  const sha512 = createHash('sha512').update(body).digest('base64');
  const sha256 = options.digest ?? createHash('sha256').update(body).digest('hex');
  const withDigest = options.digest !== false;
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/api/latest') {
      const installer = { name, size: body.length, browser_download_url: `${base}/installer` };
      if (withDigest) installer.digest = `sha256:${sha256}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: `v${version}`,
        assets: [{ name: 'latest.yml', browser_download_url: `${base}/latest.yml` }, installer],
      }));
      return;
    }
    if (req.url === '/latest.yml') {
      res.writeHead(200, { 'Content-Type': 'text/yaml' });
      res.end(`version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${body.length}\npath: ${name}\n`);
      return;
    }
    if (req.url === '/installer' && options.redirect) {
      res.writeHead(302, { Location: '/installer-real' });
      res.end();
      return;
    }
    if (req.url === '/installer' || req.url === '/installer-real') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  closing.push(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, apiBase: `${base}/api/latest`, body, sha256, name };
}

let cache;
function updaterFor(base, apiBase, currentVersion = '1.0.0', extra = {}) {
  cache = mkdtempSync(join(tmpdir(), 'coo-node-updater-'));
  closing.push(() => rmSync(cache, { recursive: true, force: true }));
  return createNodeUpdater({
    owner: 'Amyias', repo: 'coopanion', currentVersion,
    cacheDir: cache, installDir: 'D:\\Coopanion', releaseApi: apiBase,
    spawn: (file, args) => { installers.push({ file, args }); return { unref() {} }; },
    ...extra,
  });
}

describe('the Node updater', () => {
  it('compares released versions', () => {
    expect(isNewer('1.2.10', '1.2.9')).toBe(true);
    expect(isNewer('v0.2.17', '0.2.16')).toBe(true);
    expect(isNewer('1.2.9', '1.2.10')).toBe(false);
    expect(isNewer('1.2.9', '1.2.9')).toBe(false);
    expect(isNewer('nightly', '1.2.9')).toBe(false);
  });

  it('reads a release channel file, for an answer that states no digest', () => {
    expect(channelInfo('version: 0.2.17\nfiles:\n  - url: Setup.exe\n    sha512: abc=\n    size: 42\n')).toEqual({ version: '0.2.17', url: 'Setup.exe', sha512: 'abc=', size: 42 });
    expect(() => channelInfo('version: 0.2.17\n')).toThrow('latest.yml is not usable');
  });

  it('reads the repository and cache name from app-update.yml, falling back when it is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-app-update-'));
    closing.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'app-update.yml');
    expect(releaseSource(file)).toMatchObject({ owner: 'Amyias', repo: 'Coopanion-research-change' });
    require('node:fs').writeFileSync(file, 'owner: someone\nrepo: something\nprovider: github\nupdaterCacheDirName: my-updater\n');
    expect(releaseSource(file)).toEqual({ owner: 'someone', repo: 'something', cacheDirName: 'my-updater' });
  });

  it('writes what it does, so a check that fails cannot pass unnoticed', async () => {
    const server = await releaseServer();
    const lines = [];
    const updater = updaterFor(server.base, server.apiBase, '1.0.0', { log: (level, message) => lines.push(`${level} ${message}`) });
    await updater.checkForUpdates();
    expect(lines[0]).toMatch(/^info checking for update as 1\.0\.0$/);
    expect(lines.some((line) => line.includes('latest release 1.1.0, Coopanion-Setup-1.1.0.exe'))).toBe(true);
  });

  it('takes version, size and sha256 from the release answer, without fetching latest.yml', async () => {
    const server = await releaseServer();
    const updater = updaterFor(server.base, server.apiBase);
    const result = await updater.checkForUpdates();
    expect(result.isUpdateAvailable).toBe(true);
    expect(result.updateInfo).toMatchObject({ version: '1.1.0', name: server.name, size: server.body.length, algorithm: 'sha256', expected: server.sha256 });
    const [file] = await updater.downloadUpdate(result.cancellationToken);
    expect(readFileSync(file)).toEqual(server.body);
    expect(file).toBe(join(cache, 'pending', server.name));
  });

  it('falls back to latest.yml when the answer states no digest', async () => {
    const server = await releaseServer({ digest: false });
    const updater = updaterFor(server.base, server.apiBase);
    const result = await updater.checkForUpdates();
    expect(result.updateInfo.algorithm).toBe('sha512');
    const [file] = await updater.downloadUpdate(result.cancellationToken);
    expect(readFileSync(file)).toEqual(server.body);
  });

  it('follows the redirect the asset host answers with', async () => {
    const server = await releaseServer({ redirect: true });
    const updater = updaterFor(server.base, server.apiBase);
    await updater.checkForUpdates();
    const [file] = await updater.downloadUpdate(cancellationToken());
    expect(readFileSync(file)).toEqual(server.body);
  });

  it('says nothing is available when the release is the installed version', async () => {
    const server = await releaseServer({ version: '1.0.0' });
    const updater = updaterFor(server.base, server.apiBase, '1.0.0');
    expect((await updater.checkForUpdates()).isUpdateAvailable).toBe(false);
    await expect(updater.downloadUpdate(cancellationToken())).rejects.toThrow('no update was checked for');
  });

  it('refuses a download that does not match the stated sha and leaves no file behind', async () => {
    const server = await releaseServer({ digest: 'not-the-hash' });
    const updater = updaterFor(server.base, server.apiBase);
    await updater.checkForUpdates();
    await expect(updater.downloadUpdate(cancellationToken())).rejects.toThrow('sha');
    const pending = join(cache, 'pending');
    expect(existsSync(pending) ? readdirSync(pending) : []).toEqual([]);
  });

  it('stops a cancelled download without leaving a partial file', async () => {
    const server = await releaseServer({ body: Buffer.alloc(2 * 1024 * 1024, 7) });
    const updater = updaterFor(server.base, server.apiBase);
    const result = await updater.checkForUpdates();
    result.cancellationToken.cancel();
    await expect(updater.downloadUpdate(result.cancellationToken)).rejects.toThrow('cancelled');
    const pending = join(cache, 'pending');
    expect(existsSync(pending) ? readdirSync(pending) : []).toEqual([]);
  });

  it('installs silently into the running program directory, restarting when asked', async () => {
    const server = await releaseServer();
    const updater = updaterFor(server.base, server.apiBase);
    await updater.checkForUpdates();
    await updater.downloadUpdate(cancellationToken());
    updater.quitAndInstall(true, true);
    expect(installers).toEqual([{ file: join(cache, 'pending', server.name), args: ['/S', '--force-run', '/D=D:\\Coopanion'] }]);
  });

  it('logs a check that cannot reach the release, instead of failing silently', async () => {
    const lines = [];
    const updater = createNodeUpdater({
      owner: 'Amyias', repo: 'coopanion', currentVersion: '1.0.0',
      cacheDir: mkdtempSync(join(tmpdir(), 'coo-fail-')), installDir: 'D:\\Coopanion',
      releaseApi: 'http://127.0.0.1:1/api/latest',
      log: (level, message) => lines.push(`${level} ${message}`),
      spawn: () => ({ unref() {} }),
    });
    await expect(updater.checkForUpdates()).rejects.toThrow();
    expect(lines.some((line) => line.startsWith('error check failed:'))).toBe(true);
  });
});

describe('the Node updater behind manageUpdates', () => {
  it('drives downloading to ready and installs once, like the Electron path does', async () => {
    const server = await releaseServer();
    const updater = updaterFor(server.base, server.apiBase);
    const steps = [];
    const controller = manageUpdates(updater, { enabled: true, tell: (step) => steps.push(step) });
    await expect.poll(() => controller.hasUpdate()).toBe(true);
    expect(steps.map((step) => step?.phase)).toEqual(['downloading', 'ready']);
    expect(controller.installOnQuit(true)).toBe(true);
    expect(installers).toHaveLength(1);
    expect(controller.installOnQuit()).toBe(false);
    controller.setEnabled(false);
  });
});
