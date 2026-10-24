import type {CampaignContent,MessageStyle} from '../core/campaign';
import type {campaignMessaging} from '../core/campaign-messaging';
export type Messaging=ReturnType<typeof campaignMessaging>;

export function CampaignMessaging({form,onChange}:{form:CampaignContent;onChange:(c:CampaignContent)=>void}){
  function toggle(){
    if(form.sequence){const {sequence:old,...rest}=form;onChange({...rest,steps:form.steps.map(({variant,...step})=>step)});}
    else onChange({...form,sequence:{name:'Direkter Einstieg mit Follow-up',style:''},steps:form.steps.map((s,i)=>({...s,variant:{name:i?`Follow-up ${i}`:'Erstmail',style:''}}))});
  }
  return <section className="campaign-messaging"><h4>Ansprache nachvollziehbar testen</h4>
    <label className="toggle-row"><input type="checkbox" aria-label="Nachrichtenfassungen erfassen" checked={!!form.sequence} disabled={!form.hypothesisId&&!form.sequence} onChange={toggle}/>Nachrichtenfolge und Varianten benennen</label>
    {!form.hypothesisId&&<p>Wähle zuerst eine freigegebene Hypothese. Vorhandene Varianten kannst du hier ausdrücklich entfernen; die Texte bleiben dabei erhalten.</p>}
    {form.sequence&&<><StyleFields label="Nachrichtenfolge" value={form.sequence} onChange={sequence=>onChange({...form,sequence})}/>
      <p>Ein leerer Grundstil übernimmt den Stil der fest gebundenen Hypothese. Je Nachricht kannst du einen eigenen Stil festhalten. Stilangaben schreiben keinen Text um: Prüfe die konkrete Formulierung vor der Freigabe.</p>
      <small>Neue Texte, Stile oder Namen erhalten neue Fassungskennungen. Geänderte Abstände erzeugen eine neue Sequenzfassung. Alle Kontakte dieses Plans erhalten dieselbe Folge; noch keine automatische Variantenverteilung.</small></>}
  </section>;
}
export function StyleFields({label,value,onChange}:{label:string;value:MessageStyle;onChange:(v:MessageStyle)=>void}){
  return <><label>{label}: Name<input aria-label={`${label} Name`} required maxLength={100} value={value.name} onChange={e=>onChange({...value,name:e.target.value})}/></label>
    <label>{label}: Stil<textarea aria-label={`${label} Stil`} rows={2} maxLength={1000} value={value.style} placeholder="Leer: übergeordneten Stil übernehmen" onChange={e=>onChange({...value,style:e.target.value})}/></label></>;
}
export function MessagingDetails({messaging}:{messaging:Messaging}){
  if(!messaging)return null;
  return <details className="source campaign-messaging-summary"><summary>Nachrichtenfassung: {messaging.name}</summary>
    <p>Grundstil: {messaging.style||'Stil der fest gebundenen Hypothese'}</p><small style={{overflowWrap:'anywhere'}}>Sequenzkennung: {messaging.sequenceId}</small>
    {messaging.variants.map(v=><div key={v.step}><p><strong>{v.step}. {v.name}</strong> · {v.step===1?'Erstmail':`${v.gapDays} Kalendertage nach der vorherigen Nachricht`}<br/>Stil: {v.effectiveStyle||'Stil der fest gebundenen Hypothese'} ({v.styleSource==='variant'?'eigener Stil':v.styleSource==='sequence'?'Grundstil':'Hypothese'})</p><small style={{overflowWrap:'anywhere'}}>Variantenkennung: {v.variantId}</small></div>)}
    <p>Diese Kennungen beschreiben die gespeicherten Vorlagen im festen Produktrahmen. Personalisierte Einzeltexte bleiben im Versandverlauf. Frühere Fassungen gelten nicht automatisch als aktuell freigegeben.</p>
  </details>;
}
