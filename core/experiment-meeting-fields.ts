export const meetingWindowFields=[
 ['contactedCompanies','Unternehmen mit bestätigtem Kampagnenkontakt'],
 ['matureCompanies','Unternehmen mit vollständig verstrichenem Zeitfenster'],
 ['pendingCompanies','Unternehmen noch im Beobachtungsfenster'],
 ['invalidTimeCompanies','Unternehmen mit ungeklärter Versandzeit'],
 ['recordedMeetings','Termine mit Terminzeit im Fenster (auch abgesagt)'],
 ['meetingCompanies','Unternehmen mit solchem Terminbeleg'],
 ['heldConfirmedMeetings','Teilnahme durch Betreiber bestätigt: Termine'],
 ['heldConfirmedCompanies','Teilnahme durch Betreiber bestätigt: Unternehmen'],
 ['cancelledMeetings','Abgesagte Termine'],
 ['noShowMeetings','Nicht erschienen'],
 ['attendanceUnverifiedMeetings','Teilnahme noch ungeklärt'],
 ['withdrawnMeetings','Widerrufene Terminbelege (nicht mitgezählt)'],
 ['excludedMeetings','Weitere nicht mitgezählte Terminbelege']
] as const;
export const meetingWindowRates=[
 ['meetingRate','Terminbelegquote je Unternehmen (auch abgesagt)'],
 ['heldConfirmedRate','Bestätigte Teilnahmerate je Unternehmen']
] as const;
