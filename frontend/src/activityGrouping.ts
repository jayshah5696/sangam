import type { OperationEvent } from './api'

export function groupActivityEvents(events: OperationEvent[]): OperationEvent[][] {
  const groups = new Map<string, OperationEvent[]>()
  for (const event of events) {
    const group = groups.get(event.operation_id)
    if (group) group.push(event)
    else groups.set(event.operation_id, [event])
  }
  return [...groups.values()]
}
