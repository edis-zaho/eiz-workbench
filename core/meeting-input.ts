import {exactObject,cleanText} from './interpretation-input';
export const meetingStatuses=['booked','rescheduled','cancelled','no_show','held_unverified','held_confirmed'] as const;
export type MeetingContent={status:typeof meetingStatuses[number];scheduledAt:string;observedAt:string;actor:string;evidence:string;withdrawn:boolean};
export const meetingLabels:Record<MeetingContent['status'],string>={booked:'Termin vereinbart',rescheduled:'Termin verschoben',cancelled:'Termin abgesagt',no_show:'Nicht erschienen',held_unverified:'Teilnahme ungeklärt',held_confirmed:'Teilnahme durch Betreiber bestätigt'};
export function isoTime(value:unknown):string{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw Error('Zeitpunkt benötigt eine eindeutige ISO-Zeit mit Zeitzone.');return value;}
export function meetingContent(value:any):MeetingContent{
 exactObject(value,['status','scheduledAt','observedAt','actor','evidence','withdrawn']);
 if(!meetingStatuses.includes(value.status)||typeof value.withdrawn!=='boolean')throw Error('Ungültiger Terminstatus.');
 const scheduledAt=isoTime(value.scheduledAt),observedAt=isoTime(value.observedAt);
 if(['no_show','held_unverified','held_confirmed'].includes(value.status)&&scheduledAt>observedAt)throw Error('Teilnahme kann nicht vor dem Terminzeitpunkt festgestellt werden.');
 return {status:value.status,scheduledAt,observedAt,actor:cleanText(value.actor,120),evidence:cleanText(value.evidence,2000),withdrawn:value.withdrawn};
}
