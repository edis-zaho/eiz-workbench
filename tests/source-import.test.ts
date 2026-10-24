import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../core/store';
import {saveProduct} from '../core/catalog';
import {documentSource,previewProductSource,maxDocumentBytes} from '../core/source-import';
import {extractText} from '../core/website';
import {startServer} from '../core/server';
const b64=(s:string)=>Buffer.from(s).toString('base64');
const product={name:'Synthetic',description:'Test only',website:'',bookingUrl:'',archived:false};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'eiz-source-import-')),s=new Store(join(dir,'db.sqlite'),join(dir,'backups'),false);const a=s.createClient({name:'A',website:'',email:'',notes:''}).id,b=s.createClient({name:'B',website:'',email:'',notes:''}).id,p=saveProduct(s,a,null,product,0).productId;return {s,a,b,p,close(closed=false){if(!closed)s.close();rmSync(dir,{recursive:true,force:true});}};}
test('UTF-8 text and Markdown preserve readable evidence without executing markup or taking file paths',()=>{
  for(const filename of ['facts.txt','facts.MD']){const r=documentSource(filename,b64('\ufeff# Nutzen\nÜbersicht: Das Produkt exportiert CSV.\n<script>not executed</script>'));assert.equal(r.title,filename);assert.equal(r.locator,`Datei ${filename}`);assert.ok(r.text.includes('Übersicht'));assert.equal(r.withdrawn,false);assert.ok(r.text.includes('<script>'));}
  for(const filename of ['C:/secret.txt','../secret.txt','x.pdf','x.docx','x.txt.exe','x\n.txt','x.js'])assert.throws(()=>documentSource(filename,b64('Test')));
});
test('invalid encodings, binary input, oversized files and noncanonical transport never become sources',()=>{
  for(const data of ['not base64',Buffer.from([0xff,0xfe,0x20]).toString('base64'),b64('has\0null'),b64(' '),b64('x'.repeat(20001)),Buffer.alloc(maxDocumentBytes+1,65).toString('base64'),'Zh=='])assert.throws(()=>documentSource('test.txt',data));
  assert.equal(documentSource('limit.txt',b64('x'.repeat(20000))).text.length,20000);
});
test('HTML import strips active content, keeps text and refuses truncation while legacy extraction stays compatible',()=>{
  const html='<title>Public &amp; plain</title><script>STEAL()</script><style>secret</style><template>hidden</template><main>'+('CSV export supports planning. '.repeat(6))+'</main>';
  const r=documentSource('page.html',b64(html));assert.equal(r.title,'Public & plain');assert.ok(!r.text.includes('STEAL'));assert.ok(!r.text.includes('hidden'));assert.ok(!r.text.includes('<'));
  const long='<p>'+('x'.repeat(20001))+'</p>';assert.throws(()=>documentSource('page.html',b64(long)),/nicht.*gekürzt|nichts.*gekürzt/);
  assert.equal(extractText(long).text.length,12000);assert.equal(extractText('<p>'+('x'.repeat(15000))+'</p>',true).text.length,15000);
});
test('website preview is product-bound and read-only; original final URL and no-truncation option retained',async()=>{
  const f=fixture();try{const before=f.s.exportBackup().data;let calls=0;const r=await previewProductSource(f.s,f.a,f.p,{kind:'website',productRevision:1,url:'https://example.com/product#section'},async(url,strict)=>{calls++;assert.equal(url,'https://example.com/product');assert.equal(strict,true);return {kind:'website',url:'https://example.com/final',title:'Final source',text:'Synthetic source text.'};});assert.equal(r.productId,f.p);assert.equal(r.source.locator,'https://example.com/final');assert.equal(calls,1);assert.deepEqual(f.s.exportBackup().data,before);}finally{f.close();}
});
test('foreign, stale, private and malformed inputs never invoke the website reader',async()=>{
  const f=fixture();try{let calls=0;const reader=async()=>{calls++;throw new Error('must not fetch');};
    for(const [client,input] of [[f.b,{kind:'website',productRevision:1,url:'https://example.com'}],[f.a,{kind:'website',productRevision:2,url:'https://example.com'}],[f.a,{kind:'website',productRevision:1,url:'https://127.1'}],[f.a,{kind:'website',productRevision:1,url:'http://example.com'}],[f.a,{kind:'website',productRevision:1,url:'https://example.com',actor:'forged'}],[f.a,{kind:'other',productRevision:1,filename:'x.txt',base64:b64('x')}]] as const)await assert.rejects(()=>previewProductSource(f.s,client,f.p,input,reader));
    assert.equal(calls,0);assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM knowledge_versions').get()!.n,0);
  }finally{f.close();}
});
test('product change or customer pause during async retrieval rejects the late preview without writes',async()=>{
  for(const change of ['product','archive','customer']){const f=fixture();try{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const pending=previewProductSource(f.s,f.a,f.p,{kind:'website',productRevision:1,url:'https://example.com'},async()=>{await gate;return {kind:'website',url:'https://example.com',title:'Test',text:'Test source.'};});
    if(change==='customer'){const c=f.s.client(f.a);f.s.updateClient(f.a,{...c,status:'paused'},c.version);}else saveProduct(f.s,f.a,f.p,{...product,archived:change==='archive'},1);
    release();await assert.rejects(()=>pending,/während des Imports/);assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM knowledge_versions').get()!.n,0);
  }finally{f.close();}}
});
test('local document preview uses no provider/website call and rejects archived products',async()=>{
  const f=fixture();try{const input={kind:'document',productRevision:1,filename:'case.md',base64:b64('A synthetic case study.')};const r=await previewProductSource(f.s,f.a,f.p,input,async()=>{throw new Error('network forbidden');});assert.equal(r.source.text,'A synthetic case study.');assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM ai_runs').get()!.n,0);saveProduct(f.s,f.a,f.p,{...product,archived:true},1);await assert.rejects(()=>previewProductSource(f.s,f.a,f.p,{...input,productRevision:2}),/archiviert/);}finally{f.close();}
});
test('source preview API requires local authentication and preserves the source editor as the only save step',async()=>{
  const f=fixture(),token='i'.repeat(64),server=await startServer(f.s,token,600000),path=`/api/clients/${f.a}/products/${f.p}/source-preview`,value={kind:'document',productRevision:1,filename:'facts.txt',base64:b64('Synthetic facts.')},headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  try{
    assert.equal((await fetch(server.url+path,{method:'POST',body:JSON.stringify(value)})).status,401);
    assert.equal((await fetch(server.url+path,{method:'POST',headers:{...headers,Origin:'https://external.example'},body:JSON.stringify(value)})).status,403);
    const response=await fetch(server.url+path,{method:'POST',headers,body:JSON.stringify(value)});assert.equal(response.status,200);assert.equal((await response.json()).source.text,'Synthetic facts.');assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM knowledge_versions').get()!.n,0);
  }finally{await server.close();f.close(true);}
});
