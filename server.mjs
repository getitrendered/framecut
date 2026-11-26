import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { expression, hasVideoFraming, points, properties, titlePositionOffset, valueAt, videoFit, videoStretch } from './motion.mjs';
import { exportRange, exportWindow, sequenceDuration, sequenceSize } from './sequences.mjs';
import { graphics, graphicSize, particlePresets, particleSettings, readMesh, trackPatch } from './graphics.mjs';
import { extrusionOffsets, textCharacters, textFragment, titleType, titleVerticalAnchor, typewriterDuration, typewriterSteps, typographyText, usesTextReveal, wrapText } from './text.mjs';
import { installedFontNames, stageTitleFont } from './fonts.mjs';
import { soundSettings, soundWave } from './sound.mjs';
import { findLoop } from './loop.mjs';
import { clipMix, trackOf, trackSettings } from './tracks.mjs';
import { activityList, cancelTask, taskDetails, taskId, taskSignal, taskStage, withTask } from './activity.mjs';
import { backgroundKey, keyParameters } from './keying.mjs';
import { createYoutubeImporter, mp3Bitrates, youtubeVideo } from './youtube.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const data = resolve(process.env.FRAMECUT_DATA || join(root, 'data'));
let port = Number(process.env.FRAMECUT_PORT || 4869);
let origin = `http://127.0.0.1:${port}`;
const desktopToken = process.env.FRAMECUT_DESKTOP_TOKEN;
const ffmpeg = process.env.FRAMECUT_FFMPEG || 'ffmpeg';
const ffprobe = process.env.FRAMECUT_FFPROBE || 'ffprobe';
const fps = 30;
const renderInputLimit = 24;
const audioLimiter = 'alimiter=limit=0.96:level=0:latency=1';
const assets = new Map();
const exports = new Map();
const workers = new Set();
const youtubeJobs = new Map();
const assetRoot = join(data, 'media');
const lutRoot = join(data, 'luts');
const aiHome = [process.env.FRAMECUT_AI_HOME, join(data,'..','AI'),
  ...[2,3,4,5].map(level => join(root, ...Array(level).fill('..'),'work','ai'))]
  .find(path => path && existsSync(join(path,'int8','gen_transformer.onnx')) && existsSync(join(path,'deps','onnxruntime')));
const aiPython = process.env.FRAMECUT_AI_PYTHON ||
  join(homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe');
const aiReady = Boolean(aiHome && existsSync(aiPython));
const whisperHome = [process.env.FRAMECUT_WHISPER_HOME,join(root,'whisper')].find(path => path && existsSync(join(path,'whisper-cli.exe')) && existsSync(join(path,'ggml-base-q5_1.bin')));
const audioPreviews = new Map();
const loopCopies=new Set();
const luts = new Map();
const previews = new Map();
const importingFolders = new Set();
const stillImage = /\.(png|jpe?g|webp|bmp|tiff?|avif|heic|heif|jxl|tga|ico|ppm|pgm|pbm|exr|dpx)$/i;
await mkdir(assetRoot, { recursive: true });
await mkdir(lutRoot, { recursive: true });
await mkdir(join(data, 'renders'), { recursive: true });

for (const id of await readdir(assetRoot)) {
  try {
    const asset = JSON.parse(await readFile(join(assetRoot, id, 'info.json'), 'utf8'));
    assets.set(id, asset);
  } catch {
    // Incomplete imports are excluded from the media library.
  }
}
for (const file of await readdir(lutRoot)) {
  if (!/^[a-f\d-]+\.json$/.test(file)) continue;
  try {
    const lut = JSON.parse(await readFile(join(lutRoot, file),'utf8'));
    luts.set(lut.id,lut);
  } catch {}
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const signal = taskSignal();
    signal?.throwIfAborted();
    const tree = options.stopTree && process.platform==='win32';
    const child = spawn(command, args, { windowsHide: true, cwd: options.cwd, env:options.env, signal:tree?undefined:signal });
    if (tree) {
      const stop = () => {
        if (!child.pid || child.exitCode!==null) return;
        const killer = spawn(join(process.env.WINDIR || 'C:/Windows','System32','taskkill.exe'),
          ['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        killer.on('error',()=>child.kill());
        killer.on('exit',code=>{ if (code) child.kill(); });
      };
      child.stopTree = stop;
      signal?.addEventListener('abort',stop,{once:true});
      child.once('close',()=>signal?.removeEventListener('abort',stop));
    }
    workers.add(child);
    if (options.input) pipeline(Readable.from(options.input),child.stdin).catch(() => {});
    else child.stdin.end();
    let output = '';
    let outputError;
    const chunks = [];
    let errors = '';
    if (!options.binary) child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (options.binary) chunks.push(chunk);
      else if (options.progress) options.progress(chunk);
      else if (!outputError) {
        if (options.maxOutput && output.length+chunk.length>options.maxOutput) {
          outputError = new Error('The video returned too much information.');
          if (child.stopTree) child.stopTree();
          else child.kill();
        } else output += chunk;
      }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      if(options.stderrProgress) options.stderrProgress(chunk);
      errors = (errors + chunk).slice(-8000);
    });
    child.on('error', error => {
      if (error.name !== 'AbortError') workers.delete(child);
      if (error.name === 'AbortError') return;
      reject(error.code === 'ENAMETOOLONG'
        ? new Error('Windows could not start the media encoder. Try exporting a shorter In/Out range or reducing overlapping tracks.')
        : error);
    });
    child.on('close', code => {
      workers.delete(child);
      if (signal?.aborted) reject(signal.reason);
      else if (outputError) reject(outputError);
      else if (code === 0) resolve(options.binary ? Buffer.concat(chunks) : output);
      else reject(new Error(errors.trim() || `${command} exited with code ${code}`));
    });
  });
}

function runTimed(args, options, stage, duration) {
  taskStage(stage, duration > 0 ? 0 : null);
  let pending='';
  function update(chunk) {
      const lines=(pending+chunk).split('\n');
      pending=lines.pop();
      for(const line of lines){
        const match=line.match(/^out_time_us=(\d+)/);
        if(match && duration>0) taskStage(stage,Math.min(99,Number(match[1])/10000/duration));
      }
  }
  return run(ffmpeg,['-progress',options.binary?'pipe:2':'pipe:1','-nostats',...args],{
    ...options, ...(options.binary?{stderrProgress:update}:{progress:update})
  });
}

function copyMedia(readable, path, size) {
  let copied=0;
  taskStage('Copying original',size>0?0:null);
  const meter=new Transform({transform(chunk,encoding,next){
    copied+=chunk.length;
    if(size>0) taskStage('Copying original',copied/size*100);
    next(null,chunk);
  }});
  return pipeline(readable,meter,createWriteStream(path));
}

export function getRender(id) {
  const job = exports.get(id);
  if (job?.status !== 'ready') return null;
  return { filename: job.filename, format: job.format, path: join(data, 'renders', job.id, `video.${job.format}`) };
}

export function stop() {
  for (const child of workers) {
    if (child.stopTree) child.stopTree();
    else child.kill();
  }
  server.close();
  server.closeAllConnections();
}

