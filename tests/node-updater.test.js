/**
 * The Node-backed update check, download and install command: a real local release server, a real
 * temporary cache, and a spawn that records instead of installing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** A release feed, its latest.yml and the installer, served from a real local server. */
async function releaseServer(options = {}) {
  const version = options.version ?? '1.1.0';
  const body = options.body ?? Buffer.from('installer-bytes');
  const sha512 = options.sha512 ?? createHash('sha512').update(body).digest('base64');
  const name = `Coopanion-Setup-${version}.exe`;
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/api/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: `v${version}`,
        assets: [
          { name: 'latest.yml', browser_download_url: `${base}/latest.yml` },
          { name, browser_download_url: `${base}/installer` },
        ],
      }));
      return;
    }
    if (req.url === '/latest.yml') {
      res.writeHead(200, { 'Content-Type': 'text/yaml' });
      res.end(`version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${body.length}\npath: ${name}\nsha512: ${sha512}\n`);
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
  return { base, apiBase: `${base}/api/latest`, body, sha512, name };
}

let cache;
function updaterFor(base, apiBase, currentVersion = '1.0.0') {
  cache = mkdtempSync(join(tmpdir(), 'coo-node-updater-'));
  closing.push(() => rmSync(cache, { recursive: true, force: true }));
  return createNodeUpdater({
    owner: 'Amyias', repo: 'coopanion', currentVersion,
    cacheDir: cache, installDir: 'D:\\Coopanion', releaseApi: apiBase,
    spawn: (file, args) => { installers.push({ file, args }); return { unref() {} }; },
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

  it('reads the release channel file', () => {
    expect(channelInfo('version: 0.2.17\nfiles:\n  - url: Setup.exe\n    sha512: abc=\n    size: 42\n')).toEqual({ version: '0.2.17', url: 'Setup.exe', sha512: 'abc=', size: 42 });
    expect(() => channelInfo('version: 0.2.17\n')).toThrow('latest.yml is not usable');
  });

  it('reads the repository and cache name from app-update.yml, falling back when it is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-app-update-'));
    closing.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'app-update.yml');
    expect(releaseSource(file)).toMatchObject({ owner: 'Amyias', repo: 'Coopanion-research-change' });
    writeFileSync(file, 'owner: someone\nrepo: something\nprovider: github\nupdaterCacheDirName: my-updater\n');
    expect(releaseSource(file)).toEqual({ owner: 'someone', repo: 'something', cacheDirName: 'my-updater' });
  });

  it('reports a newer release and downloads exactly the installer the channel file describes', async () => {
    const server = await releaseServer();
    const updater = updaterFor(server.base, server.apiBase);
    const result = await updater.checkForUpdates();
    expect(result.isUpdateAvailable).toBe(true);
    expect(result.updateInfo).toMatchObject({ version: '1.1.0', sha512: server.sha512, size: server.body.length });
    const [file] = await updater.downloadUpdate(result.cancellationToken);
    expect(readFileSync(file)).toEqual(server.body);
    expect(file).toBe(join(cache, 'pending', server.name));
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

  it('refuses a download that does not match the channel file and leaves no file behind', async () => {
    const server = await releaseServer({ sha512: 'not-the-hash' });
    const updater = updaterFor(server.base, server.apiBase);
    await updater.checkForUpdates();
    await expect(updater.downloadUpdate(cancellationToken())).rejects.toThrow('sha512');
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
    expect(installers).toEqual([{ file: join(cache, 'pending', server.name), args: ['--updated', '/S', '--force-run', '/D=D:\\Coopanion'] }]);
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
