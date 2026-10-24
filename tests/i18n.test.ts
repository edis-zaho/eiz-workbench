import {test} from 'node:test';
import assert from 'node:assert/strict';
import {messages,t} from '../src/i18n';
test('DE and EN navigation/onboarding keys and substitutions match',()=>{
 assert.deepEqual(Object.keys(messages.de).sort(),Object.keys(messages.en).sort());
 for(const key of Object.keys(messages.de) as (keyof typeof messages.de)[]){
  assert.deepEqual(messages.de[key].match(/\{\w+\}/g),messages.en[key].match(/\{\w+\}/g));
 }
 assert.equal(t('en','count',{count:2}),'2 customer workspaces');
});
