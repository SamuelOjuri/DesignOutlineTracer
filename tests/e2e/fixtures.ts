import { test as base, expect } from "@playwright/test";

interface NetworkGuard {
  submissions: unknown[];
  expectedConsoleErrors: string[];
}

export const test = base.extend<{ networkGuard: NetworkGuard }>({
  networkGuard: [async ({ context, page, baseURL }, use) => {
    const submissions: unknown[] = [];
    const unexpectedRequests: string[] = [];
    const runtimeErrors: string[] = [];
    const expectedConsoleErrors: string[] = [];
    const origin = new URL(baseURL!).origin;
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") runtimeErrors.push(message.text());
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.hostname === "nispvuhrvlvjsvfcelsp.supabase.co" && url.pathname === "/functions/v1/send-project-email") {
        if (request.method() === "POST") submissions.push(request.postDataJSON());
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: {
            "access-control-allow-origin": origin,
            "access-control-allow-headers": "authorization, apikey, content-type",
            "access-control-allow-methods": "POST, OPTIONS",
          },
          body: JSON.stringify({ success: true }),
        });
      } else if (url.origin === origin && ["GET", "HEAD"].includes(request.method()) && !url.pathname.startsWith("/api/")) {
        await route.continue();
      } else {
        unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
        await route.abort("blockedbyclient");
      }
    });
    await use({ submissions, expectedConsoleErrors });
    expect(unexpectedRequests, "No backend, Gemini, or unmocked external requests").toEqual([]);
    expect(runtimeErrors.filter((message) => !expectedConsoleErrors.includes(message)), "No unexpected browser errors").toEqual([]);
  }, { auto: true }],
});

export { expect } from "@playwright/test";