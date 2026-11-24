import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { taskSignal, taskStage } from './activity.mjs';

const helperVersion = '2026.11.23';
const helperBytes = 23627865;
const helperDigest = '622ed48023cac1daa52a3bf3a6ac38f03514de214b5f0fa069389fd0f6d17e5c';
const helperUrl = `https://github.com/yt-dlp/yt-dlp/releases/download/${helperVersion}/yt-dlp.exe`;
const youtubeHosts = new Set(['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtu.be','www.youtu.be']);

export function youtubeVideo(value) {
  let url;
  if (typeof value==='string' && value.length<=2048) {
    try { url = new URL(value.trim().replace(/^(?=(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\/)/i,'https://')); }
    catch { /* The validation message below is shared by all unsupported links. */ }
  }
  if (url && ['http:','https:'].includes(url.protocol) && youtubeHosts.has(url.hostname) && !url.username && !url.password && !url.port) {
    const paths = url.pathname.split('/').filter(Boolean);
    const id = url.hostname.endsWith('youtu.be') && paths.length===1 ? paths[0] :
      paths[0]==='watch' && paths.length===1 ? url.searchParams.get('v') :
        paths.length===2 && ['shorts','embed','live','v'].includes(paths[0]) ? paths[1] : null;
    if (/^[A-Za-z0-9_-]{11}$/.test(id || '')) return {id,url:`https://www.youtube.com/watch?v=${id}`};
  }
  throw new Error('Paste a link to one YouTube video or Short.');
}

const hasSound = format => typeof format.acodec==='string' && format.acodec!=='none';
const hasPicture = format => typeof format.vcodec==='string' && format.vcodec!=='none';
const bytes = format => Number(format.filesize || format.filesize_approx) || null;

export function youtubeQualities(formats) {
  const valid = (formats || []).filter(format=>format && /^[a-z\d_.-]{1,80}$/i.test(format.format_id || '') && !format.has_drm);
  const audios = valid.filter(format=>hasSound(format) && !hasPicture(format)).sort((a,b)=>(b.abr || b.tbr || 0)-(a.abr || a.tbr || 0));
  const byQuality = new Map();
  for (const video of valid) {
    if (!hasPicture(video) || !Number.isFinite(video.width) || !Number.isFinite(video.height) || Math.min(video.width,video.height)<80) continue;
    const mp4 = video.ext==='mp4';
    const webm = video.ext==='webm';
    if (!mp4 && !webm) continue;
    const audio = hasSound(video) ? null : audios.find(item=>mp4 ? item.ext==='m4a' : webm && item.ext==='webm') || audios[0];
    const ext = mp4 && (!audio || audio.ext==='m4a') ? 'mp4' : webm && (!audio || audio.ext==='webm') ? 'webm' : 'mkv';
    const fps = Math.round(video.fps || 0);
    const quality = `${video.width}x${video.height}-${fps || 30}`;
    const score = (audio || hasSound(video) ? 10 : 0)+(ext==='mp4' && /^avc/.test(video.vcodec) ? 4 : ext==='webm' ? 3 : ext==='mp4' ? 2 : 1)+
      (hasSound(video) ? .25 : 0);
    if (byQuality.has(quality) && byQuality.get(quality).score>=score) continue;
    byQuality.set(quality,{quality,width:video.width,height:video.height,fps,ext,score,
      video:video.format_id,audio:audio?.format_id || null,
      hasAudio:Boolean(audio || hasSound(video)),size:bytes(video) && (!audio || bytes(audio)) ? bytes(video)+(audio?bytes(audio):0) : null});
  }
  return [...byQuality.values()].sort((a,b)=>b.width*b.height-a.width*a.height || b.fps-a.fps || b.score-a.score);
}

function cleanTitle(title) {
  return String(title || 'YouTube video').replace(/[<>:"/\\|?*\p{Cc}]/gu,' ').replace(/\s+/g,' ').trim().slice(0,120) || 'YouTube video';
}

function friendlyError(error) {
  const line = error.message.split('\n').find(line=>line.startsWith('ERROR:')) || error.message.split('\n')[0];
  if (/sign in|cookie|bot verification|age restriction/i.test(line)) return new Error('YouTube requires sign-in or verification for this link. Try another publicly accessible video.');
  if (/requested format|no formats|not available|private|removed|unavailable/i.test(line)) return new Error('YouTube could not supply this video or quality. Check the link or refresh the available qualities.');
  if (/timeout|timed out/i.test(line)) return new Error('The request timed out. Try again.');
  return new Error(line.replace(/^ERROR:\s*/, '').slice(0,230));
}

export function createYoutubeImporter({ data, run, ffmpeg, ingest }) {
  const cache = join(data,'tools');
  const target = join(cache,`yt-dlp-${helperVersion}.exe`);
  let verified = false;

  async function prepare() {
    if (process.platform!=='win32') throw new Error('YouTube import is available in the Windows app.');
    if (verified) return target;
    await mkdir(cache,{recursive:true});
    const digest = createHash('sha256');
    const existing = await stat(target).catch(()=>null);
    if (existing?.size===helperBytes) {
      for await (const chunk of createReadStream(target)) digest.update(chunk);
      if (digest.digest('hex')===helperDigest) { verified=true; return target; }
    }
    taskStage('Downloading the YouTube helper',0);
    const partial = join(cache,`${randomUUID()}.part`);
    const signal = AbortSignal.any([taskSignal(),AbortSignal.timeout(120000)].filter(Boolean));
    try {
      const response = await fetch(helperUrl,{signal});
      if (!response.ok || !response.body) throw new Error('Could not download the YouTube helper. Try again.');
      const hash = createHash('sha256');
      let received = 0;
      const meter = new Transform({transform(chunk,encoding,callback) {
        received+=chunk.length;
        if (received>helperBytes) return callback(new Error('The YouTube helper has an unexpected size.'));
        hash.update(chunk);
        taskStage('Downloading the YouTube helper',received/helperBytes*100);
        callback(null,chunk);
      }});
      await pipeline(Readable.fromWeb(response.body),meter,createWriteStream(partial,{flags:'wx'}),{signal});
      if (received!==helperBytes || hash.digest('hex')!==helperDigest) throw new Error('The YouTube helper failed verification.');
      await rename(partial,target);
      verified = true;
      return target;
    } finally { await rm(partial,{force:true}).catch(()=>{}); }
  }

  async function command(args,options={}) {
    const helper = await prepare();
    const env = {...process.env,PYTHONIOENCODING:'utf-8'};
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE='1';
    const ffmpegArgs = ffmpeg.includes('\\') || ffmpeg.includes('/') ? ['--ffmpeg-location',ffmpeg] : [];
    try {
      return await run(helper,['--ignore-config','--no-plugin-dirs','--no-playlist','--no-color','--no-warnings',
        '--no-js-runtimes','--js-runtimes',`node:${process.execPath}`,'--socket-timeout','18','--retries','2',
        ...ffmpegArgs,...args],{...options,env,stopTree:true});
    } catch (error) {
      taskSignal()?.throwIfAborted();
      throw friendlyError(error);
    }
  }

  return {
    async inspect(video) {
      await prepare();
      taskStage('Checking available qualities');
      const raw = await command(['--skip-download','--dump-single-json','--',video.url],{maxOutput:32*1024*1024});
      let info;
      try { info = JSON.parse(raw.trim()); }
      catch { throw new Error('Could not read the qualities for this YouTube link.'); }
      if (info.id!==video.id) throw new Error('The link did not return the requested YouTube video.');
      if (['is_live','is_upcoming'].includes(info.live_status)) throw new Error('Choose a video that has finished broadcasting.');
      const choices = youtubeQualities(info.formats);
      if (!choices.length) throw new Error('YouTube did not return a downloadable video quality for this link.');
      return {video,title:cleanTitle(info.title),duration:Number(info.duration) || null,choices};
    },
    async download(info,choice) {
      const folder = await mkdtemp(join(data,'youtube-'));
      try {
        const progress = () => {
          let pending = '';
          return chunk=>{
            pending += chunk;
            const lines = pending.split('\n');
            pending = lines.pop().slice(-2048);
            for (const line of lines) {
              const match = /^FRAMECUT (\S+)\s+([\d.]+)%/.exec(line);
              if (match) taskStage(choice.audio===match[1]?'Downloading audio':'Downloading video',Number(match[2]));
              else if (line.startsWith('[Merger]')) taskStage('Joining video and audio');
            }
          };
        };
        taskStage('Downloading video');
        const format = choice.audio ? `${choice.video}+${choice.audio}` : choice.video;
        await command(['--newline','--progress','--progress-template','download:FRAMECUT %(info.format_id)s %(progress._percent_str)s',
          '--concurrent-fragments','4','--fragment-retries','3','--abort-on-unavailable-fragments','-f',format,
          '--merge-output-format',choice.ext,'-o','source.%(ext)s','--',info.video.url],
          {cwd:folder,progress:progress(),stderrProgress:progress()});
        taskSignal()?.throwIfAborted();
        const output = (await readdir(folder)).find(name=>/^source\.(mp4|webm|mkv)$/i.test(name));
        if (!output) throw new Error('The download did not produce a complete video file.');
        taskStage('Adding the video to Footage');
        return await ingest(`${info.title}.${output.split('.').at(-1)}`,destination=>rename(join(folder,output),destination));
      } finally { await rm(folder,{recursive:true,force:true}).catch(()=>{}); }
    }
  };
}
