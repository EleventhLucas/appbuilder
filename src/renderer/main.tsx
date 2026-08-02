import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DesktopRoot } from "./DesktopRoot";
import { RendererErrorBoundary } from "./components/RendererErrorBoundary";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("AppBuilder root element is missing.");

const content = window.appBuilder ? (
  <StrictMode>
    <RendererErrorBoundary>
      <DesktopRoot />
    </RendererErrorBoundary>
  </StrictMode>
) : (
  <main className="grid h-full place-items-center bg-background p-8 text-foreground">
    <div className="max-w-lg rounded-2xl border bg-card p-6 shadow-lg">
      <h1 className="text-lg font-semibold">AppBuilder could not initialize</h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        The secure desktop bridge failed to load. Restart AppBuilder and check the launch terminal for preload errors.
      </p>
    </div>
  </main>
);

createRoot(rootElement).render(
  <div className="window-shell">
    <div aria-hidden="true" className="window-drag-region" />
    <div className="window-content">
      {content}
    </div>
  </div>,
);
