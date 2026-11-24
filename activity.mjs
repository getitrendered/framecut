import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const active = new AsyncLocalStorage();
const tasks = new Map();

export async function withTask(label, operation) {
  const id = randomUUID();
  const now = Date.now();
  const task = { id, label, state:'working', stage:label, progress:null, eta:null, updated:now, stageStarted:now };
  tasks.set(id,task);
  try {
    const result = await active.run(task,operation);
    Object.assign(task,{state:'ready',progress:100,eta:null});
    return result;
  } catch(error) {
    Object.assign(task,{state:'error',progress:null,eta:null,error:error.message.split('\n')[0].slice(0,250)});
    throw error;
  } finally {
    task.updated=Date.now();
    const finished=[...tasks.values()].filter(item=>item.state!=='working');
    for(const previous of finished.slice(0,Math.max(0,finished.length-12))) tasks.delete(previous.id);
  }
}

export function taskStage(stage, progress=null) {
  const task=active.getStore();
  if(!task) return;
  const now=Date.now();
  if(task.stage!==stage) task.stageStarted=now;
  const percent=Number.isFinite(progress)?Math.min(100,Math.max(0,progress)):null;
  const elapsed=(now-task.stageStarted)/1000;
  const eta=percent>=5 && percent<100 && elapsed>=2 ? Math.round(elapsed*(100-percent)/percent):null;
  Object.assign(task,{stage,progress:percent===null?null:Math.floor(percent),eta,updated:now});
}

export function activityList() {
  return [...tasks.values()].sort((a,b)=>b.updated-a.updated);
}

export function hasActiveTasks() {
  return [...tasks.values()].some(task=>task.state==='working');
}
