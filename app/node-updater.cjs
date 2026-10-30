/**
 * The update check and the download over Node's https instead of Electron's network stack. Chromium's
 * connections to github.com time out on machines where something intercepts TLS for programs that are
 * not browsers (a security product, for one); Node reaches the same hosts, so the work happens here and
 * only the install is handed back to the app.
 *
 * The release API answers everything the check needs — the version in its tag and, for each asset, its
 * size and sha256 digest — so nothing is fetched from `github.com` before a download is actually due.
 * An older answer without a digest falls back to the release's `latest.yml` (electron-builder's file),
 * which then has to be fetched from the same host.
 *
 * The returned object is the surface `manageUpdates` (updater.cjs) drives: checkForUpdates,
 * downloadUpdate, quitAndInstall.
 */
const { createHash } = require('node:crypto');
const { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { get: httpsGet } = require('node:https');
const { get: httpGet } = require('node:http');

const USER_AGENT = 'coopanion-updater';
/** One metadata request; the download sets its own inactivity timeout on the socket. */
const REQUEST_TIMEOUT_MS = 20_000;
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

/** One GET, following redirects; the caller reads the stream. The whole exchange has a deadline so a
 * stalled connection fails instead of hanging the check. */
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
    deadline(req, REQUEST_TIMEOUT_MS, url, token, reject);
  });
}

/** Fails the request when it has not answered in time, and when it is cancelled. */
function deadline(req, ms, url, token, reject) {
  const timer = setTimeout(() => req.destroy(new Error(`${url} timed out`)), ms);
  req.on('close', () => clearTimeout(timer));
  req.on('error', (error) => { clearTimeout(timer); reject(error); });
  token?.onCancel(() => req.destroy(new Error('cancelled')));
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

/** Streams `url` into `file.partial` while hashing it; a cancelled or failed transfer leaves nothing behind. */
async function downloadTo(url, file, token, algorithm = 'sha512') {
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  const hash = createHash(algorithm);
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
      res.setTimeout(60_000, () => res.destroy(new Error('the download stalled')));
      token?.onCancel(() => { res.destroy(new Error('cancelled')); reject(new Error('cancelled')); });
    });
  } finally {
    await new Promise((done) => out.end(done));
  }
  if (token?.cancelled) { rmSync(partial, { force: true }); throw new Error('cancelled'); }
  return { file: partial, size, digest: algorithm === 'sha256' ? hash.digest('hex') : hash.digest('base64'), algorithm };
}

/**
 * The updater object `manageUpdates` drives. `log` writes one line to `updater.log`; `spawn` is
 * `child_process.spawn`, injected so a test can read the install command instead of running it.
 *
 * @param {{ owner: string, repo: string, currentVersion: string, cacheDir: string, installDir: string,
 *   log?: (level: string, message: string) => void, spawn: typeof import('node:child_process').spawn,
 *   releaseApi?: string }} options
 * @returns {{ checkForUpdates: () => Promise<object>, downloadUpdate: (token?: object) => Promise<string[]>,
 *   quitAndInstall: (silent: boolean, runAfter?: boolean) => void }}
 */
function createNodeUpdater(options) {
  const {
    owner, repo, currentVersion, cacheDir, installDir,
    log = () => {}, spawn,
    releaseApi = `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
  } = options;
  let lastCheck = null;
  let ready = null;

  /** What the download is checked against: the asset's sha256 from the API, or latest.yml's sha512. */
  const verification = async (assets, installer) => {
    const digest = typeof installer.digest === 'string' ? installer.digest.replace(/^sha256:/, '') : '';
    if (digest) return { algorithm: 'sha256', expected: digest };
    const channelAsset = assets.find((asset) => asset.name === 'latest.yml');
    if (!channelAsset) throw new Error('the release states no digest for its installer');
    const channel = channelInfo(await requestText(channelAsset.browser_download_url, null));
    return { algorithm: 'sha512', expected: channel.sha512 };
  };

  const checkForUpdates = async () => {
    log('info', `checking for update as ${currentVersion}`);
    try {
      const release = await requestJson(releaseApi, null);
      const version = String(release.tag_name ?? '').replace(/^v/, '');
      if (!version) throw new Error('the latest release has no tag');
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const installer = assets.find((asset) => /\.exe$/i.test(String(asset.name)) && !String(asset.name).endsWith('.blockmap'));
      if (!installer) throw new Error('the latest release has no installer');
      log('info', `latest release ${version}, ${installer.name} ${installer.size} bytes`);
      if (!isNewer(version, currentVersion)) {
        lastCheck = null;
        return { isUpdateAvailable: false, updateInfo: { version: currentVersion } };
      }
      const check = await verification(assets, installer);
      const result = {
        isUpdateAvailable: true,
        updateInfo: { version, name: installer.name, url: installer.browser_download_url, size: installer.size, ...check },
        cancellationToken: cancellationToken(),
      };
      lastCheck = result;
      return result;
    } catch (error) {
      log('error', `check failed: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  };

  const downloadUpdate = async (token) => {
    if (!lastCheck?.isUpdateAvailable) throw new Error('no update was checked for');
    const { version, name, url, size, algorithm, expected } = lastCheck.updateInfo;
    const pendingDir = join(cacheDir, 'pending');
    mkdirSync(pendingDir, { recursive: true });
    const file = join(pendingDir, name);
    log('info', `downloading ${version} from ${url}`);
    let got;
    try {
      got = await downloadTo(url, file, token, algorithm);
    } catch (error) {
      log('error', `download failed: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
    if (got.size !== size) {
      rmSync(got.file, { force: true });
      throw new Error(`downloaded ${got.size} bytes, expected ${size}`);
    }
    if (got.digest !== expected) {
      rmSync(got.file, { force: true });
      throw new Error(`downloaded file does not match the release sha`);
    }
    renameSync(got.file, file);
    ready = { file, version };
    log('info', `${version} downloaded to ${file}`);
    return [file];
  };

  const quitAndInstall = (silent, runAfter) => {
    if (!ready) return;
    // no `--updated`: this setup aborts (exit 2) when the flag is passed; `/S` plus `--force-run` installs
    // silently into the running program's directory and starts it again.
    const args = [...(silent ? ['/S'] : []), ...(runAfter ? ['--force-run'] : []), `/D=${installDir}`];
    log('info', `installing ${ready.version}: ${ready.file} ${args.join(' ')}`);
    spawn(ready.file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    ready = null;
  };

  return { autoDownload: false, autoInstallOnAppQuit: false, checkForUpdates, downloadUpdate, quitAndInstall };
}

module.exports = { createNodeUpdater, channelInfo, isNewer, releaseSource, cancellationToken };
