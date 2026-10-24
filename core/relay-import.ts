import {exactObject} from './interpretation-input';
import {signalFile,type SignalFile} from './signal-input';
import {uuid,utc,type RelayPage} from '../relay/contract';
// This bridge prepares the existing reviewed import format. It never writes, advances
// a desktop cursor, grants automatic approval or calls a remote URL.
export function relayImportFiles(value:any,expected:{instanceId:string;stream:string;after:number;through?:number},bindings:{messageRef:string;message:SignalFile['message']}[]){
 exactObject(value,['format','version','instanceId','stream','after','through','next','complete','rows']);
 if(value.format!=='eiz-relay-page'||value.version!==1||!uuid(value.instanceId)||!uuid(value.stream)||value.instanceId!==expected.instanceId||value.stream!==expected.stream||value.after!==expected.after||expected.through!==undefined&&value.through!==expected.through||!Array.isArray(value.rows)||value.rows.length>500||typeof value.complete!=='boolean'||[value.after,value.through,value.next].some(n=>!Number.isSafeInteger(n)||n<0)||value.after>value.next||value.next>value.through||value.complete&&value.next!==value.through||!value.complete&&(!value.rows.length||value.next>=value.through))throw Error('Ungültige Relay-Seite oder geänderte Herkunft.');
 const map=new Map<string,SignalFile['message']>();for(const b of bindings){if(!uuid(b.messageRef)||map.has(b.messageRef))throw Error('Widersprüchliche lokale Nachrichtenbindung.');map.set(b.messageRef,b.message);}
 const ids=new Set<string>(),groups=new Map<string,SignalFile>();let cursor=value.after;
 for(const row of value.rows){exactObject(row,['cursor','id','messageRef','kind','occurredAt','capturedAt','linkId','flags']);if(!Number.isSafeInteger(row.cursor)||row.cursor<=cursor||row.cursor>value.next||!uuid(row.id)||ids.has(row.id)||!uuid(row.messageRef)||utc(row.occurredAt)!==row.capturedAt)throw Error('Ungültiger Relay-Beleg.');cursor=row.cursor;ids.add(row.id);const message=map.get(row.messageRef);if(!message)throw Error('Lokale Zuordnung fehlt. Keine Seite überspringen.');
  let file=groups.get(row.messageRef);if(!file){file={format:'eiz-signal-import',version:1,source:{provider:'eiz-relay-v1',stream:value.stream},message,events:[]};groups.set(row.messageRef,file);}file.events.push({externalId:row.id,kind:row.kind,occurredAt:row.occurredAt,capturedAt:row.capturedAt,linkId:row.linkId,flags:row.flags});
 }
 if(!value.complete&&(cursor!==value.next||value.rows.length!==500)||value.complete&&cursor!==value.through||value.rows.length===0&&value.after!==value.through)throw Error('Relay-Seite enthält eine Lücke.');
 return {files:[...groups.values()].map(signalFile),next:value.next as number,through:value.through as number,complete:value.complete as boolean,instanceId:value.instanceId as string};
}
