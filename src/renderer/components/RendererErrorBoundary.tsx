import { Component, type ErrorInfo, type ReactNode } from "react";
import { appIconUrl } from "../appIcon";
import { Button } from "./ui/button";

interface RendererErrorBoundaryState {
  error: Error | null;
}

export class RendererErrorBoundary extends Component<{ children: ReactNode }, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RendererErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("AppBuilder renderer error", error.message, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="grid h-full place-items-center bg-background p-8 text-foreground">
        <section className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
          <div className="flex items-center gap-3">
            <img alt="" aria-hidden="true" className="size-12 shrink-0 drop-shadow-md" src={appIconUrl} />
            <div>
              <p className="text-xs font-semibold tracking-wider text-destructive uppercase">Renderer error</p>
              <h1 className="mt-1 text-xl font-semibold">AppBuilder hit an unexpected display error</h1>
            </div>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Your local projects and conversations were not reset. Restart the app, or export a support bundle for diagnosis.</p>
          <details className="mt-4 rounded-md bg-muted p-3 text-xs"><summary>Technical detail</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap">{this.state.error.message}</pre></details>
          <div className="mt-5 flex gap-2">
            <Button onClick={() => void window.appBuilder.app.restart()}>Restart</Button>
            <Button onClick={() => void window.appBuilder.bootstrap.exportDiagnostics()} variant="outline">Export diagnostics</Button>
          </div>
        </section>
      </main>
    );
  }
}
