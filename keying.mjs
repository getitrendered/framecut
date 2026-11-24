export const keyPresets = {
  green:{ mode:'chroma', color:'#00ff00', tolerance:.12, softness:.09, spill:.65 },
  blue:{ mode:'chroma', color:'#0000ff', tolerance:.12, softness:.09, spill:.65 },
  black:{ mode:'luma', color:'#000000', tolerance:.06, softness:.12, spill:0 }
};

const limit = (value,min,max)=>Math.max(min,Math.min(max,value));
export const colorChannels = color=>[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255);

export function backgroundKey(raw) {
  if (raw?.mode!=='chroma' && raw?.mode!=='luma') return null;
  const defaults = raw.mode==='luma' ? keyPresets.black : keyPresets.green;
  const value = (key,max)=>Number.isFinite(raw[key]) ? limit(raw[key],0,max) : defaults[key];
  return { mode:raw.mode,color:/^#[\da-f]{6}$/i.test(raw.color) ? raw.color : defaults.color,
    tolerance:value('tolerance',.65),softness:value('softness',.5),spill:value('spill',1) };
}

export function keyMatrix(space) {
  if (space==='bt709') return [.2126,.7152,.0722];
  if (space==='bt2020nc' || space==='bt2020c') return [.2627,.678,.0593];
  return [.299,.587,.114];
}

export function luminance([r,g,b],[wr,wg,wb]) {
  return r*wr+g*wg+b*wb;
}

export function chroma(color, matrix) {
  const y = luminance(color,matrix);
  return [(color[2]-y)/(2*(1-matrix[2])),(color[0]-y)/(2*(1-matrix[0]))];
}

export function spillChannel([r,g,b]) {
  return g>Math.max(r,b)+.08 ? 1 : b>Math.max(r,g)+.08 ? 2 : 0;
}

export function keyParameters(key,space,fullRange=false) {
  const matrix = keyMatrix(space);
  const rgb = colorChannels(key.color);
  const range = fullRange ? 1 : 224/255;
  return {matrix,uv:chroma(rgb,matrix).map(value=>value*range),range,
    cutoff:key.mode==='luma' ? limit(luminance(rgb,matrix)+key.tolerance,0,1) : key.tolerance,
    spill:spillChannel(rgb)};
}

export function sampledKey(data, previous) {
  const colors = [];
  for (let i=0;i<data.length;i+=4) colors.push([data[i]/255,data[i+1]/255,data[i+2]/255]);
  const rgb = [0,1,2].map(axis=>colors.map(color=>color[axis]).sort((a,b)=>a-b)[Math.floor(colors.length/2)]);
  const matrix = keyMatrix();
  const dark = luminance(rgb,matrix)<.13 && Math.max(...rgb)-Math.min(...rgb)<.12;
  const preset = previous || (dark ? keyPresets.black : keyPresets.green);
  const color = '#'+rgb.map(channel=>Math.round(channel*255).toString(16).padStart(2,'0')).join('');
  const [u,v] = chroma(rgb,matrix);
  const distances = colors.map(sample=>{
    const [a,b] = chroma(sample,matrix);
    return preset.mode==='luma' ? Math.abs(luminance(sample,matrix)-luminance(rgb,matrix)) : Math.hypot(a-u,b-v)/Math.SQRT2;
  }).sort((a,b)=>a-b);
  return { ...preset,color,tolerance:Math.min(.35,Math.max(preset.tolerance,distances[Math.floor(distances.length*.85)]+.025)) };
}
