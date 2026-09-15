import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) {
    // eslint-disable-next-line no-console
    console.log('[ErrorBoundary]', err?.message, err?.stack?.split('\n').slice(0, 6).join(' | '), info?.componentStack?.split('\n').slice(0, 4).join(' | '));
  }
  render() {
    if (this.state.err) {
      return (
        <div className="p-6">
          <div className="rounded-xl border border-red-300 bg-red-50 dark:bg-red-500/10 p-4 text-[12.5px] text-red-700 dark:text-red-300 font-mono whitespace-pre-wrap">
            <div className="font-bold mb-2">Render error</div>
            {String(this.state.err?.message || this.state.err)}
            {'\n\n'}
            {String(this.state.err?.stack || '').split('\n').slice(0, 8).join('\n')}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
