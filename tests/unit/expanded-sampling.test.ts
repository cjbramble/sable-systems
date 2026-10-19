import { expect, it, vi } from 'vitest';
import { expectFiveNormalGenerationSamples } from '../fixtures/model-sampling';
import {
  expectLiveSupportAnswer,
  liveSupportScenarios,
} from '../assertions/live-support';
import {
  getSamplingScenario,
  listSamplingScenarios,
} from '../../tools/evaluation/sampling-results.mjs';

it('retains current request, full history and authorized records for a topic switch', () => {
  expect(listSamplingScenarios()).toContain('topic-switch');
  const scenario = getSamplingScenario('topic-switch');
  const records =
    '<authorized_records>\nProduct: SBL-RPC-12 — Redline Power Cell R12\nAvailable to promise: 312.\n</authorized_records>';
  const requestBody = {
    model: 'deepseek/deepseek-v4.1-flash',
    temperature: 0.35,
    top_p: 0.9,
    max_tokens: 600,
    stream: false,
    messages: [
      { role: 'system', content: 'Read-only assistant.' },
      {
        role: 'user',
        content: JSON.stringify({
          source: 'authorized_support_records',
          records,
        }),
      },
      ...scenario.messages,
    ],
  };
  const samples = Array.from({ length: 5 }, (_, i) => ({
    sample: i + 1,
    answer: 'SBL-RPC-12: 312 available.',
    passed: true,
  }));
  const line = (kind: string, data: unknown) =>
    `${scenario.label} ${kind}: ${JSON.stringify(data)}`;
  const lines = [
    line('sampling request', { requestBody, samples: 5 }),
    ...samples.map((s) => line('sample', s)),
    line('sampling summary', { samples: 5, passed: 5, failures: [] }),
  ];
  const batch = scenario.parseTranscript(lines.join('\n'));
  expect(batch?.samples).toEqual(samples);
  expect(batch?.request.messages).toEqual(requestBody.messages);
  // The judge reads records from the captured data message, not a second copy.
  expect(batch).not.toHaveProperty('reference');
  expect(() => scenario.parseTranscript(lines.slice(0, -1).join('\n'))).toThrow(
    'complete',
  );
  const altered = structuredClone(requestBody);
  altered.messages[2].content = 'Unrelated prior question';
  expect(() =>
    scenario.parseTranscript(
      [
        line('sampling request', { requestBody: altered, samples: 5 }),
        ...lines.slice(1),
      ].join('\n'),
    ),
  ).toThrow('history');
  const wrongRecords = structuredClone(requestBody);
  wrongRecords.messages[1].content = JSON.stringify({
    source: 'authorized_support_records',
    records: records.replace('312', '999'),
  });
  expect(() =>
    scenario.parseTranscript(
      [
        line('sampling request', { requestBody: wrongRecords, samples: 5 }),
        ...lines.slice(1),
      ].join('\n'),
    ),
  ).toThrow('context');
});

it('retains every original answer when one sample contradicts the requested status', async () => {
  const scenario = liveSupportScenarios.find(
    ({ id }) => id === 'order-status',
  )!;
  const valid = '**SBL-2026-000417** is partially shipped.';
  const contradiction = `${valid} The order is not partially shipped.`;
  const evidence: Array<[string, string]> = [];
  const requests: string[] = [];
  vi.spyOn(console, 'info').mockImplementation((label, row) =>
    evidence.push([label, row]),
  );
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    requests.push(init.body as string);
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: requests.length === 2 ? contradiction : valid,
            },
          },
        ],
      }),
    );
  });
  try {
    await expect(
      expectFiveNormalGenerationSamples({
        messages: [{ role: 'user', content: scenario.messages[0].content }],
        authorizedContext: scenario.contextIncludes.join('\n'),
        logPrefix: 'Offline producer control',
        checkResponse: (answer, context) =>
          expectLiveSupportAnswer(scenario, answer, context),
      }),
    ).rejects.toThrow('Every sample must pass');
    expect(requests).toHaveLength(5);
    expect(new Set(requests).size).toBe(1);
    const samples = evidence
      .filter(([label]) => label.endsWith(' sample:'))
      .map(([, row]) => JSON.parse(row));
    expect(samples.map((sample) => sample.passed)).toEqual([
      true,
      false,
      true,
      true,
      true,
    ]);
    expect(samples.map((sample) => sample.answer)).toEqual([
      valid,
      contradiction,
      valid,
      valid,
      valid,
    ]);
    expect(samples[1].failure.error).toContain('Denied expected status');
    expect(samples[1].failure.phase).toBe('factuality');
    expect(JSON.parse(evidence.at(-1)![1]).passed).toBe(4);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
