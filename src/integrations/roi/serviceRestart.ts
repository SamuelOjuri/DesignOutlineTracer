/** The API answers with these codes while a redeployed instance takes over durable storage. */
export const SERVICE_RESTART_CODES: ReadonlySet<string> = new Set(["storage_unavailable", "storage_starting"]);
export const SERVICE_RESTART_RETRY_WINDOW_MS = 60_000;
export const SERVICE_RESTART_MESSAGE = "The service is restarting after an update.";
export const SERVICE_RESTART_RETRYING = `${SERVICE_RESTART_MESSAGE} Retrying automatically...`;
