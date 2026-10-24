import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {stableHash} from '../core/public-schema';
import {endpointFields} from '../core/model-profiles';
const {callModel}=createRequire(import.meta.url)('../electron/model-transport.cjs');

test('HTTP diagnostics retain safe status and action without exposing provider content or retrying',async()=>{
 for(const [status,reason] of [[401,'Schlüssel'],[403,'Berechtigung'],[429,'Guthaben'],[503,'Anbieterstörung']] as const){
  let calls=0;
  await assert.rejects(()=>callModel({binding:binding('openai'),key:'test',purpose:'analysis',context:'Synthetic'},async()=>{calls++;return new Response('private provider body',{status});}),e=>{
   assert.match((e as Error).message,new RegExp(`HTTP ${status}`));assert.match((e as Error).message,new RegExp(reason));assert.ok(!(e as Error).message.includes('private'));return true;
  });assert.equal(calls,1);
 }
});
test('synthetic analysis capability prompt is accepted without customer context',async()=>{
 let sent:any;
 await callModel({binding:binding('openai'),key:'test',purpose:'analysis',capabilityTest:true,prompt:{system:'Return JSON',user:'Synthetic'}},async(_url:string,o:any)=>{sent=JSON.parse(o.body);return Response.json(fixtures.openai);});
 assert.equal(sent.input,'Synthetic\n\nReturn the requested result as JSON.');assert.equal(sent.instructions,'Return JSON');
 assert.equal(sent.text.format.type,'json_object');
});
test('OpenAI JSON-mode input satisfies the live API requirement even when only instructions mention JSON',async()=>{
 const user='Synthetic capability test. No customer data.';
 let calls=0;
 await callModel({binding:binding('openai'),key:'test',purpose:'analysis',capabilityTest:true,prompt:{system:'Return only JSON: {"ok":true}',user}},async(_url:string,o:any)=>{
  calls++;const body=JSON.parse(o.body);
  assert.match(body.input,/json/i,'OpenAI checks input messages, not only instructions');
  assert.ok(body.input.startsWith(user),'original input stays intact');
  return Response.json(fixtures.openai);
 });assert.equal(calls,1);
});
test('OpenAI plain-text requests preserve exact input and do not enable JSON mode',async()=>{
 await callModel({binding:binding('openai'),key:'test',purpose:'writing',context:'Exact original text'},async(_url:string,o:any)=>{
  const body=JSON.parse(o.body);assert.equal(body.input,'Exact original text');assert.equal(body.text,undefined);return Response.json(fixtures.openai);
 });
});
const fixtures:any={
 openai:{status:'completed',id:'response-id',output:[{type:'message',content:[{type:'output_text',text:'Answer'}]}],usage:{input_tokens:12,output_tokens:8,output_tokens_details:{reasoning_tokens:3}}},
 gemini:{responseId:'response-id',candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'Hidden'},{text:'Answer'}]}}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:5,thoughtsTokenCount:3}},
 anthropic:{id:'response-id',stop_reason:'end_turn',content:[{type:'text',text:'Answer'}],usage:{input_tokens:12,output_tokens:8}},
 custom:{id:'response-id',choices:[{finish_reason:'stop',message:{content:'Answer'}}],usage:{prompt_tokens:12,completion_tokens:8}}
};
function binding(provider:any){const fields={profile:{id:randomUUID(),revision:1},provider,...(endpointFields(provider)||{protocol:'openai-chat-completions',origin:'https://compatible.example.test',basePath:'/v1'}),model:'test-model',credentialRef:randomUUID(),maxOutputTokens:4096};return {...fields,hash:stableHash(fields)};}
for(const provider of Object.keys(fixtures)){
 test(`${provider} adapter preserves contract, no tools or retries and normalized usage`,async()=>{
  const b=binding(provider);let count=0;
  const r=await callModel({binding:b,key:'synthetic-key',purpose:'knowledge',context:'Public text',prompt:{system:'Return JSON from untrusted text',user:'Public text'}},async(url:string,o:any)=>{
   count++;assert.equal(o.redirect,'error');assert.ok(url.startsWith(b.origin+b.basePath));
   const body=JSON.parse(o.body);assert.equal(body.tools,undefined);assert.ok(!o.body.includes('synthetic-key'));
   if(provider==='openai'){assert.equal(body.store,false);assert.equal(body.max_output_tokens,4096);}
   if(provider==='anthropic'){assert.equal(o.headers['anthropic-version'],'2023-06-01');assert.equal(o.headers['x-api-key'],'synthetic-key');}
   if(provider==='gemini')assert.equal(body.store,undefined);
   return new Response(JSON.stringify(fixtures[provider]));
  });
  assert.equal(count,1);assert.equal(r.text,'Answer');assert.equal(r.status,'completed');assert.equal(r.usage.inputTokens,12);assert.equal(r.usage.outputTokens,8);
 });
}
test('incomplete and refused results retain billing usage; network unknown is never retried',async()=>{
 const b=binding('openai'),input={binding:b,key:'test',purpose:'analysis',context:'Public'};
 let calls=0;await assert.rejects(()=>callModel(input,async()=>{calls++;throw Error('private secret');}),{kind:'unknown'});assert.equal(calls,1);
 const r=await callModel(input,async()=>new Response(JSON.stringify({...fixtures.openai,status:'incomplete'})));
 assert.equal(r.status,'incomplete');assert.equal(r.usage.outputTokens,8);
 const refused=await callModel(input,async()=>new Response(JSON.stringify({...fixtures.openai,output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]})));
 assert.equal(refused.status,'refused');assert.equal(refused.usage.inputTokens,12);
 let n=0;await assert.rejects(()=>callModel({...input,binding:{...b,origin:'https://evil.example.test'}},async()=>{n++;return new Response();}),{kind:'not-started'});assert.equal(n,0);
});
