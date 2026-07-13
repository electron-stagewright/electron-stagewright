/** PNG metadata, hashing, and bounded pixel comparison. */

import { createHash } from 'node:crypto'

import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

import type { AnimationMode, CaretMode, RendererEnvironment } from './capture.js'

export interface VisualEnvironment extends RendererEnvironment {
  readonly platform: string
  readonly arch: string
  readonly fontFingerprint?: string
}

export interface VisualMetadata {
  readonly schemaVersion: 1
  readonly name: string
  readonly capturedAt: string
  readonly image: {
    readonly sha256: string
    readonly width: number
    readonly height: number
  }
  readonly environment: VisualEnvironment
  readonly captureProfile: {
    readonly fullPage: boolean
    readonly hash: string
  }
}

export interface CaptureProfileInput {
  readonly fullPage: boolean
  readonly animations: AnimationMode
  readonly caret: CaretMode
  readonly style?: string
  readonly masks: readonly string[]
}

export class VisualImageError extends Error {
  override readonly name: string = 'VisualImageError'
}

export class VisualImageLimitError extends VisualImageError {
  override readonly name = 'VisualImageLimitError'
}

const MAX_PNG_BYTES = 64 * 1024 * 1024
const MAX_PIXELS = 16_000_000
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Return the stable SHA-256 representation stored beside each visual baseline. */
export function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Avoid leaking raw capture CSS in metadata while ensuring changed settings cannot produce a false match. */
export function captureProfileHash(input: CaptureProfileInput): string {
  return sha256(
    JSON.stringify({
      fullPage: input.fullPage,
      animations: input.animations,
      caret: input.caret,
      style: input.style ?? '',
      masks: input.masks,
    }),
  )
}

/** Decode a PNG or fail with a plugin-owned error instead of an implementation exception. */
export function decodePng(input: Buffer): PNG {
  assertEncodedPngBounds(input)
  try {
    return PNG.sync.read(input)
  } catch (cause) {
    throw new VisualImageError(
      `The screenshot is not a readable PNG: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

/**
 * Reject an oversized encoded image or IHDR pixel claim before pngjs allocates
 * the decompressed RGBA buffer.
 */
function assertEncodedPngBounds(input: Buffer): void {
  if (input.byteLength > MAX_PNG_BYTES) {
    throw new VisualImageLimitError(`PNG is larger than the ${MAX_PNG_BYTES}-byte visual limit.`)
  }
  // Let pngjs provide the useful malformed-PNG diagnostic when the signature or
  // IHDR is incomplete. A valid IHDR, however, is sufficient to bound decoder
  // allocation before handing untrusted bytes to the library.
  if (
    input.byteLength < 24 ||
    !input.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) ||
    input.readUInt32BE(8) !== 13 ||
    input.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    return
  }
  const width = input.readUInt32BE(16)
  const height = input.readUInt32BE(20)
  if (width === 0 || height === 0 || width > MAX_PIXELS / height) {
    throw new VisualImageLimitError(`PNG exceeds the ${MAX_PIXELS}-pixel visual limit.`)
  }
}

/** Bound decoded image memory before a full pixel comparison or artifact write. */
export function assertImageBounds(png: PNG, encodedBytes: number): void {
  if (encodedBytes > MAX_PNG_BYTES) {
    throw new VisualImageLimitError(`PNG is larger than the ${MAX_PNG_BYTES}-byte visual limit.`)
  }
  if (png.width * png.height > MAX_PIXELS) {
    throw new VisualImageLimitError(`PNG exceeds the ${MAX_PIXELS}-pixel visual limit.`)
  }
}

/** Compare same-sized PNGs and return an encoded diff image with the measured count. */
export function comparePngs(
  expected: PNG,
  actual: PNG,
  threshold: number,
): { readonly diffPixels: number; readonly diffPng: Buffer } {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    throw new VisualImageError('PNG dimensions differ; compare metadata before pixels.')
  }
  const diff = new PNG({ width: expected.width, height: expected.height, fill: true })
  const diffPixels = pixelmatch(
    expected.data,
    actual.data,
    diff.data,
    expected.width,
    expected.height,
    {
      threshold,
    },
  )
  return { diffPixels, diffPng: PNG.sync.write(diff) }
}

/** Enumerate the metadata fields that must agree before a pixel comparison is meaningful. */
export function incompatibleMetadata(
  expected: VisualMetadata,
  actual: VisualMetadata,
): readonly string[] {
  const differences: string[] = []
  if (expected.name !== actual.name) differences.push('name')
  if (expected.image.width !== actual.image.width) differences.push('image.width')
  if (expected.image.height !== actual.image.height) differences.push('image.height')
  if (expected.captureProfile.fullPage !== actual.captureProfile.fullPage)
    differences.push('captureProfile.fullPage')
  if (expected.captureProfile.hash !== actual.captureProfile.hash)
    differences.push('captureProfile.hash')

  const fields: (keyof VisualEnvironment)[] = [
    'platform',
    'arch',
    'electronVersion',
    'userAgent',
    'viewport',
    'devicePixelRatio',
    'colorScheme',
    'locale',
    'fontFingerprint',
  ]
  for (const field of fields) {
    if (JSON.stringify(expected.environment[field]) !== JSON.stringify(actual.environment[field])) {
      differences.push(`environment.${field}`)
    }
  }
  return differences
}
