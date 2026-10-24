import React, { useState, useRef, useLayoutEffect } from 'react';
import './evidence-export.css';

/**
 * Definiert die erlaubten Arten von Ereignissen für den Export.
 */
type EvidenceKind = 'sent' | 'reply' | 'unknown';

/**
 * Die Props für die EvidenceExport Komponente.
 */
interface EvidenceExportProps {
  /** Die ID des Kunden, für den die Ereignisse exportiert werden sollen. */
  clientId: string;
  /** Eine Funktion zur Durchführung von API-Aufrufen. */
  api: (path: string, body?: unknown, method?: string) => Promise<any>;
}

/**
 * Die erwartete Struktur der erfolgreichen API-Antwort.
 */
interface EvidenceExportResponse {
  csv: string;
  filename: string; // Wird clientseitig ignoriert, um Sicherheit zu gewährleisten.
  rowCount: number;
  notes: string[];
}

/**
 * Eine React-Komponente, die eine Oberfläche zum Exportieren von Kundenereignissen als CSV-Datei bereitstellt.
 */
export function EvidenceExport({ clientId, api }: EvidenceExportProps) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState('all');

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ rowCount: number; notes: string[] } | null>(null);

  const requestGenerationRef = useRef(0);
  const busyRef = useRef(false);

  useLayoutEffect(() => {
    // Bei Änderung der clientId oder beim Unmount die aktuelle Generation verwerfen,
    // um veraltete Antworten zu ignorieren.
    requestGenerationRef.current++;
    busyRef.current = false;

    // Zustand für den neuen Kunden zurücksetzen.
    setFrom('');
    setTo('');
    setKind('all');
    setError(null);
    setSuccess(null);
    setIsLoading(false);

    return () => {
      // Cleanup-Funktion für Unmount
      requestGenerationRef.current++;
    };
  }, [clientId]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (busyRef.current) {
      return; // Verhindert mehrfache Anfragen bei schnellen Klicks.
    }

    busyRef.current = true;
    setIsLoading(true);
    setError(null);
    setSuccess(null);

    const currentGeneration = ++requestGenerationRef.current;

    try {
      const body: { fromInclusive?: string; toExclusive?: string; kinds?: EvidenceKind[] } = {};
      if (from) body.fromInclusive = new Date(from).toISOString();
      if (to) body.toExclusive = new Date(to).toISOString();
      if (kind !== 'all') body.kinds = [kind as EvidenceKind];
      const response: EvidenceExportResponse = await api(`/api/clients/${encodeURIComponent(clientId)}/evidence-export`, body, 'POST');

      if (requestGenerationRef.current !== currentGeneration) {
        // Veraltete Anfrage, da clientId geändert wurde oder Komponente unmounted ist.
        return;
      }

      if (typeof response?.csv !== 'string' || !Number.isSafeInteger(response?.rowCount) || response.rowCount < 0 || typeof response.filename !== 'string' || !Array.isArray(response?.notes) || response.notes.some(note=>typeof note !== 'string' || note.includes('\0')) || response.csv.includes('\0')) {
        throw new Error('Ungültige Server-Antwort erhalten.');
      }

      const blob = new Blob([response.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ereignisse.csv'; // Fester Dateiname gemäß Anforderung.
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setSuccess({ rowCount: response.rowCount, notes: response.notes });

    } catch (err) {
      if (requestGenerationRef.current !== currentGeneration) {
        return; // Veraltete Fehler nicht anzeigen.
      }
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
    <div className="card evidence-export">
      <div className="card-head">
        <h2>Ereignisse exportieren</h2>
        <p className="info">Exportiere gespeicherte Versand- und Antwortdaten dieses Kunden. Testmails sind enthalten. Zeiten beziehen sich auf deine lokale Zeitzone.</p>
      </div>
      <form onSubmit={handleSubmit} className="editor">
        <div className="form-grid">
          <div>
            <label htmlFor={`evidence-export-from-${clientId}`}>Von (optional)</label>
            <input id={`evidence-export-from-${clientId}`} type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} disabled={isLoading} />
          </div>
          <div>
            <label htmlFor={`evidence-export-to-${clientId}`}>Bis, ausschließlich (optional)</label>
            <input id={`evidence-export-to-${clientId}`} type="datetime-local" value={to} onChange={e => setTo(e.target.value)} disabled={isLoading} />
          </div>
          <div>
            <label htmlFor={`evidence-export-kind-${clientId}`}>Art der Ereignisse</label>
            <select id={`evidence-export-kind-${clientId}`} value={kind} onChange={e => setKind(e.target.value)} disabled={isLoading}>
              <option value="all">Alle</option>
              <option value="sent">Versand bestätigt</option>
              <option value="reply">Antworten</option>
              <option value="unknown">Unbekannt</option>
            </select>
          </div>
        </div>
        <div style={{ marginTop: '1rem' }}>
          <button type="submit" className="primary" disabled={isLoading}>
            {isLoading ? 'Wird geladen...' : 'CSV herunterladen'}
          </button>
        </div>
      </form>
      {error && <div className="alert error" role="alert" style={{ marginTop: '1rem' }}>{error}</div>}
      {success && (
        <div className="alert success" role="status" style={{ marginTop: '1rem' }}>
          <p><strong>Export erstellt.</strong> {success.rowCount} Datensätze. Der Download wurde gestartet.</p>
          {success.notes.length > 0 && (
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
