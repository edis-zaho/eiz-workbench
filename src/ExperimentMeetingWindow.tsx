import {meetingWindowFields,meetingWindowRates} from '../core/experiment-meeting-fields';
import type {experimentResults} from '../core/experiment-results';
export function ExperimentMeetingWindow({report}:{report:ReturnType<typeof experimentResults>}){
 const comparison=report.meetingComparison;
 return <section className="experiment-meeting-comparison"><h4>Termine und bestätigte Teilnahme</h4><p>Termine mit gespeicherter Terminzeit innerhalb der ersten {comparison.windowDays} Tage je Unternehmen. Derselbe Unternehmensnenner wie im Antwortvergleich. Aktueller Betreiberbeleg; keine automatische Teilnahmebestätigung.</p>
  <div className="lead-table"><table><caption>Terminvergleich · {comparison.windowDays} Tage je Unternehmen</caption><thead><tr><th scope="col">Kennzahl</th>{report.arms.map(a=><th scope="col" key={a.hypothesisId}>{a.name}<small>{a.personaName} · {a.angle}</small></th>)}</tr></thead><tbody>
   {meetingWindowFields.map(([key,label])=><tr key={key}><th scope="row">{label}</th>{comparison.arms.map(a=><td key={a.hypothesisId}>{a[key]}</td>)}</tr>)}
   {meetingWindowRates.map(([key,label])=><tr key={key}><th scope="row">{label}</th>{comparison.arms.map(a=>{const r=a[key];return <td key={a.hypothesisId}>{r.percent===null?'Nicht berechenbar (0 im Nenner)':`${r.numerator} / ${r.denominator} · ${r.percent.toLocaleString('de-DE')} %`}</td>;})}</tr>)}
  </tbody></table></div><p>Ein vergangenes Datum belegt keine Teilnahme. Verschiebungen ändern die aktuelle Terminzeit und können die Zuordnung zum Fenster verändern. Keine Kalenderverifikation oder Abrechnungsfreigabe.</p>
  <details><summary>Terminfenster und Ausschlüsse verstehen</summary><ul>{comparison.methodology.map(m=><li key={m}>{m}</li>)}</ul><p>Versionskennungen, Zuordnung und Ausschlussgründe im internen JSON-Export.</p></details>
 </section>;
}