function encodeSize(width, height, alpha = false) {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2${alpha ? ':black@0' : ''},setsar=1`;
}

async function importVideo(req) {
  let name;
  try {
    name = decodeURIComponent(req.headers['x-filename'] || 'Video');
  } catch {
    name = 'Video';
  }
  name = name.split(/[\\/]/).pop().slice(0, 240) || 'Video';
  return importMedia(name,path=>copyMedia(req,path,Number(req.headers['x-file-size'] || req.headers['content-length'])));
}

const youtube = createYoutubeImporter({data,run,runTimed,ffmpeg,async ingest(name,transfer,audioMime) {
  if (audioMime) return addAudio(name,(_,target)=>transfer(target),audioMime);
  const id = randomUUID();
  return ingest(id,name,transfer,{registerEarly:true});
}});

function startYoutubeJob(label,operation) {
  if ([...youtubeJobs.values()].some(job=>job.status==='working')) throw new Error('A YouTube import is already running.');
  for (const [id,job] of youtubeJobs) if (Date.now()-job.started>20*60*1000 || youtubeJobs.size>=20) youtubeJobs.delete(id);
  const job = {id:randomUUID(),status:'working',started:Date.now()};
  youtubeJobs.set(job.id,job);
  void withTask(label,async()=>{
    job.taskId = taskId();
    try {
      const result = await operation(job);
      if (taskSignal().aborted && result.id) {
        assets.delete(result.id);
        await rm(join(assetRoot,result.id),{recursive:true,force:true}).catch(()=>{});
      }
      taskSignal().throwIfAborted();
      Object.assign(job,{status:'ready',result});
    } catch (error) {
      Object.assign(job,{status:taskSignal().aborted?'cancelled':'error',error:error.message.split('\n')[0]});
      throw error;
    }
  },{cancellable:true}).catch(()=>{});
  return {id:job.id,taskId:job.taskId};
}

export async function importMediaPath(path) {
  if(typeof path!=='string' || !isAbsolute(path)) throw new Error('Choose a media file from your computer.');
  const file=await stat(path);
  if(!file.isFile()) throw new Error('Choose a media file from your computer.');
  const name=basename(path);
  if(stillImage.test(name)) return importMedia(name,target=>copyMedia(createReadStream(path),target,file.size));
  return withTask(`Import ${name}`,async()=>{
    const existing=await recoverCopy(path,file.size);
    if(existing) return inspectImportedMedia(existing,name,true);
    return ingest(randomUUID(),name,target=>copyMedia(createReadStream(path),target,file.size),{registerEarly:true});
  });
}

async function recoverCopy(path,size) {
  for(const id of await readdir(assetRoot)){
    if(assets.has(id) || importingFolders.has(id) || !/^[a-f\d-]{36}$/.test(id)) continue;
    const candidate=join(assetRoot,id,'source');
    const file=await stat(candidate).catch(()=>null);
    if(!file?.isFile() || file.size!==size || size===0) continue;
    if(await stat(join(assetRoot,id,'info.json')).catch(()=>null)) continue;
    let verified=0;
    const compare=async source=>{
      const hash=createHash('sha256');
      for await(const chunk of createReadStream(source,{highWaterMark:1024*1024})){
        hash.update(chunk);
        verified+=chunk.length;
        taskStage('Checking the earlier import',verified/(size*2)*100);
      }
      return hash.digest('hex');
    };
    const [original,copy]=await Promise.all([compare(path),compare(candidate)]);
    if(original===copy) return id;
  }
  return null;
}

function importMedia(name, transfer) {
  const still=stillImage.test(name);
  return withTask(`Import ${name}`,()=>ingest(randomUUID(),name,async path=>{
    if(!still) return transfer(path);
    const original=path+'.image';
    await transfer(original);
    await runTimed(['-nostdin','-v','error','-i',original,'-an','-vf','scale=trunc(iw/2)*2:trunc(ih/2)*2,loop=loop=149:size=1:start=0,setpts=N/(30*TB)',
      '-frames:v','150','-r','30','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-f','mp4',path],{},'Preparing still image',5);
    await rm(original);
  }, { registerEarly: !still }));
}

async function addAudio(name, prepare, audioMime) {
  const id = randomUUID();
  const folder = join(assetRoot,id);
  await mkdir(folder);
  try {
    const target = join(folder,'source');
    await prepare(folder,target);
    return await registerAudio(folder,id,name,audioMime);
  } catch (error) {
    await rm(folder,{recursive:true,force:true});
    throw error;
  }
}

async function registerAudio(folder,id,name,audioMime) {
  const info = JSON.parse(await run(ffprobe,['-v','error','-select_streams','a:0','-show_entries','stream=duration','-of','json','source'],{cwd:folder}));
  const frames = Math.ceil(Number(info.streams[0]?.duration)*fps);
  if (!frame(frames) || !frames) throw new Error('Choose a file containing readable audio.');
  const asset = { id,name,frames,kind:'audio',audio:0 };
  if (audioMime) asset.audioMime = audioMime;
  await writeFile(join(folder,'info.partial'),JSON.stringify(asset));
  await rename(join(folder,'info.partial'),join(folder,'info.json'));
  assets.set(id,asset);
  return asset;
}

async function normalizeAudio(folder,input,output) {
  taskStage('Preparing audio');
  await run(ffmpeg,['-nostdin','-v','error','-i',input,'-map','0:a:0','-vn','-c:a','pcm_s16le','-ar','48000','-ac','2','-f','wav',output],{cwd:folder});
}

function audioName(req) {
  try { return decodeURIComponent(req.headers['x-filename'] || 'Audio').split(/[\\/]/).pop().slice(0,120); }
  catch { return 'Audio'; }
}

function importAudio(req) {
  return addAudio(audioName(req),async (folder,target) => {
    const incoming=join(folder,'incoming');
    await copyMedia(req,incoming,Number(req.headers['x-file-size'] || req.headers['content-length']));
    await normalizeAudio(folder,incoming,target);
    await rm(incoming);
  });
}

async function createSound(body) {
  const settings=soundSettings(body);
  const wave=soundWave(settings);
  return addAudio(settings.name,async (folder,target) => {
    const wav=Buffer.alloc(44+wave.length*2);
    wav.write('RIFF',0); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8);
    wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
    wav.writeUInt32LE(48000,24); wav.writeUInt32LE(96000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
    wav.write('data',36); wav.writeUInt32LE(wave.length*2,40);
    for(let i=0;i<wave.length;i++) wav.writeInt16LE(Math.round(wave[i]*32767),44+i*2);
    await writeFile(target,wav);
  });
}

async function audioPreview(asset) {
  const folder=join(assetRoot,asset.id);
  if (asset.kind==='audio') return join(folder,'source');
  const file=join(folder,'audio.wav');
  if (await stat(file).catch(()=>null)) return file;
  if (!audioPreviews.has(file)) {
    const temp=file+'.partial';
    audioPreviews.set(file,run(ffmpeg,['-y','-nostdin','-v','error','-i','source','-map',`0:${asset.audio}`,'-c:a','pcm_s16le','-ar','48000','-ac','2','-f','wav',temp],{cwd:folder})
      .then(()=>rename(temp,file)).finally(()=>audioPreviews.delete(file)));
  }
  await audioPreviews.get(file);
  return file;
}

async function ingest(id, name, writeSource, options={}) {
  const folder = join(assetRoot, id);
  await mkdir(folder);
  importingFolders.add(id);
  try {
    await writeSource(join(folder, 'source'));
    return await inspectImportedMedia(id,name,options.registerEarly,options.composition);
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  } finally {
    importingFolders.delete(id);
  }
}

function nativePlayback(name,format,video,audio,alpha) {
  const a=audio?.codec_name;
  if(/\.webm$/i.test(name) && format.includes('webm') && ['vp8','vp9','av1'].includes(video.codec_name) &&
    (!a || ['opus','vorbis'].includes(a))) return 'video/webm';
  if(alpha) return null;
  if(/\.(mp4|m4v)$/i.test(name) && format.includes('mp4') && video.codec_name==='h264' &&
    ['yuv420p','yuvj420p'].includes(video.pix_fmt) && (!a || ['aac','mp3'].includes(a))) return 'video/mp4';
  return null;
}

function videoDuration(video, format) {
  if(Number(video.duration)>0) return Number(video.duration);
  const clock=video.tags?.DURATION || video.tags?.duration;
  if(typeof clock==='string' && /^\d+:\d+:\d+\./.test(clock)){
    const [hours,minutes,seconds]=clock.split(':').map(Number);
    const duration=hours*3600+minutes*60+seconds;
    if(duration>0) return duration;
  }
  return Number(format?.duration);
}

async function inspectImportedMedia(id,name,registerEarly,composition) {
  const folder=join(assetRoot,id);
  taskStage('Reading video information');
  const probe=JSON.parse(await run(ffprobe,['-v','error','-show_streams','-show_format','-of','json','source'],{cwd:folder}));
  const video=probe.streams.find(stream=>stream.codec_type==='video'&&!stream.disposition?.attached_pic);
  const audio=probe.streams.find(stream=>stream.codec_type==='audio');
  if(!video) {
    if(!audio) throw new Error('This file does not contain readable video, image or audio.');
    await normalizeAudio(folder,'source','audio.partial');
    await rename(join(folder,'audio.partial'),join(folder,'source'));
    return registerAudio(folder,id,name);
  }
  const duration=videoDuration(video,probe.format);
  const alpha=video.tags?.alpha_mode==='1' || /^(argb|rgba|abgr|bgra|yuva|gbrap)/.test(video.pix_fmt || '');
  const nativeMime=nativePlayback(composition ? 'composition.mp4' : name,probe.format?.format_name || '',video,audio,alpha);
  let frames=Math.round(duration*fps);
  const needsPreview=!registerEarly || !Number.isSafeInteger(frames) || frames<1;
  let thumbInput='source', thumbTrack=video.index;
  if(needsPreview){
    await runTimed(['-y','-nostdin','-v','error','-fflags','+genpts','-i','source','-map',`0:${video.index}`,
      ...(audio ? ['-map',`0:${audio.index}`] : []),
      '-vf',`scale=max(2\\,trunc(iw/4)*2):max(2\\,trunc(ih/4)*2):reset_sar=1,setsar=1,fps=${fps}:round=up`,
      '-c:v','libx264','-preset','ultrafast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-ac','2',
      '-movflags','+faststart','preview.mp4'],{cwd:folder},'Preparing compatible preview',duration);
    const preview=JSON.parse(await run(ffprobe,['-v','error','-select_streams','v:0','-show_entries','stream=nb_frames,duration',
      '-of','json','preview.mp4'],{cwd:folder})).streams[0];
    frames=Number(preview?.nb_frames)||Math.round(Number(preview?.duration)*fps);
    thumbInput='preview.mp4'; thumbTrack=0;
  }
  if(!Number.isSafeInteger(frames)||frames<1) throw new Error('The video contains no decodable frames.');
  taskStage('Creating thumbnail');
  await run(ffmpeg,['-y','-nostdin','-v','error','-i',thumbInput,'-map',`0:${thumbTrack}`,'-frames:v','1',
    '-vf',encodeSize(320,180),'-update','1','thumb.jpg'],{cwd:folder});
  const asset={id,name,frames,width:video.width,height:video.height,alpha,halfReady:needsPreview,
    nativeMime:needsPreview?null:nativeMime,video:video.index,audio:audio?.index??null,
    matrix:video.color_space,fullRange:video.color_range==='pc',codec:video.codec_name};
  if (composition) asset.composition = true;
  await writeFile(join(folder,'info.partial'),JSON.stringify(asset));
  await rename(join(folder,'info.partial'),join(folder,'info.json'));
  assets.set(id,asset);
  return asset;
}
async function importLut(req) {
  let content = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    content += chunk;
    if (content.length > 12_000_000) throw new Error('This LUT is too large.');
  }
  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const size = Number(lines.find(line => line.startsWith('LUT_3D_SIZE '))?.split(/\s+/)[1]);
  const triplet = line => {
    const values = line.trim().split(/\s+/);
    return values.length === 3 && values.every(v => Number.isFinite(Number(v)));
  };
  const entries = lines.filter(triplet);
  if (!Number.isInteger(size) || size < 2 || size > 65 || entries.length !== size ** 3) throw new Error('Choose a valid 3D .cube LUT (2–65 points per side).');
  const bounds = lines.filter(line => /^(DOMAIN_MIN|DOMAIN_MAX)\s/.test(line) && triplet(line.replace(/^\S+\s+/, '')));
  const id = randomUUID();
  const filename = decodeURIComponent(req.headers['x-filename'] || 'Color LUT.cube');
  const lut = { id, name:filename.split(/[\\/]/).pop().replace(/\.cube$/i,'').slice(0,110) };
  await writeFile(join(lutRoot,`${id}.cube`), [`LUT_3D_SIZE ${size}`,...bounds,...entries].join('\n'));
  await writeFile(join(lutRoot,`${id}.json`), JSON.stringify(lut));
  luts.set(id,lut);
  return lut;
}

async function proxy(asset, quality, lut) {
  if(quality==='auto') quality='half';
  const ext = asset.alpha ? 'webm' : 'mp4';
  const href = join(assetRoot,asset.id,`p-${quality}${lut ? '-'+lut : ''}.${ext}`);
  if (!asset.alpha && quality === 'half' && !lut && asset.halfReady) return join(assetRoot,asset.id,'preview.mp4');
  if (await stat(href).catch(() => null)) return href;
  if (!previews.has(href)) {
    const folder = join(assetRoot,asset.id);
    const divisor = { full:1, half:2, quarter:4, low:8 }[quality];
    const size = `max(2\\,trunc(iw/${divisor*2})*2):max(2\\,trunc(ih/${divisor*2})*2)`;
    const part = href + `.partial.${ext}`;
    const filters = [`scale=${size}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1`,
      'setsar=1', `fps=${fps}:round=up`];
    if (lut) filters.push(`lut3d=file=../../luts/${lut}.cube`);
    const encoding = asset.alpha ? ['-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','6','-auto-alt-ref','0','-b:v','0','-crf','22','-pix_fmt','yuva420p','-c:a','libopus']
      : ['-c:v','libx264','-preset','ultrafast','-crf',quality === 'full' ? '17' : '25','-pix_fmt','yuv420p','-c:a','aac','-ac','2','-movflags','+faststart'];
    const task = withTask(`Preview ${asset.name}`,()=>runTimed(['-y','-nostdin','-v','error','-fflags','+genpts',...alphaDecoder(asset),'-i','source','-map',`0:${asset.video}`,
      ...(asset.audio === null ? [] : ['-map',`0:${asset.audio}`]),'-vf',filters.join(','),
      ...encoding,part], { cwd:folder },'Transcoding preview',asset.frames/fps).then(()=>rename(part,href)))
      .finally(() => previews.delete(href));
    previews.set(href,task);
  }
  await previews.get(href);
  return href;
}

async function createGraphic(body) {
  const names = { cube:'3D Cube', mesh:'3D Model', ...Object.fromEntries(Object.entries(particlePresets).map(([key,[name]])=>[key,name])) };
  if (!Object.hasOwn(names,body.kind)) throw new Error('Unknown graphic.');
  const mesh = body.kind === 'mesh' ? readMesh(typeof body.mesh === 'string' ? body.mesh : '') : undefined;
  const name = body.kind === 'mesh' && typeof body.name === 'string'
    ? body.name.replace(/[\\/]/g,' ').replace(/\.obj$/i,'').slice(0,75) : names[body.kind];
  const duration=['cube','mesh'].includes(body.kind)?4:particleSettings(body.kind,body.settings).duration;
  return ingest(randomUUID(),name, target => runTimed(['-nostdin','-v','error','-f','rawvideo','-pix_fmt','rgba',
    '-video_size',graphicSize,'-r',String(fps),'-i','pipe:0','-c:v','qtrle','-pix_fmt','argb','-f','mov',target],
    { input:graphics(body.kind,mesh,body.settings) },'Rendering graphics',duration));
}

async function trackSource(clip, box) {
  const { asset } = clip;
  validateBox(box);
  const width=160, height=96;
  const step = Math.max(3, Math.ceil(clip.len/100));
  taskStage('Sampling video frames');
  const raw = await runTimed(['-nostdin','-v','error','-ss',(clip.in/fps).toFixed(6),
    '-i','source','-map',`0:${asset.video}`,'-t',(clip.len/fps).toFixed(6),'-vf',`fps=${fps}/${step},scale=${width}:${height}`,
    '-pix_fmt','gray','-f','rawvideo','pipe:1'], { cwd:join(assetRoot,asset.id),binary:true },'Sampling video frames',clip.len/fps);
  return trackPatch(raw,width,height,box,step,percent=>taskStage('Tracking motion',percent));
}

function validateBox(box) {
  if (!box || ![box.x,box.y,box.w,box.h].every(Number.isFinite) || box.x < 0 || box.y < 0 ||
    box.w < .06 || box.h < .06 || box.w > .60 || box.h > .60 || box.x+box.w>1.001 || box.y+box.h>1.001) {
    throw new Error('Use a box between 6% and 60% of the video.');
  }
}

async function removeObject(clip, box, follow) {
  if (!aiReady) throw new Error('The local ProPainter runtime is unavailable.');
  validateBox(box);
  if (clip.len < 2 || clip.len > 90) throw new Error('Trim or split the source shot to between 2 frames and 3 seconds first.');
  const {asset} = clip;
  const tracking = follow ? await trackSource(clip,box) : [];
  return ingest(randomUUID(),`${asset.name.replace(/\.[^.]+$/,'')} (Object removed).mp4`, async target => {
    const dir = join(target,'..','inpaint');
    await mkdir(join(dir,'input'),{recursive:true});
    const input = join(assetRoot,asset.id,'source');
    const seek = (clip.in/fps).toFixed(6);
    await run(ffmpeg,['-nostdin','-v','error','-ss',seek,'-i',input,'-map',`0:${asset.video}`,
      '-vf',`fps=${fps}:round=up,scale=trunc(iw/2)*2:trunc(ih/2)*2`,'-frames:v',String(clip.len),join(dir,'input','%05d.png')]);
    await writeFile(join(dir,'mask.json'),JSON.stringify({box,tracking}));
    taskStage('Removing object',0);
    let last='';
    await run(aiPython,[join(root,'remove_object.py'),dir,aiHome],{cwd:dir,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},progress(chunk){
      const lines=(last+chunk).split('\n'); last=lines.pop();
      for(const line of lines){
        const match=line.match(/(\d+)\s*\/\s*(\d+) frames/);
        if(match && Number(match[2])>0) taskStage('Removing object',Number(match[1])*100/Number(match[2]));
      }
    }});
    taskStage('Saving cleaned clip');
    await run(ffmpeg,['-nostdin','-v','error','-framerate',String(fps),'-i',join(dir,'output','%05d.png'),
      ...(asset.audio === null ? [] : ['-ss',seek,'-i',input,'-map','0:v:0','-map',`1:${asset.audio}`,'-c:a','aac','-shortest']),
      '-t',(clip.len/fps).toFixed(6),'-c:v','libx264','-preset','veryfast','-crf','17','-pix_fmt','yuv420p','-f','mp4',target]);
    await rm(dir,{recursive:true,force:true});
  });
}

function frame(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sourceClip(clip) {
  const asset = assets.get(clip.asset);
  if (!asset || !frame(clip.in) || !frame(clip.len) || !clip.len || clip.in + clip.len > asset.frames) {
    throw new Error('A video clip has an invalid source or trim.');
  }
  return { ...clip, asset };
}

function readAudio(project) {
  return (project.sounds || []).map(clip => {
    const source = sourceClip({...clip,kind:'audio'});
    if (!frame(clip.start) || !frame(clip.track) || clip.track < 1 || clip.track > 12 || source.asset.audio === null) throw new Error('An audio clip has an invalid source or position.');
    return source;
  });
}

function audioFilter(args,filter,timeline,{dialogueOnly=false,reuse=false,batch=false,limit=true}={}) {
  const { clips, overlays, sounds, total } = timeline;
  let position=0;
  const sources=clips.map((clip,index)=>{
    const item={...clip,start:clip.start ?? position, input:reuse?index:undefined};
    position=item.start+clip.len;
    return item;
  }).concat(overlays.map((clip,index)=>({...clip,input:reuse?clips.length+index:undefined})),sounds.filter(clip=>!dialogueOnly || clip.dialogue));
  filter.push(`anullsrc=r=48000:cl=stereo,atrim=end_sample=${total*1600}[soundbase]`);
  const labels=['soundbase'];
  let offset=args.filter(arg=>arg==='-i').length;
  for(const clip of sources) {
    const mix=clipMix(timeline,clip);
    if (mix.muted || clip.asset.audio === null) continue;
    const input=clip.input ?? offset++;
    const label='snd'+input;
    const gain=mix.gain;
    const sourceLength=clip.sourceLength ?? clip.len;
    const skip=(clip.sectionOffset ?? 0)*1600;
    const fadeIn=frame(clip.fadeIn) ? Math.min(sourceLength,clip.fadeIn)*1600 : 0;
    const fadeOut=frame(clip.fadeOut) ? Math.min(sourceLength,clip.fadeOut)*1600 : 0;
    const end=skip+clip.len*1600;
    if(clip.input===undefined) addRenderInput(args,clip,batch);
    const effects=[`[${input}:${clip.asset.audio}]aresample=48000:async=1:first_pts=0`,
      'aformat=sample_rates=48000:channel_layouts=stereo','apad',`atrim=end_sample=${end}`, 'asetpts=PTS-STARTPTS'];
    if(gain) effects.push(`volume=${gain}dB`);
    if(fadeIn) effects.push(`afade=t=in:ss=0:ns=${fadeIn}`);
    if(fadeOut) effects.push(`afade=t=out:ss=${sourceLength*1600-fadeOut}:ns=${fadeOut}`);
    if(skip) effects.push(`atrim=start_sample=${skip}`,'asetpts=PTS-STARTPTS');
    effects.push(`adelay=${clip.start*1600}S:all=1[${label}]`);
    filter.push(effects.join(','));
    labels.push(label);
  }
  if(labels.length===1) filter.push('[soundbase]anull[audio]');
  else filter.push(`${labels.map(label=>`[${label}]`).join('')}amix=inputs=${labels.length}:duration=first:normalize=0${limit?','+audioLimiter:''},atrim=end_sample=${total*1600}[audio]`);
}

async function transcribe(body) {
  if(!whisperHome) throw new Error('The offline transcription model is unavailable in this build.');
  const timeline=readTimeline({...body,titles:[]});
  if(timeline.total > 108000) throw new Error('Generate captions for up to one hour at a time.');
  const folder=join(data,'renders','captions-'+randomUUID());
  await mkdir(folder);
  try {
    await prepareDialogue(folder,timeline);
    const language=['en','hi','fr','de','es','it','pt','ja','ko','zh','ru','ar','ta','te','bn','ml','ur'].includes(body.language) ? body.language : 'auto';
    const seconds=await audibleEnd(join(folder,'speech.wav'));
    if(seconds===0) return {srt:'',endFrame:0};
    const endFrame=Math.min(timeline.total,Math.ceil((seconds+.25)*fps));
    taskStage('Transcribing dialogue',0);
    await run(join(whisperHome,'whisper-cli.exe'),['-m',join(whisperHome,'ggml-base-q5_1.bin'),'-f','speech.wav','-l',language,'-ng','-t','4',
      '-d',String(Math.ceil(endFrame*1000/fps)),'-ml','56','-sow','-pp','-osrt','-of','captions'],{cwd:folder,stderrProgress(chunk){
      for(const match of chunk.matchAll(/progress\s*=\s*(\d+)%/g)) taskStage('Transcribing dialogue',Number(match[1]));
    }});
    return {srt:await readFile(join(folder,'captions.srt'),'utf8').catch(()=> ''),endFrame};
  } finally {
    await rm(folder,{recursive:true,force:true});
  }
}

async function prepareDialogue(folder,timeline) {
  const inputs = [...timeline.clips,...timeline.overlays,...timeline.sounds.filter(clip=>clip.dialogue)]
    .filter(clip=>clip.asset.audio!==null && !clipMix(timeline,clip).muted && clip.start<timeline.total);
  if (!inputs.length) throw new Error('Add or unmute dialogue before generating captions.');
  const speech = ['-ac','1','-ar','16000','-c:a','pcm_s16le','speech.wav'];
  const mix = async (part, output, batch) => {
    const args = ['-nostdin','-v','error','-filter_complex_threads','2'];
    const filter = [];
    audioFilter(args,filter,part,{dialogueOnly:true,batch,limit:!batch});
    await writeFile(join(folder,'audio.ffscript'),filter.join(';\n'));
    await runTimed([...args,'-/filter_complex','audio.ffscript','-map','[audio]',...output],{cwd:folder},'Mixing dialogue',part.total/fps);
  };
  if (inputs.length<=renderInputLimit) {
    // Trim the input list even if dialogue occupies only a short fixed-duration edit.
    const part = timelineSection(timeline,{start:0,end:timeline.total});
    await mix(part,speech,false);
    return;
  }
  const sections = divideTimeline(inputs,0,timeline.total);
  await withRenderSections(folder,sections,'wav', (file,section)=>mix(timelineSection(timeline,section),
    ['-c:a','pcm_f32le',file],true), list=>runTimed(['-nostdin','-v','error','-f','concat','-i',list,
    '-af','asetpts=N/SR/TB,'+audioLimiter,...speech],{cwd:folder},'Joining dialogue',timeline.total/fps));
}

async function audibleEnd(path) {
  const wav=await readFile(path);
  for(let index=12;index+8<=wav.length;){
    const length=wav.readUInt32LE(index+4);
    const start=index+8;
    if(wav.toString('ascii',index,index+4)==='data'){
      const end=Math.min(start+length,wav.length);
      for(let cursor=end-2;cursor>=start;cursor-=640){
        let power=0,samples=0;
        for(let offset=cursor;offset>=Math.max(start,cursor-638);offset-=2){
          const value=wav.readInt16LE(offset);
          power+=value*value;samples++;
        }
        if(power/Math.max(1,samples)>160**2) return (cursor-start+2)/32000;
      }
      return 0;
    }
    index=start+length+(length%2);
  }
  return 0;
}

async function sampleGrade(clip) {
  const { asset } = clip;
  const frames = [...new Set([.18,.5,.82].map(p => clip.in + Math.floor((clip.len - 1) * p)))];
  const pixels = [];
  const filter = luts.has(clip.lut) ? `lut3d=file=../../luts/${clip.lut}.cube,scale=24:24` : 'scale=24:24';
  for (const n of frames) {
    const raw = await run(ffmpeg, ['-nostdin','-v','error','-ss',(n/fps).toFixed(6),
      '-i','source','-map',`0:${asset.video}`,'-vf',filter,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],
      { cwd:join(assetRoot,asset.id), binary:true });
    for (let i = 0; i < raw.length - 2; i += 3) {
      const [r,g,b] = [raw[i],raw[i+1],raw[i+2]];
      pixels.push([(.2126*r+.7152*g+.0722*b)/255,(Math.max(r,g,b)-Math.min(r,g,b))/255]);
    }
  }
  if (!pixels.length) throw new Error('Could not sample the selected shot.');
  const mean = pixels.reduce((sum,pixel) => sum + pixel[0],0)/pixels.length;
  return { mean, deviation:Math.sqrt(pixels.reduce((sum,pixel) => sum + (pixel[0]-mean)**2,0)/pixels.length),
    chroma:pixels.reduce((sum,pixel) => sum + pixel[1],0)/pixels.length };
}

function upscaleSource(clip) {
  const { asset } = clip;
  return ingest(randomUUID(), `${asset.name.replace(/\.[^.]+$/,'')} (Upscaled).mp4`, async target => {
    const temporary = target + '.mp4';
    await runTimed(['-nostdin','-v','error','-ss',(clip.in/fps).toFixed(6),'-i','source',
      '-map',`0:${asset.video}`,...(asset.audio === null ? [] : ['-map',`0:${asset.audio}`]),
      '-t',(clip.len/fps).toFixed(6),'-vf',"scale='min(iw*2,3840)':'min(ih*2,3840)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos",
      '-c:v','libx264','-preset','veryfast','-crf','17','-pix_fmt','yuv420p','-c:a','aac',temporary],
      { cwd:join(assetRoot,asset.id) },'Resizing video',clip.len/fps);
    await rename(temporary,target);
  });
}

async function loopSource(clip) {
  if(clip.len<30) throw new Error('Select footage at least one second long.');
  const {asset}=clip;
  const folder=join(assetRoot,asset.id);
  const stride=Math.max(4,Math.ceil(clip.len/170));
  taskStage('Comparing edge frames');
  const raw=await runTimed(['-nostdin','-v','error','-ss',(clip.in/fps).toFixed(6),'-i','source','-map',`0:${asset.video}`,'-t',(clip.len/fps).toFixed(6),
    '-vf',`fps=${fps}/${stride},scale=20:12`,'-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{cwd:folder,binary:true},'Comparing edge frames',clip.len/fps);
  const match=findLoop(raw,20*12*3,stride);
  const label=`${asset.name.replace(/\.[^.]+$/,'')} (Closest loop).mp4`;
  const loop=await ingest(randomUUID(),label,async target=>{
    await runTimed(['-nostdin','-v','error','-ss',((clip.in+match.start)/fps).toFixed(6),'-i','source',
      '-map',`0:${asset.video}`,...(asset.audio===null?[]:['-map',`0:${asset.audio}`]),
      '-t',((match.end-match.start)/fps).toFixed(6),'-vf','fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v','libx264','-preset','veryfast','-crf','17','-pix_fmt','yuv420p','-c:a','aac','-f','mp4',target],{cwd:folder},'Rendering loop cut',(match.end-match.start)/fps);
  });
  loop.loop=true;
  loopCopies.add(loop.id);
  await writeFile(join(assetRoot,loop.id,'info.json'),JSON.stringify(loop));
  return {asset:loop,start:clip.in+match.start,end:clip.in+match.end,error:match.error};
}

async function repeatLoop(body) {
  const asset=assets.get(body.asset);
  if(!asset || !(asset.loop || loopCopies.has(asset.id))) throw new Error('Choose a closest-loop copy first.');
  if(!Number.isFinite(body.minutes)||body.minutes<.1||body.minutes>180) throw new Error('Choose a duration between 0.1 and 180 minutes.');
  const job={id:randomUUID(),status:'rendering',progress:0,format:'mp4',filename:'Repeated loop.mp4'};
  exports.set(job.id,job);
  const folder=join(data,'renders',job.id);
  try {
    await mkdir(folder);
    await runTimed(['-nostdin','-v','error','-stream_loop','-1','-i',join(assetRoot,asset.id,'source'),'-t',String(body.minutes*60),
      '-c','copy','-movflags','+faststart','video.mp4'],{cwd:folder},'Writing repeated loop',body.minutes*60);
    job.status='ready'; job.progress=100;
    return job;
  } catch(error) { job.status='error'; throw error; }
}

function readTimeline(project) {
  let time=0;
  const clips = project.clips.map(clip=>{
    const item=sourceClip({...clip,start:clip.start ?? time});
    time=item.start+item.len;
    return item;
  }).sort((a,b)=>a.start-b.start);
  if(clips.some((clip,i)=>!frame(clip.start) || (i>0 && clip.start<clips[i-1].start+clips[i-1].len))) throw new Error('Two clips overlap on Video 1.');
  const overlays = (project.overlays || []).map(sourceClip).sort((a,b) => a.track-b.track || a.start-b.start);
  if (overlays.some(clip => !frame(clip.start) || !frame(clip.track) || clip.track < 1 || clip.track > 8)) {
    throw new Error('A video layer has invalid positioning.');
  }
  const sounds = readAudio(project);
  const titles = project.titles.map(title => {
    if (!frame(title.start) || !frame(title.len) || !title.len ||
        !/^(center|lower|caption)$/.test(title.style) || typeof title.text !== 'string' ||
        !title.text.trim() || title.text.length > 900 || /\p{Cc}/u.test(title.text.replace(/\n/g,''))) {
      throw new Error('A title has invalid text, style or timing.');
    }
    return title;
  }).sort((a, b) => Number(a.track || 1) - Number(b.track || 1) || a.start - b.start);
  const videoFrames = Math.max(0,...clips.map(clip=>clip.start+clip.len));
  const total = sequenceDuration(project, Math.max(videoFrames, ...[...titles,...overlays,...sounds].map(clip => clip.start + clip.len)));
  if (!total) throw new Error('Add media to the timeline first.');
  return { clips, overlays, titles, sounds, videoFrames, total,
    trackSettings:project.trackSettings,masterMuted:project.masterMuted,masterGainDb:project.masterGainDb };
}

function divideTimeline(inputs, start, end, cost = () => 1) {
  const relevant = inputs.filter(clip=>clip.start<end && clip.start+clip.len>start)
    .sort((a,b)=>a.start-b.start);
  const sections = [];
  let sectionInputs = [];
  let units = 0;
  for (const clip of relevant) {
    const weight = cost(clip);
    if (clip.start>start && units+weight>renderInputLimit) {
      sections.push({start,end:clip.start});
      start = clip.start;
      sectionInputs = sectionInputs.filter(item=>item.start+item.len>start);
      units = sectionInputs.reduce((sum,item)=>sum+cost(item),0);
    }
    sectionInputs.push(clip);
    units += weight;
  }
  sections.push({start,end});
  return sections;
}

function timelineSection(timeline, {start,end}) {
  const captions = timeline.titles.filter(title=>title.style==='caption').sort((a,b)=>a.start-b.start);
  const visible = new Map(captions.map((title,i)=>[title,Math.min(title.len,(captions[i+1]?.start ?? Infinity)-title.start)]));
  function slice(items) {
    const clips = [];
    for (const item of items) {
      const first = Math.max(start,item.start);
      const last = Math.min(end,item.start+(visible.get(item) ?? item.len));
      if (first>=last) continue;
      clips.push({...item,start:first-start,len:last-first,sectionOffset:first-item.start,sourceLength:item.len});
    }
    return clips;
  }
  const clips = slice(timeline.clips);
  return {
    ...timeline, clips, overlays:slice(timeline.overlays), titles:slice(timeline.titles), sounds:slice(timeline.sounds),
    videoFrames:Math.max(0,...clips.map(clip=>clip.start+clip.len)), total:end-start
  };
}

function alphaDecoder(asset) {
  if (!asset.alpha) return [];
  if (asset.codec==='vp9') return ['-c:v','libvpx-vp9'];
  if (asset.codec==='vp8') return ['-c:v','libvpx'];
  return [];
}

function addRenderInput(args, clip, batch) {
  if (batch) args.push('-threads','1');
  args.push('-ss',(clip.in/fps).toFixed(6),...alphaDecoder(clip.asset),'-i',`../../media/${clip.asset.id}/source`);
}

async function withRenderSections(folder, sections, ext, prepare, merge) {
  const list = 'sections.ffconcat';
  const files = [];
  try {
    const manifest = ['ffconcat version 1.0'];
    let elapsed = 0;
    for (const [index,section] of sections.entries()) {
      const file = `section-${index}.${ext}`;
      files.push(file);
      await prepare(file,section);
      const end = Math.round((section.end-sections[0].start)*1e6/fps);
      manifest.push('file '+file,'duration '+((end-elapsed)/1e6).toFixed(6));
      elapsed = end;
    }
    await writeFile(join(folder,list),manifest.join('\n')+'\n');
    await merge(list);
  } finally {
    await Promise.all([...files,list].map(file=>rm(join(folder,file),{force:true}).catch(()=>{})));
  }
}

async function render(job, project, timeline) {
  const folder = join(data, 'renders', job.id);
  try {
    await mkdir(folder);
    const range = exportRange(project,timeline.total);
    if (!range.frames) throw new Error('The export Out point must follow the In point.');
    const quality = { high:[17,24,'224k'], balanced:[22,31,'160k'], small:[29,40,'96k'] };
    const [h264, vp9, bitrate] = Object.hasOwn(quality,project.quality) ? quality[project.quality] : quality.high;
    const webm = job.format==='webm';
    const transparent = webm && project.transparent===true;
    const videoEncoding = webm ? ['-c:v','libvpx-vp9','-deadline','good','-cpu-used','5','-b:v','0','-crf',String(vp9)]
      : ['-c:v','libx264','-preset','veryfast','-crf',String(h264)];
    if (transparent) videoEncoding.push('-auto-alt-ref','0');
    const audioEncoding = ['-c:a',webm?'libopus':'aac','-b:a',bitrate];
    const muxOptions = webm ? [] : ['-movflags','+faststart'];
    const output = `video.${job.format}`;
    const fonts = new Map();
    const titles = timeline.titles.filter(title=>!trackSettings(timeline,trackOf(title)).muted);
    const inputs = [...timeline.clips,...timeline.overlays,...timeline.sounds,...titles];
    const renderCost = clip => clip.type?.gradient || clip.type?.depth>14 ? 4 : 1;
    const window = exportWindow(range,timeline.total);
    const windowCost = inputs.reduce((count,clip)=>clip.start<window.end && clip.start+clip.len>window.start ? count+renderCost(clip) : count,0);
    const stage = job.composition ? 'Rendering composition' : 'Rendering video';
    const report = (done, ceiling) => {
      job.progress = Math.min(ceiling,Math.round(done/range.frames*ceiling));
      taskStage(stage,job.progress);
    };
    if (windowCost<=renderInputLimit) {
      const part = window.start===0 && window.end===timeline.total ? timeline : timelineSection(timeline,window);
      const localRange = { start:range.start-window.start, end:range.end-window.start, frames:range.frames };
      await renderSection(folder,project,part,localRange,output,[...videoEncoding,...audioEncoding,...muxOptions],false,frame=>report(frame,99),fonts,transparent);
    } else {
      const sections = divideTimeline(inputs,range.start,range.end,renderCost);
      await withRenderSections(folder,sections,transparent?'mkv':'nut',async(file,section)=>{
        const part = timelineSection(timeline,section);
        await renderSection(folder,project,part,{start:0,end:part.total,frames:part.total},file,
          [...videoEncoding,'-c:a','pcm_f32le'],true,frame=>report(section.start-range.start+frame,95),fonts,transparent);
      },async list=>{
        job.progress = 96;
        await runTimed(['-nostdin','-v','error','-f','concat','-i',list,'-map','0:v:0','-map','0:a:0','-c:v','copy',
          '-af','asetpts=N/SR/TB,'+audioLimiter,...audioEncoding,...muxOptions,output],
          {cwd:folder},'Joining rendered sections',range.frames/fps);
      });
    }
    job.progress = 100;
  } catch (error) {
    job.status = 'error';
    job.error = error.message;
  }
}

async function renderSection(folder, project, timeline, range, output, encoding, batch, onFrame, fonts, transparent) {
  const { clips, overlays, videoFrames, total } = timeline;
  const titles=timeline.titles.filter(title=>!trackSettings(timeline,trackOf(title)).muted);
  const [outputWidth, outputHeight] = sequenceSize(project);
  const odd = (outputWidth % 2 || outputHeight % 2) !== 0;
  const width = outputWidth + outputWidth % 2;
  const height = outputHeight + outputHeight % 2;
  const filter = [];
  const args = ['-nostdin', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-filter_complex_threads', '2'];
  const segments=[];
  const background = `color=c=${transparent?'black@0':'black'}:s=${width}x${height}:r=${fps}${transparent?',format=yuva420p':''}`;
  let previous=0;
  const gap=(frames)=>{
    const label='gap'+segments.length;
    filter.push(`${background},trim=end_frame=${frames}[${label}]`);
    segments.push(label);
  };
  for (const [i, clip] of clips.entries()) {
    if(clip.start>previous) gap(clip.start-previous);
    addRenderInput(args,clip,batch);
    const effects = backgroundKey(clip.backgroundKey) || hasVideoFraming(clip) || Object.keys(properties).some(key => key!=='reveal' && changed(clip,key));
    videoStream(filter, clip, i, width,height, Boolean(effects || transparent), `vs${i}`);
    if (effects) {
      filter.push(`${background},trim=end_frame=${clip.len}[black${i}]`);
      composite(filter, `black${i}`, `vs${i}`, clip, 0, `v${i}`, width, height,transparent);
    } else {
      filter.push(`[vs${i}]null[v${i}]`);
    }
    segments.push(`v${i}`);
    previous=clip.start+clip.len;
  }
  if(total>videoFrames) gap(total-videoFrames);
  // A one-frame segment can leave the concat filter with a zero-length timestamp span.
  const frameClock = `settb=1/${fps},setpts=N`;
  const holdFrame = frames => frames>1 ? [`loop=loop=${frames-1}:size=1:start=0`,frameClock] : [];
  filter.push(`${segments.map(label=>`[${label}]`).join('')}concat=n=${segments.length}:v=1:a=0,${frameClock}[vbase]`);
  let video = 'vbase';
  for (const [index, clip] of overlays.entries()) {
    const input = clips.length + index;
    addRenderInput(args,clip,batch);
    videoStream(filter,clip,input,width,height,true,`layer${index}`);
    filter.push(`[layer${index}]setpts=PTS+${clip.start}/(${fps}*TB)[layerdelay${index}]`);
    composite(filter,video,`layerdelay${index}`,clip,clip.start,`layered${index}`,width,height,transparent);
    video = `layered${index}`;
  }
  audioFilter(args,filter,timeline,{reuse:true,batch,limit:!batch});
  const captions=titles.filter(title=>title.style==='caption').sort((a,b)=>a.start-b.start);
  const captionSegments=[];
  let captionEnd=0;
  const captionGap=(frames)=>{
    const label='captgap'+captionSegments.length;
    filter.push(`color=c=black@0:s=${width}x${height}:r=${fps},format=yuva420p,trim=end_frame=${frames}[${label}]`);
    captionSegments.push(label);
  };
  for (const [i, title] of titles.entries()) {
    const caption=title.style==='caption';
    const next=caption ? captions[captions.indexOf(title)+1] : null;
    const visibleLength=next ? Math.min(title.len,next.start-title.start):title.len;
    if(visibleLength<=0) continue;
    const type=titleType(title);
    const font=await stageTitleFont(folder,fonts,type);
    const size=height*type.size/100;
    const units=height/1080;
    const maxColumns=Math.max(12,Math.floor(width*.84/(size*(.56+type.tracking*.08))));
    const wrapped=wrapText(title.text,maxColumns);
    const chars = textCharacters(wrapped);
    const reveal = usesTextReveal(title);
    const animatedText = reveal || title.typewriter;
    const count = animatedText ? typewriterSteps(chars) : 1;
    const rasterFrames = animatedText ? visibleLength : 1;
    const sourceLength = title.sourceLength ?? title.len;
    const localFrame = title.sectionOffset ? `(n+${title.sectionOffset})` : 'n';
    const typing = typewriterDuration(sourceLength);
    const progress = reveal ? expression(title,'reveal',localFrame) : `min(100,(${localFrame}+1)*100/${typing})`;
    const longest=Math.max(1,...wrapped.split('\n').map(row=>[...row].length));
    const fontSize=Math.max(8,Math.round(Math.min(size,width*.86/(longest*(.56+type.tracking*.08)))));
    const x=type.align==='left' ? 'w*0.075' : type.align==='right' ? 'w*0.925-tw' : '(w-tw)/2';
    const baseY=caption ? .91 : title.style==='lower' ? .87 : .5;
    const anchorY=titleVerticalAnchor(title);
    const y=`h*${baseY}-th*${anchorY}`;
    const draw=[], shadow=[], mask=[];
    const depth = [...new Set(extrusionOffsets(type).map(([x,y])=>`${Math.round(x*units)},${Math.round(y*units)}`))]
      .filter(pair=>pair!=='0,0').map(pair=>pair.split(','));
    const color=(hex,alpha=100)=>`0x${hex.slice(1)}@${(alpha/100).toFixed(3)}`;
    // Only generate states the requested frames can display. Long clips can use the full bounded list.
    const visibleParts = animatedText && visibleLength<=300 ? new Set() : null;
    if (visibleParts) for (let frame=0;frame<visibleLength;frame++) {
      const local = frame+(title.sectionOffset ?? 0);
      const percent = reveal ? valueAt(title,'reveal',local) : Math.min(100,(local+1)*100/typing);
      const part = Math.ceil(percent*count/100)-1;
      for (const offset of [-1,0,1]) visibleParts.add(part+offset);
    }
    for (let part = 0; part < count; part++) {
      if (visibleParts && !visibleParts.has(part)) continue;
      const file = `title-${i}-${part}.txt`;
      await writeFile(join(folder,file),typographyText(textFragment(chars,count,part+1),type));
      const enable = `gt(${progress},${part*100/count})*lte(${progress},${(part+1)*100/count})`;
      const base=`drawtext=fontfile=${font}:textfile=${file}:expansion=none:fontsize=${fontSize}:line_spacing=${Math.round(fontSize*(type.leading-1))}:text_align=${type.align}${animatedText ? `:enable='${enable}'` : ''}`;
      if(type.shadow) shadow.push(`${base}:fontcolor=black@${type.shadow/100}:x=(${x})+(${Math.round(type.shadowX*units)}):y=(${y})+(${Math.round(type.shadowY*units)})`);
      const box=type.boxOpacity ? `:box=1:boxcolor=${color(type.background,type.boxOpacity)}:boxborderw=${Math.round(type.padding*units)}` : '';
      if(box && depth.length) draw.push(`${base}:fontcolor=white@0:x=${x}:y=${y}${box}`);
      for (const [dx,dy] of depth) {
        draw.push(`${base}:fontcolor=${color(type.depthColor)}:x=(${x})+(${dx}):y=(${y})+(${dy})`);
      }
      const border = Math.round(type.outline*units);
      if (!type.gradient || border || box) {
        const fill = !type.gradient ? color(type.fill) : border ? color(type.outlineColor) : 'white@0';
        draw.push(`${base}:fontcolor=${fill}:borderw=${border}:bordercolor=${color(type.outlineColor)}:x=${x}:y=${y}${depth.length?'':box}`);
      }
      if (type.gradient) mask.push(`${base}:fontcolor=white:x=${x}:y=${y}`);
    }
    if(shadow.length && type.blur) shadow.push(`gblur=sigma=${Math.max(.1,type.blur*units)}:planes=8`);
    const canvas = `color=c=black@0:s=${width}x${height}:r=${fps},format=yuva420p,trim=end_frame=${rasterFrames}`;
    // Repeat the painted text before motion so its keyframes still run on every frame.
    const finish = [...(animatedText ? [] : holdFrame(visibleLength)),...motionFilters(title),`setpts=PTS+${caption?0:title.start}/(${fps}*TB)`].join(',');
    if (type.gradient) {
      const faceWidth = Math.min(width*.9,longest*fontSize*(.56+type.tracking*.08));
      const faceHeight = fontSize*(.78+(wrapped.split('\n').length-1)*type.leading);
      const cx = type.align==='left' ? width*.075+faceWidth/2 : type.align==='right' ? width*.925-faceWidth/2 : width/2;
      const cy = height*baseY+faceHeight*(.5-anchorY);
      const paint = gradientPaint(type.gradient,cx,cy,faceWidth,faceHeight);
      filter.push([canvas,...shadow,...draw].join(',')+`[under${i}]`);
      filter.push([canvas,...mask,'alphaextract'].join(',')+`[mask${i}]`);
      filter.push([`color=c=black:s=${width}x${height}:r=${fps},trim=end_frame=1,format=gbrp`,paint,...holdFrame(rasterFrames)].join(',')+`[paint${i}]`);
      filter.push(`[paint${i}][mask${i}]alphamerge[face${i}]`);
      filter.push(`[under${i}][face${i}]overlay=format=auto:shortest=1,${finish}[title${i}]`);
    } else {
      filter.push([canvas,...shadow,...draw,finish].join(',')+`[title${i}]`);
    }
    if (!caption) {
      composite(filter,video,`title${i}`,title,title.start,`titled${i}`,width,height,transparent);
      video = `titled${i}`;
    } else {
      if(title.start>captionEnd) captionGap(title.start-captionEnd);
      if (['x','y','scale'].some(key=>changed(title,key)) || titlePositionOffset(title,'x') || titlePositionOffset(title,'y')) {
        filter.push(`color=c=black@0:s=${width}x${height}:r=${fps},format=yuva420p,trim=end_frame=${visibleLength}[captbase${i}]`);
        composite(filter,`captbase${i}`,`title${i}`,{...title,len:visibleLength},0,`caption${i}`,width,height,true);
        captionSegments.push(`caption${i}`);
      } else captionSegments.push(`title${i}`);
      captionEnd=title.start+visibleLength;
    }
  }
  if(captionSegments.length) {
    filter.push(`${captionSegments.map(label=>`[${label}]`).join('')}concat=n=${captionSegments.length}:v=1:a=0,${frameClock}[captions]`);
    composite(filter,video,'captions',{len:captionEnd},0,'withcaptions',width,height,transparent);
    video='withcaptions';
  }
  const pixelFormat = transparent ? 'yuva420p' : odd ? 'yuv444p' : 'yuv420p';
  const crop = odd ? `,format=${pixelFormat},crop=${outputWidth}:${outputHeight}:0:0:exact=1` : '';
  filter.push(`[${video}]trim=start_frame=${range.start}:end_frame=${range.end},setpts=PTS-STARTPTS${crop}[picture]`);
  filter.push(`[audio]atrim=start_sample=${range.start * 1600}:end_sample=${range.end * 1600},asetpts=PTS-STARTPTS[sound]`);
  await writeFile(join(folder, 'graph.ffscript'), filter.join(';\n'));
  let buffered = '';
  await run(ffmpeg, [
    ...args, '-/filter_complex', 'graph.ffscript',
    '-map', '[picture]', '-map', '[sound]',
    ...encoding,'-pix_fmt',pixelFormat,output
  ], { cwd: folder, progress(chunk) {
    const lines = (buffered + chunk).split('\n');
    buffered = lines.pop();
    for (const line of lines) {
      const match = line.match(/^frame=\s*(\d+)/);
      if (match) onFrame(Number(match[1]));
    }
  } });
}

function gradientPaint(gradient,cx,cy,width,height) {
  const radians = gradient.angle*Math.PI/180;
  const dx = Math.sin(radians), dy = -Math.cos(radians);
  const span = Math.max(1,Math.abs(dx*width)+Math.abs(dy*height));
  const at = `(0.5+((X-${cx})*${dx.toFixed(8)}+(Y-${cy})*${dy.toFixed(8)})/${span})`;
  function colorChannel(index) {
    const stops = gradient.stops.map(([position,color])=>[position,parseInt(color.slice(1+index*2,3+index*2),16)]);
    let value = String(stops.at(-1)[1]);
    for (let i=stops.length-1;i>0;i--) {
      const [end,to] = stops[i];
      const [start,from] = stops[i-1];
      value = `if(lte(${at},${end}),${from}+(${to-from})*clip((${at}-${start})/${end-start},0,1),${value})`;
    }
    return value;
  }
  return 'geq='+['r','g','b'].map((key,index)=>`${key}='${colorChannel(index)}'`).join(':');
}

function changed(clip,key) { return points(clip,key).some(([,value]) => value !== properties[key][3]); }

function motionFilters(clip, framing = false) {
  const result = [];
  const at = (key, frame = 'N') => expression(clip,key,clip.sectionOffset ? `(${frame}+${clip.sectionOffset})` : frame);
  if (changed(clip,'brightness') || changed(clip,'contrast') || changed(clip,'saturation')) {
    result.push(`eq=brightness='(${at('brightness','n')}-100)/180':contrast='(${at('contrast','n')})/100':saturation='(${at('saturation','n')})/100':eval=frame`);
  }
  const masked = ['left','right','top','bottom'].some(key => changed(clip,key));
  const opacity = changed(clip,'opacity');
  if (masked || opacity) {
    const mask = masked ? `*gte(X/W,(${at('left')})/100)*lt(X/W,1-(${at('right')})/100)*gte(Y/H,(${at('top')})/100)*lt(Y/H,1-(${at('bottom')})/100)` : '';
    if (!masked && points(clip,'opacity').length === 1) result.push(`lut=a='val*(${at('opacity')})/100'`);
    else result.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*(${at('opacity')})/100${mask}'`);
  }
  if (changed(clip,'rotation')) {
    const angle = `(${at('rotation','n')})*PI/180`;
    const staticAngle = points(clip,'rotation').length===1;
    const bounds = !framing ? '' : staticAngle ?
      `:ow='ceil(rotw(${angle})/2)*2':oh='ceil(roth(${angle})/2)*2'` :
      ":ow='ceil(hypot(iw,ih)/2)*2':oh=ow";
    result.push(`rotate='${angle}'${bounds}:fillcolor=black@0`);
  }
  if (changed(clip,'scale')) {
    const scale = at('scale','n');
    result.push(`scale=w='max(2,trunc(iw*(${scale})/200)*2)':h='max(2,trunc(ih*(${scale})/200)*2)':eval=frame,setsar=1`);
  }
  return result;
}

