import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

/**
 * A crashed popup must still say something and offer a way out — a blank panel
 * over a wallet reads as "my coins are gone". The error itself is never logged
 * with any RPC payload attached.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { message: null };
  }

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : 'Unexpected error.' };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo) {
    // Message only: component stacks can quote rendered values.
    console.error('BTQ Wallet UI error:', error.message);
  }

  override render() {
    if (this.state.message === null) return this.props.children;
    return (
      <div className="app">
        <main className="app-body">
          <h1>Something broke</h1>
          <p className="lede">
            The popup hit an unexpected error. Your vault is untouched — it stays encrypted in
            extension storage.
          </p>
          <p className="error" role="alert">
            {this.state.message}
          </p>
          <button
            type="button"
            className="btn btn-primary mt-16"
            onClick={() => window.location.reload()}
          >
            Reload the wallet
          </button>
        </main>
      </div>
    );
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
