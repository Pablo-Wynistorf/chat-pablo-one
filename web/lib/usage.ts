/**
 * Usage accounting + abuse limits, backed by DynamoDB.
 *
 * Three item types (keyed by `pk`, all with a TTL so they self-clean):
 *
 *   cost#<day>       calls · inputTokens · outputTokens · embedTokens · microUsd
 *                    everything spent that day across all callers -> budget cap
 *
 *   ip#<day>#<ip>    calls · inputTokens · outputTokens · embedTokens · microUsd
 *                    the same counters scoped to one public IP -> per-IP chat cap.
 *                    Greeting spend lands here too (tokens, no `calls` increment).
 *
 *   ipblock#<ip>     lastLimitDay · streak · blocked · blockedAt
 *                    consecutive-day abuse tracking -> outright block
 *
 * The global and per-IP items carry the identical set of counters — one
 * consolidated `calls` count (not the old `count`/`calls` split), plus the raw
 * token totals beside the derived cost. Cost alone is lossy: it merges three token
 * types at prices that change and rounds to whole micro-USD, so keeping the counts
 * lets spend be recomputed after a price fix and shows the input/output split that
 * explains a bill. Cost is integer micro-USD (1 USD = 1_000_000) to avoid float drift.
 */
import {
  type AttributeValue,
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { awsCredentials, region } from "./aws";

const TABLE = process.env.USAGE_TABLE;

// Nova Micro + Titan embed pricing (USD per 1K tokens). Override via env if the
// model/region price differs. Defaults are Nova Micro / Titan v2 on-demand.
const CHAT_IN_PER_1K = Number.parseFloat(process.env.CHAT_IN_PER_1K ?? "0.000035");
const CHAT_OUT_PER_1K = Number.parseFloat(process.env.CHAT_OUT_PER_1K ?? "0.00014");
const EMBED_PER_1K = Number.parseFloat(process.env.EMBED_PER_1K ?? "0.00002");

export const DAILY_BUDGET_USD = Number.parseFloat(process.env.DAILY_BUDGET_USD ?? "0.5");
export const IP_DAILY_LIMIT = Number.parseInt(process.env.IP_DAILY_LIMIT ?? "50", 10);
export const MAX_INPUT_TOKENS = Number.parseInt(process.env.MAX_INPUT_TOKENS ?? "400", 10);

/**
 * Request-shape limits. These matter because the whole conversation history is
 * supplied by the client and forwarded to Bedrock: validating only the newest
 * message lets a caller pad `messages` with thousands of individually-legal
 * turns and bill us for all of them.
 */
export const MAX_BODY_BYTES = Number.parseInt(process.env.MAX_BODY_BYTES ?? "65536", 10);
export const MAX_HISTORY_MESSAGES = Number.parseInt(
  process.env.MAX_HISTORY_MESSAGES ?? "100",
  10,
);
export const MAX_CONVERSATION_TOKENS = Number.parseInt(
  process.env.MAX_CONVERSATION_TOKENS ?? "20000",
  10,
);

/** Block an IP after it maxes out its daily message limit this many days in a row. */
export const BLOCK_AFTER_CONSECUTIVE_DAYS = Number.parseInt(
  process.env.BLOCK_AFTER_CONSECUTIVE_DAYS ?? "3",
  10,
);

/** How long per-IP records (daily counters + block state) are retained. */
const IP_RETENTION_DAYS = Number.parseInt(process.env.IP_RETENTION_DAYS ?? "30", 10);

const BUDGET_MICRO = Math.round(DAILY_BUDGET_USD * 1_000_000);

const DAY_SECONDS = 24 * 60 * 60;
// Cost counters only feed the daily budget, so they can be short-lived.
const COST_TTL_SECONDS = 2 * DAY_SECONDS;
// Per-IP counters and block state must survive long enough to see a
// consecutive-day pattern and to keep an abusive IP blocked afterwards.
const IP_TTL_SECONDS = IP_RETENTION_DAYS * DAY_SECONDS;

const client = new DynamoDBClient({ region, credentials: awsCredentials });

/** UTC day stamp, e.g. "2026-07-03". */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The UTC day before `day` ("2026-07-03" -> "2026-07-02"). */
function previousDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function costTtl(): number {
  return Math.floor(Date.now() / 1000) + COST_TTL_SECONDS;
}

function ipTtl(): number {
  return Math.floor(Date.now() / 1000) + IP_TTL_SECONDS;
}

/**
 * Rough token estimate (~4 chars/token). Good enough for an input-size guard;
 * we reconcile real spend from the model's reported usage afterwards.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens spent embedding the query for retrieval (chat only). */
  embedTokens?: number;
}