function fitVideoFilter(clip,width,height) {
  const [w,h] = {
    contain:[`min(${width},${height}*dar)`,`min(${height},${width}/dar)`],
    stretch:[width,height],
    width:[width,`${width}/dar`],
    height:[`${height}*dar`,height]
  }[videoFit(clip)];
  const horizontal = videoStretch(clip.stretchWidth);
  const vertical = videoStretch(clip.stretchHeight);
  return `scale=w='max(2,round((${w})*${horizontal}/200)*2)':h='max(2,round((${h})*${vertical}/200)*2)':reset_sar=1,setsar=1`;
}

function videoStream(filter,clip,input,width,height,alpha,output) {
  const chain = ['setpts=PTS-STARTPTS',`fps=${fps}:round=up`];
  const framing = hasVideoFraming(clip);
  const offset = clip.sectionOffset ?? 0;
  const trim = [`tpad=stop_mode=clone:stop_duration=${((clip.sourceLength ?? clip.len)/fps).toFixed(6)}`,
    `trim=start_frame=${offset}:end_frame=${offset+clip.len}`,'setpts=PTS-STARTPTS'];
  if (offset) chain.push(...trim);
  if (clip.lut && luts.has(clip.lut)) chain.push(`lut3d=file=../../luts/${clip.lut}.cube`);
  const key = backgroundKey(clip.backgroundKey);
  const source = `${input}:${clip.asset.video}`;
  let current = source;
  if (key) {
    if (!offset) chain.push(...trim);
    const params = keyParameters(key,clip.asset.matrix,clip.asset.fullRange);
    chain.push('format=yuva444p');
    const keyInput = `${output}keyinput`;
    if (clip.asset.alpha) {
      filter.push(`[${source}]${chain.join(',')},split[${keyInput}][${output}original]`);
      filter.push(`[${output}original]alphaextract[${output}originalalpha]`);
    } else filter.push(`[${source}]${chain.join(',')}[${keyInput}]`);
    chain.length = 0;
    current = `${output}keyed`;
    const keyed = [];
    if (key.mode==='luma') {
      const range = clip.asset.fullRange ? 1 : 219/255;
      const bottom = clip.asset.fullRange ? 0 : 16/255;
      keyed.push(`lumakey=threshold=0:tolerance=${bottom+params.cutoff*range}:softness=${key.softness*range}`);
    } else {
      const uv = params.uv.map(value=>Math.min(255,Math.round(128+value*255)).toString(16).padStart(2,'0')).join('');
      keyed.push(`chromakey=color=0x80${uv}:similarity=${Math.max(.00001,key.tolerance)}:blend=${key.softness}:yuv=1`);
      if (params.spill && key.spill) {
        const type = params.spill===1 ? 'green' : 'blue';
        keyed.push(`despill=type=${type}:green=${params.spill===1?-key.spill:0}:blue=${params.spill===2?-key.spill:0}:alpha=0`);
      }
    }
    if (clip.asset.alpha) {
      filter.push(`[${keyInput}]${keyed.join(',')},split[${output}colors][${output}matte]`);
      filter.push(`[${output}matte]alphaextract[${output}keyalpha]`);
      filter.push(`[${output}originalalpha][${output}keyalpha]blend=all_mode=multiply[${output}alpha]`);
      filter.push(`[${output}colors][${output}alpha]alphamerge[${current}]`);
    } else filter.push(`[${keyInput}]${keyed.join(',')}[${current}]`);
  }
  chain.push(`format=${alpha ? 'yuva420p' : 'yuv420p'}`,framing ? fitVideoFilter(clip,width,height) : encodeSize(width,height,alpha));
  if (!offset && !key) chain.push(...trim);
  if (alpha) chain.push(...motionFilters(clip,framing));
  filter.push(`[${current}]${chain.join(',')}[${output}]`);
}

