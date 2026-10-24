const assert=require('node:assert/strict');
const {writeFileSync}=require('node:fs');
const {join}=require('node:path');
exports.checkCampaignKnowledge=async(win,dataDir,js,until,click,url,headers,clientId,productId)=>{
  const path=`/api/clients/${clientId}/products/${productId}/knowledge`;
  const request=async body=>{const r=await fetch(url+path,{headers,method:'POST',body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
  const state=await(await fetch(url+path,{headers})).json(),source=state.items.find(r=>r.kind==='source'&&r.usable);
  const content={category:'feature',text:'Synthetische Kampagnenaussage mit geprüftem Beleg.',sourceId:source.id,quote:source.content.text.slice(0,30)};
  const draft=await request({entityId:null,expectedRevision:0,productRevision:state.productRevision,kind:'claim',action:'save',content,actor:'Smoke',reason:'Testbasis'});
  const approved=await request({entityId:draft.entityId,expectedRevision:1,productRevision:state.productRevision,kind:'claim',action:'approve',content,actor:'Smoke',reason:'Geprüft'});
  const selectProduct=async value=>js(`(()=>{const el=document.querySelector('[aria-label="Kampagnenprodukt"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const selector=`[aria-label="Kampagnenaussage ${approved.id}"]`;
  await until(`document.querySelector('.campaign-knowledge button')&&!document.querySelector('.campaign-knowledge button').disabled`);
  await click('Kampagnenwissen aktualisieren');await until(`document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`);
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`);await until(`document.querySelector(${JSON.stringify(selector)}).checked`);
  assert.equal(await js(`!!document.querySelector('[aria-label="Kampagnenaussage ${draft.id}"]')`),false,'draft is not a selectable fact');
  // A pending old-product response must not replace the next product screen.
  await js(`window.__campaignKnowledgeFetch=window.fetch;window.fetch=(...args)=>String(args[0]).endsWith(${JSON.stringify(path)})?new Promise(resolve=>{window.__releaseCampaignKnowledge=()=>resolve(new Response(${JSON.stringify(JSON.stringify(state))}));}):window.__campaignKnowledgeFetch(...args);void 0;`);
  try{
    await click('Kampagnenwissen aktualisieren');await until(`typeof window.__releaseCampaignKnowledge==='function'`);
    await selectProduct('');await until(`!document.querySelector('.campaign-knowledge')`);
    await js(`window.__releaseCampaignKnowledge();void 0;`);
    assert.equal(await js(`!!document.querySelector('.campaign-knowledge')`),false);
  }finally{await js(`window.fetch=window.__campaignKnowledgeFetch;delete window.__releaseCampaignKnowledge;void 0;`);}
  await selectProduct(productId+':'+state.productRevision);
  await until(`document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`);
  assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).checked`),false,'product switch clears the old selection');
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`);await until(`document.querySelector(${JSON.stringify(selector)}).checked`);
  win.show();await js(`document.querySelector('.campaign-knowledge').scrollIntoView({behavior:'instant',block:'start'})`);
  await new Promise(resolve=>setTimeout(resolve,700));
  const shot=await win.webContents.capturePage();if(!shot.isEmpty())writeFileSync(join(dataDir,'campaign-knowledge.png'),shot.toPNG());
  writeFileSync(join(dataDir,'campaign-knowledge-result.json'),JSON.stringify({passed:true,approvedFactSelected:true,draftNotSelectable:true,productSwitchClearsSelection:true,lateResponseIgnored:true,liveProvider:false},null,2));
  return approved.id;
};
