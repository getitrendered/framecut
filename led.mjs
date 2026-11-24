const ns = 'http://www.w3.org/2000/svg';
const clipNS = 'http://www.w3.org/1999/xhtml';
const scale = 34;
const shapes = { rectangle:'Rectangle', square:'Square', circle:'Circle', ellipse:'Ellipse',
  triangle:'Triangle', hexagon:'Hexagon', star:'Star', custom:'Custom outline' };
const masks = {
  circle:'ellipse(50% 50%)', ellipse:'ellipse(50% 50%)',
  triangle:'polygon(50% 0,100% 100%,0 100%)', hexagon:'polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)',
  star:'polygon(50% 0,62% 35%,100% 38%,70% 62%,81% 100%,50% 78%,19% 100%,30% 62%,0 38%,38% 35%)'
};
const bounded = (n, min, max) => Math.max(min, Math.min(max,n));
const distance = (a,b) => Math.hypot(b.x-a.x,b.y-a.y);
const feet = value => Number(value.toFixed(2))+' ft';

function el(tag, cls, label) {
  const item = document.createElementNS(clipNS,tag);
  if (cls) item.className = cls;
  if (label !== undefined) item.textContent = label;
  return item;
}
function svg(tag, attrs={}) {
  const node = document.createElementNS(ns,tag);
  for (const [name,value] of Object.entries(attrs)) node.setAttribute(name,value);
  return node;
}
function button(label, fn, className='secondary') {
  const item = el('button',className,label);
  item.type = 'button';
  item.onclick = fn;
  return item;
}
function field(label, input) {
  const item = el('label','property');
  input.setAttribute('aria-label',label);
  item.append(el('span','',label),input);
  return item;
}
function select(options, value, update) {
  const input = el('select');
  for (const [id,name] of Object.entries(options)) input.add(new Option(name,id));
  input.value = value;
  input.onchange = () => update(input.value);
  return input;
}
function number(value,min,max,step,update) {
  const input = el('input');
  Object.assign(input,{ type:'number', value, min, max, step });
  if (update) input.onchange = () => {
    const next = input.valueAsNumber;
    if (Number.isFinite(next)) update(bounded(next,min,max));
    else input.value = value;
  };
  return input;
}
function controlPoint(a,b,arch) {
  const len = distance(a,b) || 1;
  return { x:(a.x+b.x)/2+2*arch*(a.y-b.y)/len, y:(a.y+b.y)/2+2*arch*(b.x-a.x)/len };
}
function pathFor(vertices, closed) {
  if (!vertices.length) return '';
  const [first,...rest] = vertices;
  let path = 'M '+first.x+' '+first.y;
  for (const [index,to] of rest.entries()) {
    const from = vertices[index];
    if (to.arch) {
      const mid = controlPoint(from,to,to.arch);
      path += ' Q '+mid.x+' '+mid.y+' '+to.x+' '+to.y;
    } else path += ' L '+to.x+' '+to.y;
  }
  return closed ? path+' Z' : path;
}
function normalizedPath(vertices) {
  const points = [...vertices];
  for (let i=1;i<vertices.length;i++) {
    const [a,b] = [vertices[i-1],vertices[i]];
    if (!b.arch) continue;
    const mid = controlPoint(a,b,b.arch);
    for (const key of ['x','y']) {
      const t = (a[key]-mid[key])/(a[key]-2*mid[key]+b[key]);
      if (t>0 && t<1) points.push({
        x:(1-t)**2*a.x+2*(1-t)*t*mid.x+t*t*b.x,
        y:(1-t)**2*a.y+2*(1-t)*t*mid.y+t*t*b.y
      });
    }
  }
  const x = Math.min(...points.map(p=>p.x));
  const y = Math.min(...points.map(p=>p.y));
  const width = Math.max(...points.map(p=>p.x))-x;
  const height = Math.max(...points.map(p=>p.y))-y;
  return { width,height,shape:vertices.map(p=>({...p})),path:pathFor(vertices,true),box:[x,y,width,height] };
}

