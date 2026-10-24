import {createServer,type IncomingMessage} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {RelayError,exact,scopes as validateScopes,type Scope,type RelayObservation} from './contract';
import {RelayStore} from './store';
const pixel=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
function auth(req:IncomingMessage,scopes:Scope[],role:'write'|'read'){const value=String(req.headers.authorization||'');if(!/^Bearer [a-f0-9]{64}$/.test(value))throw new RelayError(401,'Unauthorized');const actual=Buffer.from(value.slice(7));const scope=scopes.find(s=>timingSafeEqual(actual,Buffer.from(role==='write'?s.writeKey:s.readKey)));if(!scope)throw new RelayError(401,'Unauthorized');return scope;}
async function body(req:IncomingMessage){let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>16384)throw new RelayError(413,'Request too large');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new RelayError(400,'Invalid JSON');}}
function hints(req:IncomingMessage):RelayObservation['flags']{const agent=String(req.headers['user-agent']||'').slice(0,1024),purpose=String(req.headers['sec-purpose']||req.headers.purpose||'').slice(0,256),flags:RelayObservation['flags']=[];if(/bot|crawler|spider|scanner/i.test(agent))flags.push('automation');if(/prefetch|prerender/i.test(purpose))flags.push('prefetch');if(/GoogleImageProxy/i.test(agent))flags.push('proxy');return flags;}
export async function startRelay(store:RelayStore,config:{version:1;scopes:Scope[]},options:{host?:string;port?:number;requestsPerMinute?:number}={}){
 const scopes=validateScopes(config),rate=options.requestsPerMinute??6000;if(!Number.isSafeInteger(rate)||rate<1||rate>60000)throw Error('Invalid request rate');let minute=Math.floor(Date.now()/60000),requests=0;
 const server=createServer({maxHeaderSize:8192},async(req,res)=>{
  res.setHeader('Cache-Control','no-store, no-cache, max-age=0');res.setHeader('Pragma','no-cache');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
  try{
   const current=Math.floor(Date.now()/60000);if(current!==minute){minute=current;requests=0;}if(++requests>rate){res.setHeader('Retry-After','60');throw new RelayError(429,'Rate limit reached');}
   if(!req.url||req.url.length>4096||!req.url.startsWith('/')||req.url.startsWith('//'))throw new RelayError(400,'Invalid request');const url=new URL(req.url,'http://relay.local');
   let result:unknown;
   if(req.method==='POST'&&url.pathname==='/v1/register-bound'&&!url.search){const scope=auth(req,scopes,'write'),input=await body(req);exact(input,['stream','instanceId','registration']);if(input.stream!==scope.stream||input.instanceId!==store.instanceId)throw new RelayError(409,'Registration identity changed');result=store.register(scope,input.registration);}
   else if(req.method==='POST'&&url.pathname==='/v1/register'&&!url.search){const scope=auth(req,scopes,'write');result=store.register(scope,await body(req));}
   else if(req.method==='POST'&&url.pathname==='/v1/revoke'&&!url.search){const scope=auth(req,scopes,'write'),input=await body(req);if(!input||Object.keys(input).length!==1||typeof input.token!=='string')throw new RelayError(400,'Invalid fields');result=store.revoke(scope,input.token);}
   else if(req.method==='GET'&&url.pathname==='/v1/status'&&!url.search)result=store.status(auth(req,scopes,'read'));
   else if(req.method==='GET'&&url.pathname==='/v1/events'){
    const scope=auth(req,scopes,'read');if([...url.searchParams.keys()].some(k=>!['after','through'].includes(k))||url.searchParams.getAll('after').length!==1||url.searchParams.getAll('through').length>1)throw new RelayError(400,'Invalid pagination');
    const value=(s:string|null)=>{if(s===null||!/^(0|[1-9]\d{0,15})$/.test(s))throw new RelayError(400,'Invalid cursor');return Number(s);};result=store.page(scope,value(url.searchParams.get('after')),url.searchParams.has('through')?value(url.searchParams.get('through')):undefined);
   }else{
    const match=/^\/(o|c)\/([a-f0-9]{64})(\.gif)?$/.exec(url.pathname);if(!match||url.search||!['GET','HEAD'].includes(req.method||'')||(match[1]==='o')!==(match[3]==='.gif'))throw new RelayError(404,'Not found');
    const kind=match[1]==='o'?'open':'click',row=store.capture(match[2],kind,scopes,hints(req),req.method==='HEAD');
    if(kind==='open'){res.writeHead(200,{'Content-Type':'image/gif','Content-Length':pixel.length});res.end(req.method==='HEAD'?undefined:pixel);}else{res.writeHead(302,{Location:row.target!,'Content-Length':0});res.end();}return;
   }
   res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(result));
  }catch(e){const known=e instanceof RelayError;res.writeHead(known?e.status:503,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:known?e.message:'Relay unavailable'}));}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??0,options.host??'127.0.0.1',()=>{server.off('error',reject);resolve();});});const address=server.address();if(!address||typeof address==='string')throw Error('Relay did not listen');
 return {port:address.port,url:`http://127.0.0.1:${address.port}`,close:()=>new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections();})};
}
