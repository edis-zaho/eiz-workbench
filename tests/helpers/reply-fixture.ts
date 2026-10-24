import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,validateBackup} from '../../core/store';
import {saveProduct} from '../../core/catalog';
import {saveKnowledge,knowledgeState} from '../../core/knowledge';
import {recordConversation,markUnsubscribe} from '../../core/inbox';
import {interpretationHistory,saveHumanInterpretation} from '../../core/interpretations';
import {emptyInterpretation} from '../../core/interpretation-input';
import {conversationPreview,saveConversationCase} from '../../core/conversations';
import {threadContextSetup,saveThreadContext} from '../../core/thread-context';
import {replyWritingOptions,replyWritingSetup,reserveReplyWriting,finishReplyWriting,saveReplyDraft,replyWritingState,exportReplyWriting} from '../../core/reply-writing';
import {rehearseRestore} from '../../core/recovery';
import {startServer} from '../../core/server';
const resign=(b:any)=>{b.checksum=createHash('sha256').update(JSON.stringify(b.data)).digest('hex');return b;};
export function fixture(options:{assessed?:boolean;excerpt?:string}={}){
 const dir=mkdtempSync(join(tmpdir(),'eiz-reply-writing-')),file=join(dir,'revenue.sqlite'),backups=join(dir,'backups');let s=new Store(file,backups,false);
 const a=s.createClient({name:'A',website:'',email:'',notes:''}).id,b=s.createClient({name:'B',website:'',email:'',notes:''}).id;
 let brief=s.addSource(a,{kind:'manual',url:'',title:'Synthetic',text:'Synthetic product'},0);brief=s.reviewSource(a,brief.content.sources[0].id,brief.revision,true);Object.assign(brief.content.rules,{offer:'CSV',targets:'Companies',personas:'IT',claims:'CSV',aiDailyLimit:2});brief.content.routes.analysis.model='test';brief.content.routes.writing.model='test';brief=s.saveRules(a,{...brief.content,revision:brief.revision});s.approveBrief(a,brief.revision,1);
 const product={name:'Synthetic CSV',description:'Synthetic only',website:'',bookingUrl:'https://example.com/book',archived:false},p=saveProduct(s,a,null,product,0).productId;
 const source=saveKnowledge(s,a,p,{entityId:null,expectedRevision:0,productRevision:1,kind:'source',action:'save',content:{title:'Synthetic facts',locator:'Synthetic document',capturedAt:'2026-10-01T10:00:00.000Z',text:'Exports CSV.',withdrawn:false},actor:'Operator',reason:'Checked'});
 const claim=saveKnowledge(s,a,p,{entityId:null,expectedRevision:0,productRevision:1,kind:'claim',action:'save',content:{category:'feature',text:'Exports CSV.',sourceId:source.id,quote:'Exports CSV.'},actor:'Operator',reason:'Checked'});
 const fact=saveKnowledge(s,a,p,{entityId:claim.entityId,expectedRevision:1,productRevision:1,kind:'claim',action:'approve',content:{category:'feature',text:'Exports CSV.',sourceId:source.id,quote:'Exports CSV.'},actor:'Operator',reason:'Checked'});
 const mail=s.reserveMailTest(a,{id:randomUUID(),clientVersion:1,mailboxId:randomUUID(),sender:'sender@example.com',recipient:'lead@example.com',subject:'CSV',body:'Exports CSV.'});s.finishMailTest(a,mail.id,'sent','sent123','Synthetic');
 recordConversation(s,a,mail.id,{clientVersion:1,mailboxId:mail.mailboxId,rows:[{providerId:'reply123',threadId:'thread123',sender:mail.recipient,subject:'Re',excerpt:options.excerpt||'CSV?',receivedAt:'2026-10-01T12:00:00.000Z',kind:'reply',evidence:'{}'}]});
 const incoming=s.exportBackup().data.incoming![0],event=s.db.prepare("SELECT id FROM evidence_events WHERE source='incoming' AND providerId='reply123'").get()!.id as string;
 function human(patch:any={}){const h=interpretationHistory(s,a,event);saveHumanInterpretation(s,a,event,{expectedRevision:h.revision,expectedBasisHash:h.basisHash,reviewer:'Operator',content:{...emptyInterpretation(),replyType:'interest',technicalQuestion:'no',materialRequest:'no',meetingIntent:'no',requiresHumanReview:false,rationale:'Checked',...patch}});}
 function decide(status='dialogue_ready'){const c=conversationPreview(s,a,mail.recipient);saveConversationCase(s,a,{recipient:mail.recipient,expectedId:c.current?.id||null,basisHash:c.basisHash,status,dueDate:null,actor:'Operator',reason:'Checked',confirmed:true});}
 if(options.assessed!==false){human();decide();}
 const capture={threadId:'thread123',messages:[{providerId:'sent123',messageId:mail.messageId,from:mail.sender,to:mail.recipient,cc:'',subject:'CSV',sentAt:'2026-10-01T11:00:00.000Z',direction:'sent',text:'Exports CSV.',textStatus:'plain',issues:[]},{providerId:'reply123',messageId:'<reply@example.com>',from:mail.recipient,to:mail.sender,cc:'',subject:'Re',sentAt:incoming.receivedAt,direction:'received',text:options.excerpt||'Can I export CSV?',textStatus:'plain',issues:[]}]};
 function captureSave(value=capture){const c=threadContextSetup(s,a,incoming.id);return saveThreadContext(s,a,incoming.id,{basisHash:c.basisHash,expectedId:c.expectedId,capture:value});}captureSave();
 function setup(){return replyWritingSetup(s,a,incoming.id,p,[fact.id]);}
 function reserve(){const v=setup();return reserveReplyWriting(s,a,incoming.id,{productId:p,factIds:[fact.id],basisHash:v.basisHash,confirmed:true});}
 const output={outcome:'draft',subject:'Re: CSV',body:'Yes, CSV export is available.',factIds:[fact.id],missingKnowledge:[],rationale:'Approved source'};
 function finish(id:string,value:any=output){return finishReplyWriting(s,a,incoming.id,id,{status:'completed',text:JSON.stringify(value),usage:{inputTokens:20,outputTokens:10}});}
 function save(id:string,patch:any={}){const state=replyWritingState(s,a,incoming.id);return saveReplyDraft(s,a,incoming.id,id,{expectedId:state.drafts[0]?.id||null,subject:output.subject,body:output.body,factIds:[fact.id],actor:'Operator',reason:'Verified',confirmed:true,...patch});}
 return {get s(){return s;},dir,backups,a,b,p,product,fact,incoming,mail,source,capture,captureSave,human,decide,setup,reserve,output,finish,save,reopen(){s.close();s=new Store(file,backups,false);},close(){s.close();rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}};
}
