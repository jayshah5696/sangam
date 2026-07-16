import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  children: ReactNode
  groupId: string
  resetKey: string
  onRecover: () => void
}

type State = { error: Error | null }

export class EditorGroupErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Editor group render failed', {
      error,
      groupId: this.props.groupId,
      componentStack: info.componentStack,
    })
  }

  componentDidUpdate(previous: Props) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <section className="editor-group group-error" role="alert">
        <div className="center-message error-text">
          <strong>This editor group could not be rendered.</strong>
          <p>The rest of your workbench is still available.</p>
          <button onClick={this.props.onRecover}>Close this group</button>
        </div>
      </section>
    )
  }
}
