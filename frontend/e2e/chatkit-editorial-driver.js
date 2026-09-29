// Deterministic substitute for the external ChatKit component, using its public
// methods and the real options.api.fetch transport supplied by ChatPanel.
class EditorialChatKit extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return
    const root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = ':host { display:block; height:100%; } textarea { box-sizing:border-box; width:100%; height:60%; } button { min-height:44px; }'
    this.composer = document.createElement('textarea')
    this.composer.setAttribute('aria-label', 'ChatKit composer')
    const send = document.createElement('button')
    send.textContent = 'Send'
    this.status = document.createElement('p')
    this.status.setAttribute('role', 'status')
    send.addEventListener('click', () => this.sendUserMessage({ text: this.composer.value }))
    root.append(style, this.composer, send, this.status)
  }
  setOptions(options) {
    this.options = options
    this.threadId = options.initialThread
    queueMicrotask(() => this.dispatchEvent(new CustomEvent('chatkit.ready', { detail: {} })))
  }
  async setComposerValue({ text }) { this.composer.value = text }
  async focusComposer() { this.composer.focus() }
  async setThreadId(id) { this.threadId = id }
  async sendUserMessage({ text }) {
    const input = { content: [{ type: 'input_text', text }], attachments: [], inference_options: { model: 'openai/gpt-5.4-nano' } }
    const response = await this.options.api.fetch(this.options.api.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.threadId ? { type: 'threads.add_user_message', params: { thread_id: this.threadId, input } } : { type: 'threads.create', params: { input } }),
    })
    await response.text()
    this.status.textContent = response.ok ? 'Message persisted' : 'Message failed'
    this.dispatchEvent(new CustomEvent('chatkit.response.end', { detail: {} }))
  }
}
customElements.define('openai-chatkit', EditorialChatKit)
