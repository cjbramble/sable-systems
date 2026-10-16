import { localDatabase, workerCompatibility } from './worker-settings';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject build drift before starting a runtime with test or live credentials. */
export function validateBuiltConfig(value: unknown): void {
  if (!isRecord(value)) throw new Error('Invalid built Worker configuration');
  const databases = value.d1_databases;
  const database =
    Array.isArray(databases) && databases.length === 1
      ? databases[0]
      : undefined;
  if (
    value.main !== 'index.js' ||
    value.compatibility_date !== workerCompatibility.compatibilityDate ||
    JSON.stringify(value.compatibility_flags) !==
      JSON.stringify(workerCompatibility.compatibilityFlags) ||
    !isRecord(database) ||
    Object.entries(localDatabase).some(
      ([key, expected]) => database[key] !== expected,
    ) ||
    !isRecord(value.assets) ||
    value.assets.directory !== '../client' ||
    !isRecord(value.vars) ||
    value.vars.SABLE_LOCAL_DEMO !== 'false' ||
    typeof value.vars.OPENROUTER_SUPPORT_MODEL !== 'string' ||
    'OPENROUTER_API_KEY' in value.vars
  )
    throw new Error(
      'Built Worker configuration differs from the supported runtime contract',
    );
}
