import { expect } from 'vitest';
import type { ChatHistoryMessage } from '@/lib/chat-history';
import {
  createSupportModelRequest,
  extractSupportModelContent,
} from '@/lib/support-model';
import { calderPikeUser } from './users';

export async function expectFiveNormalGenerationSamples({
  messages,
  authorizedContext,
  logPrefix,
  checkResponse,
}: {
  messages: ChatHistoryMessage[];
  authorizedContext: string;
  logPrefix: string;
  checkResponse: (answer: string, authorizedContext: string) => void;
}) {
  const sampleCount = 5;
  const failures: Array<{ sample: number; phase: string; error: string }> = [];
  let firstRequestBody: RequestInit['body'];
  // Independent requests: do not add earlier samples to conversation history.
  for (let sample = 1; sample <= sampleCount; sample++) {
    const [modelUrl, modelRequest] = createSupportModelRequest({
      distributorName: calderPikeUser.distributorDisplayName,
      distributorId: calderPikeUser.distributorId,
      authorizedContext,
      messages,
      // Omit generation overrides to exercise the actual application defaults.
    });
    if (typeof modelRequest.body !== 'string')
      throw new Error('Expected a JSON model request body');
    if (sample === 1) {
      firstRequestBody = modelRequest.body;
      const requestBody = JSON.parse(modelRequest.body);
      expect(requestBody).toMatchObject({
        temperature: 0.35,
        top_p: 0.9,
        max_tokens: 600,
      });
      expect(requestBody).not.toHaveProperty('seed');
      console.info(
        `${logPrefix} sampling request:`,
        JSON.stringify({ modelUrl, requestBody, samples: sampleCount }),
      );
    }
    expect(modelRequest.body).toBe(firstRequestBody);

    let phase = 'inference';
    let httpStatus: number | undefined;
    let responseBody: string | undefined;
    let answer: string | null = null;
    let failure: (typeof failures)[number] | undefined;
    try {
      const response = await fetch(modelUrl, modelRequest);
      httpStatus = response.status;
      responseBody = await response.text();
      expect(response.ok, `Model HTTP status: ${httpStatus}`).toBe(true);
      phase = 'response-format';
      answer = extractSupportModelContent(JSON.parse(responseBody));
      if (answer === null) throw new Error('Model returned no nonempty answer');
      phase = 'factuality';
      checkResponse(answer, authorizedContext);
    } catch (error) {
      failure = {
        sample,
        phase,
        error: error instanceof Error ? error.message : String(error),
      };
      failures.push(failure);
    } finally {
      // The host runner retains this output even when a later sample fails.
      console.info(
        `${logPrefix} sample:`,
        JSON.stringify({
          sample,
          httpStatus,
          responseBody,
          answer,
          passed: !failure,
          failure,
        }),
      );
    }
  }
  console.info(
    `${logPrefix} sampling summary:`,
    JSON.stringify({
      samples: sampleCount,
      passed: sampleCount - failures.length,
      failures,
    }),
  );
  expect(
    failures,
    'Every sample must pass; no retries or majority-vote acceptance',
  ).toEqual([]);
}
