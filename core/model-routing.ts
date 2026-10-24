import {AppError,type Store} from './store';
import {publicRecord,putPublicRecord} from './public-schema';
import {endpointFields,getModelProfile,saveModelProfileWithinTransaction,type ModelTask,type ProfileRef,type ModelBinding} from './model-profiles';
export const MODEL_TASKS:ModelTask[]=['analysis','writing','knowledge','campaign-writing','reply-analysis','reply-writing'];
export function setModelRoute(s:Store,clientId:string,task:ModelTask,ref:ProfileRef){
  if(!MODEL_TASKS.includes(task))throw new AppError('Unbekannte Modellaufgabe.');
  const p=getModelProfile(s,ref.id);if(!p.enabled||p.revision!==ref.revision)throw new AppError('Modellprofil wurde geändert oder deaktiviert.',409);
  return s.transaction(()=>{
    s.client(clientId);const old=publicRecord(s,'routes',clientId);
    const content={enabled:true,tasks:{...old?.content.tasks,[task]:ref}};
    putPublicRecord(s,{kind:'routes',id:clientId,clientId,revision:(old?.revision||0)+1,content});
    return content;
  });
}
export function migrateLegacyModelRoutes(s:Store,clientId:string){
  if(publicRecord(s,'routes',clientId))return;
  // Explicit migration owns its transaction. Resolution never mutates public
  // profiles inside a reservation transaction.
  return s.transaction(()=>{
  const legacy=s.brief(clientId).content.routes,refs:Partial<Record<'analysis'|'writing',ProfileRef>>={};
  for(const purpose of ['analysis','writing'] as const){
    const route=legacy[purpose];if(!route.model)continue;
    const endpoint=endpointFields(route.provider);if(!endpoint)continue;
    const profile=saveModelProfileWithinTransaction(s,{name:`${s.client(clientId).name} · ${purpose}`,provider:route.provider,...endpoint,model:route.model,credentialRef:`legacy-${route.provider}`,maxOutputTokens:4096});
    refs[purpose]=profile.binding.profile;
  }
  const tasks:Partial<Record<ModelTask,ProfileRef>>={};
  for(const task of MODEL_TASKS){const ref=refs[['analysis','knowledge','reply-analysis'].includes(task)?'analysis':'writing'];if(ref)tasks[task]=ref;}
  if(Object.keys(tasks).length)putPublicRecord(s,{kind:'routes',id:clientId,clientId,revision:1,content:{enabled:true,tasks}});
  });
}
export function resolveModelRoute(s:Store,clientId:string,task:ModelTask):ModelBinding {
  if(!MODEL_TASKS.includes(task))throw new AppError('Unbekannte Modellaufgabe.');
  s.client(clientId);if(!s.publicMode)migrateLegacyModelRoutes(s,clientId);
  const routes=publicRecord(s,'routes',clientId)?.content;
  if(!routes?.enabled||!routes.tasks[task])throw new AppError('Bitte eine Modellroute wählen; vorhandene Route ist deaktiviert.');
  const ref=routes.tasks[task],p=getModelProfile(s,ref.id);
  if(!p.enabled||p.revision!==ref.revision)throw new AppError('Modellprofil wurde geändert oder deaktiviert. Bitte erneut wählen.',409);
  return structuredClone(p.binding);
}
