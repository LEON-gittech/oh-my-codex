import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getStateDir } from '../mcp/state-paths.js';
import { writeAtomic } from '../team/state.js';
import { sleep } from '../utils/sleep.js';
import { getNormalizedQuestionType } from './types.js';
import type {
  QuestionAnswer,
  QuestionInput,
  QuestionRecord,
  QuestionRendererState,
  QuestionStatus,
} from './types.js';

const QUESTION_NAMESPACE = 'questions';
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_TRANSIENT_PARSE_RETRY_DELAY_MS = 10;
const DEFAULT_TRANSIENT_PARSE_MAX_READ_ATTEMPTS = 2;

function buildQuestionId(now = new Date()): string {
  return `question-${now.toISOString().replace(/[:.]/g, '-')}-$${Math.random().toString(16).slice(2, 10)}`.replace('$', '');
}

export function getQuestionStateDir(cwd: string, sessionId?: string): string {
  return join(getStateDir(cwd, sessionId), QUESTION_NAMESPACE);
}

export function getQuestionRecordPath(cwd: string, questionId: string, sessionId?: string): string {
  return join(getQuestionStateDir(cwd, sessionId), `${questionId}.json`);
}

export async function writeQuestionRecord(recordPath: string, record: QuestionRecord): Promise<void> {
  await mkdir(dirname(recordPath), { recursive: true });
  await writeAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

function isLikelyTransientQuestionParseFailure(raw: string, err: unknown): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return true;
  if (!(err instanceof SyntaxError)) return false;
  if (!trimmed.startsWith('{') || trimmed.endsWith('}')) return false;
  return (
    /Unexpected end of JSON input/.test(err.message)
    || /Unterminated string in JSON/.test(err.message)
    || /Expected double-quoted property name in JSON/.test(err.message)
    || /Expected property name or '}' in JSON/.test(err.message)
    || /Expected ':' after property name in JSON/.test(err.message)
    || /Expected ',' or '}' after property value in JSON/.test(err.message)
  );
}

export async function readQuestionRecord(recordPath: string): Promise<QuestionRecord | null> {
  if (!existsSync(recordPath)) return null;

  let lastError: unknown;
  for (let attempt = 1; attempt <= DEFAULT_TRANSIENT_PARSE_MAX_READ_ATTEMPTS; attempt += 1) {
    const raw = await readFile(recordPath, 'utf-8');
    try {
      return JSON.parse(raw) as QuestionRecord;
    } catch (error) {
      lastError = error;
      if (
        attempt >= DEFAULT_TRANSIENT_PARSE_MAX_READ_ATTEMPTS
        || !isLikelyTransientQuestionParseFailure(raw, error)
      ) {
        throw error;
      }
      await sleep(DEFAULT_TRANSIENT_PARSE_RETRY_DELAY_MS);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function createQuestionRecord(
  cwd: string,
  input: QuestionInput,
  sessionId?: string,
  now = new Date(),
): Promise<{ recordPath: string; record: QuestionRecord }> {
  const questionId = buildQuestionId(now);
  const nowIso = now.toISOString();
  const record: QuestionRecord = {
    kind: 'omx.question/v1',
    question_id: questionId,
    ...(sessionId ? { session_id: sessionId } : {}),
    created_at: nowIso,
    updated_at: nowIso,
    status: 'pending',
    ...(input.header ? { header: input.header } : {}),
    question: input.question,
    options: input.options,
    allow_other: input.allow_other,
    other_label: input.other_label,
    multi_select: input.multi_select,
    type: getNormalizedQuestionType(input),
    ...(input.source ? { source: input.source } : {}),
  };
  const recordPath = getQuestionRecordPath(cwd, questionId, sessionId);
  await writeQuestionRecord(recordPath, record);
  return { recordPath, record };
}

export async function updateQuestionRecord(
  recordPath: string,
  updater: (record: QuestionRecord) => QuestionRecord,
): Promise<QuestionRecord> {
  const current = await readQuestionRecord(recordPath);
  if (!current) throw new Error(`Question record not found: ${recordPath}`);
  const updated = updater(current);
  await writeQuestionRecord(recordPath, updated);
  return updated;
}

export async function markQuestionPrompting(
  recordPath: string,
  renderer: QuestionRendererState,
): Promise<QuestionRecord> {
  return updateQuestionRecord(recordPath, (record) => ({
    ...record,
    status: 'prompting',
    updated_at: new Date().toISOString(),
    renderer,
  }));
}

export async function markQuestionAnswered(
  recordPath: string,
  answer: QuestionAnswer,
): Promise<QuestionRecord> {
  return updateQuestionRecord(recordPath, (record) => ({
    ...record,
    status: 'answered',
    updated_at: new Date().toISOString(),
    answer,
    error: undefined,
  }));
}

export async function markQuestionTerminalError(
  recordPath: string,
  status: Extract<QuestionStatus, 'aborted' | 'error'>,
  code: string,
  message: string,
): Promise<QuestionRecord> {
  return updateQuestionRecord(recordPath, (record) => ({
    ...record,
    status,
    updated_at: new Date().toISOString(),
    error: {
      code,
      message,
      at: new Date().toISOString(),
    },
  }));
}

export function isTerminalQuestionStatus(status: QuestionStatus): boolean {
  return status === 'answered' || status === 'aborted' || status === 'error';
}

export async function waitForQuestionTerminalState(
  recordPath: string,
  options: {
    pollIntervalMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<QuestionRecord> {
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = options.timeoutMs;
  const startedAt = Date.now();

  while (true) {
    const record = await readQuestionRecord(recordPath);
    if (!record) throw new Error(`Question record not found while waiting: ${recordPath}`);
    if (isTerminalQuestionStatus(record.status)) return record;
    if (typeof timeoutMs === 'number' && timeoutMs >= 0 && Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for question answer after ${timeoutMs}ms`);
    }
    await sleep(pollIntervalMs);
  }
}