function composite(filter, base, layer, clip, start, target, width, height, alpha=false) {
  const at = `(max(0,round(t*${fps})-${start})+${clip.sectionOffset ?? 0})`;
  const x = `(main_w-overlay_w)/2+${width}*(${expression(clip,'x',at)}+(${titlePositionOffset(clip,'x')}))/100`;
  const y = `(main_h-overlay_h)/2+${height}*(${expression(clip,'y',at)}+(${titlePositionOffset(clip,'y')}))/100`;
  filter.push(`[${base}][${layer}]overlay=x='${x}':y='${y}':eof_action=pass:repeatlast=0${alpha?':format=auto':''}:enable='gte(t,${start/fps})*lt(t,${(start+clip.len)/fps})'[${target}]`);
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function serveFile(req, res, path, type, download) {
  const { size } = await stat(path);
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  if (type.startsWith('text/html')) {
    headers['Content-Security-Policy'] = "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  }
  if (download) headers['Content-Disposition'] = `attachment; filename="${download}"`;
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(end, Number(range[2])) : end;
      if (start < size && start <= end) {
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      }
    }
    if (status !== 206) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
  }
  res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  await pipeline(createReadStream(path, { start, end }), res).catch(error => {
    if (!res.destroyed) throw error;
  });
}

const routes = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/workspace.css': ['workspace.css', 'text/css; charset=utf-8'],
  '/projects.css': ['projects.css', 'text/css; charset=utf-8'],
  '/editor.js': ['editor.js', 'text/javascript; charset=utf-8'],
  '/projects.mjs': ['projects.mjs', 'text/javascript; charset=utf-8'],
  '/sequences.mjs': ['sequences.mjs', 'text/javascript; charset=utf-8'],
  '/led.mjs': ['led.mjs', 'text/javascript; charset=utf-8'],
  '/motion.mjs': ['motion.mjs', 'text/javascript; charset=utf-8'],
  '/keying.mjs': ['keying.mjs', 'text/javascript; charset=utf-8'],
  '/key-preview.mjs': ['key-preview.mjs', 'text/javascript; charset=utf-8'],
  '/text.mjs': ['text.mjs','text/javascript; charset=utf-8'],
  '/sound.mjs': ['sound.mjs','text/javascript; charset=utf-8'],
  '/layout.mjs': ['layout.mjs','text/javascript; charset=utf-8'],
  '/updates-ui.mjs': ['updates-ui.mjs','text/javascript; charset=utf-8'],
  '/tracks.mjs': ['tracks.mjs','text/javascript; charset=utf-8'],
  '/graphics.mjs': ['graphics.mjs','text/javascript; charset=utf-8']
};

