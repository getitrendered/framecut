import { execFile } from 'node:child_process';
import { open, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { fontFamilies } from './text.mjs';

const exec = promisify(execFile);
const systemFonts = join(process.env.WINDIR || 'C:/Windows','Fonts');
const userFonts = join(process.env.LOCALAPPDATA || join(homedir(),'AppData','Local'),'Microsoft','Windows','Fonts');
const fontExtension = /\.(?:ttf|otf|ttc|otc)$/i;
const fontSignatures = new Set([0x00010000,0x4f54544f,0x74727565]);
const utf16 = new TextDecoder('utf-16be');
const macRoman = new TextDecoder('macintosh');
const styles = [[400,false],[700,false],[400,true],[700,true]];
let installed;

const registryScript = String.raw`
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $paths = foreach ($scope in 'HKCU','HKLM') {
    $key = Get-Item -LiteralPath ($scope + ':\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts') -ErrorAction SilentlyContinue
    if ($key) {
      foreach ($name in $key.GetValueNames()) {
        $file = $key.GetValue($name)
        if ($file -isnot [string] -or !$file) { continue }
        if ([IO.Path]::IsPathRooted($file)) { $file }
        elseif ($scope -eq 'HKLM' -and $env:WINDIR) { Join-Path $env:WINDIR ('Fonts\' + $file) }
        elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA ('Microsoft\Windows\Fonts\' + $file) }
      }
    }
  }
  ConvertTo-Json -Compress -InputObject @($paths)
`;

async function registeredPaths() {
  if (process.platform!=='win32') return [];
  try {
    const {stdout} = await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(registryScript,'utf16le').toString('base64')],{windowsHide:true,timeout:5000});
    const paths = JSON.parse(stdout);
    return Array.isArray(paths) ? paths.filter(path=>typeof path==='string') : [];
  } catch { return []; }
}

async function directoryPaths(folder) {
  return (await readdir(folder).catch(()=>[])).map(file=>join(folder,file));
}

function tables(directory, size) {
  if (directory.length<12 || !fontSignatures.has(directory.readUInt32BE(0))) return [];
  const count = directory.readUInt16BE(4);
  if (count>512 || directory.length<12+count*16) return [];
  const result = [];
  for (let i=12;i<12+count*16;i+=16) {
    const tag = directory.toString('ascii',i,i+4);
    const offset = directory.readUInt32BE(i+8);
    const length = directory.readUInt32BE(i+12);
    if (offset+length>size) return [];
    result.push({tag,offset,length,index:i});
  }
  return result;
}

function fontNames(name) {
  const names = new Map();
  if (!name || name.length<6) return names;
  const end = Math.min(name.length,6+name.readUInt16BE(2)*12);
  const firstString = name.readUInt16BE(4);
  for (let i=6;i+12<=end;i+=12) {
    const platform = name.readUInt16BE(i);
    if (![0,1,3].includes(platform)) continue;
    const id = name.readUInt16BE(i+6);
    if (![1,2,16,17].includes(id)) continue;
    const length = name.readUInt16BE(i+8);
    const offset = firstString+name.readUInt16BE(i+10);
    if (offset+length>name.length || (platform!==1 && length%2)) continue;
    const language = name.readUInt16BE(i+4);
    const priority = platform===3 ? (language & 0x3ff)===9 ? 4 : 2 : platform===0 ? 3 : 1;
    if ((names.get(id)?.priority ?? 0)>=priority) continue;
    const value = (platform===1?macRoman:utf16).decode(name.subarray(offset,offset+length)).replace(/\p{Cc}/gu,'').trim();
    if (value && value.length<=200) names.set(id,{value,priority});
  }
  return names;
}

