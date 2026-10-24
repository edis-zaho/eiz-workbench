import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessStorage,BACKUP_IMPORT_LIMIT} from '../core/storage';
test('Speicherprüfung unterscheidet Importgrenze, Vorwarnung und unbekannten Speicher',()=>{
 assert.equal(assessStorage(1000,2e9).warnings.length,0);
 assert.equal(assessStorage(BACKUP_IMPORT_LIMIT,2e9).withinImportLimit,true);
 assert.equal(assessStorage(BACKUP_IMPORT_LIMIT+1,2e9).withinImportLimit,false);
 assert.equal(assessStorage(BACKUP_IMPORT_LIMIT*.8,2e9).warnings.length,1);
 assert.equal(assessStorage(1000,null).freeBytes,null);
 assert.equal(assessStorage(1000,1000).warnings.length,1);
});
