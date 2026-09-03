import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIncidentTitle,
  filterSupportIncidents,
  parseStoredIncidents,
  removeSupportIncident,
  type SupportIncident,
} from '../lib/support-incidents.ts';

const incidents: SupportIncident[] = [
  {
    id: 'priority-trace',
    title: 'Priority shipment trace',
    updatedAt: 'Today',
    messages: [],
  },
  {
    id: 'nerveline-allocation',
    title: 'Nerveline allocation',
    updatedAt: 'Aug 29',
    messages: [],
  },
];

void test('filters support incidents by title without case sensitivity', () => {
  assert.deepEqual(filterSupportIncidents(incidents, '  NERVE  '), [
    incidents[1],
  ]);
  assert.equal(filterSupportIncidents(incidents, '').length, 2);
});

void test('restores only valid persisted incident collections', () => {
  assert.deepEqual(parseStoredIncidents(JSON.stringify(incidents), []), incidents);
  assert.deepEqual(parseStoredIncidents('{broken', incidents), incidents);
  assert.deepEqual(parseStoredIncidents('[{"id": 3}]', incidents), incidents);
  assert.deepEqual(parseStoredIncidents('[]', incidents), []);
});

void test('removes only the selected support incident', () => {
  assert.deepEqual(removeSupportIncident(incidents, 'priority-trace'), [
    incidents[1],
  ]);
  assert.deepEqual(removeSupportIncident(incidents, 'missing'), incidents);
});

void test('creates compact incident titles from the first customer message', () => {
  assert.equal(createIncidentTitle('  Trace   order 42  '), 'Trace order 42');
  assert.equal(
    createIncidentTitle('Please investigate the priority allocation for order SBL-2031-000124'),
    'Please investigate the priority allocat…',
  );
});
