const assert=require('node:assert/strict');
exports.checkModelRoundTrip=async({js,click,fill,until,profile})=>{
 await click('Sicherungen');
 await click('Modelle & Kosten');
 await until(`document.querySelector('[aria-label="Modellprofil"] option[value="${profile.id}"]')`);
 await fill('[aria-label="Modellprofil"]',profile.id);
 await until(`document.querySelector('[aria-label="Profilname"]').value===${JSON.stringify(profile.name)}`);
 const values=await js(`Object.fromEntries(Array.from(document.querySelectorAll('.model-settings label')).filter(l=>l.querySelector('input')).map(l=>[l.firstChild.textContent.trim(),l.querySelector('input').value]))`);
 assert.deepEqual({
  input:values['Eingabe je Million Tokens'],output:values['Ausgabe je Million Tokens'],
  bound:values['Dokumentiertes Eingabelimit in Tokens'],source:values['Offizielle Preisquelle'],
  run:values['Pro Aufruf'],day:values['Pro UTC-Tag'],month:values['Pro UTC-Monat']
 },{input:'1',output:'1',bound:'1000',source:'https://example.com/prices',run:'1',day:'10',month:'100'},
 'saved prices and budgets must be editable after navigating away and back');
 await fill('[aria-label="Modellprofil"]','');
 assert.equal(await js(`Array.from(document.querySelectorAll('label')).find(l=>l.firstChild.textContent.trim()==='Eingabe je Million Tokens').querySelector('input').value`),'','a new profile must not inherit another model price');
 await fill('[aria-label="Modellprofil"]',profile.id);
 assert.equal(await js(`(()=>{const e=Array.from(document.querySelectorAll('label')).find(l=>l.firstChild.textContent.trim()==='Eingabe je Million Tokens').querySelector('input');e.focus();e.dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true}));return document.activeElement===e;})()`),false,'scrolling must release a focused monetary input before its native step action');
};
