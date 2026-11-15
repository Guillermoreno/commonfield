// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.resetModules();
});

test("the private owner entry route lands directly on native first-run setup", async () => {
  history.replaceState(null, "", "/bootstrap");
  document.body.innerHTML = '<div id="root"></div>';
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "authentication_required" }), {
          status: 401,
        }),
    ),
  );

  await import("../../../src/web/main.js");

  expect(
    await screen.findByRole("heading", {
      name: "Set up the first administrator",
    }),
  ).toBeTruthy();
  expect(screen.getByTestId("bootstrap-submit")).toBeTruthy();
});
