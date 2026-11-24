const width = 480;
const height = 270;
export const graphicSize = `${width}x${height}`;
export const graphicFrames = 120;

export function readMesh(source) {
  const vertices = [];
  const triangles = [];
  for (const line of source.split(/\r?\n/)) {
    const [kind, ...parts] = line.trim().split(/\s+/);
    if (kind === 'v') {
      const vertex = parts.slice(0,3).map(Number);
      if (vertex.length !== 3 || vertex.some(value => !Number.isFinite(value) || Math.abs(value) > 1e9)) throw new Error('The OBJ has invalid vertices.');
      vertices.push(vertex);
    } else if (kind === 'f') {
      const indices = parts.map(part => Number(part.split('/')[0])).map(index => index < 0 ? vertices.length + index : index - 1);
      for (let i=1; i+1<indices.length; i++) triangles.push([indices[0],indices[i],indices[i+1]]);
    }
    if (triangles.length > 8000 || vertices.length > 16000) throw new Error('Choose an OBJ mesh with 8,000 triangles or fewer.');
  }
  if (!triangles.length || triangles.some(face => face.some(index => !vertices[index]))) throw new Error('Choose an OBJ file with valid polygon faces.');
  const center = [0,1,2].map(axis => {
    const values = vertices.map(vertex => vertex[axis]);
    return (Math.min(...values)+Math.max(...values))/2;
  });
  const relative = vertices.map(vertex => vertex.map((value,axis) => value-center[axis]));
  const radius = Math.max(...relative.map(vertex => Math.hypot(...vertex))) || 1;
  return { vertices:relative.map(vertex => vertex.map(value => value*92/radius)), triangles };
}

const cube = readMesh(`v -1 -1 -1
v 1 -1 -1
v 1 1 -1
v -1 1 -1
v -1 -1 1
v 1 -1 1
v 1 1 1
v -1 1 1
f 1 2 3 4
f 5 8 7 6
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 4 8 5 1`);

