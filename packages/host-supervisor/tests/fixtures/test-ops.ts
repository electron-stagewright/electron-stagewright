export interface TestOps {
  echo(value: string): Promise<string>
  slow(ms: number): Promise<string>
  hang(): Promise<string>
  /** How many `hang` calls saw their abort signal. */
  aborted(): Promise<number>
  crash(): Promise<never>
  exhaustHeap(): Promise<never>
  block(ms: number): Promise<string>
  count(limit: number): AsyncIterable<number>
}

export const TEST_OPERATIONS = [
  'echo',
  'slow',
  'hang',
  'aborted',
  'crash',
  'exhaustHeap',
  'block',
] as const
export const TEST_STREAMS = ['count'] as const
