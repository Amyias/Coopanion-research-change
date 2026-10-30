/**
 * The update check and the download over Node's https instead of Electron's network stack. Chromium's
 * connections to github.com time out on machines where something intercepts TLS for programs that are
 * not browsers (a security product, for one); Node reaches the same hosts, so the work happens here and
 * only the install is handed back to the app.
 *
 * The returned object is the surface `manageUpdates` (updater.cjs) drives: checkForUpdates,
 * downloadUpdate, quitAndInstall. A release is the repository's latest one; its `latest.yml` asset
 * carries the installer's name, size and sha512, and the download is checked against all three.
 */
const { createHash } = require('node:crypto');
const { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { get: httpsGet } = require('node:https');
const { get: httpGet } = require('node:http');

const USER_AGENT = 'coopanion-updater';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

/** The repository and the cache directory name `electron-builder` wrote into `app-update.yml`. */
function releaseSource(file) {
  const fallback = { owner: 'Amyias', repo: 'Coopanion-research-change', cacheDirName: 'coopanion-updater' };
  if (!existsSync(file)) return fallback;
  const read = (key) => new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'm').exec(readFileSync(file, 'utf8'))?.[1] ?? null;
  return {
    owner: read('owner') ?? fallback.owner,
    repo: read('repo') ?? fallback.repo,
    cacheDirName: read('updaterCacheDirName') ?? fallback.cacheDirName,
  };
}

/** `1.2.10` above `1.2.9`; an unparsable side never counts as newer. */
function isNewer(candidate, current) {
  const parts = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
    return match ? match.slice(1).map(Number) : null;
  };
  const left = parts(candidate);
  const right = parts(current);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

/** The fields of `latest.yml` this updater reads; the first file is the setup it downloads. */
function channelInfo(text) {
  const version = /^version:\s*(\S+)\s*$/m.exec(text)?.[1];
  const url = /^\s*-\s*url:\s*(\S+)\s*$/m.exec(text)?.[1];
  const sha512 = /^\s*sha512:\s*(\S+)\s*$/m.exec(text)?.[1];
  const size = Number(/^\s*size:\s*(\d+)\s*$/m.exec(text)?.[1]);
  if (!version || !url || !sha512 || !Number.isInteger(size)) throw new Error('latest.yml is not usable');
  return { version, url, sha512, size };
}

/** A cancellation handle with the shape `manageUpdates` expects. */
function cancellationToken() {
  const listeners = [];
  const token = {
    cancelled: false,
    cancel() {
      token.cancelled = true;
      for (const listener of listeners.splice(0)) listener();
    },
    onCancel(listener) {
      if (token.cancelled) listener();
      else listeners.push(listener);
    },
  };
  return token;
}

/** One GET, following redirects; the caller reads the stream. */
function request(url, token, redirects = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    if (token?.cancelled) { reject(new Error('cancelled')); return; }
    const client = url.startsWith('https:') ? httpsGet : httpGet;
    const req = client(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(request(new URL(res.headers.location, url).href, token, redirects - 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`${url} -> HTTP ${status}`));
        return;
      }
      resolve(res);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`${url} timed out`)));
    req.on('error', reject);
    token?.onCancel(() => req.destroy(new Error('cancelled')));
  });
}

async function requestText(url, token) {
  const res = await request(url, token);
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function requestJson(url, token) {
  return JSON.parse(await requestText(url, token));
}

/** Streams `url` into `file.partial` with its hash; a cancelled or failed transfer leaves nothing behind. */
async function downloadTo(url, file, token) {
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  const hash = createHash('sha512');
  const res = await request(url, token);
  const out = createWriteStream(partial);
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      res.on('data', (chunk) => {
        size += chunk.length;
        hash.update(chunk);
        if (!out.write(chunk)) res.pause();
      });
      out.on('drain', () => res.resume());
      res.on('end', resolve);
      res.on('error', reject);
      out.on('error', reject);
      token?.onCancel(() => { res.destroy(new Error('cancelled')); reject(new Error('cancelled')); });
    });
  } finally {
    await new Promise((done) => out.end(done));
  }
  if (token?.cancelled) { rmSync(partial, { force: true }); throw new Error('cancelled'); }
  return { file: partial, size, sha512: hash.digest('base64') };
}

/**
 * The updater object `manageUpdates` drives. `log` writes one line to `updater.log`; `spawn` is
 * `child_process.spawn`, injected so a test can read the install command instead of running it.
 */
function createNodeUpdater(options) {
  const {
    owner, repo, currentVersion, cacheDir, installDir,
    log = () => {}, spawn,
    releaseApi = `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
  } = options;
  let lastCheck = null;
  let ready = null;

  const checkForUpdates = async () => {
    const release = await requestJson(releaseApi, null);
    const tag = String(release.tag_name ?? '').replace(/^v/, '');
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const channelAsset = assets.find((asset) => asset.name === 'latest.yml');
    if (!channelAsset) throw new Error('the latest release has no latest.yml');
    const channel = channelInfo(await requestText(channelAsset.browser_download_url, null));
    log('info', `latest release ${tag || channel.version}, latest.yml ${channel.version}`);
    if (!isNewer(channel.version, currentVersion)) {
      lastCheck = null;
      return { isUpdateAvailable: false, updateInfo: { version: currentVersion } };
    }
    const installer = assets.find((asset) => asset.name === channel.url);
    if (!installer) throw new Error(`the latest release has no ${channel.url}`);
    const result = {
      isUpdateAvailable: true,
      updateInfo: { version: channel.version, name: channel.url, url: installer.browser_download_url, sha512: channel.sha512, size: channel.size },
      cancellationToken: cancellationToken(),
    };
    lastCheck = result;
    return result;
  };

  const downloadUpdate = async (token) => {
    if (!lastCheck?.isUpdateAvailable) throw new Error('no update was checked for');
    const { version, name, url, sha512, size } = lastCheck.updateInfo;
    const pendingDir = join(cacheDir, 'pending');
    mkdirSync(pendingDir, { recursive: true });
    const file = join(pendingDir, name);
    log('info', `downloading ${version} from ${url}`);
    const got = await downloadTo(url, file, token);
    if (got.size !== size) { rmSync(got.file, { force: true }); throw new Error(`downloaded ${got.size} bytes, expected ${size}`); }
    if (got.sha512 !== sha512) { rmSync(got.file, { force: true }); throw new Error('downloaded file does not match latest.yml sha512'); }
    renameSync(got.file, file);
    ready = { file, version };
    log('info', `${version} downloaded to ${file}`);
    return [file];
  };

  const quitAndInstall = (silent, runAfter) => {
    if (!ready) return;
    const args = ['--updated', ...(silent ? ['/S'] : []), ...(runAfter ? ['--force-run'] : []), `/D=${installDir}`];
    log('info', `installing ${ready.version}: ${ready.file} ${args.join(' ')}`);
    spawn(ready.file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    ready = null;
  };

  return { autoDownload: false, autoInstallOnAppQuit: false, checkForUpdates, downloadUpdate, quitAndInstall };
}

module.exports = { createNodeUpdater, channelInfo, isNewer, releaseSource, cancellationToken, downloadTo, request, requestJson, requestText, MAX_REDIRECTS };
