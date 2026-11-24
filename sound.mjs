export const soundPresets = {
  pop: ['Pop', 'sine', .16, 580, 190, 2.6, .05],
  bubble: ['Bubble pop', 'sine', .26, 180, 760, 2, .03],
  click: ['Click', 'triangle', .065, 1900, 480, 4, .21],
  snap: ['Snap', 'triangle', .10, 1200, 310, 3.3, .58],
  tap: ['Soft tap', 'sine', .13, 540, 215, 4, .03],
  tick: ['Tick', 'square', .05, 2300, 1200, 6, .05],
  chime: ['Chime', 'sine', .69, 840, 760, 2.4, .01],
  bell: ['Bell', 'triangle', 1.01, 660, 655, 1.8, .01],
  blip: ['Digital blip', 'square', .14, 840, 1150, 2.4, .01],
  alert: ['Alert', 'triangle', .51, 970, 560, 1.3, .02],
  sparkle: ['Sparkle', 'sine', .79, 410, 1620, 2, .03],
  success: ['Success tone', 'sine', .52, 494, 988, 1, .01],
  whoosh: ['Quick whoosh', 'noise', .42, 420, 120, 2, .93],
  sweep: ['Soft sweep', 'noise', .84, 950, 210, 1.7, .96],
  riser: ['Riser', 'triangle', 1.2, 180, 1670, .25, .34],
  drop: ['Bass drop', 'sine', .91, 146, 31, 1.1, .06],
  thud: ['Thud', 'sine', .36, 148, 43, 2.6, .25],
  blast: ['Blast', 'sine', .82, 138, 35, 1.9, .72],
  hit: ['Impact hit', 'triangle', .43, 224, 38, 2.4, .5],
  clap: ['Clap', 'noise', .25, 1450, 530, 3.8, .9],
  rewind: ['Rewind', 'triangle', .47, 930, 240, 1.7, .3],
  shutter: ['Shutter', 'square', .23, 1260, 390, 4.2, .49]
};

export function soundSettings(input) {
  if (Object.hasOwn(soundPresets,input.preset)) {
    const [name,wave,len,from,to,decay,noise] = soundPresets[input.preset];
    return {name,wave,len,from,to,decay,noise,preset:input.preset};
  }
  const n = (key,fallback,min,max) => Number.isFinite(input[key]) ? Math.max(min,Math.min(max,input[key])) : fallback;
  return {
    name:typeof input.name==='string' && input.name.trim() ? input.name.trim().slice(0,64) : 'Custom sound',
    wave:['sine','triangle','square','noise'].includes(input.wave) ? input.wave : 'sine',
    len:n('len',.45,.04,4), from:n('from',560,25,3500), to:n('to',220,25,3500),
    decay:n('decay',2,.2,8),noise:n('noise',.15,0,1)
  };
}

export function soundWave(settings, rate = 48000) {
  const num = Math.max(1,Math.round(settings.len*rate));
  const data = new Float32Array(num);
  let phase=0, low=0, seed=2473339;
  for(let i=0;i<num;i++){
    const p=i/num, t=i/rate;
    const pitch=settings.from*Math.pow(settings.to/settings.from,p);
    phase+=pitch/rate;
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    low+=(seed/2147483648-1-low)*Math.min(.6,pitch*6/rate);
    const tone=settings.wave==='sine' ? Math.sin(2*Math.PI*phase) : settings.wave==='triangle' ? 2/Math.PI*Math.asin(Math.sin(2*Math.PI*phase))
      : settings.wave==='square' ? Math.tanh(3*Math.sin(2*Math.PI*phase)) : low;
    let env=Math.min(1,t/.003)*(1-p)**settings.decay;
    if (['whoosh','sweep','riser'].includes(settings.preset)) env = Math.sin(Math.PI*p)**1.5;
    if (settings.preset==='success') phase+=i===Math.floor(num*.45) ? .35 : 0;
    if (settings.preset==='clap' || settings.preset==='shutter') env*=.42+.58*Math.abs(Math.cos(t*86));
    const mix=settings.wave==='noise' ? low*1.75 : tone*(1-settings.noise)+low*1.5*settings.noise;
    data[i]=Math.max(-.85,Math.min(.85,mix*env*.76));
  }
  return data;
}
