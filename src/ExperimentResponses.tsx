import {responseFields,responseRates} from '../core/experiment-response-fields';
import type {experimentResults} from '../core/experiment-results';
type Report=ReturnType<typeof experimentResults>;
export function ExperimentResponses({report}:{report:Report}){
 const comparison=report.responseComparison;
 return <section className="experiment-response-comparison"><h4>Antworten bei gleicher Beobachtungsdauer</h4>
  <p>Die ersten {comparison.windowDays} Tage je Unternehmen, ab seiner ersten bestätigten Kampagnensendung. Nur vollständig verstrichene Unternehmensfenster zählen in den Quoten. Weitere Personen und Follow-ups starten die Frist nicht neu.</p>
  <div className="lead-table"><table><caption>Antwortvergleich · {comparison.windowDays} Tage je Unternehmen</caption><thead><tr><th scope="col">Kennzahl</th>{report.arms.map(a=><th scope="col" key={a.hypothesisId}>{a.name}<small>{a.personaName} · {a.angle}</small></th>)}</tr></thead><tbody>
   {responseFields.map(([key,label])=><tr key={key}><th scope="row">{label}</th>{comparison.arms.map(a=><td key={a.hypothesisId}>{a[key]}</td>)}</tr>)}
   {responseRates.map(([key,label])=><tr key={key}><th scope="row">{label}</th>{comparison.arms.map(a=>{const r=a[key];return <td key={a.hypothesisId}>{r.percent===null?'Nicht berechenbar (0 im Nenner)':`${r.numerator} / ${r.denominator} · ${r.percent.toLocaleString('de-DE')} %`}</td>;})}</tr>)}
  </tbody></table></div>
  <p>Eine noch nicht abgeschlossene Beobachtungszeit zählt nicht als Misserfolg. Fehlende Eingänge und offene Bewertungen können das Ergebnis verändern. Terminabsicht ist keine Buchung; dieser Vergleich kürt keinen Gewinner.</p>
  <details><summary>Antwortfenster und Ausschlüsse verstehen</summary><ul>{comparison.methodology.map(m=><li key={m}>{m}</li>)}</ul><p>Unternehmensanker, aktuelle Bewertungsreferenzen und Ausschlussgründe stehen im internen JSON-Export.</p></details>
 </section>;
}