function rasterMesh(data, mesh, frame) {
  const turn = frame*2*Math.PI/graphicFrames + .38;
  const pitch = .32;
  const vertices = mesh.vertices.map(([x,y,z]) => {
    const a = x*Math.cos(turn) - z*Math.sin(turn);
    const b = x*Math.sin(turn) + z*Math.cos(turn);
    return [width/2+a, height/2-(y*Math.cos(pitch)-b*Math.sin(pitch)), y*Math.sin(pitch)+b*Math.cos(pitch)];
  });
  const faces = mesh.triangles.map(face => face.map(index => vertices[index])).sort((a,b) => a.reduce((s,p)=>s+p[2],0)-b.reduce((s,p)=>s+p[2],0));
  for (const [a,b,c] of faces) {
    const ab = b.map((v,i)=>v-a[i]), ac = c.map((v,i)=>v-a[i]);
    const normal = [ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
    const norm = Math.hypot(...normal);
    if (!norm || Math.abs(normal[2]) < .001) continue;
    const shade = .48 + .52*Math.abs((normal[0]*.4-normal[1]*.32+normal[2]*.82)/norm);
    const lowX = Math.max(0,Math.floor(Math.min(a[0],b[0],c[0])));
    const highX = Math.min(width-1,Math.ceil(Math.max(a[0],b[0],c[0])));
    const lowY = Math.max(0,Math.floor(Math.min(a[1],b[1],c[1])));
    const highY = Math.min(height-1,Math.ceil(Math.max(a[1],b[1],c[1])));
    for (let y=lowY;y<=highY;y++) for (let x=lowX;x<=highX;x++) {
      const u = ((x-a[0])*ac[1]-(y-a[1])*ac[0])/normal[2];
      const v = (ab[0]*(y-a[1])-ab[1]*(x-a[0]))/normal[2];
      if (u < 0 || v < 0 || u+v > 1) continue;
      const offset = (y*width+x)*4;
      data[offset]=Math.round(171*shade);
      data[offset+1]=Math.round(225*shade);
      data[offset+2]=Math.round(249*shade);
      data[offset+3]=255;
    }
  }
}

export const particlePresets={
  sparks:['Sparks',64,5,1,.65,70,'#ffad53',0],
  fire:['Fire',100,17,1,.76,33,'#ff8830',0],
  rain:['Rain',150,3,1.65,.72,100,'#9dd9fb',180],
  snow:['Snow',92,4,.5,1.4,100,'#eff8ff',180],
  dust:['Floating dust',86,7,.45,1.4,100,'#d2bd9b',45],
  smoke:['Smoke',74,24,.49,1.56,55,'#939ca6',0],
  confetti:['Confetti',100,7,1.1,1.2,90,'#f0c149',180],
  blast:['Power burst',128,6,1.35,.8,100,'#73aaff',0],
  aura:['Energy aura',110,9,1.05,.9,82,'#6decca',0]
};

export function particleSettings(kind, input={}) {
  const [,quantity,size,speed,life,spread,tone,direction]=particlePresets[kind] || particlePresets.sparks;
  const n=(key,fallback,min,max)=>Number.isFinite(input[key])?Math.max(min,Math.min(max,input[key])):fallback;
  return {quantity:Math.round(n('quantity',quantity,4,260)),size:n('size',size,1,34),speed:n('speed',speed,.1,3),
    life:n('life',life,.15,3),spread:n('spread',spread,4,100),color:/^#[a-f\d]{6}$/i.test(input.color)?input.color:tone,
    direction:n('direction',direction,-180,180),duration:n('duration',4,.5,12),opacity:n('opacity',85,5,100),
    gravity:n('gravity',0,-100,100),turbulence:n('turbulence',35,0,100),seed:Math.round(n('seed',1,1,9999)),
    originX:n('originX',50,0,100),originY:n('originY',kind==='rain'||kind==='snow'?2:kind==='blast'||kind==='aura'?50:72,0,100)};
}

export function paintParticles(data,kind,frame,settings=particleSettings(kind)) {
  const fire=kind==='fire', rain=kind==='rain', snow=kind==='snow', confetti=kind==='confetti';
  const burst=kind==='blast', aura=kind==='aura', soft=kind==='smoke'||kind==='dust';
  const count=settings.quantity;
  const angle=settings.direction*Math.PI/180;
  const rgb=[1,3,5].map(i=>parseInt(settings.color.slice(i,i+2),16));
  const noise = n => ((Math.sin(n*78.233)*43758.5453)%1+1)%1;
  for (let i=0;i<count;i++) {
    const seed=i+settings.seed*223+3;
    const t=frame/30;
    const p=(t/settings.life+noise(seed))%1;
    const travel=(rain?340:fire?134:soft?102:182)*settings.speed*p*(.45+.55*noise(seed+25));
    const swirl=noise(seed+20)*Math.PI*2+(aura?t*2.5:0);
    const radial=(25+(aura?(1-p*.4):p)*settings.spread*1.4)*settings.speed;
    const jitter=Math.sin(seed+p*6)*settings.turbulence*.34*p;
    const spread=(noise(seed+43)-.5)*settings.spread*(fire?1.6:(rain||snow||confetti)?5.2:3.3);
    const x=width*settings.originX/100+(burst||aura?Math.cos(swirl)*radial:spread+jitter+Math.sin(angle)*travel);
    const y=height*settings.originY/100+(burst||aura?Math.sin(swirl)*radial*.7:-Math.cos(angle)*travel)+settings.gravity*p*p*.8;
    const radius=Math.max(.7,settings.size*(.28+noise(seed+53)*.72)*(fire?(1-p*.68):soft?.6+p*.65:1));
    const tone=confetti?[rgb[i%3],rgb[(i+1)%3],rgb[(i+2)%3]]:rgb.map((value,c)=>fire?Math.min(255,value+(c===1?110:35)*(1-p)):value);
    const tall=rain?Math.min(32,radius*6):radius;
    for (let dy=-Math.ceil(tall);dy<=tall;dy++) for (let dx=-Math.ceil(radius);dx<=radius;dx++) {
      const xx = Math.round(x+dx), yy = Math.round(y+dy);
      if (xx<0 || xx>=width || yy<0 || yy>=height) continue;
      const distance = confetti?Math.max(Math.abs(dx),Math.abs(dy))/radius:Math.hypot(dx/radius,dy/tall);
      if (distance>1) continue;
      const index = (yy*width+xx)*4;
      const a=(1-distance)**(soft?2.6:fire?1.45:.5)*(1-p)*Math.min(1,p*9)*settings.opacity/100*(soft?.36:1);
      const previous = data[index+3]/255;
      const combined = a + previous*(1-a);
      if (combined<=0) continue;
      for (let c=0;c<3;c++) data[index+c] = Math.round((tone[c]*a+data[index+c]*previous*(1-a))/combined);
      data[index+3]=Math.round(combined*255);
    }
  }
}

export function* graphics(kind, mesh = cube, input) {
  const particles=kind!=='mesh' && kind!=='cube';
  const settings=particles?particleSettings(kind,input):null;
  const count=particles?Math.round(settings.duration*30):graphicFrames;
  for (let frame=0; frame<count; frame++) {
    const data = Buffer.alloc(width*height*4);
    if (kind === 'mesh' || kind === 'cube') rasterMesh(data,mesh || cube,frame);
    else paintParticles(data,kind,frame,settings);
    yield data;
  }
}

export async function trackPatch(raw, width, height, box, step, progress = () => {}) {
  const area = width*height;
  const length = Math.floor(raw.length/area);
  if (!length) throw new Error('The selected range has no frames to track.');
  const w = Math.max(8,Math.round(width*box.w));
  const h = Math.max(8,Math.round(height*box.h));
  const clamp = (n,high) => Math.max(0,Math.min(high,n));
  let x = clamp(Math.round(box.x*width),width-w);
  let y = clamp(Math.round(box.y*height),height-h);
  const pattern = [];
  for (let sy=0;sy<h;sy+=2) for (let sx=0;sx<w;sx+=2) pattern.push([sx,sy,raw[(y+sy)*width+x+sx]]);
  const mean = pattern.reduce((sum,p)=>sum+p[2],0)/pattern.length;
  if (pattern.reduce((sum,p)=>sum+Math.abs(p[2]-mean),0)/pattern.length < 6) throw new Error('Pick a patch with more contrast or visible detail.');
  const track = [];
  for (let frame=0;frame<length;frame++) {
    const offset = frame*area;
    let best = Infinity;
    let nextX = x, nextY = y;
    for (let cy=Math.max(0,y-11); cy<=Math.min(height-h,y+11); cy++) {
      for (let cx=Math.max(0,x-11); cx<=Math.min(width-w,x+11); cx++) {
        let difference = 0;
        for (const [px,py,sample] of pattern) difference+=Math.abs(raw[offset+(cy+py)*width+cx+px]-sample);
        difference = difference/pattern.length + Math.hypot(cx-x,cy-y)*.15;
        if (difference<best) { best=difference; nextX=cx; nextY=cy; }
      }
    }
    if (best<55) { x=nextX; y=nextY; }
    track.push([frame*step,(x+w/2)/width,(y+h/2)/height]);
    if(frame%3===0 || frame+1===length) {
      progress((frame+1)/length*100);
      await new Promise(resolve=>setImmediate(resolve));
    }
  }
  return track;
}
