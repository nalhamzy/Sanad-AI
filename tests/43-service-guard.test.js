// Anti-hallucination guard: the agent may only START a real, ACTIVE catalogue
// service. Prod (+96892888715 / +96892200199): Qwen fabricated "Driving Licence
// Application (New)" under وزارة النقل (a service that doesn't exist) and dead-ended.
// start_submission now refuses a missing or inactive service.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestEnv } from './helpers.js';
import { TOOL_IMPL_V2 } from '../lib/agent_tools.js';

test('start_submission refuses a fabricated (missing) or inactive service', async () => {
  await bootTestEnv();
  const { db } = await import('../lib/db.js');
  await db.execute("INSERT INTO service_catalog(id,name_ar,name_en,is_active,required_documents_json) VALUES (91002,'خدمة غير نشطة','Inactive svc',0,'[]')");

  const inactive = await TOOL_IMPL_V2.start_submission({ state: { pending_uploads: [] }, session_id: 'g-inact' }, { service_id: 91002 });
  assert.equal(inactive.ok, false);
  assert.equal(inactive.error, 'service_inactive');

  const missing = await TOOL_IMPL_V2.start_submission({ state: { pending_uploads: [] }, session_id: 'g-miss' }, { service_id: 999999 });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'service_not_found');
});

test('start_submission allows a real, active service', async () => {
  await bootTestEnv();
  const { db } = await import('../lib/db.js');
  await db.execute("INSERT INTO service_catalog(id,name_ar,name_en,is_active,fee_omr,required_documents_json) VALUES (91001,'خدمة نشطة','Active svc',1,3,'[]')");
  const active = await TOOL_IMPL_V2.start_submission(
    { state: { pending_uploads: [], collected: {} }, session_id: 'g-ok', citizen_phone: '+96890000001' },
    { service_id: 91001 }
  );
  assert.equal(active.ok, true, 'a real active service starts fine');
});
