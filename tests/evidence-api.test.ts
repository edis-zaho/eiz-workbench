import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store';
import { startServer } from '../core/server';

test('Export API preserves authentication, URL customer scope and input validation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eiz-evidence-api-'));
  const store = new Store(join(dir, 'test.sqlite'), join(dir, 'backups'), false);
  const client = store.createClient({name:'Export test',website:'https://example.com',email:'test@example.com',notes:''});
  const token = 'e'.repeat(64);
  const service = await startServer(store, token, 600000);
  const path = `/api/clients/${client.id}/evidence-export`;
  const post = (payload: unknown, headers: Record<string,string> = {Authorization:`Bearer ${token}`}, endpoint = path) => fetch(service.url + endpoint, {
    method:'POST', headers:{'Content-Type':'application/json',...headers}, body:JSON.stringify(payload),
  });
  try {
    assert.equal((await post({}, {})).status, 401);
    assert.equal((await post({}, {Authorization:`Bearer ${token}`,Origin:'https://untrusted.example'})).status, 403);
    assert.equal((await post({}, undefined, '/api/clients/missing/evidence-export')).status, 404);
    for (const body of [{clientId:'other'}, {fromInclusive:'2026-02-30T00:00:00Z'}, {kinds:['positive']}, null, []]) {
      assert.equal((await post(body)).status, 400, JSON.stringify(body));
    }
    const response = await post({});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.filename, 'ereignisse.csv');
    assert.equal(result.rowCount, 0);
    assert.ok(result.csv.startsWith('id,clientId,accountId,contactId,campaignId,occurredAt,kind,sourceId'));
    assert.ok(result.notes.length > 0);
  } finally {
    await service.close();
    rmSync(dir, {recursive:true, force:true});
  }
});
