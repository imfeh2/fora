import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<
  { children: ReactNode; fallback: (reset: () => void) => ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  reset = () => this.setState({ failed: false });

  render() {
    return this.state.failed
      ? this.props.fallback(this.reset)
      : this.props.children;
  }
}
