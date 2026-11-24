import { backgroundKey, chroma, keyParameters, luminance } from './keying.mjs';

const vertex = `attribute vec2 point;
varying vec2 uv;
void main() { uv = point * 0.5 + 0.5; gl_Position = vec4(point,0.0,1.0); }`;

const fragment = `precision mediump float;
uniform sampler2D image;
uniform vec2 keyUV, pixel;
uniform vec3 matrix;
uniform float chromaRange, cutoff, softness, spill, channel, luma, matte;
varying vec2 uv;
float distanceToKey(vec3 color) {
  float y = dot(color,matrix);
  vec2 c = vec2((color.b-y)/(2.0*(1.0-matrix.b)),(color.r-y)/(2.0*(1.0-matrix.r)));
  return length(c*chromaRange-keyUV)*0.70710678;
}
void main() {
  vec4 source = texture2D(image,uv);
  vec3 color = source.rgb;
  float d = dot(color,matrix);
  if (luma < .5) {
    d = 0.0;
    for (int row=-1;row<=1;row++) for (int col=-1;col<=1;col++) {
      d += distanceToKey(texture2D(image,uv+vec2(float(col),float(row))*pixel).rgb);
    }
    d /= 9.0;
    if (channel > 1.5) color.b -= spill*max(0.0,color.b-(color.r+color.g)*.5);
    else if (channel > .5) color.g -= spill*max(0.0,color.g-(color.r+color.b)*.5);
  }
  float a = source.a * (softness <= .0001 ? float(d>cutoff) : clamp((d-cutoff)/softness,0.0,1.0));
  gl_FragColor = matte > .5 ? vec4(vec3(a),1.0) : vec4(color,a);
}`;

