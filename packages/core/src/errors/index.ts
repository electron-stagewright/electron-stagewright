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
  StagewrightError,
} from './registry.js'

export {
  type ResponseMeta,
  type SimilarRef,
  type ErrorResponse,
  type SuccessResponse,
  type ToolResponse,
  type MakeErrorOptions,
  type MakeSuccessOptions,
  estimateTokens,
  getSessionId,
  makeError,
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
