/** Injects environment options at exec time (sole channel for secrets and identity injection). */
export type EnvOptionsComposer = (input: {
  nodeId: string
  cwd: string
  conversationId?: number
}) => Promise<Record<string, string>> | Record<string, string>