function graphics(canvas) {
  const gl = canvas.getContext('webgl',{alpha:true,premultipliedAlpha:false,antialias:false});
  if (!gl) return null;
  const program = gl.createProgram();
  for (const [kind,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
    const shader = gl.createShader(kind);
    gl.shaderSource(shader,source);
    gl.compileShader(shader);
    gl.attachShader(program,shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program,gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const points = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,points);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  const location = gl.getAttribLocation(program,'point');
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location,2,gl.FLOAT,false,0,0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
  for (const key of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D,key,gl.LINEAR);
  for (const key of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D,key,gl.CLAMP_TO_EDGE);
  const uniforms = Object.fromEntries(['keyUV','pixel','matrix','chromaRange','cutoff','softness','spill','channel','luma','matte'].map(name=>[name,gl.getUniformLocation(program,name)]));
  const draw = (video,key,params,matte)=>{
    gl.viewport(0,0,canvas.width,canvas.height);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,video);
    gl.uniform2fv(uniforms.keyUV,params.uv);
    gl.uniform2f(uniforms.pixel,1/video.videoWidth,1/video.videoHeight);
    gl.uniform3fv(uniforms.matrix,params.matrix);
    for (const [name,value] of Object.entries({chromaRange:params.range,cutoff:params.cutoff,softness:key.softness,
      spill:key.spill,channel:params.spill,luma:Number(key.mode==='luma'),matte:Number(matte)})) gl.uniform1f(uniforms[name],value);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  };
  draw.dispose = ()=>{
    gl.deleteTexture(texture);
    gl.deleteBuffer(points);
    gl.deleteProgram(program);
  };
  return draw;
}

function software(canvas) {
  const context = canvas.getContext('2d',{willReadFrequently:true});
  return (video,key,params,matte)=>{
    const {width,height} = canvas;
    context.clearRect(0,0,width,height);
    context.drawImage(video,0,0,width,height);
    const image = context.getImageData(0,0,width,height);
    const data = image.data;
    for (let i=0;i<data.length;i+=4) {
      const color = [data[i]/255,data[i+1]/255,data[i+2]/255];
      let distance = luminance(color,params.matrix);
      if (key.mode==='chroma') {
        const [u,v] = chroma(color,params.matrix);
        distance = Math.hypot(u*params.range-params.uv[0],v*params.range-params.uv[1])/Math.SQRT2;
        if (params.spill) {
          const index = params.spill;
          const other = color[index===1?2:1];
          data[i+index] -= 255*key.spill*Math.max(0,color[index]-(color[0]+other)*.5);
        }
      }
      const alpha = data[i+3]*(key.softness ? Math.min(1,Math.max(0,(distance-params.cutoff)/key.softness)) : Number(distance>params.cutoff));
      if (matte) { data[i]=data[i+1]=data[i+2]=alpha; data[i+3]=255; }
      else data[i+3] = alpha;
    }
    context.putImageData(image,0,0);
  };
}

export function createKeyPreview(video) {
  let canvas = document.createElement('canvas');
  let draw = graphics(canvas);
  const accelerated = Boolean(draw);
  if (!draw) { canvas = document.createElement('canvas'); draw = software(canvas); }
  canvas.className = 'key-preview';
  canvas.hidden = true;
  canvas.setAttribute('aria-hidden','true');
  video.after(canvas);
  let current, frameCallback, lastTime;
  function paint() {
    if (!current || video.readyState<2 || video.seeking || !video.videoWidth) return;
    const { key,params,matte,quality } = current;
    const maxHeight = accelerated ? ({full:1080,half:540,quarter:360,low:240}[quality] || 720) : 270;
    const ratio = Math.min(1,maxHeight/video.videoHeight,maxHeight*2/video.videoWidth);
    const width = Math.max(1,Math.round(video.videoWidth*ratio));
    const height = Math.max(1,Math.round(video.videoHeight*ratio));
    if (canvas.width!==width) canvas.width=width;
    if (canvas.height!==height) canvas.height=height;
    try {
      draw(video,key,params,matte);
      canvas.hidden = false;
      video.classList.add('key-preview-source');
      lastTime = video.currentTime;
    } catch {
      canvas.hidden = true;
      video.classList.remove('key-preview-source');
    }
  }
  const ready = ()=>paint();
  video.addEventListener('loadeddata',ready);
  video.addEventListener('seeked',ready);
  function schedule() {
    if (frameCallback!==undefined || !video.requestVideoFrameCallback) return;
    frameCallback = video.requestVideoFrameCallback(()=>{
      frameCallback=undefined;
      paint();
      if (!video.paused) schedule();
    });
  }
  return {
    update(raw,asset,matte,quality) {
      canvas.style.cssText = video.style.cssText;
      canvas.classList.toggle('framed-video',video.classList.contains('framed-video'));
      if (!current || raw!==current.raw || asset!==current.asset || matte!==current.matte || quality!==current.quality) {
        const key = backgroundKey(raw);
        current = {raw,asset,key,params:keyParameters(key,asset?.matrix,asset?.fullRange),matte,quality};
        paint();
      } else if (!video.requestVideoFrameCallback && lastTime!==video.currentTime) paint();
      schedule();
    },
    destroy() {
      if (frameCallback!==undefined) video.cancelVideoFrameCallback(frameCallback);
      current = null;
      video.removeEventListener('loadeddata',ready);
      video.removeEventListener('seeked',ready);
      video.classList.remove('key-preview-source');
      canvas.remove();
      draw.dispose?.();
    }
  };
}

export function readColorSample(video,u,v) {
  const canvas = document.createElement('canvas');
  const size = Math.min(9,video.videoWidth,video.videoHeight);
  canvas.width=canvas.height=size;
  const context = canvas.getContext('2d');
  const left = Math.max(0,Math.min(video.videoWidth-size,Math.round(u*video.videoWidth-size/2)));
  const top = Math.max(0,Math.min(video.videoHeight-size,Math.round(v*video.videoHeight-size/2)));
  context.drawImage(video,left,top,size,size,0,0,size,size);
  return context.getImageData(0,0,size,size).data;
}
