import {AppError,type Store} from './store';
import {withGmailReferences} from './gmail-reference';
// Transport only the evidence needed for matching, never historical message bodies.
export const MAIL_REFERENCE_LIMIT=100000;
export function mailReferences(s:Store,clientId:string,mailboxId:string){
 s.client(clientId);if(!/^[a-f0-9-]{36}$/.test(mailboxId))throw new AppError('Ungültiges Postfach.');
 const rows=s.db.prepare("SELECT id,clientId,mailboxId,sender,recipient,providerId,messageId,createdAt,status FROM mail_tests WHERE clientId=? AND mailboxId=? AND status='sent' ORDER BY createdAt,id LIMIT ?").all(clientId,mailboxId,MAIL_REFERENCE_LIMIT+1);
 if(rows.length>MAIL_REFERENCE_LIMIT)throw new AppError('Mehr als100.000 bestätigte Sendungen je Postfach: Abgleich angehalten, keine gekürzte Prüfung.',413);
 return withGmailReferences(s,clientId,rows as (typeof rows[number]&{id:string;clientId:string})[]);
}
