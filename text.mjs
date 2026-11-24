import { presets, properties, valueAt } from './motion.mjs';

export const fontFamilies = {
  'Segoe UI': ['segoeui.ttf','segoeuib.ttf','segoeuii.ttf','segoeuiz.ttf'],
  Arial: ['arial.ttf','arialbd.ttf','ariali.ttf','arialbi.ttf'],
  Georgia: ['georgia.ttf','georgiab.ttf','georgiai.ttf','georgiaz.ttf'],
  'Times New Roman': ['times.ttf','timesbd.ttf','timesi.ttf','timesbi.ttf'],
  Cambria: ['cambria.ttc','cambriab.ttf','cambriai.ttf','cambriaz.ttf'],
  Consolas: ['consola.ttf','consolab.ttf','consolai.ttf','consolaz.ttf'],
  Verdana: ['verdana.ttf','verdanab.ttf','verdanai.ttf','verdanaz.ttf']
};

export const textPresets = {
  'Lecture opener': { text:'Research seminar\nTopic · Presenter', style:'center', type:{ family:'Georgia',size:7.5,leading:1.22,weight:1 } },
  'Section heading': { text:'01  Introduction', style:'center', type:{ family:'Segoe UI',size:6.6,weight:1,tracking:1 } },
  'Definition card': { text:'Key term\nWrite the definition here.', style:'center', type:{ family:'Georgia',size:5.2,leading:1.45,weight:0,background:'#18232b',boxOpacity:88,padding:16 } },
  'Equation callout': { text:'E = mc²', style:'center', type:{ family:'Cambria',size:9,weight:2,outline:0 } },
  'Citation lower third': { text:'Author (Year)\nSource or paper title', style:'lower', type:{ family:'Georgia',size:4.4,align:'left',weight:0,background:'#19242d',boxOpacity:90,padding:15 } }
};

function phase(name, reverse = false) {
  const tracks = presets.find(row=>row[0]===name)[2];
  const times = Object.values(tracks).flatMap(keys=>keys.map(([time])=>time));
  const start = Math.min(...times), end = Math.max(...times);
  return Object.fromEntries(Object.entries(tracks).map(([key,keys])=>{
    const normal = properties[key][3];
    const points = [[0,keys[0][1]],...keys.map(([time,value])=>[(time-start)/(end-start),value]),[1,keys.at(-1)[1]]];
    if (!reverse) return [key,points];
    return [key,[[0,normal],...points.reverse().map(([time,value])=>[1-time,value])]];
  }));
}

export const textListEntrances = {
  cut:['Cut',{}],
  fade:['Fade in',phase('Fade in')],
  pop:['Pop in',phase('Pop in')],
  left:['Slide from left',phase('Slide from left')],
  right:['Slide from right',phase('Slide from right')],
  rise:['Rise in',phase('Rise')],
  drop:['Drop in',phase('Drop in')],
  wipe:['Wipe right',phase('Wipe right')],
  type:['Typewriter',{reveal:[[0,0],[1,100]]}]
};

export const textListExits = {
  cut:['Cut',{}],
  fade:['Fade out',phase('Fade out')],
  pop:['Pop out',phase('Pop out')],
  left:['Slide left',phase('Slide from left',true)],
  right:['Slide right',phase('Slide from right',true)],
  rise:['Rise out',phase('Drop in',true)],
  drop:['Drop out',phase('Rise',true)],
  wipe:['Wipe left',phase('Wipe right',true)],
  erase:['Erase text',{reveal:[[0,100],[1,0]]}]
};

export function textListMotion({entrance,exit,enterFrames,holdFrames,exitFrames}) {
  const motion = {};
  for (const [tracks, start, length] of [
    [textListEntrances[entrance][1],0,enterFrames],
    [textListExits[exit][1],enterFrames+holdFrames,exitFrames]
  ]) {
    if (!length) continue;
    for (const [key,keys] of Object.entries(tracks)) {
      const track = new Map(motion[key] || []);
      if (start && !track.size) track.set(0,properties[key][3]);
      for (const [at,value] of keys) track.set(start+Math.round(at*(length-1)),value);
      motion[key] = [...track];
    }
  }
  return motion;
}

