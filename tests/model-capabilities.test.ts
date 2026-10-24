import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateModelCapabilities} from '../core/model-capabilities';
test('capability evidence distinguishes text, JSON and binding identity',()=>{
 const b={hash:'a'.repeat(64)} as any;
 const text=evaluateModelCapabilities(b,{text:'Hello',structured:'not JSON'});
 assert.equal(text.text,true);assert.equal(text.structured,false);assert.equal(text.bindingHash,b.hash);
 const json=evaluateModelCapabilities({...b,hash:'b'.repeat(64)},{text:'Hello',structured:'{"ok":true}'});
 assert.equal(json.structured,true);assert.notEqual(json.bindingHash,text.bindingHash);
 assert.equal(evaluateModelCapabilities(b,{text:'',structured:'{"ok":false}'}).structured,false);
});
