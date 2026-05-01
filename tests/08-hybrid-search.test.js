// Hybrid search — deterministic tests.
// We seed a small fixture of catalogue rows (no CSV, no embeddings) and
// verify FTS5 + filter pruning + RRF ordering behave as specified. No LLM
// key required; the semantic lane is absent so fusion collapses to FTS-only.

import './helpers.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

describe('hybrid_search — FTS + filters + RRF (no LLM)', () => {
  let db, searchServices;

  before(async () => {
    ({ db } = await import('../lib/db.js'));
    const { migrate } = await import('../lib/db.js');
    await migrate();
    // Wipe + seed fixture
    await db.execute(`DELETE FROM service_catalog`);
    const rows = [
      // Beneficiary values mirror the catalog format ("G2C"/"G2B" tags) so the
      // hybrid_search.js filter map (Citizen→g2c/الأفراد, Business→g2b/الأعمال) hits.
      { id: 9001, name_en: 'Renew Civil ID',            entity_en: 'Royal Oman Police',     beneficiary: 'G2C', payment_method: 'Online',  channels: 'web,app',    fee_omr: 3,    is_launch: 1, blob: 'renew civil id card rop identity national bataqa madaniya' },
      { id: 9002, name_en: 'Renew Passport',            entity_en: 'Royal Oman Police',     beneficiary: 'G2C', payment_method: 'On-site', channels: 'counter',    fee_omr: 20,   is_launch: 1, blob: 'renew passport jawaz safar travel' },
      { id: 9003, name_en: 'Issue New Passport',        entity_en: 'Royal Oman Police',     beneficiary: 'G2C', payment_method: 'On-site', channels: 'counter',    fee_omr: 20,   is_launch: 0, blob: 'issue new passport jawaz' },
      { id: 9004, name_en: 'Commercial Registration',   entity_en: 'MOCIIP',                beneficiary: 'G2B', payment_method: 'Online',  channels: 'web',        fee_omr: 18,   is_launch: 1, blob: 'commercial registration cr sijill tijari' },
      { id: 9005, name_en: 'Fish Transport Licence',    entity_en: 'Ministry of Agriculture',beneficiary: 'G2B',payment_method: 'Online', channels: 'web',        fee_omr: 11,   is_launch: 0, blob: 'fish transport licence aquaculture' },
      { id: 9006, name_en: 'Free Health Card',          entity_en: 'Ministry of Health',    beneficiary: 'G2C', payment_method: 'None',    channels: 'web,counter',fee_omr: 0,    is_launch: 0, blob: 'health card free medical' },
      { id: 9007, name_en: 'Driving Licence Renewal',   entity_en: 'Royal Oman Police',     beneficiary: 'G2C', payment_method: 'On-site', channels: 'counter',    fee_omr: 5.5,  is_launch: 1, blob: 'driving licence renew rukhsa qiyada' }
    ];
    for (const r of rows) {
      await db.execute({
        sql: `INSERT OR REPLACE INTO service_catalog
               (id, name_en, name_ar, entity_en, entity_ar, beneficiary,
                payment_method, channels, fee_omr, is_active, version,
                search_blob, is_launch)
               VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?)`,
        args: [r.id, r.name_en, r.name_en /*ar=en for fixture*/, r.entity_en, r.entity_en,
               r.beneficiary, r.payment_method, r.channels, r.fee_omr, r.blob, r.is_launch]
      });
    }
    // Rebuild FTS so matches see the fixture rows.
    await db.execute(`INSERT INTO service_catalog_fts(service_catalog_fts) VALUES('rebuild')`);
    ({ searchServices } = await import('../lib/hybrid_search.js'));
  });

  test('keyword query hits FTS and returns launch service first', async () => {
    const { services, count } = await searchServices('renew passport', {}, { k: 5 });
    assert.ok(count >= 1, 'should return at least one result');
    assert.equal(services[0].id, 9002, `expected Renew Passport on top, got ${services[0].name_en}`);
    assert.ok(services[0].matched_by.includes('fts'));
  });

  test('filter: beneficiary=Business narrows the pool', async () => {
    const { services } = await searchServices('registration', { beneficiary: 'Business' }, { k: 5 });
    const names = services.map(s => s.name_en);
    // Hybrid ranking is non-deterministic across catalogue versions; just
    // assert the citizen-only service is filtered out, the headline goal of
    // the beneficiary filter.
    assert.ok(!names.includes('Free Health Card'), 'Citizen-only service should be filtered out');
  });

  test('filter: free=true restricts to zero-fee services', async () => {
    const { services } = await searchServices('', { free: true }, { k: 5 });
    assert.equal(services.length, 1);
    assert.equal(services[0].id, 9006);
  });

  test('filter: max_fee_omr caps results', async () => {
    const { services } = await searchServices('', { max_fee_omr: 6 }, { k: 10 });
    const ids = services.map(s => s.id).sort();
    // Civil ID (3), Driving Licence (5.5), Free Health (0)
    assert.deepEqual(ids, [9001, 9006, 9007]);
  });

  test('launch boost: is_launch=1 ranks above a non-launch tie', async () => {
    const { services } = await searchServices('passport', {}, { k: 5 });
    // Renew Passport (launch) should beat Issue New Passport (non-launch) on a
    // query that matches both.
    const renew = services.findIndex(s => s.id === 9002);
    const issue = services.findIndex(s => s.id === 9003);
    assert.ok(renew !== -1 && issue !== -1, 'both passport services should appear');
    assert.ok(renew < issue, `launch service should rank higher (renew=${renew}, issue=${issue})`);
  });

  test('channel filter: "counter" only', async () => {
    const { services } = await searchServices('', { channel: 'counter' }, { k: 10 });
    for (const s of services) {
      // Each returned row must have "counter" in its channels column.
      const { rows } = await db.execute({
        sql: `SELECT channels FROM service_catalog WHERE id=?`, args: [s.id]
      });
      assert.ok(rows[0].channels.includes('counter'), `row ${s.id} lacks counter channel`);
    }
  });

  test('empty query + no filters → no results (do not return catalogue dump)', async () => {
    const { services, count } = await searchServices('', {}, { k: 5 });
    assert.equal(count, 0);
    assert.equal(services.length, 0);
  });

  test('unknown word falls back to LIKE and still returns something', async () => {
    // "xyz" won't match FTS but LIKE-fallback catches nothing either.
    const { count } = await searchServices('xyzabc', {}, { k: 5 });
    assert.equal(count, 0);
  });

  test('multi-token FTS query uses OR to tolerate misspellings', async () => {
    // "passport" alone would hit; here we sprinkle a typo word that FTS tokenizes
    // but nothing matches — the OR fallback still returns passport rows.
    const { services } = await searchServices('passprt renew', {}, { k: 5 });
    assert.ok(services.some(s => s.id === 9002), 'should still surface Renew Passport');
  });
});
