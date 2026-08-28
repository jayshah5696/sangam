export type ExplorerCommand = 'move' | 'tags' | 'trash'

const explorerCommandEvent = 'sangam:explorer-command'

export function dispatchExplorerCommand(command: ExplorerCommand) {
  window.dispatchEvent(new CustomEvent<ExplorerCommand>(explorerCommandEvent, { detail: command }))
}

export function subscribeExplorerCommands(listener: (command: ExplorerCommand) => void) {
  const handle = (event: Event) => listener((event as CustomEvent<ExplorerCommand>).detail)
  window.addEventListener(explorerCommandEvent, handle)
  return () => window.removeEventListener(explorerCommandEvent, handle)
}
