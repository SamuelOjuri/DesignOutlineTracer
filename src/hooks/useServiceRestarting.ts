import { useSyncExternalStore } from "react";

export interface ServiceRestartSource {
  serviceRestarting?: () => boolean;
  subscribeServiceRestart?: (listener: () => void) => () => void;
}

const noSubscription = () => () => undefined;
const notRestarting = () => false;

/** Whether a request from this client is waiting for the API to finish restarting. */
export function useServiceRestarting(client: ServiceRestartSource): boolean {
  return useSyncExternalStore(client.subscribeServiceRestart ?? noSubscription, client.serviceRestarting ?? notRestarting);
}
