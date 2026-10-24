export function encryptPortableBackup(bytes:Uint8Array,passphrase:string):Promise<Buffer>;
export function decryptPortableBackup(bytes:Uint8Array,passphrase:string):Promise<Buffer>;
export function encryptLocalBackup(bytes:Uint8Array,key:Buffer):Buffer;
export function decryptLocalBackup(bytes:Uint8Array,key:Buffer):Buffer;
