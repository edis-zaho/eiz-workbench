import React, { useState, useRef, useLayoutEffect } from 'react';
import './evidence-export.css';

interface JournalExportProps {
  clientId: string;
  api: (path: string, body?: unknown, method?: string) => Promise<any>;
}

interface JournalExportResponse {
  csv: string;
  filename: string;
  rowCount: number;
  notes: string[];
}

export function JournalExport({ clientId, api }: JournalExportProps) {
  const [fromInclusive, setFromInclusive] = useState('');
  const [toExclusive, setToExclusive] = useState('');
  const [timeBasis, setTimeBasis] = useState<'recordedAt' | 'occurredAt'>('recordedAt');
  const [source, setSource] = useState<'all' | 'mail_tests' | 'incoming'>('all');

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ rowCount: number; notes: string[] } | null>(null);

  const requestGenerationRef = useRef(0);
  const busyRef = useRef(false);

  useLayoutEffect(() => {
    requestGenerationRef.current++;
    busyRef.current = false;

    setFromInclusive('');
    setToExclusive('');
    setTimeBasis('recordedAt');
    setSource('all');
    setError(null);
    setSuccess(null);
    setIsLoading(false);

    return () => { requestGenerationRef.current++; };
  }, [clientId]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;

    busyRef.current = true;
    setIsLoading(true);
    setError(null);
    setSuccess(null);
    const currentGeneration = ++requestGenerationRef.current;

    try {
      const body: { fromInclusive?: string; toExclusive?: string; timeBasis: string; source: string; } = { timeBasis, source };
      if (fromInclusive) body.fromInclusive = new Date(fromInclusive).toISOString();
      if (toExclusive) body.toExclusive = new Date(toExclusive).toISOString();

      const response: JournalExportResponse = await api(`/api/clients/${encodeURIComponent(clientId)}/journal-export`, body, 'POST');

      if (requestGenerationRef.current !== currentGeneration) return;

      if (typeof response?.csv !== 'string' || response.csv.includes('\0') || !Number.isSafeInteger(response?.rowCount) || response.rowCount < 0 || response.rowCount > 50000 || response.filename !== 'ereignishistorie.csv' || !Array.isArray(response.notes) || response.notes.some(note=>typeof note!=='string'||note.includes('\0'))) {
        throw new Error('Ungültige Server-Antwort erhalten.');
      }

      const blob = new Blob([response.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ereignishistorie.csv';
      try { document.body.appendChild(a); a.click(); }
      finally { a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      setSuccess({ rowCount: response.rowCount, notes: response.notes });

    } catch (err) {
      if (requestGenerationRef.current !== currentGeneration) return;
      const message = (err instanceof Error) ? err.message : 'Ein unbekannter Fehler ist aufgetreten.';
      setError(`Export fehlgeschlagen: ${message}`);
    } finally {
      if (requestGenerationRef.current === currentGeneration) {
        busyRef.current = false;
        setIsLoading(false);
      }
    }
  };

  return (
    <div className="card evidence-export journal-export">
      <div className="card-head">
        <h2>Ereignishistorie exportieren</h2>
        <p className="info">Alle aufgezeichneten Statuswechsel bleiben erhalten. Technische Beobachtungen sind kein Beleg für Zustellung oder menschliches Interesse. Übernommene Altbestände sind markiert. Von/Bis gelten in deiner lokalen Zeitzone. Maximal 50.000 Beobachtungen pro Kunde.</p>
      </div>
      <form onSubmit={handleSubmit} className="editor">
        <div className="form-grid">
          <div>
            <label htmlFor={`journal-export-from-${clientId}`}>Von, inkl. (optional)</label>
            <input id={`journal-export-from-${clientId}`} type="datetime-local" value={fromInclusive} onChange={e => setFromInclusive(e.target.value)} disabled={isLoading} />
          </div>
          <div>
            <label htmlFor={`journal-export-to-${clientId}`}>Bis, exkl. (optional)</label>
            <input id={`journal-export-to-${clientId}`} type="datetime-local" value={toExclusive} onChange={e => setToExclusive(e.target.value)} disabled={isLoading} />
          </div>
          <div>
            <label htmlFor={`journal-export-timebasis-${clientId}`}>Zeitbasis</label>
            <select id={`journal-export-timebasis-${clientId}`} value={timeBasis} onChange={e => setTimeBasis(e.target.value as any)} disabled={isLoading}>
              <option value="recordedAt">Erfassungszeit</option>
              <option value="occurredAt">Quellenzeit</option>
            </select>
          </div>
          <div>
            <label htmlFor={`journal-export-source-${clientId}`}>Quelle</label>
            <select id={`journal-export-source-${clientId}`} value={source} onChange={e => setSource(e.target.value as any)} disabled={isLoading}>
              <option value="all">Alle</option>
              <option value="mail_tests">Versandbeobachtungen</option>
              <option value="incoming">Eingänge</option>
            </select>
          </div>
        </div>
        <div style={{ marginTop: '1rem' }}>
          <button type="submit" className="primary" disabled={isLoading}>
            {isLoading ? 'Wird geladen...' : 'Journal-CSV herunterladen'}
          </button>
        </div>
      </form>
      {error && <div className="alert error" role="alert" style={{ marginTop: '1rem' }}>{error}</div>}
      {success && (
        <div className="alert success" role="status" style={{ marginTop: '1rem' }}>
          <p><strong>Export erstellt.</strong> {success.rowCount} Datensätze. Der Download wurde gestartet.</p>
          {success.notes?.length > 0 && (
            <div className="info" style={{ marginTop: '0.5rem' }}>
              <strong>Hinweise:</strong>
              <ul style={{ margin: '0.5rem 0 0 1rem', padding: 0 }}>
                {success.notes.map((note, index) => <li key={index}>{note}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
