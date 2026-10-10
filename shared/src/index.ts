/**
 * @wuzip/wuzapi-queue-core
 *
 * The whole per-number worker lives here; each `cloudflare/<nomor>/src/index.ts`
 * is only `export default createWorker()` plus the Durable Object export, so a
 * bug fix reaches every number at once while configuration, secrets and
 * Cloudflare resources stay per number.
 *
 * Routes:
 *   POST /ingest/<INGEST_TOKEN>  receive one wuzapi webhook and enqueue it
 *   GET  /healthz                liveness + effective configuration (no secrets)
 *
 * Queue consumers (selected by BOT_MODE):
 *   off          <worker>-events → relay to DOWNSTREAM_URL
 *   shadow | on  <worker>-events → bot pipeline (filter, policy, lock, AI, send)
 *   always       <worker>-dlq    → archive failures to R2 and optionally alert
 */
export { createWorker } from "./worker";
export { isDlqQueue, resolveConfig } from "./support";
export { ConfigError, botReadiness, loadConfig } from "./config";
export type {
  AiToolsMode,
  BotConfig,
  BotMode,
  BotReadiness,
  Env,
  HmacMode,
  InstanceConfig,
  KnowledgeMode,
  MediaMode,
  PaymentProviderName,
  RelayMode,
} from "./config";
export { ENVELOPE_VERSION, isEnvelopeV1, isWuzapiEventKind } from "./envelope";
export type { DlqRecord, EnvelopeKind, EnvelopeV1, MediaPointer } from "./envelope";
export { handleIngest, ingestTokenFromPath } from "./ingest/handler";
export type { IngestDeps, IngestOptions } from "./ingest/handler";
export { parseFormWebhook, parseJsonWebhook, parseWebhookBody, WebhookParseError } from "./ingest/parse";
export type { ParsedWebhook } from "./ingest/parse";
export { handleEventsBatch } from "./consumer/relay";
export type { ConsumerDeps, ConsumerOptions } from "./consumer/relay";
export { handleDlqBatch } from "./consumer/dlq";
export type { DlqDeps, DlqOptions } from "./consumer/dlq";
export { hmacSha256Hex, hmacSha256HexStream, matchesAnyKey, timingSafeEqualString } from "./lib/hmac";
export { scanTopLevelJson, ScanError } from "./lib/jsonScan";
export type { ScanResult } from "./lib/jsonScan";
export { retryDelaySeconds } from "./lib/backoff";
export { createLogger } from "./lib/logger";
export type { Logger } from "./lib/logger";

