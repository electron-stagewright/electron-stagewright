import type {
  ArtifactMimeType,
  ArtifactPublication,
  ArtifactPublisher,
  ArtifactStore,
} from '../resources/artifacts.js'
import type { RequestOperation } from './request-operation.js'

/** Publications owned by one dispatch, independent of the fields its handler returns. */
export class RequestArtifacts implements ArtifactPublisher {
  readonly #store: ArtifactStore
  readonly #operation: RequestOperation
  readonly #uris = new Set<string>()
  readonly #unregister: (() => void) | undefined
  #closed = false

  constructor(store: ArtifactStore, operation: RequestOperation) {
    this.#store = store
    this.#operation = operation
    this.#unregister = operation.onCancel(() => this.finish(false))
  }

  get maxArtifactBytes(): number {
    return this.#store.maxArtifactBytes
  }

  publish(bytes: Uint8Array, mimeType: ArtifactMimeType, name: string): ArtifactPublication {
    this.#operation.signal.throwIfAborted()
    if (this.#closed) return { artifact_unavailable: 'closed' }
    const publication = this.#store.publish(bytes, mimeType, name)
    if ('artifact' in publication) {
      // Cancellation can occur inside an injected producer/store collaborator, before ownership
      // is recorded. Revoke this new snapshot even if the cancellation cleanup already ran.
      if (this.#closed) this.#store.remove(publication.artifact.uri)
      else this.#uris.add(publication.artifact.uri)
    }
    this.#operation.signal.throwIfAborted()
    return publication
  }

  /** Commit a valid success; all failed outcomes revoke only this dispatch's publications. */
  finish(success: boolean): void {
    if (this.#closed) return
    this.#closed = true
    // A pre-cancelled operation calls its cleanup during construction, before assignment.
    this.#unregister?.()
    if (!success) for (const uri of this.#uris) this.#store.remove(uri)
    this.#uris.clear()
  }
}
