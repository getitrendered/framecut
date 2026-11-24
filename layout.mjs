const workspace=document.getElementById('workspace-root');
const storage='framecut-layout-v1';
let layouts={};
try { layouts=JSON.parse(localStorage.getItem(storage) || '{}') || {}; }
catch { layouts={}; }
const mode=()=>workspace.dataset.page==='footage'?'footage':'editor';
const current=()=>layouts[mode()] ||= {};
const bounded=(n,min,max)=>Math.max(min,Math.min(max,n));
const rect=selector=>workspace.querySelector(selector).getBoundingClientRect();
const left=()=>rect(mode()==='footage'?'.folders':'.viewer').width;
const right=()=>rect(mode()==='footage'?'.source':'.inspector').width;
const axes= {
  'resize-left': { key:'left',axis:'x',direction:1,read:left,range:()=>[146,Math.min(700,workspace.clientWidth-right()-310)] },
  'resize-right': { key:'right',axis:'x',direction:-1,read:right,range:()=>[156,Math.min(760,workspace.clientWidth-left()-310)] },
  'resize-tasks': { key:'tasks',axis:'y',direction:-1,read:()=>rect('.tasks-panel').height,range:()=>[45,Math.max(60,rect('.viewer').height*.56)] },
  'resize-tools': { key:'tools',axis:'y',direction:1,read:()=>rect('#tools').height,range:()=>[64,Math.max(90,rect('.inspector-scroll').height-125)] },
  'resize-tracks': { key:'tracks',axis:'y',direction:1,read:()=>current().tracks || 70,range:()=>[37,164] },
  'resize-source': { key:'source',axis:'y',direction:1,read:()=>rect('#source-video').height,range:()=>[65,Math.max(80,rect('.source').height*.7)] }
};

function apply() {
  const layout=current();
  const root=workspace.style;
  for(const [key,property] of [
    ['left','--left-width'], ['right','--right-width'], ['tools','--tools-height'],
    ['source','--source-height'], ['tasks','--tasks-height'], ['tracks','--video-row']
  ]) {
    if(Number.isFinite(layout[key])) {
      const config=Object.values(axes).find(item=>item.key===key);
      const [min,max]=config.range();
      root.setProperty(property,`${Math.round(bounded(layout[key],min,max))}px`);
    } else root.removeProperty(property);
  }
  if(Number.isFinite(layout.tracks)){
    root.setProperty('--title-row',`${Math.round(layout.tracks*48/70)}px`);
    root.setProperty('--audio-row',`${Math.round(layout.tracks*46/70)}px`);
  } else {
    root.removeProperty('--title-row');
    root.removeProperty('--audio-row');
  }
  for(const [id,config] of Object.entries(axes)){
    const grip=document.getElementById(id);
    const [min,max]=config.range();
    grip.setAttribute('aria-valuemin',Math.round(min));
    grip.setAttribute('aria-valuemax',Math.round(Math.max(min,max)));
    grip.setAttribute('aria-valuenow',Math.round(config.read()));
  }
}

function persist(){
  try{localStorage.setItem(storage,JSON.stringify(layouts));}
  catch{}
}

for(const [id,config] of Object.entries(axes)){
  const grip=document.getElementById(id);
  grip.title='Drag to resize · Double-click to reset';
  const coordinate=event=>config.axis==='x'?event.clientX:event.clientY;
  function change(value){
    const [min,max]=config.range();
    current()[config.key]=bounded(value,min,max);
    apply();
  }
  let drag=null;
  grip.onpointerdown=event=>{
    if(event.button!==0) return;
    event.preventDefault();
    drag={pointer:event.pointerId,coordinate:coordinate(event),value:config.read()};
    grip.setPointerCapture(event.pointerId);
    grip.classList.add('resizing');
  };
  grip.onpointermove=event=>{
    if(drag?.pointer!==event.pointerId) return;
    change(drag.value+(coordinate(event)-drag.coordinate)*config.direction);
  };
  grip.onlostpointercapture=()=>{
    if(drag){drag=null;grip.classList.remove('resizing');persist();}
  };
  grip.ondblclick=()=>{
    delete current()[config.key];
    apply();persist();
  };
  grip.onkeydown=event=>{
    const arrows=config.axis==='x'?['ArrowLeft','ArrowRight']:['ArrowUp','ArrowDown'];
    if(!arrows.includes(event.key) && event.key!=='Home') return;
    event.preventDefault();
    if(event.key==='Home'){delete current()[config.key];apply();}
    else change(config.read()+(event.key===arrows[0]?-1:1)*config.direction*(event.shiftKey?32:12));
    persist();
  };
}

new MutationObserver(apply).observe(workspace,{attributes:true,attributeFilter:['data-page']});
new ResizeObserver(apply).observe(workspace);
apply();
