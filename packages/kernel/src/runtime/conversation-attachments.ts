/**
 * Conversation artifact authorization and attachment resolution / content assembly module.
 *
 * Responsibilities:
 * - Check conversation access authorization for artifacts (self or ancestor conversation chain, max depth 32 to prevent cycles);
 * - Resolve and validate attachment artifact IDs (existence, authorization, lightweight ref, metadata, absolute path on disk);
 * - Assemble model-visible attachment prompt block `[Attached Files]` (with pull instructions);
 * - Assemble model-visible multimodal content when image attachments are present (plain text / text block + ImageContent base64).
 */
import { join } from 'node:path'
import type { ArtifactMetadata, ConversationAttachmentRef } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import { FileNotFoundError, type ArtifactService } from '../services/index.js'
import type { HelmxStore } from './store.js'

/** Image MIME types: predicate set for assembling multimodal ImageContent blocks from attachments. */
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Model-visible user prompt content (plain string or multimodal text + image content blocks). */
export type PromptContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>

/** Authorized attachment reference paired with its absolute file path on Hub storage. */
export interface ResolvedAttachmentItem {
  ref: ConversationAttachmentRef
  absPath: string
}

interface ConversationAttachmentsHost {
  readonly store: HelmxStore
  readonly artifactsSvc: ArtifactService
  readonly dataDir: string
}

export class ConversationAttachments {
  constructor(private readonly host: ConversationAttachmentsHost) {}

  /** Artifact authorization: current conversation or its ancestor chain (children can read parent artifacts); capped at 32 hops to avoid cycles. */
  isArtifactAuthorized(conversationId: number, artifactConversationId: number): boolean {
    if (conversationId === artifactConversationId) return true
    let current: number | undefined = conversationId
    const seen = new Set<number>()
    for (let depth = 0; depth < 32 && current !== undefined && !seen.has(current); depth += 1) {
      seen.add(current)
      if (current === artifactConversationId) return true
      current = this.host.store.getConv(current)?.parentConversationId
    }
    return false
  }

  /**
   * Resolve and authorize a list of attachment artifact IDs:
   * - artifact must exist (FileNotFoundError -> 404 not_found with artifactId);
   * - artifact's conversation must be this conversation or an ancestor (unauthorized mount -> 403 artifact_forbidden);
   * - returns lightweight pointer (ref), full metadata, and absolute disk path (for prompt and multimodal assembly).
   */
  async resolveAuthorizedAttachments(
    conversationId: number,
    attachmentIds: readonly string[],
  ): Promise<
    Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }>
  > {
    const unique = [...new Set(attachmentIds)]
    const out: Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }> = []
    for (const artifactId of unique) {
      const metadata = await this.host.artifactsSvc.get(artifactId).catch((error: unknown) => {
        if (error instanceof FileNotFoundError) {
          throw new HelmxError('not_found', `attachment artifact not found: ${artifactId}`, 404, { artifactId })
        }
        throw error
      })
      if (!this.isArtifactAuthorized(conversationId, metadata.conversationId)) {
        throw new HelmxError(
          'artifact_forbidden',
          `artifact ${artifactId} does not belong to conversation ${conversationId} or its ancestor chain; refusing unauthorized attachment`,
          403,
          { conversationId, artifactId, artifactConversationId: metadata.conversationId },
        )
      }
      out.push({
        ref: { id: metadata.id, name: metadata.name, mimeType: metadata.mimeType, size: metadata.size },
        metadata,
        absPath: join(this.host.dataDir, metadata.path),
      })
    }
    return out
  }

  /**
   * Authorized artifact byte read (current conversation or ancestor chain, max depth 32):
   * validates boundary inputs (400), artifact existence (404 not_found), conversation scope
   * (403 artifact_forbidden), and reads raw bytes via `ArtifactService.readBufferForMetadata`
   * (metadata shape gate + 3-layer realpath guard + ENOENT -> 404 artifact_file_missing +
   * isolated Uint8Array copy; never exposes host disk paths).
   */
  async readAuthorizedArtifact(
    conversationId: number,
    artifactId: string,
  ): Promise<{ metadata: ArtifactMetadata; bytes: Uint8Array }> {
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
      throw new HelmxError(
        'validation_error',
        `invalid conversationId: ${String(conversationId)}`,
        400,
        { conversationId },
      )
    }
    if (typeof artifactId !== 'string' || artifactId.trim() === '') {
      throw new HelmxError('validation_error', 'artifactId must be a non-empty string', 400, {
        conversationId,
        artifactId,
      })
    }
    const metadata = await this.host.artifactsSvc.get(artifactId).catch((error: unknown) => {
      if (error instanceof FileNotFoundError) {
        throw new HelmxError('not_found', `artifact not found: ${artifactId}`, 404, { artifactId })
      }
      throw error
    })
    if (!this.isArtifactAuthorized(conversationId, metadata.conversationId)) {
      throw new HelmxError(
        'artifact_forbidden',
        `artifact ${artifactId} does not belong to conversation ${conversationId} or its ancestor chain; refusing unauthorized read`,
        403,
        { conversationId, artifactId, artifactConversationId: metadata.conversationId },
      )
    }
    const bytes = await this.host.artifactsSvc.readBufferForMetadata(metadata)
    return { metadata: { ...metadata }, bytes }
  }

  /** Plaintext `[Attached Files]` manifest block (without body text prefix). */
  buildAttachmentBlock(
    resolved: ReadonlyArray<ResolvedAttachmentItem>,
  ): string {
    const lines = resolved.map(
      ({ ref, absPath }) =>
        `- ${ref.name} (id=${ref.id}, mime=${ref.mimeType}, size=${ref.size} bytes, path=${absPath}, pull=\`helmx artifacts get ${ref.id} --output ./${ref.name}\`)`,
    )
    return `[Attached Files]\n${lines.join('\n')}`
  }

  /**
   * Build model-visible content with attachments:
   * - appends the `[Attached Files]` manifest (via `buildAttachmentBlock`) after `effectiveText`,
   *   and optional `suffixText` (e.g., `<structured_output_contract>`) after the manifest;
   * - if any image attachments exist, returns a multimodal block array (text block + base64 ImageContent blocks);
   * - if no image attachments exist, returns the concatenated plain string.
   */
  async buildAttachmentContent(
    effectiveText: string,
    resolved: ReadonlyArray<ResolvedAttachmentItem>,
    options?: { suffixText?: string },
  ): Promise<PromptContent> {
    const attachedBlock = this.buildAttachmentBlock(resolved)
    const sections: string[] = []
    if (effectiveText.length > 0) sections.push(effectiveText)
    sections.push(attachedBlock)
    if (options?.suffixText !== undefined && options.suffixText.length > 0) {
      sections.push(options.suffixText)
    }
    const modelText = sections.join('\n\n')
    const hasImage = resolved.some(({ ref }) => IMAGE_MIMES.has(ref.mimeType))
    if (!hasImage) return modelText
    const contentParts: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
      { type: 'text', text: modelText },
    ]
    for (const item of resolved) {
      if (!IMAGE_MIMES.has(item.ref.mimeType)) continue
      const bytes = await this.host.artifactsSvc.readBuffer(item.ref.id)
      contentParts.push({
        type: 'image',
        data: Buffer.from(bytes).toString('base64'),
        mimeType: item.ref.mimeType,
      })
    }
    return contentParts
  }
}
