import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const github = 'https://api.github.com';
const releaseAsset = 'Framecut-Setup-x64.exe';
const execute = promisify(execFile);

function versionNumbers(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match?.slice(1).map(Number);
}

export function newerVersion(candidate, installed) {
  const next = versionNumbers(candidate);
  const current = versionNumbers(installed);
  if (!next || !current) return false;
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== current[i]) return next[i] > current[i];
  }
  return false;
}

async function githubToken() {
  try {
    const result = await execute('gh', ['auth', 'token', '--hostname', 'github.com'], {
      windowsHide:true, timeout:6000, maxBuffer:8192
    });
    const token = result.stdout.trim();
    if (token) return token;
  } catch { /* The login can be configured separately through GitHub CLI. */ }
  throw new Error('Sign in to GitHub CLI with access to the Framecut repository, then check again.');
}

function allowedDownload(url) {
  return url.protocol === 'https:' && !url.username && !url.password &&
    (url.hostname === 'api.github.com' || url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com'));
}

export function createUpdater({ repository, privateRepo, currentVersion, cache, broadcast,
  request=fetch, credentials=githubToken }) {
  if (!/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i.test(repository)) throw new Error('Invalid update repository.');
  const base = `${github}/repos/${repository}`;
  let state = { phase:'idle', currentVersion, repository };
  let release;
  let installer;
  let checking;
  let downloadJob;

  function update(values) {
    state = { ...state, ...values };
    broadcast(state);
  }

  function headers(token, accept) {
    return { Accept:accept, 'User-Agent':'Framecut-Windows', 'X-GitHub-Api-Version':'2022-11-28',
      ...(token ? { Authorization:`Bearer ${token}` } : {}) };
  }

  function check() {
    if (downloadJob || installer) return Promise.resolve(state);
    if (checking) return checking;
    checking = (async () => {
      update({ phase:'checking', error:null });
      try {
        const token = privateRepo ? await credentials() : '';
        const response = await request(`${base}/releases/latest`, {
          headers:headers(token,'application/vnd.github+json'), signal:AbortSignal.timeout(15000)
        });
        if (response.status === 401 || response.status === 403) throw new Error('GitHub could not authorize the update check. Check your GitHub CLI login and repository access.');
        if (response.status === 404) throw new Error('GitHub has no accessible published release for Framecut.');
        if (!response.ok) throw new Error(`GitHub update check returned HTTP ${response.status}.`);
        const next = await response.json();
        if (next.draft || next.prerelease || !newerVersion(next.tag_name,currentVersion)) {
          release = null;
          update({phase:'current',version:null,notes:null,title:null,progress:null,error:null});
          return state;
        }
        const asset = next.assets?.find(item => item.name === releaseAsset && item.state === 'uploaded');
        if (!asset || !Number.isSafeInteger(asset.id) || !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
            !/^sha256:[a-f\d]{64}$/i.test(asset.digest || '')) {
          throw new Error('The GitHub release is missing a verified Windows installer.');
        }
        release = { id:asset.id, size:asset.size, digest:asset.digest.slice(7).toLowerCase() };
        update({phase:'available',version:next.tag_name.replace(/^v/,''),title:String(next.name || next.tag_name).slice(0,150),
          notes:String(next.body || '').slice(0,25000),progress:null,error:null});
      } catch (error) {
        update({phase:'error',error:error.name==='TimeoutError'?'The GitHub update check timed out.':error.message});
      }
      return state;
    })().finally(()=>{ checking = undefined; });
    return checking;
  }

  async function downloadResponse(id, token, signal) {
    let url = new URL(`${base}/releases/assets/${id}`);
    for (let i = 0; i < 6; i++) {
      if (!allowedDownload(url)) throw new Error('GitHub returned an untrusted download address.');
      const result = await request(url, {
        headers:headers(url.hostname==='api.github.com' ? token : '', 'application/octet-stream'), redirect:'manual', signal
      });
      if (result.status >= 300 && result.status < 400 && result.headers.has('location')) {
        await result.body?.cancel();
        url = new URL(result.headers.get('location'),url);
        continue;
      }
      if (!result.ok || !result.body) throw new Error(`GitHub download returned HTTP ${result.status}.`);
      return result;
    }
    throw new Error('GitHub returned too many redirects.');
  }

  function download() {
    if (downloadJob) return downloadJob;
    if (installer) return Promise.resolve(state);
    if (!release || !state.version) throw new Error('Check for an update first.');
    const asset = release;
    const version = state.version;
    downloadJob = (async () => {
      update({phase:'downloading',progress:0,error:null});
      const folder = join(cache,`v${version}`);
      const target = join(folder,releaseAsset);
      const temporary = target + '.part';
      const controller = new AbortController();
      let timer;
      const refresh = () => {
        clearTimeout(timer);
        timer = setTimeout(()=>controller.abort(),60000);
      };
      try {
        await mkdir(folder,{recursive:true});
        const token = privateRepo ? await credentials() : '';
        refresh();
        const response = await downloadResponse(asset.id,token,controller.signal);
        const digest = createHash('sha256');
        let bytes = 0;
        let lastPercent = 0;
        const verify = new Transform({transform(chunk,encoding,done) {
          refresh();
          bytes += chunk.length;
          if (bytes > asset.size) return done(new Error('The installer size does not match the GitHub release.'));
          digest.update(chunk);
          const progress = Math.min(99,Math.floor(bytes*100/asset.size));
          if (progress !== lastPercent) {
            lastPercent = progress;
            update({phase:'downloading',progress});
          }
          done(null,chunk);
        }});
        await pipeline(Readable.fromWeb(response.body),verify,createWriteStream(temporary),{signal:controller.signal});
        if (bytes !== asset.size || digest.digest('hex') !== asset.digest) {
          throw new Error('The installer failed its GitHub SHA-256 verification.');
        }
        await rename(temporary,target);
        installer = { path:target, digest:asset.digest, version };
        update({phase:'downloaded',progress:100,error:null});
      } catch (error) {
        await rm(temporary,{force:true}).catch(()=>{});
        update({phase:'available',progress:null,error:controller.signal.aborted?'The download stopped responding. Try again.':error.message});
      } finally {
        clearTimeout(timer);
      }
      return state;
    })().finally(()=>{ downloadJob = undefined; });
    return downloadJob;
  }

  return { snapshot:()=>state, check, download, verifiedInstaller:()=>installer };
}

export async function startWindowsUpdate({ installer, executable, profile, statusFile }) {
  const script = await readFile(new URL('./update-runner.ps1',import.meta.url),'utf8');
  const info = Buffer.from(JSON.stringify({ installer, executable, profile, statusFile, pid:process.pid })).toString('base64');
  const encoded = Buffer.from(`$payload64 = '${info}'\n${script}`,'utf16le').toString('base64');
  const log = await open(join(dirname(statusFile),'update-helper.log'),'w');
  try {
    const child = spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{
      windowsHide:true, stdio:['ignore',log.fd,log.fd]
    });
    await new Promise((resolve,reject)=>{
      child.once('spawn',resolve);
      child.once('error',reject);
    });
    child.unref();
  } finally {
    await log.close();
  }
}
