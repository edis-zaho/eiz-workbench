import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Store,validateBackup,AppError} from '../core/store';
import {recordConversation} from '../core/inbox';
import {interpretationHistory,saveHumanInterpretation,appendInterpretation,exportClientInterpretations,exportInterpretations} from '../core/interpretations';
import {emptyInterpretation,interpretationContent} from '../core/interpretation-input';
import {rehearseRestore} from '../core/recovery';
import {startServer} from '../core/server';
const {saveCheckpoint}=createRequire(import.meta.url)('../scripts/save-checkpoint.cjs');
const resign=(b:any)=>{b.checksum=createHash('sha256').update(JSON.stringify(b.data)).digest('hex');return b;};
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'eiz-interpretations-')),file=join(dir,'revenue.sqlite'),backups=join(dir,'backups');let s=new Store(file,backups,false);
  const a=s.createClient({name:'A',email:'',website:'',notes:''}).id,b=s.createClient({name:'B',email:'',website:'',notes:''}).id,mailboxId=randomUUID();
  const mail=s.reserveMailTest(a,{id:randomUUID(),clientVersion:1,mailboxId,sender:'sender@example.com',recipient:'lead@example.com',subject:'Synthetic',body:'Synthetic'});
  s.finishMailTest(a,mail.id,'sent','sent123','OK');
  function reply(){const providerId=randomUUID();recordConversation(s,a,mail.id,{mailboxId,clientVersion:s.client(a).version,rows:[{providerId,threadId:'thread123',sender:'lead@example.com',subject:'Frage',excerpt:'Bitte senden Sie technische Informationen.',receivedAt:'2026-09-01T12:00:00.000Z',kind:'reply',evidence:'{}'}]});return String(s.db.prepare("SELECT id FROM evidence_events WHERE source='incoming' AND providerId=?").get(providerId)!.id);}
  const eventId=reply();
  function input(patch={}){const h=interpretationHistory(s,a,eventId);return {expectedRevision:h.revision,expectedBasisHash:h.basisHash,reviewer:'Testbetreiber',content:{...emptyInterpretation(),rationale:'Explizite technische Anfrage im gespeicherten Ausschnitt.',...patch}};}
  return {get s(){return s;},a,b,eventId,mail,dir,backups,reply,input,save(patch={}){return saveHumanInterpretation(s,a,eventId,input(patch));},reopen(){s.close();s=new Store(file,backups,false);},close(){s.close();rmSync(dir,{recursive:true,force:true});}};
}
test('interpretations require complete explicit fields, uncertainty and a real rationale',()=>{
  for(const patch of [{replyType:'winner'},{meetingIntent:true},{technicalQuestion:null},{requiresHumanReview:'false'},{withdrawn:0},{rationale:' '},{rationale:'\0bad'},{extra:true}])assert.throws(()=>interpretationContent({...emptyInterpretation(),rationale:'valid',...patch}));
  assert.deepEqual(interpretationContent({...emptyInterpretation(),rationale:' valid '}),{...emptyInterpretation(),rationale:'valid'});
});
test('human versions and withdrawal preserve original observations, stops and prior assessments',()=>{
  const f=fixture();try{
    const before=f.s.exportBackup().data;
    const one=f.save({replyType:'interest',materialRequest:'yes'}),two=f.save({replyType:'unclear',withdrawn:true,rationale:'Die frühere Einschätzung war nicht ausreichend belegt.'});
    const h=interpretationHistory(f.s,f.a,f.eventId);assert.equal(h.revision,2);assert.equal(h.rows[0].previousId,one.id);assert.equal(h.rows[0].id,two.id);assert.equal(h.rows[0].content.withdrawn,true);assert.equal(h.rows[1].content.replyType,'interest');
    const after=f.s.exportBackup().data;assert.deepEqual({...after,interpretations:[]},before);
    assert.equal(h.rows[0].sourceSnapshot.excerpt,'Bitte senden Sie technische Informationen.');
    assert.throws(()=>f.s.db.prepare("UPDATE interpretations SET actor='changed' WHERE id=?").run(one.id),/overwritten/);
    f.reopen();assert.equal(interpretationHistory(f.s,f.a,f.eventId).revision,2);
  }finally{f.close();}
});
test('revision and changed source conflicts fail without creating an extra version',()=>{
  const f=fixture();try{
    const input=f.input();f.save();assert.throws(()=>saveHumanInterpretation(f.s,f.a,f.eventId,input),(e:any)=>e.status===409);
    const stale=f.input();f.s.db.prepare("UPDATE incoming SET excerpt='Changed synthetic evidence' WHERE id=(SELECT sourceId FROM evidence_events WHERE id=?)").run(f.eventId);
    assert.throws(()=>saveHumanInterpretation(f.s,f.a,f.eventId,stale),(e:any)=>e.status===409);
    assert.equal(exportInterpretations(f.s).length,1);assert.equal(interpretationHistory(f.s,f.a,f.eventId).rows[0].sourceSnapshot.excerpt,'Bitte senden Sie technische Informationen.');
  }finally{f.close();}
});
test('a storage failure rolls back the assessment and never changes the evidence or contact state',()=>{
  const f=fixture();try{
    const before=f.s.exportBackup().data;
    f.s.db.exec("CREATE TRIGGER synthetic_interpretation_failure BEFORE INSERT ON interpretations BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;");
    assert.throws(()=>f.save(),/synthetic disk failure/);assert.deepEqual(f.s.exportBackup().data,before);
    f.s.db.exec('DROP TRIGGER synthetic_interpretation_failure');f.save();assert.equal(exportInterpretations(f.s).length,1);
  }finally{f.close();}
});
test('human route cannot forge model provenance; internal model seam stores explicit provenance only',()=>{
  const f=fixture();try{
    for(const extra of [{origin:'model'},{model:'fake'},{clientId:f.b},{eventId:randomUUID()},{provider:'Google'}])assert.throws(()=>saveHumanInterpretation(f.s,f.a,f.eventId,{...f.input(),...extra}),AppError);
    const h=interpretationHistory(f.s,f.a,f.eventId),content=f.input().content;
    assert.throws(()=>appendInterpretation(f.s,f.a,f.eventId,0,h.basisHash,content,{origin:'model',actor:'test',provider:'',model:'synthetic',promptVersion:'v1'}));
    appendInterpretation(f.s,f.a,f.eventId,0,h.basisHash,content,{origin:'model',actor:'Synthetic test producer',provider:'test-only',model:'synthetic',promptVersion:'v1'});
    const row=interpretationHistory(f.s,f.a,f.eventId).rows[0];assert.equal(row.origin,'model');assert.equal(row.promptVersion,'v1');
    f.save({rationale:'Menschliche Korrektur des synthetischen Modellvorschlags.'});assert.equal(interpretationHistory(f.s,f.a,f.eventId).rows[0].origin,'human');
  }finally{f.close();}
});
test('customer boundaries and incoming-only scope hold for history, writes and export',()=>{
  const f=fixture();try{
    f.save();assert.throws(()=>interpretationHistory(f.s,f.b,f.eventId),(e:any)=>e.status===404);
    assert.throws(()=>saveHumanInterpretation(f.s,f.b,f.eventId,f.input()),(e:any)=>e.status===404);
    const mailEvent=String(f.s.db.prepare("SELECT id FROM evidence_events WHERE source='mail_tests' LIMIT 1").get()!.id);
    assert.throws(()=>interpretationHistory(f.s,f.a,mailEvent),/nur Eingänge/);
    assert.equal(exportClientInterpretations(f.s,f.b).rowCount,0);assert.equal(exportClientInterpretations(f.s,f.a).rowCount,1);
    assert.equal(exportClientInterpretations(f.s,f.a).archive.rows[0].clientId,f.a);
  }finally{f.close();}
});
test('schema11 migration backs up the raw journal and creates no invented assessments',()=>{
  const f=fixture();try{
    const raw=f.s.exportBackup().data.evidenceEvents;
    f.s.db.exec('DROP TABLE experiment_versions; DROP TABLE strategy_versions; DROP TABLE knowledge_versions; DROP TABLE interpretations; DROP INDEX evidence_id_client; PRAGMA user_version=11');f.reopen();
    assert.equal(f.s.snapshot().database.schema,34);assert.deepEqual(f.s.exportBackup().data.evidenceEvents,raw);assert.deepEqual(exportInterpretations(f.s),[]);
    const name=readdirSync(f.backups).find(n=>n.includes('before-upgrade'))!,saved=validateBackup(JSON.parse(readFileSync(join(f.backups,name),'utf8')));
    assert.equal(saved.version,11);assert.deepEqual(saved.data.evidenceEvents,JSON.parse(JSON.stringify(raw)));assert.equal(saved.data.interpretations,undefined);
  }finally{f.close();}
});
test('older restore, checkpoint and isolated restart retain all known interpretation versions',()=>{
  const f=fixture();try{
    const old=f.s.exportBackup();f.save();f.save({withdrawn:true,rationale:'Korrektur mit neuer Version.'});const known=exportInterpretations(f.s);
    f.s.restore(old);assert.deepEqual(exportInterpretations(f.s),known);f.reopen();assert.deepEqual(exportInterpretations(f.s),known);
    const backup=f.s.exportBackup();assert.equal(rehearseRestore(backup).counts.interpretations,2);
    const checkpoint=saveCheckpoint(join(f.dir,'checkpoint'),f.dir);const checked=validateBackup(JSON.parse(readFileSync(checkpoint.filename,'utf8')));assert.deepEqual(checked.data.interpretations,JSON.parse(JSON.stringify(known)));
  }finally{f.close();}
});
test('backup tampering, missing revisions, competing branches and changed known IDs are rejected',()=>{
  const f=fixture();try{
    f.save();f.save({rationale:'Zweite nachvollziehbare Einschätzung.'});const before=f.s.exportBackup();
    for(const change of [(b:any)=>delete b.data.interpretations,(b:any)=>b.data.interpretations[0].clientId=f.b,(b:any)=>b.data.interpretations[0].eventHash='a'.repeat(64),(b:any)=>b.data.interpretations[0].sourceSnapshot='{}',(b:any)=>b.data.interpretations=b.data.interpretations.filter((r:any)=>r.revision!==1),(b:any)=>b.data.interpretations[0].content='{}',(b:any)=>b.data.interpretations[0].previousId=randomUUID(),(b:any)=>b.data.interpretations[0].origin='other',(b:any)=>b.version=11]){
      const corrupt=structuredClone(before);change(corrupt);
      assert.throws(()=>validateBackup(resign(corrupt)),/Bewertung/);
    }
    const changed=structuredClone(before);changed.data.interpretations![0].actor='Other';assert.throws(()=>f.s.restore(resign(changed)),/bekannten Bewertung/);
    const fork=structuredClone(before);fork.data.interpretations!.find(r=>r.revision===2)!.id=randomUUID();assert.throws(()=>f.s.restore(resign(fork)),/Bewertung/);
    assert.deepEqual(f.s.exportBackup().data,before.data);
  }finally{f.close();}
});
test('interpretation and export limits fail explicitly instead of losing records',()=>{
  const f=fixture();try{
    {
      const insert=f.s.db.prepare('INSERT INTO interpretations SELECT ?,clientId,eventId,?,NULL,origin,actor,provider,model,promptVersion,eventHash,sourceSnapshot,content,createdAt FROM interpretations WHERE id=?');
      // Data fixtures use direct SQL, while application writes always validate a full chain.
      for(let n=0;n<10;n++){
        const eventId=n===0?f.eventId:f.reply();const h=interpretationHistory(f.s,f.a,eventId);
        // appendInterpretation opens its own transaction: populate one template directly.
        const template=randomUUID();f.s.db.prepare('INSERT INTO interpretations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(template,f.a,eventId,1,null,'human','Synthetic','','','',h.eventHash,JSON.stringify(h.source),JSON.stringify(f.input().content),new Date().toISOString());
        f.s.transaction(()=>{for(let revision=2;revision<=1000;revision++)insert.run(randomUUID(),revision,template);});
      }
    }
    assert.equal(exportClientInterpretations(f.s,f.a).rowCount,10000);
    assert.throws(()=>saveHumanInterpretation(f.s,f.a,f.eventId,f.input()),/Bewertung/);
    const extra=f.reply(),h=interpretationHistory(f.s,f.a,extra);saveHumanInterpretation(f.s,f.a,extra,{...f.input(),expectedRevision:0,expectedBasisHash:h.basisHash});
    assert.throws(()=>exportClientInterpretations(f.s,f.a),/10.000/);assert.equal(exportClientInterpretations(f.s,f.b).rowCount,0);
  }finally{f.close();}
});
test('interpretation API preserves authentication, revision conflict and customer scope',async()=>{
  const f=fixture(),token='i'.repeat(64),server=await startServer(f.s,token,600000),path=`/api/clients/${f.a}/evidence-journal/${f.eventId}/interpretations`;
  const input=f.input(),headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  try{
    assert.equal((await fetch(server.url+path)).status,401);
    assert.equal((await fetch(server.url+path,{method:'POST',headers:{...headers,Origin:'https://untrusted.example'},body:JSON.stringify(input)})).status,403);
    const first=await fetch(server.url+path,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(first.status,200);
    assert.equal((await fetch(server.url+path,{method:'POST',headers,body:JSON.stringify(input)})).status,409);
    assert.equal((await fetch(server.url+path.replace(f.a,f.b),{headers})).status,404);
    const response=await fetch(server.url+path,{headers});assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).revision,1);
  }finally{await server.close();rmSync(f.dir,{recursive:true,force:true});}
});
