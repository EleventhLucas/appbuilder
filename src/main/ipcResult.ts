import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { errorDto } from "./errors/AppBuilderError";

let errorReporter: ((channel: string, error: ReturnType<typeof errorDto>) => void) | null = null;

export function setIpcErrorReporter(reporter: (channel: string, error: ReturnType<typeof errorDto>) => void): void {
  errorReporter = reporter;
}

export function handleIpc(
  channel: string,
  // IPC is the runtime validation boundary, so individual handlers validate their own arguments.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown | Promise<unknown>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, value: await listener(event, ...args) };
    } catch (error) {
      const dto = errorDto(error);
      errorReporter?.(channel, dto);
      return { ok: false, error: dto };
    }
  });
}
