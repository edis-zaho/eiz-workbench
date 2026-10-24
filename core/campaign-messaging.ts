import {createHash} from 'node:crypto';
import {AppError} from './store';
import {validateCampaign,type CampaignContent} from './campaign';
import type {BackupData} from './types';

const hash=(prefix:string,value:unknown)=>prefix+createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Content-addressed versions: never resolve against today's hypothesis or templates.
// An empty effectiveStyle means inherit the fixed hypothesis referenced in scope.
export function campaignMessaging(clientId:string,input:CampaignContent){
  const c=validateCampaign(input);if(!c.sequence)return null;
  const scope={clientId,productRef:c.productRef,hypothesisId:c.hypothesisId,knowledgeIds:c.knowledgeIds};
  const variants=c.steps.map((step,index)=>{
    const effectiveStyle=step.variant!.style||c.sequence!.style;
    const variantId=hash('mv1_',{scope,variant:step.variant!,subject:step.subject,body:step.body,effectiveStyle});
    return {step:index+1,variantId,name:step.variant!.name,style:step.variant!.style,effectiveStyle,styleSource:step.variant!.style?'variant':c.sequence!.style?'sequence':'hypothesis',gapDays:step.gapDays};
  });
  const sequenceId=hash('sq1_',{scope,sequence:c.sequence,steps:variants.map(v=>({variantId:v.variantId,gapDays:v.gapDays}))});
  return {formatVersion:1,sequenceId,name:c.sequence.name,style:c.sequence.style,variants};
}

export function validateCampaignMessagingBackup(data:BackupData,version:number){
  const approvals=new Map<string,string[]>();
  function signature(clientId:string,content:CampaignContent){
    const m=campaignMessaging(clientId,content);
    if(m&&version<19)throw new AppError('Nachrichtenfassungen benötigen Sicherungsformat 19 oder neuer.');
    return m?.sequenceId||'';
  }
  for(const h of data.campaignHistory||[]){
    const id=signature(h.clientId,JSON.parse(h.content));
    if(h.action==='approved'){
      const key=h.clientId+':'+h.campaignId+':'+h.fingerprint,old=approvals.get(key)||[];
      if((id||old.some(Boolean))&&old.some(value=>value!==id))throw new AppError('Widersprüchliche Nachrichtenfassungen unter derselben Kampagnenfreigabe.');
      approvals.set(key,[...old,id]);
    }
  }
  for(const c of data.campaigns||[])signature(c.clientId,JSON.parse(c.content));
  for(const r of data.queueRuns||[]){
    const id=signature(r.clientId,JSON.parse(r.snapshot).content),old=approvals.get(r.clientId+':'+r.campaignId+':'+r.fingerprint)||[];
    if((id||old.some(Boolean))&&!old.includes(id))throw new AppError('Nachrichtenfassung des Versandlaufs weicht von ihrer historischen Freigabe ab.');
  }
}
