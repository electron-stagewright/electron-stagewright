import type { Server } from 'node:http'

export interface BenchAppServer {
  readonly origin: string
  close(): Promise<void>
}

export function createBenchAppServer(html: string): Server
export function startBenchAppServer(html: string): Promise<BenchAppServer>
