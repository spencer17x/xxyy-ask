const sources = ["docs.xxyy.io / Getting started", "docs.xxyy.io / Account setup"];

export default function HomePage() {
  return (
    <main className="appShell">
      <aside className="sidebar" aria-label="Knowledge base status">
        <div>
          <p className="eyebrow">XXYY Ask</p>
          <h1>Ask XXYY</h1>
        </div>
        <div className="statusBlock">
          <div>
            <span className="label">Knowledge base</span>
            <strong>docs.xxyy.io</strong>
          </div>
          <div>
            <span className="label">Workflow</span>
            <strong>LangGraph agent</strong>
          </div>
          <div>
            <span className="label">Answer mode</span>
            <strong>Cited support</strong>
          </div>
        </div>
      </aside>

      <section className="chatSurface" aria-label="Ask XXYY chat">
        <div className="chatHeader">
          <div>
            <span className="label">Support thread</span>
            <h2>Documentation assistant</h2>
          </div>
          <span className="pill">Ready</span>
        </div>

        <div className="thread">
          <div className="message user">Where should I start if I am new to XXYY?</div>
          <div className="message assistant">
            Start with the setup guide, then confirm your account settings before
            continuing to the integration steps.
            <div className="sourceRow">
              {sources.map((source) => (
                <span key={source}>{source}</span>
              ))}
            </div>
          </div>
        </div>

        <form className="composer">
          <input aria-label="Ask a question" placeholder="Ask about XXYY docs..." />
          <button type="submit">Send</button>
        </form>
      </section>
    </main>
  );
}