/** Convert token usage to integer micro-USD. */
export function costMicroUsd(u: TokenUsage): number {
  const usd =
    (u.inputTokens / 1000) * CHAT_IN_PER_1K +
    (u.outputTokens / 1000) * CHAT_OUT_PER_1K +
    ((u.embedTokens ?? 0) / 1000) * EMBED_PER_1K;
  return Math.round(usd * 1_000_000);
}

/** The counter set carried by both the global and per-IP daily items. */
export interface Usage {
  /** Model calls recorded. */
  calls: number;
  /** Prompt tokens billed by the chat model. */
  inputTokens: number;
  /** Completion tokens billed by the chat model. */
  outputTokens: number;
  /** Tokens spent embedding queries for retrieval. */
  embedTokens: number;
  /** Spend in integer micro-USD (1 USD = 1_000_000). */
  microUsd: number;
}

/** Back-compat alias: this used to be the only (global) usage shape. */
export type DailyUsage = Usage;

const EMPTY_USAGE: Usage = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  embedTokens: 0,
  microUsd: 0,
};

/** Attribute name for each counter, shared by the reader and the writer. */
const COUNTER_ATTRS = {
  calls: "calls",
  inputTokens: "inputTokens",
  outputTokens: "outputTokens",
  embedTokens: "embedTokens",
  microUsd: "microUsd",
} as const;

async function readUsage(pk: string): Promise<Usage> {
  if (!TABLE) return { ...EMPTY_USAGE };
  const res = await client.send(
    new GetItemCommand({ TableName: TABLE, Key: { pk: { S: pk } }, ConsistentRead: true }),
  );
  const n = (attr: string): number => Number(res.Item?.[attr]?.N ?? "0");
  return {
    calls: n("calls"),
    inputTokens: n("inputTokens"),
    outputTokens: n("outputTokens"),
    embedTokens: n("embedTokens"),
    microUsd: n("microUsd"),
  };
}

/**
 * Today's GLOBAL usage totals. Consistent read, because the budget decision is
 * made from it and an eventually-consistent read could let several requests
 * through after the cap is reached.
 */
export async function getDailyUsage(): Promise<Usage> {
  return readUsage(`cost#${today()}`);
}

/** Today's usage totals for one IP (0s if it hasn't been seen today). */
export async function getIpDailyUsage(ip: string, day = today()): Promise<Usage> {
  return readUsage(`ip#${day}#${ip}`);
}

/** Current spend for today in micro-USD (0 if unset or table missing). */
export async function getDailyMicroUsd(): Promise<number> {
  return (await getDailyUsage()).microUsd;
}

/** True if today's spend is already at/over the daily budget. */
export async function isOverBudget(): Promise<boolean> {
  return (await getDailyMicroUsd()) >= BUDGET_MICRO;
}

/** Non-negative integer, so a bad reading can't corrupt a running total. */
function safeCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

/**
 * Atomically ADD a set of counters to one item, refreshing its TTL, and return the
 * item's new `calls` value.
 *
 * The five counters are always written together in a single ADD, so concurrent
 * requests can't lose an update, and both the global and per-IP items go through
 * here — that's what keeps their schemas identical. A counter left at 0 is a
 * harmless no-op (DynamoDB ADD of 0).
 */
async function addUsage(pk: string, u: Usage, ttlEpoch: number): Promise<number> {
  if (!TABLE) return 0;
  const res = await client.send(
    new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: pk } },
      UpdateExpression:
        "ADD #calls :calls, #in :in, #out :out, #embed :embed, #micro :micro SET #ttl = :ttl",
      ExpressionAttributeNames: {
        "#calls": COUNTER_ATTRS.calls,
        "#in": COUNTER_ATTRS.inputTokens,
        "#out": COUNTER_ATTRS.outputTokens,
        "#embed": COUNTER_ATTRS.embedTokens,
        "#micro": COUNTER_ATTRS.microUsd,
        "#ttl": "expiresAt",
      },
      ExpressionAttributeValues: {
        ":calls": { N: String(u.calls) },
        ":in": { N: String(u.inputTokens) },
        ":out": { N: String(u.outputTokens) },
        ":embed": { N: String(u.embedTokens) },
        ":micro": { N: String(u.microUsd) },
        ":ttl": { N: String(ttlEpoch) },
      },
      ReturnValues: "UPDATED_NEW",
    }),
  );
  return Number(res.Attributes?.[COUNTER_ATTRS.calls]?.N ?? "0");
}

/**
 * Count one message from a public IP toward its daily allowance and return the new
 * per-IP call total. Called BEFORE generation, so it is the rate-limit gate; the
 * tokens that message spends are added later by `recordUsage`.
 *
 * The per-IP item is retained for IP_RETENTION_DAYS (30 by default) so the
 * consecutive-day block logic has history to work with.
 */
