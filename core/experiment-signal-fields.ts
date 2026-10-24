// Shared presentation labels only; no journal access in the renderer.
export const signalFields=[
 ['acceptedMessages','Angenommene Kampagnenmails'],
 ['matureMessages','Nachrichten mit vollständig verstrichenem Zeitfenster'],
 ['pendingMessages','Noch im Beobachtungsfenster'],
 ['invalidTimeMessages','Nicht auswertbare Versandzeit'],
 ['registeredMessages','Davon mit passendem Registrierungsbeleg'],
 ['withoutRegistration','Davon ohne gespeicherten Registrierungsnachweis'],
 ['registeredWithoutSignal','Registriert, aber kein aktives Signal im Zeitfenster'],
 ['expiresBeforeWindowEnd','Registrierung endet vor Ende des Beobachtungsfensters'],
 ['clickEnabledMessages','Davon mit registriertem Klicklink'],
 ['observedMessages','Nachrichten mit aktivem Signal'],
 ['observedContacts','Kontakte mit aktivem Signal'],
 ['observedCompanies','Unternehmen mit aktivem Signal'],
 ['opens','Technische Pixelabrufe'],['clicks','Technische Klickabrufe'],
 ['flaggedSignals','Davon mit Proxy-/Automatikmerkmal'],
 ['unflaggedSignals','Davon ohne Automatikmerkmal (Menschlichkeit unbekannt)'],
 ['relaySignals','Davon automatisch abgeholt'],['importedSignals','Davon aus Dateiimport'],
 ['repeatedOpenMessages','Nachrichten mit mindestens drei verschiedenen Abrufzeiten je Quelle'],
 ['withdrawnSignals','Widerrufene Signale (nicht mitgezählt)'],
 ['excludedSignals','Aktive Signale außerhalb auswertbarer Zeitfenster']
] as const;
