import { describe, expect, it } from 'vitest';

import { getDatabase } from '@/db/database';
import { buildAuthorizedContext } from '@/db/support';
import { classifySupportQuery } from '@/lib/support-query';
import { calderPikeUser } from '../fixtures/users';

describe('support incident grounding', () => {
  it("returns only the authenticated user's incident history", async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'Show my support incident history.',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({ kind: 'incidents' });

    const database = await getDatabase();
    const incidents = await database
      .prepare(
        `SELECT i.incident_id, i.user_id, i.title, i.updated_at,
          COUNT(m.message_id) AS message_count
         FROM support_incidents i
         LEFT JOIN support_messages m ON m.incident_id = i.incident_id
         WHERE i.user_id = ?
         GROUP BY i.incident_id
         ORDER BY i.updated_at DESC, i.incident_id`,
      )
      .bind(calderPikeUser.userId)
      .all<{
        incident_id: string;
        user_id: string;
        title: string;
        updated_at: string;
        message_count: number;
      }>();
    const externalIncident = await database
      .prepare(
        `SELECT incident_id, user_id
         FROM support_incidents
         WHERE user_id <> ?
         ORDER BY updated_at DESC, incident_id
         LIMIT 1`,
      )
      .bind(calderPikeUser.userId)
      .first<{ incident_id: string; user_id: string }>();

    expect(incidents.results).toEqual([
      {
        incident_id: 'INC-USR-CPD-001-01',
        user_id: 'USR-CPD-001',
        title: 'Priority shipment trace',
        updated_at: '2026-09-03T08:42:00Z',
        message_count: 2,
      },
      {
        incident_id: 'INC-USR-CPD-001-02',
        user_id: 'USR-CPD-001',
        title: 'Nerveline allocation',
        updated_at: '2026-08-29T15:18:00Z',
        message_count: 2,
      },
      {
        incident_id: 'INC-USR-CPD-001-03',
        user_id: 'USR-CPD-001',
        title: '2030 contract releases',
        updated_at: '2026-08-24T11:06:00Z',
        message_count: 2,
      },
    ]);
    expect(externalIncident).not.toBeNull();
    if (!externalIncident) return;

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );
    const contextIncidentIds =
      context.match(/\bINC-[A-Za-z0-9-]{6,100}\b/g) ?? [];

    expect(context).toContain(
      'Support incidents for authenticated user Mara Venn (USR-CPD-001); showing up to 8 most recent.',
    );
    expect(contextIncidentIds).toEqual(
      incidents.results.map((incident) => incident.incident_id),
    );
    for (const incident of incidents.results) {
      expect(context).toContain(
        `- ${incident.incident_id}: ${incident.title}; updated ${incident.updated_at};`,
      );
    }
    expect(context.match(/; 2 messages\./g)).toHaveLength(3);
    expect(context).toContain(
      'Do not reveal incidents belonging to other users or distributors.',
    );
    expect(context).not.toContain(externalIncident.incident_id);
    expect(context).not.toContain(externalIncident.user_id);
  });
});