export async function recordIpMessage(ip: string): Promise<number> {
  return addUsage(
    `ip#${today()}#${ip}`,
    { calls: 1, inputTokens: 0, outputTokens: 0, embedTokens: 0, microUsd: 0 },
    ipTtl(),
  );
}

/**
 * Record one completed model call's token usage. Called AFTER generation.
 *
 * Always updates the global `cost#<day>` item (this is where a call is counted for
 * the whole app — greetings included). When an `ip` is given, the SAME token and
 * cost counters are added to that IP's daily item too, but WITHOUT a second call
 * increment: the call was already counted up front by `recordIpMessage`, so the
 * per-IP `calls` and per-IP tokens stay consistent.
 */
export async function recordUsage(u: TokenUsage, ip?: string): Promise<void> {
  if (!TABLE) return;

  const tokens = {
    inputTokens: safeCount(u.inputTokens),
    outputTokens: safeCount(u.outputTokens),
    embedTokens: safeCount(u.embedTokens),
    microUsd: costMicroUsd(u),
  };

  // Global: always count the call, even a failed one that produced no tokens.
  await addUsage(`cost#${today()}`, { calls: 1, ...tokens }, costTtl());

  // Per-IP: fold in the tokens (calls already counted by recordIpMessage). Skip a
  // pure-zero write, since there's nothing to add to the existing counters.
  const nothing =
    tokens.inputTokens === 0 &&
    tokens.outputTokens === 0 &&
    tokens.embedTokens === 0 &&
    tokens.microUsd <= 0;
  if (ip && !nothing) {
    await addUsage(`ip#${today()}#${ip}`, { calls: 0, ...tokens }, ipTtl());
  }
}

/**
 * Per-IP block state, keyed `ipblock#<ip>`:
 *   lastLimitDay  UTC day this IP last maxed out its daily message allowance
 *   streak        consecutive days (including lastLimitDay) it has maxed out
 *   blocked       true once streak reached BLOCK_AFTER_CONSECUTIVE_DAYS
 *
 * A blocked IP is refused entirely. The record's 30-day TTL is refreshed on every
 * limit-reached day, so an IP that keeps hammering the limit stays blocked, while
 * one that stops is forgotten 30 days later. (To make blocks permanent, drop the
 * TTL on this item.)
 */
export async function isIpBlocked(ip: string): Promise<boolean> {
  if (!TABLE) return false;
  const res = await client.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `ipblock#${ip}` } },
      ConsistentRead: true,
    }),
  );
  return res.Item?.blocked?.BOOL === true;
}

/**
 * Record that `ip` maxed out its daily allowance today, advancing its
 * consecutive-day streak and blocking it once the streak is long enough.
 *
 * MUST be called exactly once on the message that first reaches the limit
 * (the recordIpMessage result === IP_DAILY_LIMIT). Because recordIpMessage is
 * atomic, only one request per day sees that exact value, so this fires once per
 * day per IP — the `lastLimitDay === today` guard just makes a stray double-call
 * harmless.
 *
 * Read-modify-write is safe here precisely because of that once-per-day trigger:
 * there is no concurrent writer to race with.
 */
export async function noteDailyLimitReached(ip: string): Promise<void> {
  if (!TABLE) return;
  const day = today();

  const existing = await client.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `ipblock#${ip}` } },
      ConsistentRead: true,
    }),
  );

  const lastLimitDay = existing.Item?.lastLimitDay?.S;
  if (lastLimitDay === day) return; // already counted today

  const priorStreak = Number(existing.Item?.streak?.N ?? "0");
  // Consecutive only if the previous maxed-out day was literally yesterday;
  // any gap resets the streak to today alone.
  const streak = lastLimitDay === previousDay(day) ? priorStreak + 1 : 1;
  const blocked = existing.Item?.blocked?.BOOL === true || streak >= BLOCK_AFTER_CONSECUTIVE_DAYS;

  const values: Record<string, AttributeValue> = {
    ":day": { S: day },
    ":streak": { N: String(streak) },
    ":blocked": { BOOL: blocked },
    ":ttl": { N: String(ipTtl()) },
  };
  let update =
    "SET lastLimitDay = :day, streak = :streak, blocked = :blocked, expiresAt = :ttl";

  // Stamp the moment of blocking once, for later inspection.
  if (blocked && existing.Item?.blocked?.BOOL !== true) {
    update += ", blockedAt = :blockedAt";
    values[":blockedAt"] = { S: new Date().toISOString() };
  }

  await client.send(
    new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `ipblock#${ip}` } },
      UpdateExpression: update,
      ExpressionAttributeValues: values,
    }),
  );
}

/** Best-effort client IP from common proxy headers. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return (
    req.headers.get("x-real-ip") ??
    req.headers.get("cf-connecting-ip") ??
    "unknown"
  );
}
