exports.prepare=({binding:b,prompt,outputSchema})=>{
 if(outputSchema)throw Error('Schema-Ausgabe ist für diesen Adapter noch nicht freigegeben. JSON-Text mit Fachprüfung verwenden.');
 return {body:{model:b.model,max_tokens:b.maxOutputTokens,system:prompt.system,messages:[{role:'user',content:prompt.user}]},headersWithoutSecret:{'anthropic-version':'2023-06-01'}};
};
exports.parse=d=>({status:d.stop_reason==='refusal'?'refused':d.stop_reason==='end_turn'?'completed':'incomplete',text:(d.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n'),usage:d.usage,providerRequestId:d.id||null,finishReason:d.stop_reason||null});
