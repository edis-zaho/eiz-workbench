const BASE='https://gmail.googleapis.com/gmail/v1/users/me';
const validHistory=id=>typeof id==='string'&&/^[1-9][0-9]{0,39}$/.test(id);
async function historyPage(progress,options,request){
 if(!validHistory(progress.historyId))throw Error('Ungültiger Änderungsstand.');
 let result;try{result=await request(`${BASE}/history?maxResults=25&startHistoryId=${progress.historyId}${progress.pageToken?'&pageToken='+encodeURIComponent(progress.pageToken):''}`,options);}catch(e){if(e.status===404)throw Object.assign(Error('Google-Änderungsstand abgelaufen. Vollständige Prüfung wird neu begonnen.'),{historyExpired:true});throw e;}
 if(!validHistory(result?.historyId)||BigInt(result.historyId)<BigInt(progress.historyId)||result.history!==undefined&&!Array.isArray(result.history))throw Error('Ungültige Änderungshistorie.');
 const messages=new Map();
 for(const event of result.history||[]){
  if(!validHistory(event.id))throw Error('Ungültiger Historieneintrag.');
  for(const field of ['messagesAdded','labelsAdded','labelsRemoved']){
   if(event[field]!==undefined&&!Array.isArray(event[field]))throw Error('Unvollständige Änderungshistorie.');
   for(const change of event[field]||[]){const id=change?.message?.id;if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(id))throw Error('Ungültige Nachricht in Historie.');messages.set(id,{id});}
  }
 }
 if(messages.size>100)throw Error('Änderungsseite überschreitet 100 Nachrichten. Prüfung bleibt angehalten.');
 return {messages:[...messages.values()],nextPageToken:result.nextPageToken,historyId:result.historyId};
}
module.exports={historyPage,validHistory};
