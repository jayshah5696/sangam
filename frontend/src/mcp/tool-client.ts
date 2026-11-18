import type { App } from '@modelcontextprotocol/ext-apps'
import { mutationErrorSchema, type AppAction } from './contracts'

export class AppActionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly outcome: 'rejected' | 'committed' | 'unknown' = 'unknown',
  ) {
    super(message)
  }
}

export async function callAppTool(app: App, action: AppAction) {
  const reply = await app.callServerTool({ name: 'mcp_app', arguments: { action } })
  if (reply.isError) {
    const parsed = mutationErrorSchema.safeParse(reply.structuredContent)
    throw new AppActionError(
      parsed.success ? parsed.data.error.message : 'The action failed. Retry with its original arguments.',
      parsed.success ? parsed.data.error.code : 'unknown',
      parsed.success ? (parsed.data.mutation?.outcome ?? 'unknown') : 'unknown',
    )
  }
  return reply.structuredContent
}
