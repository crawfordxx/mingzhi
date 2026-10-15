/** 渲染出错时只替换工作区（不让整页白屏），给出原因和「重新载入」 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State { error?: Error }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('工作台渲染出错', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="boot crash" role="alert">
        <b>这一块没能显示出来</b>
        <span>{error.message || '未知错误'}</span>
        <button type="button" className="btn btn-k" onClick={() => window.location.reload()}>重新载入</button>
      </div>
    );
  }
}