async function scanFile(path) {
  const file = await open(path,'r');
  try {
    const {size} = await file.stat();
    const read = async (offset,length) => {
      if (offset+length>size) return null;
      const data = Buffer.alloc(length);
      const result = await file.read(data,0,length,offset);
      return result.bytesRead===length ? data : null;
    };
    const header = await read(0,12);
    if (!header) return [];
    let offsets = [0];
    if (header.toString('ascii',0,4)==='ttcf') {
      const count = header.readUInt32BE(8);
      if (count>256) return [];
      const index = await read(12,count*4);
      if (!index) return [];
      offsets = Array.from({length:count},(_,i)=>index.readUInt32BE(i*4));
    }
    const faces = [];
    for (const offset of offsets) {
      const face = await read(offset,12);
      if (!face || !fontSignatures.has(face.readUInt32BE(0)) || face.readUInt16BE(4)>512) continue;
      const directory = await read(offset,12+face.readUInt16BE(4)*16);
      const fields = tables(directory || Buffer.alloc(0),size);
      const name = fields.find(field=>field.tag==='name');
      if (!name || name.length>512*1024) continue;
      const names = fontNames(await read(name.offset,name.length));
      const families = [...new Set([names.get(16)?.value,names.get(1)?.value].filter(Boolean))];
      if (!families.length) continue;
      const os2 = fields.find(field=>field.tag==='OS/2' && field.length>=64);
      const metrics = os2 && await read(os2.offset,64);
      const style = names.get(17)?.value || names.get(2)?.value || '';
      const weight = metrics?.readUInt16BE(4) || (/bold/i.test(style)?700:400);
      const italic = Boolean((metrics?.readUInt16BE(62) ?? 0)&513) || /italic|oblique/i.test(style);
      faces.push({families,path,offset,weight,italic});
    }
    return faces;
  } finally { await file.close(); }
}

async function scanFonts() {
  const sources = await Promise.all([registeredPaths(),directoryPaths(userFonts),directoryPaths(systemFonts)]);
  const paths = new Map();
  for (const path of sources.flat()) {
    if (fontExtension.test(path) && isAbsolute(path) && !path.startsWith('\\\\')) paths.set(path.toLowerCase(),path);
  }
  const catalog = new Map();
  const files = [...paths.values()];
  for (let i=0;i<files.length;i+=24) {
    const groups = await Promise.all(files.slice(i,i+24).map(file=>scanFile(file).catch(()=>[])));
    for (const face of groups.flat()) {
      for (const family of face.families) {
        const key = family.toLowerCase();
        if (!catalog.has(key)) catalog.set(key,{family,faces:[]});
        catalog.get(key).faces.push(face);
      }
    }
  }
  return catalog;
}

export async function installedFontNames() {
  const catalog = await (installed ??= scanFonts());
  return Array.from(catalog.values(),entry=>entry.family).sort((a,b)=>a.localeCompare(b));
}

function singleFace(data, offset) {
  if (!offset) return data;
  const count = data.readUInt16BE(offset+4);
  const directorySize = 12+count*16;
  const directory = data.subarray(offset,offset+directorySize);
  const fields = tables(directory,data.length);
  if (!fields.length) throw new Error('The font collection could not be read.');
  const padded = length=>Math.ceil(length/4)*4;
  const font = Buffer.alloc(directorySize+fields.reduce((size,field)=>size+padded(field.length),0));
  directory.copy(font);
  let start = directorySize;
  let adjustment;
  for (const field of fields) {
    data.copy(font,start,field.offset,field.offset+field.length);
    font.writeUInt32BE(start,field.index+8);
    if (field.tag==='head' && field.length>=12) adjustment = start+8;
    start += padded(field.length);
  }
  if (adjustment!==undefined) {
    font.writeUInt32BE(0,adjustment);
    let sum = 0;
    for (let i=0;i<font.length;i+=4) sum = (sum+font.readUInt32BE(i))>>>0;
    font.writeUInt32BE((0xb1b0afba-sum)>>>0,adjustment);
  }
  return font;
}

export async function stageTitleFont(folder, staged, {family,weight}) {
  const key = family+'\0'+weight;
  if (staged.has(key)) return staged.get(key);
  const defaultFont = () => readFile(join(systemFonts,fontFamilies['Segoe UI'][weight]));
  let bytes;
  if (Object.hasOwn(fontFamilies,family)) {
    bytes = await readFile(join(systemFonts,fontFamilies[family][weight])).catch(defaultFont);
  } else {
    const entry = (await (installed ??= scanFonts())).get(family.toLowerCase());
    if (entry) {
      const [desiredWeight,desiredItalic] = styles[weight];
      const score = face=>Math.abs(face.weight-desiredWeight)+(face.italic===desiredItalic?0:1000);
      const face = entry.faces.reduce((best,face)=>score(face)<score(best)?face:best);
      try { bytes = singleFace(await readFile(face.path),face.offset); }
      catch { /* A font can be removed between launch and export. */ }
    }
    bytes ??= await defaultFont();
  }
  const file = `font-${staged.size}.ttf`;
  await writeFile(join(folder,file),bytes);
  staged.set(key,file);
  return file;
}