export function titleType(title) {
  const type = title.type || {};
  const caption = title.style === 'caption';
  const color = (key, fallback) => /^#[\da-f]{6}$/i.test(type[key]) ? type[key] : fallback;
  const number = (key, fallback, min, max) => Number.isFinite(type[key]) ? Math.max(min,Math.min(max,type[key])) : fallback;
  return {
    family: Object.hasOwn(fontFamilies,type.family) ? type.family : 'Segoe UI',
    weight: Math.round(number('weight',1,0,3)),
    size: number('size', caption ? 4.6 : title.style === 'lower' ? 6.3 : 8.9,1.5,20),
    align: ['left','center','right'].includes(type.align) ? type.align : title.style === 'lower' ? 'left' : 'center',
    leading: number('leading',1.14,.8,2.6),
    tracking: Math.round(number('tracking',0,0,3)),
    fill: color('fill','#ffffff'),
    background: color('background','#101316'),
    boxOpacity: number('boxOpacity',caption ? 82 : 0,0,100),
    padding: number('padding',caption ? 15 : 12,0,60),
    outline: number('outline',caption ? 1 : 2,0,18),
    outlineColor: color('outlineColor','#000000'),
    shadow: number('shadow',caption ? 0 : 20,0,100),
    blur: number('blur',6,0,48),
    shadowX: number('shadowX',2,-60,60),
    shadowY: number('shadowY',4,-60,60),
    depth: Math.round(number('depth',0,0,14)),
    depthColor: color('depthColor','#385761'),
    case: ['upper','lower'].includes(type.case) ? type.case : 'normal'
  };
}

export function typographyText(text, type) {
  let result = type.case === 'upper' ? text.toLocaleUpperCase() : type.case === 'lower' ? text.toLocaleLowerCase() : text;
  if (!type.tracking) return result;
  return result.split('\n').map(line => textCharacters(line).join('\u200a'.repeat(type.tracking))).join('\n');
}

export function wrapText(text, max) {
  const lines = [];
  for (const line of text.split('\n')) {
    if (!line || [...line].length <= max) { lines.push(line); continue; }
    let row = '';
    for (const word of line.split(/\s+/)) {
      if (row && [...row+' '+word].length > max) {
        lines.push(row);
        row = word;
      } else row += (row ? ' ' : '') + word;
    }
    lines.push(row);
  }
  return lines.join('\n');
}

const graphemes = new Intl.Segmenter(undefined,{granularity:'grapheme'});
export const textCharacters = text => Array.from(graphemes.segment(text),part=>part.segment);
export const typewriterStep = (frames,count) => Math.max(1,Math.ceil(frames*.65/count));
export const textFragment = (chars,count,step) => chars.slice(0,Math.ceil(step*chars.length/count)).join('');
export const usesTextReveal = title => Array.isArray(title.motion?.reveal) && title.motion.reveal.length>0;

export function visibleText(title, frame) {
  const reveal = usesTextReveal(title);
  if (!reveal && !title.typewriter) return title.text;
  const chars = textCharacters(title.text);
  const count = Math.min(chars.length,24);
  if (!count) return '';
  const step = reveal ? Math.ceil(valueAt(title,'reveal',frame)*count/100) : Math.floor(frame/typewriterStep(title.len,count))+1;
  return textFragment(chars,count,step);
}

export function readSrt(input, rate = 30) {
  const text = input.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  const timestamp = '(\\d{1,3}):(\\d{2}):(\\d{2})[,.](\\d{3})';
  const regex = new RegExp(`^${timestamp}\\s*-->\\s*${timestamp}(?:[^\\n]*)$`);
  const time = ([h,m,s,ms]) => (Number(h)*3600 + Number(m)*60 + Number(s) + Number(ms)/1000)*rate;
  const list = [];
  for (const block of text.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    const index = lines.findIndex(line => regex.test(line.trim()));
    if (index < 0) continue;
    const match = lines[index].trim().match(regex);
    const start = Math.floor(time(match.slice(1,5)) + 1e-6);
    const end = Math.ceil(time(match.slice(5,9)) - 1e-6);
    const value = lines.slice(index+1).join('\n').replace(/<\/?(?:i|b|u|font)(?:\s[^>]+)?>/gi,'').trim();
    if (end > start && value && end <= rate*10*3600) list.push({ start,len:end-start,text:value.slice(0,900) });
  }
  return list.sort((a,b)=>a.start-b.start);
}

export function writeSrt(cues, rate = 30) {
  const time = frame => {
    const ms = Math.round(frame*1000/rate);
    return [Math.floor(ms/3600000),Math.floor(ms/60000)%60,Math.floor(ms/1000)%60].map(value=>String(value).padStart(2,'0')).join(':') + ',' + String(ms%1000).padStart(3,'0');
  };
  return [...cues].sort((a,b)=>a.start-b.start)
    .map((cue,index)=>`${index+1}\r\n${time(cue.start)} --> ${time(cue.start+cue.len)}\r\n${cue.text.replace(/\r?\n/g,'\r\n')}\r\n`).join('\r\n');
}
