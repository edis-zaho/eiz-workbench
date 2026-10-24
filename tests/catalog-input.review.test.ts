import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateProductInput,validateAccountInput} from '../core/catalog-input';
const p={name:'Produkt',description:'',website:'',bookingUrl:'',archived:false};
test('every ASCII control is rejected except formatting in product description',()=>{
  for(const code of [...Array.from({length:32},(_,i)=>i),127]) {
    const ch=String.fromCharCode(code);
    assert.throws(()=>validateProductInput({...p,name:'a'+ch+'b'}),`name ${code}`);
    assert.throws(()=>validateAccountInput({name:'Firma',domain:'a'+ch+'.de'}),`domain ${code}`);
    if([9,10,13].includes(code))assert.doesNotThrow(()=>validateProductInput({...p,description:'a'+ch}));
    else assert.throws(()=>validateProductInput({...p,description:'a'+ch}),`description ${code}`);
  }
});
test('canonical values remain valid and limits are respected',()=>{
  const account=validateAccountInput({name:' Firma ',domain:'MÜSLI.DE.'});
  assert.deepEqual(validateAccountInput(account),account);
  assert.throws(()=>validateAccountInput({name:'Firma',domain:Array(4).fill('é'.repeat(60)).join('.')}));
  assert.doesNotThrow(()=>validateProductInput({...p,name:'x'.repeat(160),description:'x'.repeat(12000)}));
  assert.throws(()=>validateProductInput({...p,description:'x'.repeat(12001)}));
  for(const field of ['website','bookingUrl']) {
    assert.throws(()=>validateProductInput({...p,[field]:'https://user:password@example.com'}));
    assert.throws(()=>validateProductInput({...p,[field]:'https://example.com/a b'}));
  }
});
