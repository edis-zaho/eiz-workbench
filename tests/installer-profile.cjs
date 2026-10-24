const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2],{readOnly:true});
const result=JSON.stringify({clients:db.prepare('SELECT COUNT(*) n FROM clients').get().n,schema:db.prepare('PRAGMA user_version').get().user_version});
if(process.argv[3])require('node:fs').writeFileSync(process.argv[3],result);else console.log(result);
db.close();
