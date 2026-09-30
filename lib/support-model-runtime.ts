import { env } from 'cloudflare:workers';
import {
  getSupportModelConfig,
  type SupportModelEnvironment,
} from './support-model-config.mjs';

export function supportModelConfig() {
  return getSupportModelConfig(env as unknown as SupportModelEnvironment);
}
