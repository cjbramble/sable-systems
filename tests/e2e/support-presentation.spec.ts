import { expect, test } from './fixtures/app';

test.use({
  modelReply: 'Which shipment should I trace?',
  timezoneId: 'America/New_York',
});

for (const user of [
  {
    id: 'USR-CPD-001',
    name: 'Mara Venn',
    email: 'mara.venn@calderpike.example',
    password: 'Sable-WHS-0427!',
  },
  {
    id: 'USR-MCS-001',
    name: 'Imani Kade',
    email: 'imani.kade@meridiancivic.example',
    password: 'Sable-WHS-1098!',
  },
]) {
  test(`preserves local dates, saved timestamps, and ${user.name}'s attribution after reload`, async ({
    page,
    app,
    loginPage,
    supportPage,
  }) => {
    await loginPage.goto();
    await loginPage.signIn(user.email, user.password);
    const incident = await app.database
      .prepare(
        'SELECT incident_id, title FROM support_incidents WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
      )
      .bind(user.id)
      .first<{ incident_id: string; title: string }>();
    expect(incident).not.toBeNull();
    if (!incident) throw new Error('Missing support history fixture');
    const past = ['2026-09-03T03:59:00Z', '2026-09-03T04:01:00Z'];
    const historical = (
      await app.database
        .prepare(
          'SELECT message_id FROM support_messages WHERE incident_id = ? ORDER BY sequence_number',
        )
        .bind(incident.incident_id)
        .all<{ message_id: string }>()
    ).results;
    expect(historical).toHaveLength(2);
    for (const [index, message] of historical.entries())
      await app.database
        .prepare(
          'UPDATE support_messages SET created_at = ? WHERE message_id = ?',
        )
        .bind(past[index], message.message_id)
        .run();
    await app.database
      .prepare(
        'UPDATE support_incidents SET updated_at = ? WHERE incident_id = ?',
      )
      .bind(past[1], incident.incident_id)
      .run();
    await page.clock.setFixedTime(new Date('2026-09-03T12:00:00Z'));
    await supportPage.reload();
    for (const reload of [false, true]) {
      if (reload) await supportPage.reload();
      await supportPage.openIncident(incident.title);
      await expect(supportPage.dateDividers).toHaveText(['Yesterday', 'Today']);
      await expect(supportPage.messageTimes).toHaveText([
        '11:59 PM',
        '12:01 AM',
      ]);
      await expect(supportPage.messageAuthors).toHaveText([user.name, 'COV-E']);
      for (const [index, date] of past.entries())
        await expect(supportPage.messageTimes.nth(index)).toHaveAttribute(
          'datetime',
          date,
        );
    }
    await page.clock.setFixedTime(new Date());
    await supportPage.startIncident();
    const question = 'Trace a timezone test shipment.';
    const response = await supportPage.sendMessage(question);
    expect(response.status()).toBe(200);
    const payload = await response.json();
    const { incidentId } = response.request().postDataJSON();
    const stored = (
      await app.database
        .prepare(
          'SELECT created_at FROM support_messages WHERE incident_id = ? ORDER BY sequence_number',
        )
        .bind(incidentId)
        .all<{ created_at: string }>()
    ).results;
    expect(stored).toEqual([
      { created_at: payload.customerCreatedAt },
      { created_at: payload.assistantCreatedAt },
    ]);
    await expect(supportPage.messageTimes).toHaveCount(2);
    const freshTimes = await supportPage.messageTimes.allTextContents();
    for (const reload of [false, true]) {
      if (reload) {
        await supportPage.reload();
        await supportPage.openIncident(question);
      }
      await expect(
        supportPage.messageAuthors.filter({ hasText: user.name }),
      ).toHaveCount(1);
      await expect(supportPage.messageTimes).toHaveText(freshTimes);
      await expect(supportPage.messageTimes.nth(0)).toHaveAttribute(
        'datetime',
        stored[0].created_at,
      );
      await expect(supportPage.messageTimes.nth(1)).toHaveAttribute(
        'datetime',
        stored[1].created_at,
      );
      await expect(supportPage.dateDividers).toContainText(['Today']);
    }
  });
}
