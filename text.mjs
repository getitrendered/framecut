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
  return result.split('\n').map(line => [...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(line)]
    .map(part => part.segment).join('\u200a'.repeat(type.tracking))).join('\n');
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

export function visibleText(title, frame) {
  const chars = [...title.text];
  if (!title.typewriter) return title.text;
  const count = Math.min(chars.length,24);
  const step = Math.max(1,Math.ceil(title.len*.65/count));
  return chars.slice(0,Math.ceil((Math.floor(frame/step)+1)*chars.length/count)).join('');
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
