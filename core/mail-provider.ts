export type MailCapabilities={send:boolean;read:boolean;incrementalSync:boolean;threadedReply:boolean;reconcileSent:boolean};
export type MailIdentity={providerKind:string;connectionId:string;email:string;checkedAt:string|null};
export type MailStatus={
 identity:MailIdentity|null;implemented:MailCapabilities;granted:Pick<MailCapabilities,'send'|'read'>;
 readiness:'disconnected'|'needs-auth'|'needs-read-check'|'ready'|'failed';lastSyncAt:string|null;
};
