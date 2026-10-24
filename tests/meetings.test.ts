import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {Store,validateBackup} from '../core/store';
import {meetingBasis,saveMeeting,meetingOverview,validateMeetings} from '../core/meetings';
import {evidenceHash} from '../core/interpretations';
import {rehearseRestore} from '../core/recovery';
import {startServer} from '../core/server';
const {saveCheckpoint}=createRequire(import.meta.url)('../scripts/save-checkpoint.cjs');
function fixture(){const dir=mkdtempSync(join(tmpdir(),'eiz-meetings-')),file=join(dir,'revenue.sqlite'),backups=join(dir,'backups');let s=new Store(file,backups,false);const c=s.createClient({name:'Meeting test',email:'',website:'',notes:''}),other=s.createClient({name:'Other',email:'',website:'',notes:''});const mail=s.reserveMailTest(c.id,{id:randomUUID(),clientVersion:1,mailboxId:randomUUID(),sender:'me@example.com',recipient:'prospect@example.org',subject:'Synthetic',body:'Synthetic'});s.finishMailTest(c.id,mail.id,'sent','sent1','OK');const eventId=String(s.db.prepare("SELECT id FROM evidence_events WHERE sourceId=? AND json_extract(payload,'$.status')='sent'").get(mail.id)!.id),id=randomUUID();
 const input=(content:any={},extra:any={})=>{const h=meetingBasis(s,c.id,eventId),old=h.rows.find(r=>r.meetingId===id);return {meetingId:id,expectedRevision:old?.revision||0,eventHash:h.eventHash,reference:'calendar-test-1',confirmed:true,content:{status:'booked',scheduledAt:'2026-09-01T12:00:00.000Z',observedAt:new Date(Date.now()-1000).toISOString(),actor:'Testbetreiber',evidence:'Manuelle Rückmeldung des Kunden.',withdrawn:false,...content},...extra};};
 return {get s(){return s;},c,other,eventId,id,dir,backups,input,save:(content:any={},extra:any={})=>saveMeeting(s,c.id,eventId,input(content,extra)),reopen(){s.close();s=new Store(file,backups,false);},close(){s.close();rmSync(dir,{recursive:true,force:true});}};
}
const resign=(b:any)=>{b.checksum=createHash('sha256').update(JSON.stringify(b.data)).digest('hex');return b;};
test('meeting backup capacity is per customer, matching reads, not shared across customers',()=>{
 const f=fixture();try{f.save();const data=f.s.exportBackup().data,template=data.events.find(e=>e.type==='MEETING_RECORDED')!,first=data.evidenceEvents!.find(e=>e.id===f.eventId)!,second={...first,id:randomUUID(),clientId:f.other.id},base=JSON.parse(template.text);data.evidenceEvents!.push(second);data.events=[];
 for(const [clientId,source] of [[f.c.id,first],[f.other.id,second]] as const){const eventHash=evidenceHash(source);for(let i=0;i<50001;i++)data.events.push({...template,id:randomUUID(),clientId,text:JSON.stringify({...base,meetingId:randomUUID(),eventId:source.id,eventHash,reference:'capacity-'+i})});}
 assert.equal(data.events.length,100002);assert.doesNotThrow(()=>validateMeetings(data,30));
 // Move the second customer's records to the first with valid source hashes and distinct references.
 for(const e of data.events.slice(50001)){const p=JSON.parse(e.text);e.clientId=f.c.id;e.text=JSON.stringify({...p,eventId:first.id,eventHash:evidenceHash(first),reference:'second-'+p.reference});}
 assert.throws(()=>validateMeetings(data,30),/Terminhistorie/);
 }finally{f.close();}
});
test('meeting revisions preserve evidence, distinguish overdue from attendance and prevent duplicate appointments',()=>{
 const f=fixture();try{const raw=f.s.exportBackup().data.evidenceEvents;f.save();let r=meetingOverview(f.s,f.c.id);assert.equal(r.current.length,1);assert.equal(r.current[0].attendanceUnverified,true);assert.equal(r.current[0].content.status,'booked');assert.equal(r.history.length,1);
 assert.throws(()=>f.save({}, {meetingId:randomUUID(),expectedRevision:0}),/bereits erfasst/);const old=f.input();f.save({status:'rescheduled',scheduledAt:'2026-09-02T12:00:00.000Z'});assert.throws(()=>saveMeeting(f.s,f.c.id,f.eventId,old),/geändert/);f.save({status:'held_confirmed'});r=meetingOverview(f.s,f.c.id);assert.equal(r.current.length,1);assert.equal(r.current[0].revision,3);assert.equal(r.current[0].attendanceUnverified,false);f.save({withdrawn:true});assert.equal(meetingOverview(f.s,f.c.id).current[0].content.withdrawn,true);assert.deepEqual(f.s.exportBackup().data.evidenceEvents,raw);validateBackup(f.s.exportBackup());
 }finally{f.close();}
});
test('meeting writes require human evidence, exact source and truthful time ordering',()=>{
 const f=fixture();try{
 for(const data of [f.input({}, {confirmed:false}),f.input({evidence:''}),f.input({}, {origin:'model'}),f.input({}, {eventHash:'bad'}),f.input({observedAt:'2999-01-01T00:00:00.000Z'}),f.input({status:'held_confirmed',scheduledAt:'2999-01-01T00:00:00.000Z'}),f.input({scheduledAt:'2026-01-01T12:00:00'}),f.input({status:'invented'})])assert.throws(()=>saveMeeting(f.s,f.c.id,f.eventId,data));
 assert.throws(()=>saveMeeting(f.s,f.other.id,f.eventId,f.input()),/Quellbeleg/);assert.equal(meetingOverview(f.s,f.c.id).current.length,0);
 f.save();assert.throws(()=>f.save({}, {reference:'new-reference'}),/bleiben fest/);assert.equal(meetingOverview(f.s,f.c.id).history.length,1);
 }finally{f.close();}
});
test('old backups retain current meeting corrections and withdrawals with original raw evidence',()=>{
 const f=fixture();try{const old=f.s.exportBackup();f.save();f.save({status:'cancelled',evidence:'Prospect cancelled'});const before=meetingOverview(f.s,f.c.id);f.s.restore(old);f.reopen();assert.deepEqual(meetingOverview(f.s,f.c.id).history,before.history);assert.equal(meetingOverview(f.s,f.c.id).current[0].content.status,'cancelled');f.save({withdrawn:true});f.s.restore(old);assert.equal(meetingOverview(f.s,f.c.id).current[0].content.withdrawn,true);assert.equal(rehearseRestore(f.s.exportBackup()).schema,34);
 }finally{f.close();}
});
test('backup validation rejects fabricated provenance, broken revision chains and downgraded meeting data',()=>{
 const f=fixture();try{f.save();f.save({status:'no_show'});const original=f.s.exportBackup();for(const mode of ['source','chain','hash','origin','version','type','future']){const b=structuredClone(original),e=b.data.events.find(e=>e.type==='MEETING_RECORDED')!,d=JSON.parse(e.text);if(mode==='source')d.eventId=randomUUID();if(mode==='chain')d.previousId=randomUUID();if(mode==='hash')d.eventHash='x';if(mode==='origin')d.origin='model';if(mode==='version')b.version=29;if(mode==='type')e.type='MEETING_FAKE';if(mode==='future')d.content.observedAt='2999-01-01T00:00:00.000Z';e.text=JSON.stringify(d);assert.throws(()=>validateBackup(resign(b)),mode);assert.throws(()=>f.s.restore(b));assert.deepEqual(meetingOverview(f.s,f.c.id).history.length,2);}
 const conflict=structuredClone(original),event=conflict.data.events.find(e=>e.type==='MEETING_RECORDED')!,d=JSON.parse(event.text);d.content.evidence='Changed historical claim';event.text=JSON.stringify(d);resign(conflict);assert.throws(()=>f.s.restore(conflict),/bekannten Termin/);
 }finally{f.close();}
});
test('schema29 upgrade preserves records, saves the old version and checkpoints meeting history',()=>{
 const f=fixture();try{const before=f.s.exportBackup().data;f.s.db.exec('PRAGMA user_version=29');f.reopen();assert.equal(f.s.snapshot().database.schema,34);assert.deepEqual(f.s.exportBackup().data,before);const name=readdirSync(f.backups).find(n=>n.includes('before-upgrade'))!;assert.equal(validateBackup(JSON.parse(readFileSync(join(f.backups,name),'utf8'))).version,29);f.save();const saved=saveCheckpoint(join(f.dir,'checkpoint'),f.dir);const b=validateBackup(JSON.parse(readFileSync(saved.filename,'utf8')));assert.equal(b.version,34);assert.equal(b.data.events.filter(e=>e.type==='MEETING_RECORDED').length,1);
 }finally{f.close();}
});
test('meeting HTTP routes require authentication and maintain client isolation',async()=>{
 const f=fixture(),token='m'.repeat(64),server=await startServer(f.s,token,600000),path=`/api/clients/${f.c.id}/evidence-journal/${f.eventId}/meetings`,headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
 try{assert.equal((await fetch(server.url+path)).status,401);assert.equal((await fetch(server.url+path.replace(f.c.id,f.other.id),{headers})).status,404);const r=await fetch(server.url+path,{method:'POST',headers,body:JSON.stringify(f.input())});assert.equal(r.status,200);assert.equal((await r.json()).rows.length,1);const list=await(await fetch(server.url+`/api/clients/${f.other.id}/meetings`,{headers})).json();assert.equal(list.current.length,0);
 }finally{await server.close();rmSync(f.dir,{recursive:true,force:true});}
});
