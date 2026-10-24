export const responseFields=[
 ['contactedCompanies','Unternehmen mit bestätigtem Kampagnenkontakt'],
 ['matureCompanies','Unternehmen mit vollständig verstrichenem Zeitfenster'],
 ['pendingCompanies','Unternehmen noch im Beobachtungsfenster'],
 ['invalidTimeCompanies','Unternehmen mit ungeklärter Versandzeit'],
 ['incomingMessages','Zugeordnete Eingänge innerhalb des Fensters'],
 ['humanReplyCompanies','Unternehmen mit menschlich geprüfter Antwort'],
 ['positiveCompanies','Unternehmen mit menschlich geprüftem Interesse'],
 ['meetingIntentCompanies','Unternehmen mit menschlich geprüfter Terminabsicht'],
 ['unreviewedMessages','Eingänge ohne abschließende menschliche Einordnung'],
 ['automaticMessages','Menschlich als automatisch eingeordnete Eingänge'],
 ['modelPositiveCompanies','KI-Interesse: Unternehmen (unbestätigt)'],
 ['modelMeetingIntentCompanies','KI-Terminabsicht: Unternehmen (unbestätigt)'],
 ['excludedMessages','Nicht mitgezählte Eingänge (Gründe im internen Export)']
] as const;
export const responseRates=[
 ['humanReplyRate','Geprüfte Antwortrate im Unternehmensfenster'],
 ['positiveRate','Geprüfte Interesserate im Unternehmensfenster'],
 ['meetingIntentRate','Geprüfte Terminabsichtsrate im Unternehmensfenster']
] as const;
