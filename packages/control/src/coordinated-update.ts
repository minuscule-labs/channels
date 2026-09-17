import type { LocalServiceStatus } from "./service-lifecycle.ts";
import { requestServiceRestart, type ServiceRestartResult } from "./service-restart.ts";
import {
  installationDataDirectoryId,
  installUpdate,
  type UpdateCheck,
} from "./updater.ts";

interface UpdateServicePort {
  status(): Promise<LocalServiceStatus>;
  processId(): Promise<number | undefined>;
  waitForStop(previousPid: number, timeoutMs?: number): Promise<LocalServiceStatus>;
  start(): Promise<LocalServiceStatus>;
}

type InstalledUpdate = { previousVersion: string; version: string };

export interface CoordinatedUpdateResult extends InstalledUpdate {
  serviceRestarted: boolean;
}

export async function coordinateConversationsUpdate(
  update: UpdateCheck,
  options: {
    dataDirectory: string;
    service?: UpdateServicePort;
    install?: typeof installUpdate;
    requestQuiesce?: typeof requestServiceRestart;
  },
): Promise<CoordinatedUpdateResult> {
  const install = options.install ?? installUpdate;
  const requestQuiesce = options.requestQuiesce ?? requestServiceRestart;
  const serviceWasRunning = Boolean((await options.service?.status())?.running);
  let serviceNeedsRestart = false;
  let serviceProcessId: number | undefined;
  let installed: InstalledUpdate;
  try {
    installed = await install(update, {
      ...(serviceWasRunning
        ? { allowedServiceDataDirectoryId: installationDataDirectoryId(options.dataDirectory) }
        : {}),
      async beforeInstall() {
        if (!serviceWasRunning || !options.service) return;
        const previousPid = await options.service.processId();
        if (previousPid === undefined) {
          throw new Error("MinuChannels service state could not be verified for update");
        }
        serviceProcessId = previousPid;
        const deadline = performance.now() + 135_000;
        const remaining = (): number => Math.max(1, Math.floor(deadline - performance.now()));
        const preparation: ServiceRestartResult = await requestQuiesce(options.dataDirectory, {
          action: "stop_for_update",
          waitForIdle: true,
          timeoutMs: remaining(),
          onUpdateStopClaimed() { serviceNeedsRestart = true; },
        });
        if (preparation.status !== "ready") {
          throw new Error("MinuChannels could not become ready for update");
        }
        // Custom test ports may return directly instead of exercising the file handshake.
        serviceNeedsRestart = true;
        await options.service.waitForStop(previousPid, remaining());
      },
    });
  } catch (error) {
    if (serviceNeedsRestart && options.service) {
      try {
        if (serviceProcessId !== undefined) await options.service.waitForStop(serviceProcessId);
        await options.service.start();
      } catch {
        throw new Error(
          "The update did not complete and the background service could not restart. "
          + "Run `minu-channels start` after repairing the installation.",
        );
      }
    }
    throw error;
  }

  if (serviceNeedsRestart && options.service) {
    try {
      await options.service.start();
    } catch {
      throw new Error(
        `Updated MinuChannels to ${installed.version}, but the background service did not restart. `
        + "Run `minu-channels start`.",
      );
    }
  }
  return { ...installed, serviceRestarted: serviceNeedsRestart };
}