function outlineEditor(wall, onApply) {
  const dialog = el('dialog','outline-dialog');
  dialog.setAttribute('aria-label','Build a wall shape');
  const head = el('div','dialog-head');
  head.append(el('h2','','Shape builder'),button('Close',()=>dialog.close()));
  const tools = el('div','outline-tools');
  const canvas = svg('svg',{viewBox:'-15 -9 30 18',role:'img','aria-label':'Shape drawing grid in feet'});
  const group = svg('g');
  const grid = svg('pattern',{id:'outline-grid',width:1,height:1,patternUnits:'userSpaceOnUse'});
  grid.append(svg('path',{d:'M 0 1 V 0 H 1',fill:'none',stroke:'#384854','stroke-width':'.035'}));
  const defs = svg('defs');
  defs.append(grid);
  canvas.append(defs,svg('rect',{x:-15,y:-9,width:30,height:18,fill:'url(#outline-grid)'}),group);
  const message = el('output','subtle');
  message.setAttribute('aria-live','polite');
  const actions = el('div','dialog-actions');
  let points = structuredClone(wall.outline?.shape || []);
  let tool = 'line';
  let pointer = null;
  let measurement = [];
  const length = number('',0.1,300,0.01);
  const arch = number(1,-150,150,0.1);
  length.placeholder = 'Draw freely';
  const lengthField = field('Line / chord length (ft)',length);
  const archField = field('Arc rise (ft)',arch);
  const apply = button('Use shape',() => {
    const result = normalizedPath(points);
    if (result.width<0.1 || result.height<0.1 || Math.max(result.width,result.height)>300) {
      message.textContent = 'The shape must span between 0.1 and 300 feet on each axis.';
      return;
    }
    onApply(result);
    dialog.close();
  },'primary');
  const toolSelect = select({line:'Pen · line',arc:'Pen · arc',measure:'Measure'},tool,value=>{
    tool = value;
    measurement = [];
    redraw();
  });
  tools.append(field('Tool',toolSelect),lengthField,archField);
  actions.append(button('Undo point',()=>{ points.pop(); redraw(); }),button('Clear',()=>{ points=[]; redraw(); }),apply);
  function endpoint(at) {
    const last = points.at(-1);
    const size = length.valueAsNumber;
    if (tool==='measure' || !last || !Number.isFinite(size) || size<=0) return at;
    const angle = Math.atan2(at.y-last.y,at.x-last.x);
    const exact = bounded(size,.1,300);
    return { x:last.x+Math.cos(angle)*exact, y:last.y+Math.sin(angle)*exact };
  }
  function lineLabel(a,b) {
    const label = svg('text',{x:(a.x+b.x)/2,y:(a.y+b.y)/2-.18,class:'outline-distance'});
    let len = distance(a,b);
    if (b.arch) {
      const p = controlPoint(a,b,b.arch);
      let start = a;
      len = 0;
      for (let i=1;i<=32;i++) {
        const t = i/32;
        const next = {x:(1-t)**2*a.x+2*(1-t)*t*p.x+t*t*b.x,y:(1-t)**2*a.y+2*(1-t)*t*p.y+t*t*b.y};
        len += distance(start,next);
        start = next;
      }
    }
    label.textContent = feet(len);
    group.append(label);
    return len;
  }
  function redraw() {
    group.replaceChildren();
    apply.disabled = points.length<3;
    archField.hidden = tool!=='arc';
    lengthField.hidden = tool==='measure';
    const outline = svg('path',{d:pathFor(points,points.length>=3),class:'outline-path'});
    group.append(outline);
    for (const [index,point] of points.entries()) {
      group.append(svg('circle',{cx:point.x,cy:point.y,r:.10,class:'outline-point'}));
      if (index) lineLabel(points[index-1],point);
    }
    const last = tool==='measure' ? measurement.at(-1) : points.at(-1);
    let end = pointer && endpoint(pointer);
    if (end && tool==='arc') end = {...end,arch:bounded(arch.valueAsNumber||0,-150,150)};
    if (tool==='measure' && measurement.length===2) {
      group.append(svg('path',{d:pathFor(measurement),class:'outline-guide'}));
      lineLabel(...measurement);
      message.textContent = 'Distance '+feet(distance(...measurement))+' · Click to start another measurement.';
    } else if (last && end) {
      group.append(svg('path',{d:pathFor([last,end]),class:'outline-guide'}));
      message.textContent = (tool==='measure'?'Distance ':'Segment ')+feet(lineLabel(last,end));
    } else message.textContent = tool==='measure' ? 'Click two points to measure their distance.' :
      'Click to add points. Enter a length to set the next segment, then click in its direction.';
  }
  function position(event) {
    const point = new DOMPoint(event.clientX,event.clientY).matrixTransform(canvas.getScreenCTM().inverse());
    return { x:point.x, y:point.y };
  }
  canvas.onpointermove = event => { pointer=position(event); redraw(); };
  canvas.onpointerleave = () => { pointer=null; redraw(); };
  canvas.onclick = event => {
    let at = endpoint(position(event));
    if (tool==='measure') {
      if (measurement.length===2) measurement = [];
      measurement.push(at);
    } else if (points.length<150 && (!points.length || distance(points.at(-1),at)>.02)) {
      if (points.length && tool==='arc') at = {...at,arch:bounded(arch.valueAsNumber||0,-150,150)};
      points.push(at);
    }
    redraw();
  };
  length.oninput = arch.oninput = redraw;
  dialog.append(head,tools,canvas,message,actions);
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  redraw();
  dialog.showModal();
}

