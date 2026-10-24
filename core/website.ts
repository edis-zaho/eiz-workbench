import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { AppError } from './store';

export function publicIPv4(ip:string) {
  if(isIP(ip)!==4)return false;
  const [a,b,c]=ip.split('.').map(Number);
  return a>0&&a<224&&a!==10&&a!==127&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0||b===88&&c===99))&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);
}
export function websiteURL(value:string) {
  let url:URL;try{url=new URL(value);}catch{throw new AppError('Bitte eine gültige HTTPS-Adresse angeben.');}
  if(url.protocol!=='https:'||url.port&&url.port!=='443'||url.username||url.password||url.href.length>2000)throw new AppError('Nur öffentliche HTTPS-Seiten ohne Anmeldedaten und Sonderport sind erlaubt.');
  if(url.hostname==='localhost'||url.hostname.endsWith('.local')||isIP(url.hostname)&&!publicIPv4(url.hostname)||url.hostname.includes(':'))throw new AppError('Lokale oder private Adressen sind nicht erlaubt.');
  url.hash='';return url;
}
const decode=(text:string)=>text.replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[\da-f]+|\d+);/gi,entity=>{const named:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '};if(named[entity.toLowerCase()])return named[entity.toLowerCase()];const hex=entity[2].toLowerCase()==='x',n=parseInt(entity.slice(hex?3:2,-1),hex?16:10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):' ';});
export function extractText(html:string,strictProductSource=false) {
  const title=decode(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'Website').replace(/<[^>]*>/g,'').trim().slice(0,140);
  const clean=html.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<[^>]*>/g,' ');
  const text=decode(clean).replace(/\s+/g,' ').trim();
  if(text.length<80)throw new AppError('Zu wenig lesbarer Text. Diese Website benötigt möglicherweise JavaScript. Bitte relevante Inhalte manuell als Quelle hinzufügen.');
  if(strictProductSource){if(text.length>20000)throw new AppError('Mehr als 20.000 Textzeichen. Bitte eine gezielte Unterseite oder einen ausdrücklich bezeichneten Auszug verwenden. Es wurde nichts gekürzt.');return {title,text};}
  return {title:title+(text.length>12000?' · Auszug':''),text:text.slice(0,12000)};
}
export async function fetchWebsite(value:string,strictProductSource=false) {
  const signal=AbortSignal.timeout(20000);
  try {
    let url=websiteURL(value);
    for(let hop=0;hop<=3;hop++) {
      signal.throwIfAborted();
      const addresses=await Promise.race([lookup(url.hostname,{family:4,all:true}),new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('Timeout')),{once:true}))]);
      if(!addresses.length||addresses.some(a=>!publicIPv4(a.address)))throw new AppError('Die Website verweist auf ein privates oder nicht unterstütztes Netzwerk.');
      const response=await new Promise<{status:number;location?:string;html:string}>((resolve,reject)=>{
        const req=request(url,{method:'GET',signal,agent:false,headers:{'User-Agent':'EiZ-Workbench/0.2 (website knowledge import)','Accept':'text/html','Accept-Encoding':'identity'},lookup:(_host,options:any,callback:any)=>options.all?callback(null,[addresses[0]]):callback(null,addresses[0].address,4)},res=>{
          const status=res.statusCode||0;
          if([301,302,303,307,308].includes(status)){res.resume();resolve({status,location:res.headers.location,html:''});return;}
          if(status!==200){res.resume();reject(new AppError(`Website antwortet mit HTTP ${status}.`));return;}
          if(!String(res.headers['content-type']||'').toLowerCase().includes('text/html')){res.resume();reject(new AppError('Diese Adresse liefert keine HTML-Webseite.'));return;}
          const chunks:Buffer[]=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){req.destroy(new AppError('Website ist zu groß (maximal 2 MB).'));return;}chunks.push(chunk);});
          res.on('error',reject);res.on('end',()=>resolve({status,html:Buffer.concat(chunks).toString('utf8')}));
        });req.on('error',reject);req.end();
      });
      if(response.location){url=websiteURL(new URL(response.location,url).href);continue;}
      if(response.status!==200)throw new AppError('Weiterleitung ohne gültiges Ziel.');
      return {kind:'website' as const,url:url.href,...extractText(response.html,strictProductSource)};
    }
    throw new AppError('Zu viele Weiterleitungen. Bitte die endgültige Seitenadresse verwenden.');
  }catch(e){if(e instanceof AppError)throw e;throw new AppError('Website nicht erreichbar oder Zeitlimit überschritten. Inhalte können manuell ergänzt werden.');}
}
