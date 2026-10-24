import {AppError,type Store} from './store';
import {knowledgeState} from './knowledge';
import {sourceContent} from './knowledge-input';
import {exactObject,cleanText} from './interpretation-input';
import {extractText,fetchWebsite,websiteURL} from './website';

export const maxDocumentBytes=256*1024;
export function documentSource(filename:unknown,base64:unknown) {
  try{
    const name=cleanText(filename,160);
    if(/[\\/:\u0000-\u001f]/.test(name)||!/^.+\.(txt|md|html|htm)$/i.test(name))throw new AppError('Bitte eine UTF-8-Textdatei (.txt, .md, .html oder .htm) auswählen. PDF und Office folgen als eigener Import.');
    if(typeof base64!=='string'||!base64||base64.length>4*Math.ceil(maxDocumentBytes/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw new AppError('Datei ist ungültig oder größer als 256 KiB.');
    const bytes=Buffer.from(base64,'base64');if(bytes.length>maxDocumentBytes||bytes.toString('base64')!==base64)throw new AppError('Datei ist ungültig oder größer als 256 KiB.');
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new AppError('Die Datei ist nicht gültig UTF-8-kodiert. Bitte als UTF-8-Text speichern.');}
    const html=/\.html?$/i.test(name),content=html?extractText(text,true):{title:name,text};
    if(content.text.length>20000)throw new AppError('Mehr als 20.000 Textzeichen. Bitte einen ausdrücklich bezeichneten Auszug verwenden; nichts wurde gekürzt.');
    return sourceContent({title:content.title||name,locator:`Datei ${name}`,capturedAt:new Date().toISOString(),text:content.text,withdrawn:false});
  }catch(e){if(e instanceof AppError)throw e;throw new AppError('Datei enthält keinen gültigen Quellentext. Inhalt und Zeichen prüfen.');}
}
export async function previewProductSource(s:Store,clientId:string,productId:string,input:any,reader=fetchWebsite) {
  try{
    exactObject(input,input?.kind==='website'?['kind','productRevision','url']:['kind','productRevision','filename','base64']);
    if(!['website','document'].includes(input.kind))throw new Error();
  }catch{throw new AppError('Ungültiger Quellenimport.');}
  const c=s.client(clientId),state=knowledgeState(s,clientId,productId);
  if(c.status==='paused'||state.archived)throw new AppError('Kunde pausiert oder Produkt archiviert. Import nicht gestartet.');
  if(!Number.isSafeInteger(input.productRevision)||state.productRevision!==input.productRevision)throw new AppError('Produktstand geändert. Wissen neu laden.',409);
  let source;
  if(input.kind==='website'){
    const url=websiteURL(input.url);const result=await reader(url.href,true);
    source=sourceContent({title:result.title,locator:result.url,capturedAt:new Date().toISOString(),text:result.text,withdrawn:false});
  }else source=documentSource(input.filename,input.base64);
  const after=knowledgeState(s,clientId,productId),customer=s.client(clientId);
  if(after.archived||after.productRevision!==state.productRevision||customer.version!==c.version||customer.status==='paused')throw new AppError('Kunden- oder Produktstand während des Imports geändert. Nichts gespeichert; neu starten.',409);
  return {clientId,productId,productRevision:state.productRevision,kind:input.kind,source};
}
