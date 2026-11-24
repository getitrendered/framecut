import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const active = new AsyncLocalStorage();
const tasks = new Map();

export async function withTask(label, operation, { cancellable = false } = {}) {
  const id = randomUUID();
  const now = Date.now();
  const task = { id, label, state:'working', stage:label, progress:null, eta:null, updated:now, stageStarted:now, cancellable };
  const controller = cancellable ? new AbortController() : null;
  tasks.set(id,{ task, controller });
  try {
    const result = await active.run({task,controller},operation);
    controller?.signal.throwIfAborted();
    Object.assign(task,{state:'ready',progress:100,eta:null});
    return result;
  } catch(error) {
    Object.assign(task,{state:controller?.signal.aborted?'cancelled':'error',progress:null,eta:null,error:error.message.split('\n')[0].slice(0,250)});
    throw error;
  } finally {
    task.cancellable=false;
    task.updated=Date.now();
    const finished=activityList().filter(item=>item.state!=='working').reverse();
    for(const previous of finished.slice(0,Math.max(0,finished.length-12))) tasks.delete(previous.id);
  }
}

export function taskStage(stage, progress=null) {
  const context=active.getStore();
  if(!context || context.controller?.signal.aborted) return;
  const {task}=context;
  const now=Date.now();
  if(task.stage!==stage) task.stageStarted=now;
  const percent=Number.isFinite(progress)?Math.min(100,Math.max(0,progress)):null;
  const elapsed=(now-task.stageStarted)/1000;
  const eta=percent>=5 && percent<100 && elapsed>=2 ? Math.round(elapsed*(100-percent)/percent):null;
  Object.assign(task,{stage,progress:percent===null?null:Math.floor(percent),eta,updated:now});
}

export function activityList() {
  return [...tasks.values()].map(item=>item.task).sort((a,b)=>b.updated-a.updated);
}

export function hasActiveTasks() {
  return [...tasks.values()].some(({task})=>task.state==='working');
}

export const taskSignal = () => active.getStore()?.controller?.signal;

export function cancelTask(id) {
  const item=tasks.get(id);
  if (!item?.task.cancellable) return false;
  Object.assign(item.task,{cancellable:false,stage:'Stopping…',progress:null,eta:null,updated:Date.now()});
  item.controller.abort(new Error('Task cancelled.'));
  return true;
}
