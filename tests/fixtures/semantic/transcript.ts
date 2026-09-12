import casePack from './case-pack.json';
import comparison from './comparison.json';

export const samplingScenarios = [
  { key: 'case-pack', label: 'Case-pack', fixture: casePack },
  { key: 'comparison', label: 'Comparison', fixture: comparison },
] as const;

type SamplingScenario = (typeof samplingScenarios)[number];
type SamplingSample = {
  sample: number;
  answer: string | null;
  passed: boolean;
  failure?: { sample: number; phase: string; error: string };
};

// Complete producer-shaped evidence for bridge/report tests. Parser contract
// tests author their inputs separately so this builder cannot mask parser drift.
export function createSamplingEvidence(
  { key, label, fixture }: SamplingScenario,
  samples: SamplingSample[] = Array.from({ length: 5 }, (_, index) => ({
    sample: index + 1,
    answer: `${key} answer ${index + 1}`,
    passed: true,
  })),
) {
  const request = {
    temperature: 0.35,
    top_p: 0.9,
    max_tokens: 600,
    stream: false,
    messages: [
      { role: 'system', content: 'Scenario-specific authorized context' },
      { role: 'user', content: fixture.question },
    ],
  };
  const summary = {
    samples: 5,
    passed: samples.filter((sample) => sample.passed).length,
    failures: samples
      .filter((sample) => !sample.passed)
      .map((sample) => sample.failure),
  };
  const transcript = [
    `${label} sampling request: ${JSON.stringify({ samples: 5, requestBody: request })}`,
    ...samples.map((sample) => `${label} sample: ${JSON.stringify(sample)}`),
    `${label} sampling summary: ${JSON.stringify(summary)}`,
  ].join('\n');
  return { request, samples, transcript };
}
