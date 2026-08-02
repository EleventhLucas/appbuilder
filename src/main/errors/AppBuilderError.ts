import type { AppErrorDto } from "../../shared/types";

export class AppBuilderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: string | null = null,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AppBuilderError";
  }

  toDto(): AppErrorDto {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

export function errorDto(error: unknown, fallbackCode = "UNEXPECTED_ERROR"): AppErrorDto {
  if (error instanceof AppBuilderError) return error.toDto();
  if (error && typeof error === "object" && error.constructor?.name === "CodexRpcError") {
    const rpc = error as Error & { code?: unknown; data?: unknown };
    return {
      code: "CODEX_RPC_ERROR",
      message: "Codex rejected the operation.",
      details: JSON.stringify({
        rpcCode: typeof rpc.code === "number" ? rpc.code : null,
        hasRpcData: rpc.data !== undefined,
      }),
      retryable: rpc.code === -32001,
    };
  }
  const nodeCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
  return {
    code: nodeCode ? `SYSTEM_${nodeCode}` : fallbackCode,
    message: nodeCode ? "The operation could not be completed because of a system error." : "The operation could not be completed.",
    details: nodeCode ? `System code: ${nodeCode}` : null,
    retryable: false,
  };
}
