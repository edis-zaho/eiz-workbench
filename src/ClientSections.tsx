import {useState,type ReactNode} from 'react';
import './guided-setup.css';

const areas=[['setup','Einrichtung'],['product','Produkt & Zielgruppe'],['mailbox','Gmail'],['leads','Kontakte & Freigaben'],['campaigns','Kampagnen'],['journal','Auswertung'],['advanced','Erweitert']] as const;
type Area=typeof areas[number][0];
export function ClientSections({children,onModels}:{children:(open:(id:string)=>void)=>Record<Area,ReactNode>;onModels:()=>void}){
 const [area,setArea]=useState<Area>('setup');
 function open(id:string){
  const next=({brief:'product',catalog:'product',client:'setup',queue:'campaigns'} as Record<string,string>)[id]||id;
  if(areas.some(([key])=>key===next)){setArea(next as Area);window.scrollTo(0,0);}
 }
 const content=children(open);
 return <div className="client-sections">
  <nav aria-label="Arbeitsbereiche" className="area-nav">{areas.map(([id,label])=><button type="button" key={id} aria-current={area===id?'page':undefined} onClick={()=>open(id)}>{label}</button>)}</nav>
  {areas.map(([id,label])=><section key={id} data-area={id} aria-label={label} hidden={area!==id}>
   {id==='setup'&&<div className="card setting setup-intro"><h2>In vier Schritten startklar</h2><p>Richte einen Bereich nach dem anderen ein. Es wird nichts automatisch versendet.</p>
    <div className="setup-steps">
     {[
      ['1','Produkt beschreiben','Was bietest du an, für wen und welche Aussagen sind belegt?',()=>open('product')],
      ['2','Gmail verbinden','Konto verbinden, Signatur speichern und eine Testnachricht prüfen.',()=>open('mailbox')],
      ['3','KI auswählen','Ein Modell für alle Aufgaben und ein Kostenlimit festlegen.',onModels],
      ['4','Kontakte vorbereiten','Liste importieren, Kontakte prüfen und anschließend eine Kampagne anlegen.',()=>open('leads')]
     ].map(([number,title,description,fn])=><button className="setup-step" key={String(number)} onClick={fn as ()=>void}><span>{String(number)}</span><strong>{String(title)}</strong><small>{String(description)}</small></button>)}
    </div><p>Du kannst Texte auch selbst schreiben und die KI-Einrichtung überspringen. Versand und automatische Antworten brauchen weiterhin deine Freigabe.</p>
    <div className="button-row"><button className="secondary" onClick={()=>open('campaigns')}>Kampagne vorbereiten</button><button className="text-button" onClick={()=>open('journal')}>Ergebnisse ansehen</button></div>
   </div>}
   {content[id]}
  </section>)}
 </div>;
}
