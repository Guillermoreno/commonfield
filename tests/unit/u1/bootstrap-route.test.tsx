// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Root } from "react-dom/client";

const mountedRoots: Root[] = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) root.unmount();
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

  mountedRoots.push((await import("../../../src/web/main.js")).appRoot);

  expect(
    await screen.findByRole("heading", {
      name: "Set up the first administrator",
    }),
  ).toBeTruthy();
  expect(screen.getByTestId("bootstrap-submit")).toBeTruthy();
});
