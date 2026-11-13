export interface TestOps {
  echo(value: string): Promise<string>
  slow(ms: number): Promise<string>
  hang(): Promise<string>
  crash(): Promise<never>
  exhaustHeap(): Promise<never>
  block(ms: number): Promise<string>
  count(limit: number): AsyncIterable<number>
}

export const TEST_OPERATIONS = ['echo', 'slow', 'hang', 'crash', 'exhaustHeap', 'block'] as const
export const TEST_STREAMS = ['count'] as const
