import type { AppBuilderApi } from "../preload/api";

declare global {
  interface Window {
    appBuilder: AppBuilderApi;
  }
}
