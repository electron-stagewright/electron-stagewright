/** Schema fragments shared by plugin tools only when their agent-facing contract is identical. */

import { z } from 'zod'

/** Optional explicit target session, with the standard single-session default. */
export const sessionIdField = {
  sessionId: z.string().optional().describe('Target session; defaults to the only session.'),
} as const
