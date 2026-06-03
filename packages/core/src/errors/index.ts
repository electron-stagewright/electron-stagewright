/**
 * Public surface of the errors module — re-exported from the package root so
 * downstream callers can import via `@electron-stagewright/core`.
 *
 * @module
 */

export {
  ERROR_CODES,
  type ErrorCodeDefinition,
  type ErrorCode,
  assertNever,
  isErrorCode,
  isKnownErrorCode,
  lookupErrorCodeDefinition,
  registerPluginErrorCodes,
  unregisterPluginErrorCodes,
  clearPluginErrorCodes,
  StagewrightError,
} from './registry.js'

export {
  type ResponseMeta,
  type ResponseCode,
  type SimilarRef,
  type ErrorResponse,
  type SuccessResponse,
  type ToolResponse,
  type MakeErrorOptions,
  type MakeSuccessOptions,
  estimateTokens,
  getSessionId,
  makeError,
  makePluginError,
  makeSuccess,
} from './envelope.js'

export {
  OperationTypeSchema,
  type OperationType,
  type ValidateEvalOptions,
  validateCommandContent,
  validateEvalContent,
  routeByOperationType,
  DANGEROUS_EVAL_KEYWORDS_FOR_TESTS,
} from './operation-type.js'

export {
  type SessionContextStore,
  runWithSessionContext,
  currentSessionId,
} from './session-context.js'
