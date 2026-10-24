// One mailbox lease covers identity, reservation, final checks and the single
// provider call. Persistence failures must never become send failures/retries.
async function dispatchOutbound({ google, request, row, stopping = () => false }) {
  const base = `/api/clients/${row.clientId}/queue/${row.runId}`;
  return google.withMailbox(row.clientId, async mailbox => {
    if (stopping()) return { skipped: true };
    if (mailbox.id !== row.mailboxId) throw new Error('Postfach wurde geändert.');
    const mail = await request(base + '/claim-send', { mailboxId: mailbox.id, sender: mailbox.email });
    if (!mail) return { skipped: true };
    const finish = result => request(`${base}/items/${mail.id}/finish-send`, result);
    let result,prepared={mail,check:()=>{}};
    try {
      if (stopping()) throw new Error('Workbench wird beendet. Nachricht nicht übergeben.');
      if(google.prepareTracking)prepared=await google.prepareTracking(mail);
      await request(`${base}/items/${mail.id}/authorize-send`, {
        mailboxId: mailbox.id, sender: mailbox.email, revision: mail.runRevision,
      });
      prepared.check();
    } catch (error) {
      result = { status: 'failed', providerId: '', result: `Vor Gmail angehalten: ${error.message}` };
    }
    if (!result) {
      try {
        const sent = await google.sendOnce(prepared.mail, mailbox.accessToken);
        result = { status: 'sent', providerId: sent.providerId, result: 'Von Google angenommen. Zustellung nicht bestätigt.' };
      } catch (error) {
        result = { status: error.kind === 'failed' ? 'failed' : 'unknown', providerId: '', result: error.message || 'Versandergebnis unklar.' };
      }
    }
    try {
      await finish(result);
      return { status: result.status, saved: true };
    } catch {
      // A response can be lost after either Gmail or the local commit succeeded.
      // Never call Gmail again. Unresolved reservations block further dispatch.
      try {
        await finish({ status: 'unknown', providerId: '', result: 'Versandabschluss lokal nicht bestätigt. Gmail abgleichen; keine Wiederholung.' });
      } catch { /* persisted result or outstanding reservation remains authoritative */ }
      return { status: 'unknown', saved: false };
    }
  });
}
module.exports = { dispatchOutbound };