// ---- bot pipeline ----------------------------------------------------------
export { ChatCoordinator, claimChat, releaseChat, coordinatorFor, rateLimiterFor } from "./bot/coordinator/chat-lock";
export type { ClaimRequest, ClaimResponse, CoordinatorState, RateRequest, RateResponse } from "./bot/coordinator/chat-lock";
export { filterInbound, messageEventOf, parseTimestamp } from "./bot/filter";
export type { FilterOptions, FilterResult } from "./bot/filter";
export { extractBody, unwrapMessage } from "./bot/text";
export type { ExtractedBody } from "./bot/text";
export { asBoolean, asRecord, asString } from "./bot/types";
export type {
  ChatMessage,
  FilterReason,
  InboundMessage,
  JsonRecord,
  MessageKind,
  OutboundDocument,
  OutboundImage,
  OutboundMessage,
  OutboundText,
  ReplyContext,
  WuzapiMessageEvent,
  WuzapiMessageInfo,
} from "./bot/types";
export { claimDelivery, finishDelivery, forgetDeliveries, isDeliveryDone } from "./bot/idempotency";
export type { ProcessedEventInput } from "./bot/idempotency";
export {
  ensureChatState,
  getChatState,
  loadHistory,
  pruneHistory,
  recordInbound,
  recordOutbound,
  setChatEnabled,
  touchOutbound,
} from "./bot/history";
export type { ChatStateRow } from "./bot/history";
export { containsNoAi, namesFromContact, noAiFromContact, resolveChatPolicy, upsertContact } from "./bot/contacts/policy";
export type { ChatPolicy, ContactRow, PolicyReason } from "./bot/contacts/policy";
export { deliverOutbound, describeOutbound, RATE_CAPACITY, RATE_REFILL_PER_SECOND } from "./bot/outbound";
export type { OutboundContext, OutboundOutcome, SendFailure } from "./bot/outbound";
export {
  buildMessages,
  catalogFor,
  createResponder,
  fallbackReply,
  invalidateCatalogCache,
  runAgentLoop,
} from "./bot/agent/run";
export type { AgentLoopOptions, AgentOptions, AgentTurnInput, ReplyPlan, Responder } from "./bot/agent/run";
export { LlmClient } from "./bot/agent/llm";
export type { LlmClientOptions, LlmMessage, LlmResult, LlmToolCall, LlmToolDefinition } from "./bot/agent/llm";
export {
  CATALOG_MAX_CHARS,
  CATALOG_MAX_PRODUCTS,
  DEFAULT_BOT_PROMPT,
  FORBIDDEN_PATTERNS,
  HISTORY_MAX_CHARS,
  buildSystemPrompt,
  checkForbidden,
  describeProduct,
  renderCatalog,
} from "./bot/agent/prompt";
export type { PromptContext } from "./bot/agent/prompt";
export { IMAGE_PREFIX, TOOL_DEFINITIONS, executeTool, parseArguments, toBase64 } from "./bot/agent/tools";
export type { ToolContext, ToolOutcome } from "./bot/agent/tools";
export {
  addItem,
  cartToCustomer,
  cartToPrompt,
  clearCart,
  findProduct,
  limitsOf,
  readCart,
  removeItem,
} from "./bot/sales/cart.service";
export type { CartLimits, CartLine, CartOutcome, CartView } from "./bot/sales/cart.service";
export { formatRupiah, formatWib, formatWibShort, orderReference, truncate } from "./bot/utils/format";
export { handleBotBatch } from "./bot/queue/router";
export type { BotBatchOptions } from "./bot/queue/router";
export {
  createBotRuntime,
  handleOutboxTick,
  handlePaymentEvent,
  handleWuzapiEvent,
} from "./bot/queue/handlers";
export type { BotDeps, BotRuntime, BotRuntimeOptions, Disposition } from "./bot/queue/handlers";
export {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  chunkText,
  contentHash,
} from "./bot/knowledge/chunker";
export type { Chunk, ChunkOptions } from "./bot/knowledge/chunker";
export {
  KNOWLEDGE_KEYS,
  invalidateKnowledgeCache,
  loadKnowledge,
  loadOngkirPolicy,
  resolveKnowledgeMode,
} from "./bot/knowledge/loader";
export type { KnowledgeBundle, KnowledgeSource, LoadKnowledgeOptions } from "./bot/knowledge/loader";
export {
  NO_CONTEXT_INTRO,
  buildMatchQuery,
  chunksFor,
  ensureFtsSchema,
  invalidateChunkCache,
  retrieve,
  scoreChunk,
  searchInMemory,
  tokenize,
} from "./bot/knowledge/search";
export type { KnowledgeHit, RetrievalResult, RetrieveOptions } from "./bot/knowledge/search";
export {
  assignOngkirPolicy,
  isOngkirDecision,
  parseCatalog,
  parseRupiah,
  resolveCatalog,
  summariseCatalog,
} from "./bot/knowledge/catalog";
export type {
  AssignedPolicy,
  AssignOptions,
  CatalogProduct,
  OngkirDecision,
  OngkirPolicy,
  OngkirSource,
  ResolvedProduct,
} from "./bot/knowledge/catalog";
export { WuzapiClient } from "./bot/wuzapi/client";
export type { WuzapiClientDeps, WuzapiClientOptions, WuzapiSendResult } from "./bot/wuzapi/client";