async function requestJson(req, limit=1_000_000) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('This request is too large.');
  }
  return JSON.parse(body);
}

const server = createServer(async (req, res) => {
  if ((desktopToken && req.headers['x-framecut-desktop'] !== desktopToken) ||
      req.headers.host !== `127.0.0.1:${port}` ||
      (req.headers.origin && req.headers.origin !== origin)) {
    return json(res, 403, { error: 'Open Framecut through its local launcher.' });
  }
  const path = new URL(req.url, origin).pathname;
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (routes[path]) {
        const [file, type] = routes[path];
        return await serveFile(req, res, join(root, file), type);
      }
      if (path === '/api/media') return json(res, 200, [...assets.values()]);
      if (path === '/api/tasks') return json(res,200,activityList());
      const youtubeMatch = /^\/api\/youtube\/jobs\/([\da-f-]{36})$/.exec(path);
      if (youtubeMatch) {
        const job = youtubeJobs.get(youtubeMatch[1]);
        if (!job) return json(res,404,{error:'This YouTube request has expired.'});
        const {id,status,result,error} = job;
        return json(res,200,{id,status,result,error,task:taskDetails(job.taskId)});
      }
      if (path === '/api/luts') return json(res, 200, [...luts.values()]);
      if (path === '/api/tools') return json(res,200,{ objectRemoval:aiReady, transcription:Boolean(whisperHome) });
      if (path === '/api/fonts') return json(res,200,await installedFontNames());
      const sound=/^\/media\/([a-f\d-]+)\/audio\.(?:wav|mp3)$/.exec(path);
      const soundAsset = sound && assets.get(sound[1]);
      if(soundAsset && soundAsset.audio !== null) return await serveFile(req,res,await audioPreview(soundAsset),soundAsset.audioMime || 'audio/wav');
      const program = /^\/media\/([a-f\d-]+)\/p-(auto|full|half|quarter|low)(?:-([a-f\d-]+))?\.(mp4|webm)$/.exec(path);
      if (program && assets.has(program[1]) && (!program[3] || luts.has(program[3]))) {
        const asset=assets.get(program[1]);
        if(asset.nativeMime && !program[3] && ['auto','full'].includes(program[2])){
          return await serveFile(req,res,join(assetRoot,asset.id,'source'),asset.nativeMime);
        }
        const file = await proxy(asset,program[2],program[3]);
        return await serveFile(req,res,file,asset.alpha ? 'video/webm' : 'video/mp4');
      }
      const media = /^\/media\/([a-f\d-]+)\/(preview\.mp4|thumb\.jpg)$/.exec(path);
      if (media && assets.has(media[1])) {
        if(media[2].endsWith('.jpg')) return await serveFile(req,res,join(assetRoot,media[1],media[2]),'image/jpeg');
        const asset=assets.get(media[1]);
        return await serveFile(req,res,await proxy(asset,'half'),asset.alpha?'video/webm':'video/mp4');
      }
      const match = /^\/api\/exports\/([a-f\d-]+)(\/download)?$/.exec(path);
      const job = match && exports.get(match[1]);
      if (job && !match[2]) return json(res, 200, job);
      if (job?.status === 'ready' && !job.composition) {
        const type = { webm:'video/webm', mov:'video/quicktime', mp4:'video/mp4' }[job.format];
        return await serveFile(req, res, getRender(job.id).path, type, job.filename);
      }
    } else if (req.method === 'POST' && req.headers['x-framecut'] === '1') {
      const cancel = /^\/api\/tasks\/([a-f\d-]+)\/cancel$/.exec(path);
      if (cancel) return cancelTask(cancel[1]) ? json(res,200,{cancelled:true}) : json(res,409,{error:'This task has already finished or is stopping.'});
      if (path === '/api/youtube/inspect') {
        const video = youtubeVideo((await requestJson(req,4096)).url);
        return json(res,202,startYoutubeJob('Check YouTube video',async job=>{
          const info = await youtube.inspect(video);
          job.info = info;
          const {combined,video:videoOnly,audio} = info.choices;
          const qualities = list=>list.map(({quality,width,height,fps,ext,size})=>({quality,width,height,fps,ext,size}));
          return {title:info.title,duration:info.duration,modes:{
            combined:qualities(combined),video:qualities(videoOnly),audio:audio?mp3Bitrates:[]
          }};
        }));
      }
      if (path === '/api/youtube/download') {
        const {id,mode='combined',quality,bitrate} = await requestJson(req,4096);
        const inspected = youtubeJobs.get(id);
        if (inspected?.status!=='ready' || !inspected.info || Date.now()-inspected.started>20*60*1000) {
          return json(res,400,{error:'Check the YouTube link again and choose one of its available qualities.'});
        }
        const choices = inspected.info.choices;
        let choice;
        if (mode==='audio' && choices.audio && mp3Bitrates.includes(bitrate)) choice = {audio:choices.audio,bitrate};
        if (mode==='combined' || mode==='video') choice = choices[mode].find(item=>item.quality===quality);
        if (!choice) return json(res,400,{error:'Choose an available YouTube format and quality.'});
        return json(res,202,startYoutubeJob(`Import ${inspected.info.title}`,()=>youtube.download(inspected.info,choice)));
      }
      if (path === '/api/media') return json(res, 201, await importVideo(req));
      if (path === '/api/audio') return json(res,201,await withTask('Importing audio',()=>importAudio(req)));
      if (path === '/api/sound') return json(res,201,await withTask('Creating sound',async()=>createSound(await requestJson(req))));
      if (path === '/api/transcribe') return json(res,200,await withTask('Generating subtitles',async()=>transcribe(await requestJson(req))));
      if (path === '/api/luts') return json(res,201,await importLut(req));
      if (path === '/api/analyze') return json(res,200,await withTask('Analyzing color',async()=>sampleGrade(sourceClip(await requestJson(req)))));
      if (path === '/api/upscale') return json(res,201,await withTask('Upscaling video',async()=>upscaleSource(sourceClip(await requestJson(req)))));
      if (path === '/api/loop') return json(res,201,await withTask('Finding closest loop',async()=>loopSource(sourceClip(await requestJson(req)))));
      if (path === '/api/repeat-loop') return json(res,201,await withTask('Repeating loop',async()=>repeatLoop(await requestJson(req))));
      if (path === '/api/graphics') return json(res,201,await withTask('Creating graphic',async()=>createGraphic(await requestJson(req))));
      if (path === '/api/track') {
        const body = await requestJson(req);
        return json(res,200,await withTask('Motion tracking',()=>trackSource(sourceClip(body),body.box)));
      }
      if (path === '/api/remove-object') {
        const body = await requestJson(req);
        return json(res,201,await withTask('Object removal',()=>removeObject(sourceClip(body),body.box,body.follow === true)));
      }
      if (path === '/api/exports' || path === '/api/compositions') {
        const composition = path === '/api/compositions';
        const request = await requestJson(req,8_000_000);
        const project = composition ? { ...request, markIn:null, markOut:null, quality:'high' } : request;
        const timeline = readTimeline(project);
        if (!composition && [...exports.values()].some(job => !job.composition && job.status === 'rendering')) {
          return json(res, 409, { error: 'Wait for the active export to finish.' });
        }
        const name = String(project.name || 'Framecut').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 80) || 'Framecut';
        const format = !composition && ['mov','webm'].includes(project.format) ? project.format : 'mp4';
        const job = { id: randomUUID(), status: 'rendering', progress: 0, filename: `${name}.${format}`, format, composition };
        exports.set(job.id, job);
        void withTask(composition ? `Prepare composition · ${request.name || name}` : `Export ${job.filename}`,async()=>{
          const signal = taskSignal();
          const folder = join(data, 'renders', job.id);
          try {
            taskStage(composition ? 'Preparing composition' : 'Preparing export');
            await render(job,project,timeline);
            signal.throwIfAborted();
            if(job.status==='error') throw new Error(job.error);
            if (composition) {
              const video = join(folder, `video.${format}`);
              job.asset = await ingest(randomUUID(), String(request.name || name).slice(0,80),
                destination => rename(video, destination), { registerEarly:true, composition:true });
              await rm(folder, {recursive:true, force:true}).catch(()=>{});
            }
            signal.throwIfAborted();
            job.status = 'ready';
          } catch (error) {
            job.status = signal.aborted ? 'cancelled' : 'error';
            job.error = error.message;
            throw error;
          } finally {
            if (job.status !== 'ready') await rm(folder, {recursive:true, force:true}).catch(()=>{});
          }
        }, {cancellable:true}).catch(()=>{});
        return json(res, 202, job);
      }
    }
    return json(res, 404, { error: 'File or operation unavailable.' });
  } catch (error) {
    if (!res.headersSent && !res.destroyed) json(res, 400, { error: error.message });
    else res.end();
  }
});

function openEditor() {
  if (process.platform !== 'win32') return;
  const child = spawn('cmd.exe', ['/d', '/c', 'start', '', origin], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

export const ready = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => {
    server.off('error', reject);
    port = server.address().port;
    origin = `http://127.0.0.1:${port}`;
    resolve(origin);
  });
});

async function launch() {
  try {
    await ready;
    console.log(`Framecut is running at ${origin}. Keep this window open while editing.`);
    if (process.argv.includes('--open')) openEditor();
  } catch (error) {
    if (error.code === 'EADDRINUSE' && process.argv.includes('--open')) {
      try {
        const previous = await fetch(`${origin}/api/media`);
        if (previous.ok && Array.isArray(await previous.json())) return openEditor();
      } catch {
        // Surface the port error if the running service is not Framecut.
      }
    }
    console.error(error.message);
    process.exitCode = 1;
  }
}
server.requestTimeout = 0;
if (!desktopToken) void launch();
