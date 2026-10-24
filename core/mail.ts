import { validEmail } from './leads';
export type MailTest = { id:string;clientId:string;mailboxId:string;sender:string;recipient:string;subject:string;body:string;messageId:string;status:'sending'|'sent'|'failed'|'unknown';providerId:string;result:string;createdAt:string;updatedAt:string };
export type MailTestInput=Pick<MailTest,'id'|'mailboxId'|'sender'|'recipient'|'subject'|'body'> & {clientVersion:number};
export function validateMailInput(input:unknown):MailTestInput {
  const d=input as MailTestInput;
  if(!d||!Number.isSafeInteger(d.clientVersion)||d.clientVersion<1)throw new Error('Kundenstand fehlt.');
  for(const field of ['id','mailboxId'] as const)if(typeof d[field]!=='string'||!/^[a-f0-9-]{36}$/.test(d[field]))throw new Error('Ungültige Testkennung.');
  for(const field of ['sender','recipient'] as const)if(typeof d[field]!=='string'||!validEmail(d[field])||/[\r\n\0]/.test(d[field]))throw new Error('Bitte genau eine gültige E-Mail-Adresse angeben.');
  if(typeof d.subject!=='string'||!d.subject.trim()||d.subject.length>120||/[\r\n\0]/.test(d.subject))throw new Error('Betreff fehlt oder ist ungültig (maximal 120 Zeichen).');
  if(typeof d.body!=='string'||!d.body.trim()||d.body.length>4000||d.body.includes('\0'))throw new Error('Nachricht fehlt oder überschreitet 4.000 Zeichen.');
  return {...d,sender:d.sender.toLowerCase(),recipient:d.recipient.toLowerCase(),subject:d.subject.trim(),body:d.body.trim()};
}