export function createLedWorkspace({ assets, sequences, scene, url, save, renderSequence }) {
  const root = document.getElementById('led-workspace');
  const viewer = el('section','led-view panel');
  const viewport = el('div','led-viewport');
  const world = el('div','led-world');
  const floor = el('div','led-floor');
  const definitions = svg('svg',{width:0,height:0,'aria-hidden':'true'});
  const toolbar = el('div','led-toolbar');
  const bottom = el('div','led-bottom');
  const status = el('output','subtle');
  status.setAttribute('role','status');
  const sidebar = el('aside','led-sidebar panel');
  const list = el('div','led-list');
  const properties = el('div','led-properties');
  const menu = el('div','led-menu panel');
  menu.hidden = true;
  let projectID;
  let selected;
  let positioning = false;
  let playing = false;
  let drag;
  let pending = false;
  const screens = new Map();
  const chosen = () => scene().walls.find(wall=>wall.id===selected);
  const available = () => new Map(assets().map(asset=>[asset.id,asset]));
  const add = button('＋ Add wall',() => {
    const count = scene().walls.length;
    const wall = {id:crypto.randomUUID(),name:'LED Wall '+(count+1),shape:'rectangle',width:8,height:4,
      x:count%4*9,y:count>3?5*Math.floor(count/4):0,z:0,rx:0,ry:0,rz:0,mediaX:0,mediaY:0,fit:'contain'};
    scene().walls.push(wall);
    choose(wall);
    save();
  },'primary');
  const play = button('Play walls',() => setPlaying(!playing));
  const zoom = number(100,10,350,1,value=>{
    scene().camera.zoom = value/100;
    camera();
    save();
  });
  function setPlaying(next) {
    playing = next;
    play.textContent = playing?'Pause walls':'Play walls';
    for (const screen of screens.values()) {
      if (playing && screen.video.src) void screen.video.play().catch(()=>{});
      else screen.video.pause();
    }
  }
  function camera() {
    const {pitch,yaw,zoom:magnification} = scene().camera;
    world.style.transform = 'scale('+magnification+') rotateX('+pitch+'deg) rotateY('+yaw+'deg)';
    zoom.value = Math.round(magnification*100);
  }
  function setCamera(pitch,yaw,magnification) {
    scene().camera = {pitch,yaw,zoom:magnification};
    camera();
    save();
  }
  toolbar.append(el('h1','','LED Wall'),button('Front',()=>setCamera(0,0,1)),button('Orbit view',()=>setCamera(-10,18,1)),field('Zoom (%)',zoom));
  bottom.append(play,button('Restart walls',()=>{
    for (const {video} of screens.values()) if (video.readyState) video.currentTime = 0;
  }),status);
  viewport.append(world);
  viewer.append(toolbar,viewport,bottom);
  const listHead = el('div','panel-head');
  listHead.append(el('h2','','Walls'),add);
  sidebar.append(listHead,list,properties);
  root.append(viewer,sidebar,definitions,menu);
  world.append(floor);

  function updateScreen(wall) {
    if (!screens.has(wall.id)) {
      const item = el('div','led-wall');
      const face = el('div','led-face');
      const video = el('video');
      Object.assign(video,{ muted:true, loop:true, playsInline:true, preload:'metadata' });
      const label = el('span','led-face-label');
      face.append(video);
      item.append(face,label);
      item.dataset.wall = wall.id;
      item.tabIndex = 0;
      item.setAttribute('role','button');
      item.onkeydown = event => { if (event.key==='Enter' || event.key===' ') { event.preventDefault(); choose(wall); } };
      item.oncontextmenu = event => {
        event.preventDefault();
        choose(wall);
        menu.replaceChildren(button('Position video',()=>{
          positioning = true;
          menu.hidden = true;
          render();
          document.getElementById('led-video-x').focus();
        }));
        menu.style.left = Math.min(event.clientX,window.innerWidth-160)+'px';
        menu.style.top = Math.min(event.clientY,window.innerHeight-52)+'px';
        menu.hidden = false;
      };
      world.append(item);
      screens.set(wall.id,{ item,face,video,label });
    }
    const {item,face,video,label} = screens.get(wall.id);
    item.setAttribute('aria-label',wall.name);
    item.classList.toggle('selected',wall.id===selected);
    item.style.width = wall.width*scale+'px';
    item.style.height = wall.height*scale+'px';
    item.style.transform = 'translate3d('+wall.x*scale+'px,'+(-wall.y*scale)+'px,'+wall.z*scale+'px) translate(-50%, -50%) rotateX('+wall.rx+'deg) rotateY('+wall.ry+'deg) rotateZ('+wall.rz+'deg)';
    label.textContent = wall.name+' · '+feet(wall.width)+' × '+feet(wall.height);
    let mask = masks[wall.shape] || 'none';
    if (wall.shape==='custom' && wall.outline) {
      const clipId = 'wall-'+wall.id;
      const clip = svg('clipPath',{id:clipId,clipPathUnits:'objectBoundingBox'});
      const [x,y,width,height] = wall.outline.box;
      clip.append(svg('path',{d:wall.outline.path,transform:'scale('+1/width+' '+1/height+') translate('+(-x)+' '+(-y)+')'}));
      definitions.append(clip);
      mask = 'url(#'+clipId+')';
    }
    face.style.clipPath = mask;
    const source = available().get(wall.asset);
    const path = source ? url(source) : wall.asset ? '/media/'+wall.asset+'/p-auto.mp4' : '';
    video.hidden = !path;
    if ((video.getAttribute('src') || '') !== path) {
      if (path) {
        video.src = path;
        if (playing) void video.play().catch(()=>{});
      } else {
        video.removeAttribute('src');
        video.load();
      }
    }
    video.style.objectFit = wall.fit==='stretch'?'fill':wall.fit;
    video.style.transform = 'translate('+wall.mediaX+'%,'+wall.mediaY+'%)';
  }
  function choose(wall) {
    if (selected!==wall.id) positioning = false;
    selected = wall.id;
    render();
  }
  function edit(wall, values, rebuild=true) {
    Object.assign(wall,values);
    if (rebuild) render();
    save();
  }
  function wallProperties(wall) {
    const name = el('input');
    name.value = wall.name;
    name.maxLength = 60;
    name.onchange = () => edit(wall,{name:name.value.trim() || wall.name});
    const shape = select(shapes,wall.shape,value=>{
      if (value==='custom' && !wall.outline) return draw();
      const size = ['circle','square'].includes(value) ? {height:wall.width} : {};
      edit(wall,{...size,shape:value});
    });
    const draw = () => outlineEditor(wall,result=>edit(wall,{shape:'custom',outline:result,width:result.width,height:result.height}));
    const symmetric = ['circle','square'].includes(wall.shape);
    const dimensions = el('div','led-columns');
    dimensions.append(field(wall.shape==='circle'?'Diameter (ft)':'Width (ft)',number(wall.width,.1,300,.01,value=>
      edit(wall,symmetric?{width:value,height:value}:{width:value}))));
    if (!symmetric) dimensions.append(field('Height (ft)',number(wall.height,.1,300,.01,value=>edit(wall,{height:value}))));
    const transforms = el('div','led-columns led-axes');
    for (const axis of ['x','y','z']) transforms.append(field(axis.toUpperCase()+' (ft)',
      number(wall[axis],-500,500,.1,value=>edit(wall,{[axis]:value}))));
    for (const axis of ['x','y','z']) transforms.append(field(axis.toUpperCase()+' rotation (°)',
      number(wall['r'+axis],-360,360,1,value=>edit(wall,{['r'+axis]:value}))));
    const source = el('select');
    source.add(new Option('No video',''));
    const media = el('optgroup');
    media.label = 'Footage';
    for (const asset of assets()) media.append(new Option(asset.name,'media:'+asset.id));
    const compositions = el('optgroup');
    compositions.label = 'Timelines';
    for (const item of sequences()) compositions.append(new Option(item.id==='main'?'Main · '+item.sequence.name:item.sequence.name,'sequence:'+item.id));
    source.append(media,compositions);
    source.value = wall.sequence ? 'sequence:'+wall.sequence : wall.asset ? 'media:'+wall.asset : '';
    const refresh = async key => {
      if (pending) return;
      const currentProject = projectID;
      pending = true;
      render();
      status.textContent = 'Preparing timeline video…';
      try {
        const asset = await renderSequence(key);
        if (projectID===currentProject && scene().walls.includes(wall)) edit(wall,{sequence:key,asset:asset.id});
        status.textContent = 'Timeline video ready.';
      } catch (error) { status.textContent = error.message; }
      finally { pending=false; render(); }
    };
    source.disabled = pending;
    source.onchange = () => {
      const [kind,key] = source.value.split(':');
      if (kind==='sequence') void refresh(key);
      else edit(wall,{sequence:null,asset:key || null});
    };
    const videoPosition = el('div','led-columns');
    for (const axis of ['X','Y']) {
      const numberInput = number(wall['media'+axis],-150,150,1,value=>edit(wall,{['media'+axis]:value}));
      numberInput.id = 'led-video-'+axis.toLowerCase();
      videoPosition.append(field('Video '+axis+' (%)',numberInput));
    }
    videoPosition.hidden = !positioning;
    properties.append(field('Wall name',name),field('Shape',shape),dimensions,button('Build custom shape',draw),
      el('h2','','Placement'),transforms,el('h2','','Wall video'),field('Source',source));
    if (wall.sequence) properties.append(button('Refresh timeline video',()=>void refresh(wall.sequence), 'secondary'));
    properties.append(field('Fit',select({contain:'Fit inside wall',cover:'Fill and crop',stretch:'Stretch to fit'},wall.fit,value=>edit(wall,{fit:value}))),
      button(positioning?'Done positioning':'Position video',()=>{ positioning=!positioning; render(); }),videoPosition);
    const actions = el('div','inline-actions');
    actions.append(button('Duplicate wall',()=>{
      const copy = {...structuredClone(wall),id:crypto.randomUUID(),name:wall.name+' copy',x:wall.x+1};
      scene().walls.push(copy);
      choose(copy);
      save();
    }),button('Remove wall',()=>{
      scene().walls = scene().walls.filter(item=>item!==wall);
      selected = scene().walls[0]?.id;
      positioning = false;
      render();
      save();
    }));
    properties.append(actions);
  }
  function render() {
    definitions.replaceChildren();
    const walls = scene().walls;
    for (const [id,screen] of screens) {
      if (walls.some(wall=>wall.id===id)) continue;
      screen.video.pause();
      screen.item.remove();
      screens.delete(id);
    }
    list.replaceChildren();
    properties.replaceChildren();
    camera();
    viewport.classList.toggle('positioning-video',positioning);
    if (!walls.length) list.append(el('p','subtle','Add a wall to set its size and assign a video.'));
    for (const wall of walls) {
      updateScreen(wall);
      const item = button(wall.name,()=>choose(wall),'led-list-item');
      item.setAttribute('aria-pressed',String(wall.id===selected));
      list.append(item);
    }
    const wall = chosen();
    if (wall) wallProperties(wall);
  }
  viewport.onpointerdown = event => {
    menu.hidden = true;
    if (event.button!==0) return;
    const key = event.target.closest('[data-wall]')?.dataset.wall;
    const wall = scene().walls.find(item=>item.id===key);
    if (wall && key!==selected) choose(wall);
    const pan = wall?.id===selected && positioning;
    drag = {x:event.clientX,y:event.clientY,...scene().camera,pan,wall,mediaX:wall?.mediaX,mediaY:wall?.mediaY};
    viewport.setPointerCapture(event.pointerId);
  };
  viewport.onpointermove = event => {
    if (!drag) return;
    const x = event.clientX-drag.x;
    const y = event.clientY-drag.y;
    if (drag.pan) {
      const wall = drag.wall;
      wall.mediaX = bounded(Math.round(drag.mediaX+100*x/(wall.width*scale*drag.zoom)),-150,150);
      wall.mediaY = bounded(Math.round(drag.mediaY+100*y/(wall.height*scale*drag.zoom)),-150,150);
      const video = screens.get(wall.id).video;
      video.style.transform = 'translate('+wall.mediaX+'%,'+wall.mediaY+'%)';
      document.getElementById('led-video-x').value = wall.mediaX;
      document.getElementById('led-video-y').value = wall.mediaY;
    } else {
      scene().camera.pitch = bounded(drag.pitch-y*.25,-85,85);
      scene().camera.yaw = drag.yaw+x*.28;
      camera();
    }
  };
  const finishDrag = () => { if (drag) { drag=null; save(); } };
  viewport.onpointerup = viewport.onpointercancel = finishDrag;
  viewport.addEventListener('wheel',event=>{
    event.preventDefault();
    scene().camera.zoom = bounded(scene().camera.zoom*Math.exp(-event.deltaY*.001),.1,3.5);
    camera();
    save();
  },{passive:false});
  document.addEventListener('pointerdown',event=>{ if (!menu.contains(event.target)) menu.hidden=true; });
  return {
    open(key) {
      if (projectID!==key) {
        projectID = key;
        selected = scene().walls[0]?.id;
        positioning = false;
        status.textContent = '';
      }
      render();
    },
    suspend() { setPlaying(false); menu.hidden=true; }
  };
}
