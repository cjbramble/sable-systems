import type casePack from './case-pack.json';
import manifest from '../../../scripts/semantic/model.json';

// A controlled subprocess response, not a live model-quality evaluation.
export const createSemanticEvaluatorReport = (
  fixture: typeof casePack,
  samples: { sample: number; answer: string | null }[],
  fixtureSha256: string,
) => ({
  schemaVersion: 1,
  scenario: fixture.scenario,
  policy: { mode: 'advisory' },
  model: { id: manifest.id, revision: manifest.revision },
  fixtureSha256,
  samples: samples.map(({ sample, answer }) => ({
    sample,
    answer,
    score: 0.9,
    referenceScores: [0.9, 0.8],
    chunks: 1,
  })),
  calibration: {
    minimumCorrectScore: 0.7,
    maximumIncorrectScore: 0.99,
    status: 'overlap',
    examples: fixture.examples.map((example) => ({ ...example, score: 0.8 })),
  },
  pairwiseSimilarity: samples.map(() => samples.map(() => 0.9)),
});
