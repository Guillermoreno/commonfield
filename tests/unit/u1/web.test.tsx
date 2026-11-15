// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

afterEach(async () => {
  cleanup();
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
  }
  close() {}
}

test("mount-captured fetch uses the native global receiver", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  let calls = 0;
  const nativeLikeFetch = function (
    this: typeof globalThis,
    input: string | URL,
  ) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    calls += 1;
    const path = String(input);
    const body =
      path === "/api/session"
        ? { boardId: "board", csrf: "csrf" }
        : { id: "board", name: "Team board", stickies: [] };
    return Promise.resolve(new Response(JSON.stringify(body)));
  };
  vi.stubGlobal("fetch", nativeLikeFetch);

  // @ts-expect-error Vite test query isolates the module's singleton root.
  await import("../../../src/web/main.js?native-fetch-receiver");

  expect(await screen.findByTestId("canvas")).toBeTruthy();
  expect(calls).toBeGreaterThanOrEqual(2);
});

test("browser state completes bootstrap, login, save, remote update, and conflict recovery", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("crypto", {
    randomUUID: () => "00000000-0000-4000-8000-000000000099",
  });
  let mutation = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/session")
        return new Response(
          JSON.stringify({ code: "authentication_required" }),
          { status: 401 },
        );
      if (path === "/api/bootstrap")
        return new Response(JSON.stringify({ boardId: "board" }), {
          status: 201,
        });
      if (path === "/api/login")
        return new Response(
          JSON.stringify({ csrf: "csrf", boardId: "board" }),
          { status: 200 },
        );
      if (path === "/api/boards/board" && !init?.method)
        return new Response(JSON.stringify({ sticky: null }), { status: 200 });
      if (path.endsWith("/sticky")) {
        mutation += 1;
        if (mutation === 2)
          return new Response(
            JSON.stringify({
              code: "version_conflict",
              canonical: { id: "sticky", text: "remote", version: 2 },
            }),
            { status: 409 },
          );
        return new Response(
          JSON.stringify({ id: "sticky", text: "hello", version: 1 }),
          { status: 200 },
        );
      }
      return new Response("{}", {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  // @ts-expect-error Vite test query isolates the module's singleton root.
  await import("../../../src/web/main.js?bootstrap-flow");
  fireEvent.click(await screen.findByTestId("show-bootstrap"));
  expect(screen.queryByTestId("email")).toBeNull();
  expect(screen.getByTestId("display-name")).toBeTruthy();
  expect(screen.getByTestId("bootstrap-email")).toBeTruthy();
  expect(screen.getByTestId("bootstrap-password")).toBeTruthy();
  fireEvent.change(screen.getByTestId("display-name"), {
    target: { value: "Admin" },
  });
  fireEvent.change(screen.getByTestId("bootstrap-email"), {
    target: { value: "admin@example.test" },
  });
  fireEvent.change(screen.getByTestId("team-name"), {
    target: { value: "Team" },
  });
  fireEvent.change(screen.getByTestId("bootstrap-password"), {
    target: { value: "correct horse battery" },
  });
  fireEvent.submit(screen.getByTestId("bootstrap-submit").closest("form")!);
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "Workspace created",
    ),
  );
  expect(
    vi.mocked(fetch).mock.calls.find(([path]) => path === "/api/bootstrap")?.[1]
      ?.body,
  ).toBe(
    JSON.stringify({
      displayName: "Admin",
      email: "admin@example.test",
      teamName: "Team",
      password: "correct horse battery",
    }),
  );
  fireEvent.change(screen.getByTestId("email"), {
    target: { value: "admin@example.test" },
  });
  fireEvent.change(screen.getByTestId("password"), {
    target: { value: "correct horse battery" },
  });
  fireEvent.submit(screen.getByTestId("login-submit").closest("form")!);
  await screen.findByRole("heading", { name: "Team board" });
  fireEvent.change(screen.getByTestId("sticky-text"), {
    target: { value: "hello" },
  });
  fireEvent.submit(screen.getByTestId("save-sticky").closest("form")!);
  await waitFor(() =>
    expect(screen.getByTestId("version").textContent).toBe("1"),
  );
  await act(async () =>
    FakeWebSocket.instances.at(-1)!.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "sticky.committed",
          sticky: { id: "sticky", text: "remote", version: 2 },
        }),
      }),
    ),
  );
  expect(screen.getByTestId("version").textContent).toBe("2");
  fireEvent.change(screen.getByTestId("sticky-text"), {
    target: { value: "my draft" },
  });
  fireEvent.submit(screen.getByTestId("save-sticky").closest("form")!);
  await screen.findByText(/Conflict: your draft is preserved/);
  expect(document.activeElement).toBe(screen.getByTestId("sticky-text"));
  expect((screen.getByTestId("sticky-text") as HTMLTextAreaElement).value).toBe(
    "my draft",
  );
});

test("board exposes spatial tools, one-shot sticky placement, and zoom controls", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  let uuidSequence = 100;
  vi.stubGlobal("crypto", {
    randomUUID: vi.fn(() => {
      uuidSequence += 1;
      return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, "0")}`;
    }),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/session")
        return new Response(JSON.stringify({ boardId: "board", csrf: "csrf" }));
      if (path === "/api/boards/board")
        return new Response(
          JSON.stringify({ id: "board", name: "Team board", stickies: [] }),
        );
      if (String(init?.body).includes("preserve me")) {
        return new Response(
          JSON.stringify({
            code: "version_conflict",
            canonical: {
              id: "note-1",
              text: "remote canonical",
              x: 120,
              y: 80,
              version: 9,
            },
          }),
          { status: 409 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "note-1",
          text: "New sticky",
          x: 120,
          y: 80,
          version: 1,
          color: "yellow",
        }),
      );
    }),
  );
  // @ts-expect-error Vite test query isolates the module's singleton root.
  await import("../../../src/web/main.js?spatial-tools");
  expect(
    await screen.findByRole("toolbar", { name: "Board tools" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: /Select/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Hand/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Sticky/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Fit to content" })).toBeTruthy();
  const boardTitle = screen.getByRole("heading", { name: "Team board" });
  expect(boardTitle.classList.contains("board-title-pill")).toBe(true);
  expect(boardTitle.querySelector(".board-title-marker")).toBeTruthy();
  const palette = screen.getByRole("toolbar", { name: "Board tools" });
  expect(palette.classList.contains("floating-palette")).toBe(true);
  expect(palette.querySelectorAll("svg.tool-icon")).toHaveLength(3);
  expect(screen.getByText("Select", { exact: true }).className).toContain(
    "tool-label",
  );
  const navigation = screen.getByRole("group", { name: "Canvas navigation" });
  expect(navigation.classList.contains("canvas-navigation")).toBe(true);
  expect(navigation.querySelector(".zoom-divider")).toBeTruthy();
  expect(navigation.querySelectorAll("svg.tool-icon")).toHaveLength(3);
  expect(screen.queryByRole("group", { name: "Navigation input" })).toBeNull();
  expect(
    screen.getByText(/Wheel and trackpad gestures are detected automatically/),
  ).toBeTruthy();
  const labelledActions = Array.from(
    document.querySelectorAll("button"),
  ).filter((button) => button.textContent?.trim());
  expect(
    labelledActions.every(
      (button) =>
        button.querySelector("svg") || button.classList.contains("sticky-drag"),
    ),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Sticky/ }));
  const canvas = screen.getByTestId("canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 700,
    width: 1000,
    height: 700,
    toJSON: () => ({}),
  });
  fireEvent.pointerDown(canvas, {
    clientX: 320,
    clientY: 220,
  });
  const draft = document.querySelector("textarea.spatial-sticky")!;
  await waitFor(() => expect(document.activeElement).toBe(draft));
  fireEvent.pointerDown(draft);
  expect(draft.closest("article")?.getAttribute("aria-current")).toBe("true");
  const edgeNote = draft.closest("article") as HTMLElement;
  vi.spyOn(edgeNote, "getBoundingClientRect").mockReturnValue({
    x: 400,
    y: 8,
    top: 8,
    left: 400,
    right: 600,
    bottom: 208,
    width: 200,
    height: 200,
    toJSON: () => ({}),
  });
  fireEvent.pointerDown(edgeNote, { pointerType: "mouse" });
  fireEvent.click(screen.getByRole("button", { name: "Choose sticky color" }));
  expect(document.querySelector(".canvas-world .color-picker")).toBeNull();
  expect(document.querySelector("body > .color-picker")).toBeTruthy();
  expect(document.querySelector<HTMLElement>(".color-picker")?.style.top).toBe(
    "220px",
  );
  expect(
    screen.getByRole("button", { name: "Blue sticky color" }),
  ).toBeTruthy();
  expect(canvas.getAttribute("role")).toBe("application");
  expect(edgeNote.hasAttribute("tabindex")).toBe(false);
  expect(edgeNote.hasAttribute("role")).toBe(false);
  fireEvent.pointerDown(edgeNote, { pointerType: "mouse" });
  expect(edgeNote.getAttribute("aria-current")).toBe("true");
  expect(draft.closest("article")?.getAttribute("style")).toContain(
    "translate(400px, 250px)",
  );
  fireEvent.change(draft, { target: { value: "spatial unit note" } });
  fireEvent.blur(draft);
  await waitFor(() => expect(screen.getByText(/Saved version/)).toBeTruthy());
  const move = screen.getAllByRole("button", { name: /Move sticky/ }).at(-1)!;
  fireEvent.keyDown(move, { key: "ArrowRight" });
  fireEvent.keyDown(move, { key: "ArrowDown", shiftKey: true });
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  fireEvent.click(screen.getByRole("button", { name: "Fit to content" }));
  fireEvent.wheel(screen.getByTestId("canvas"), {
    deltaX: 8,
    deltaY: 12,
    timeStamp: 1,
  });
  const world = document.querySelector<HTMLElement>(".canvas-world")!;
  const beforeAnchoredZoom = world.style.transform;
  fireEvent.wheel(screen.getByTestId("canvas"), {
    clientX: 120,
    clientY: 80,
    deltaY: -100,
  });
  expect(world.style.transform).not.toBe(beforeAnchoredZoom);
  expect(world.style.transform).not.toContain("translate(0px, 0px)");
  const nativePan = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaX: 12,
    deltaY: 8,
  });
  expect(canvas.dispatchEvent(nativePan)).toBe(false);
  expect(nativePan.defaultPrevented).toBe(true);
  const nativePinch = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    deltaY: -80,
    clientX: 120,
    clientY: 80,
  });
  expect(canvas.dispatchEvent(nativePinch)).toBe(false);
  expect(nativePinch.defaultPrevented).toBe(true);
  const outsidePinch = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    deltaY: -80,
  });
  expect(document.body.dispatchEvent(outsidePinch)).toBe(true);
  expect(outsidePinch.defaultPrevented).toBe(false);
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    const gesture = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(gesture, {
      scale: { value: 1.2 },
      clientX: { value: 120 },
      clientY: { value: 80 },
    });
    expect(canvas.dispatchEvent(gesture)).toBe(false);
    expect(gesture.defaultPrevented).toBe(true);
  }
  const canvasElement = screen.getByTestId("canvas");
  const nativeWheel = new WheelEvent("wheel", {
    deltaX: 12,
    deltaY: 8,
    bubbles: true,
    cancelable: true,
  });
  expect(canvasElement.dispatchEvent(nativeWheel)).toBe(false);
  expect(nativeWheel.defaultPrevented).toBe(true);
  const outsideWheel = new WheelEvent("wheel", {
    deltaY: -40,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(outsideWheel);
  expect(outsideWheel.defaultPrevented).toBe(false);
  const zoomBeforeCtrlOverride =
    screen.getByLabelText("Zoom level").textContent;
  canvasElement.dispatchEvent(
    new WheelEvent("wheel", {
      deltaX: 20,
      deltaY: 10,
      bubbles: true,
      cancelable: true,
    }),
  );
  canvasElement.dispatchEvent(
    new WheelEvent("wheel", {
      ctrlKey: true,
      clientX: 100,
      clientY: 80,
      deltaY: -120,
      bubbles: true,
      cancelable: true,
    }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Zoom level").textContent).not.toBe(
      zoomBeforeCtrlOverride,
    ),
  );
  const safariGesture = new Event("gesturechange", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(safariGesture, "scale", { value: 1.2 });
  canvasElement.dispatchEvent(safariGesture);
  expect(safariGesture.defaultPrevented).toBe(true);

  const readCanvasScale = () =>
    Number(
      /scale\(([^)]+)\)/.exec(
        document.querySelector<HTMLElement>(".canvas-world")!.style.transform,
      )?.[1],
    );
  const safariBase = readCanvasScale();
  const safariStart = new Event("gesturestart", {
    bubbles: true,
    cancelable: true,
  });
  canvasElement.dispatchEvent(safariStart);
  const firstSafariChange = new Event("gesturechange", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(firstSafariChange, "scale", { value: 1.1 });
  canvasElement.dispatchEvent(firstSafariChange);
  await waitFor(() => expect(readCanvasScale()).toBeCloseTo(safariBase * 1.1));
  const secondSafariChange = new Event("gesturechange", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(secondSafariChange, "scale", { value: 1.2 });
  canvasElement.dispatchEvent(secondSafariChange);
  await waitFor(() => expect(readCanvasScale()).toBeCloseTo(safariBase * 1.2));
  expect(canvasElement.tabIndex).toBe(0);
  canvasElement.focus();
  fireEvent.keyDown(canvasElement, { key: "ArrowRight" });
  fireEvent.keyDown(window, { key: "n" });
  fireEvent.keyDown(window, { key: "Enter" });
  const discard = screen
    .getAllByRole("button", { name: "Discard draft" })
    .at(-1)!;
  expect(discard).toBeTruthy();
  fireEvent.click(discard);
  const committedEditor = document.querySelector<HTMLTextAreaElement>(
    "textarea.spatial-sticky",
  )!;
  fireEvent.change(committedEditor, { target: { value: "preserve me" } });
  fireEvent.blur(committedEditor);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Reconcile" })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reconcile" }));
  fireEvent.click(screen.getByRole("button", { name: "Retry local draft" }));
});

test("mobile sticky editing is explicit and cancel never sends the draft", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  vi.stubGlobal("innerWidth", 390);
  const viewportListeners = new Map<string, EventListener>();
  vi.stubGlobal("visualViewport", {
    height: 350,
    width: 390,
    offsetTop: 80,
    offsetLeft: 0,
    addEventListener: (type: string, listener: EventListener) =>
      viewportListeners.set(type, listener),
    removeEventListener: (type: string) => viewportListeners.delete(type),
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("crypto", { randomUUID: () => "mobile-op" });
  const requests: Array<{ path: string; init: RequestInit | undefined }> = [];
  let mobileCommit = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = String(input);
      requests.push({ path, init });
      if (path === "/api/session")
        return new Response(
          JSON.stringify({
            boardId: "board",
            csrf: "csrf",
            role: "administrator",
          }),
        );
      if (path === "/api/boards/board")
        return new Response(
          JSON.stringify({
            stickies: [
              {
                id: "note",
                text: "committed",
                x: 10,
                y: 20,
                version: 3,
                color: "yellow",
              },
            ],
          }),
        );
      if (path === "/api/boards/board/stickies/note") {
        mobileCommit += 1;
        if (mobileCommit === 1)
          return new Response(JSON.stringify({ code: "invalid_text" }), {
            status: 422,
          });
        if (mobileCommit === 2)
          return new Response(JSON.stringify({ code: "writer_unavailable" }), {
            status: 503,
          });
        if (mobileCommit === 3) throw new TypeError("network down");
        if (mobileCommit === 4)
          return new Response(
            JSON.stringify({
              code: "version_conflict",
              canonical: {
                id: "note",
                text: "remote",
                x: 10,
                y: 20,
                version: 4,
                color: "yellow",
              },
            }),
            { status: 409 },
          );
        return new Response(
          JSON.stringify({
            id: "note",
            text: "mobile draft",
            x: 10,
            y: 20,
            version: 5,
            color: "yellow",
          }),
        );
      }
      return new Response("{}", { status: 404 });
    }),
  );
  // @ts-expect-error Vite test query isolates the module's singleton root.
  await import("../../../src/web/main.js?mobile-editor");
  const note = await screen.findByRole("textbox", {
    name: /Sticky note committed/,
  });
  fireEvent.focus(note);
  const editor = await screen.findByRole("textbox", {
    name: "Edit sticky note",
  });
  expect(
    document.documentElement.style.getPropertyValue("--visual-viewport-top"),
  ).toBe("80px");
  expect(
    document.documentElement.style.getPropertyValue("--visual-viewport-width"),
  ).toBe("390px");
  expect(
    screen
      .getByRole("toolbar", { name: "Board tools", hidden: true })
      .hasAttribute("inert"),
  ).toBe(true);
  const commitButton = screen.getByRole("button", {
    name: "Commit mobile draft",
  });
  commitButton.focus();
  fireEvent.keyDown(commitButton, { key: "Tab" });
  expect(document.activeElement).toBe(editor);
  fireEvent.change(editor, { target: { value: "do not send" } });
  fireEvent.click(screen.getByRole("button", { name: "Discard mobile draft" }));
  expect(
    requests
      .filter(({ init }) => init?.method === "PATCH")
      .map(({ path }) => path),
  ).toEqual([]);
  expect(
    screen.getByRole("textbox", { name: /Sticky note committed/ }),
  ).toBeTruthy();

  fireEvent.focus(
    screen.getByRole("textbox", { name: /Sticky note committed/ }),
  );
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Edit sticky note" }),
    {
      target: { value: "" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Commit mobile draft" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "invalid_text",
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "Edit sticky note",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("");
  fireEvent.change(screen.getByRole("textbox", { name: "Edit sticky note" }), {
    target: { value: "mobile draft" },
  });
  for (const expectedError of [
    "writer_unavailable",
    "network_error",
    "version_conflict",
  ]) {
    fireEvent.click(
      screen.getByRole("button", { name: "Commit mobile draft" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(expectedError),
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: "Edit sticky note",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("mobile draft");
  }
  fireEvent.click(screen.getByRole("button", { name: "Commit mobile draft" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("textbox", { name: "Edit sticky note" }),
    ).toBeNull(),
  );
  await waitFor(() =>
    expect(
      requests.filter(
        ({ init }) =>
          init?.method === "PATCH" &&
          JSON.parse(String(init.body)).text === "mobile draft",
      ),
    ).toHaveLength(4),
  );
});

test.each([false, true])(
  "a create acknowledgement releases matching fields for remote commits while preserving a newer dirty draft (%s)",
  async (newerDirtyDraft) => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.resetModules();
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("crypto", { randomUUID: () => "local-create-id" });
    let resolveCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const mutations: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/session")
          return new Response(JSON.stringify({ boardId: "board", csrf: "csrf" }));
        if (path === "/api/boards/board")
          return new Response(JSON.stringify({ stickies: [] }));
        if (init?.method === "POST" || init?.method === "PATCH") {
          mutations.push({
            method: init.method,
            body: JSON.parse(String(init.body)),
          });
          return init.method === "POST"
            ? createResponse
            : new Promise<Response>(() => {});
        }
        return new Response("{}", { status: 404 });
      }),
    );
    const modulePath = `../../../src/web/main.js?create-remote-${newerDirtyDraft}`;
    await import(modulePath);
    fireEvent.click(await screen.findByRole("button", { name: /Sticky/ }));
    fireEvent.pointerDown(screen.getByTestId("canvas"));
    const editor = document.querySelector<HTMLTextAreaElement>(
      "textarea.spatial-sticky",
    )!;
    fireEvent.change(editor, { target: { value: "Creator text" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]!.method).toBe("POST");
    expect(mutations[0]!.body.operationKind).toBe("create");
    if (newerDirtyDraft) {
      fireEvent.change(editor, { target: { value: "Newer dirty draft" } });
      fireEvent.blur(editor);
    }
    await act(async () => {
      resolveCreate(
        new Response(
          JSON.stringify({
            ...mutations[0]!.body,
            id: "server-create-id",
            version: 1,
          }),
          { status: 201 },
        ),
      );
    });
    await screen.findByText("Saved version 1");
    await act(async () =>
      FakeWebSocket.instances.at(-1)!.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "sticky.committed",
            sticky: {
              id: "server-create-id",
              text: "Collaborator text",
              x: 320,
              y: 180,
              color: "blue",
              version: 2,
            },
          }),
        }),
      ),
    );
    const creatorEditor = document.querySelector<HTMLTextAreaElement>(
      "textarea.spatial-sticky",
    )!;
    expect(document.querySelectorAll("textarea.spatial-sticky")).toHaveLength(1);
    expect(creatorEditor.value).toBe(
      newerDirtyDraft ? "Newer dirty draft" : "Collaborator text",
    );
    expect(creatorEditor.closest("article")?.className).toContain("sticky-blue");
    expect(creatorEditor.closest("article")?.style.transform).toBe(
      "translate(320px, 180px)",
    );
    expect(screen.getByTestId("version").textContent).toBe("2");
  },
);

test("a first-create late acknowledgement remaps queued work to the server ID without losing the newer draft", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  vi.stubGlobal("innerWidth", 1024);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("crypto", { randomUUID: () => "local-draft-id" });
  let resolveCreate!: (response: Response) => void;
  const createResponse = new Promise<Response>((resolve) => {
    resolveCreate = resolve;
  });
  const mutations: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/session")
        return new Response(JSON.stringify({ boardId: "board", csrf: "csrf" }));
      if (path === "/api/boards/board")
        return new Response(JSON.stringify({ stickies: [] }));
      if (init?.method === "POST") {
        mutations.push({ path, body: JSON.parse(String(init.body)) });
        return createResponse;
      }
      if (init?.method === "PATCH") {
        mutations.push({ path, body: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify({
            id: "server-note-id",
            text: "Newer draft",
            x: 400,
            y: 250,
            version: 2,
            color: "yellow",
          }),
        );
      }
      return new Response("{}", { status: 404 });
    }),
  );
  // @ts-expect-error Vite test query isolates the module's singleton root.
  await import("../../../src/web/main.js?first-create-remap");
  fireEvent.click(await screen.findByRole("button", { name: /Sticky/ }));
  const canvas = screen.getByTestId("canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 700,
    width: 1000,
    height: 700,
    toJSON: () => ({}),
  });
  fireEvent.pointerDown(canvas, { clientX: 500, clientY: 350 });
  const editor = document.querySelector<HTMLTextAreaElement>(
    "textarea.spatial-sticky",
  )!;
  fireEvent.change(editor, { target: { value: "First draft" } });
  fireEvent.blur(editor);
  await waitFor(() => expect(mutations).toHaveLength(1));
  fireEvent.change(editor, { target: { value: "Newer draft" } });
  fireEvent.blur(editor);
  resolveCreate(
    new Response(
      JSON.stringify({
        id: "server-note-id",
        text: "First draft",
        x: 400,
        y: 250,
        version: 1,
        color: "yellow",
      }),
    ),
  );
  await waitFor(() => expect(mutations).toHaveLength(2));
  expect(mutations[1]!.path).toBe("/api/boards/board/stickies/server-note-id");
  expect(mutations[1]!.body.text).toBe("Newer draft");
  expect(document.querySelectorAll("textarea.spatial-sticky")).toHaveLength(1);
  expect(
    document.querySelector<HTMLTextAreaElement>("textarea.spatial-sticky")!
      .value,
  ).toBe("Newer draft");
});

test("remote text commits merge with local colour and position intents while their acknowledgements are in flight", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  vi.stubGlobal("innerWidth", 1024);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("crypto", { randomUUID: () => "field-intent-op" });
  const pending: Array<(response: Response) => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/session")
        return new Response(JSON.stringify({ boardId: "board", csrf: "csrf" }));
      if (path === "/api/boards/board")
        return new Response(
          JSON.stringify({
            stickies: [
              {
                id: "note",
                text: "Initial",
                x: 10,
                y: 20,
                version: 1,
                color: "yellow",
              },
            ],
          }),
        );
      if (
        path === "/api/boards/board/stickies/note" &&
        init?.method === "PATCH"
      )
        return new Promise<Response>((resolve) => pending.push(resolve));
      return new Response("{}", { status: 404 });
    }),
  );
  // @ts-expect-error Vite test query isolates the module's singleton root.
  await import("../../../src/web/main.js?remote-field-intents");
  const editor = await screen.findByRole("textbox", {
    name: /Sticky note Initial/,
  });
  fireEvent.pointerDown(editor, { pointerType: "touch" });
  fireEvent.click(screen.getByRole("button", { name: "Choose sticky color" }));
  fireEvent.click(screen.getByRole("button", { name: "Blue sticky color" }));
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () =>
    FakeWebSocket.instances.at(-1)!.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "sticky.committed",
          sticky: {
            id: "note",
            text: "Remote text",
            x: 10,
            y: 20,
            version: 2,
            color: "yellow",
          },
        }),
      }),
    ),
  );
  expect((editor as HTMLTextAreaElement).value).toBe("Remote text");
  expect(editor.closest("article")?.className).toContain("sticky-blue");
  pending.shift()!(
    new Response(
      JSON.stringify({
        id: "note",
        text: "Initial",
        x: 10,
        y: 20,
        version: 3,
        color: "blue",
      }),
    ),
  );
  await waitFor(() =>
    expect(editor.closest("article")?.className).toContain("sticky-blue"),
  );
  expect((editor as HTMLTextAreaElement).value).toBe("Remote text");

  const move = screen.getByRole("button", { name: /Move sticky Remote text/ });
  fireEvent.keyDown(move, { key: "ArrowRight" });
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () =>
    FakeWebSocket.instances.at(-1)!.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "sticky.committed",
          sticky: {
            id: "note",
            text: "New remote text",
            x: 10,
            y: 20,
            version: 4,
            color: "blue",
          },
        }),
      }),
    ),
  );
  expect(editor.closest("article")?.getAttribute("style")).toContain(
    "translate(20px, 20px)",
  );
  pending.shift()!(
    new Response(
      JSON.stringify({
        id: "note",
        text: "Remote text",
        x: 20,
        y: 20,
        version: 5,
        color: "blue",
      }),
    ),
  );
  await waitFor(() =>
    expect((editor as HTMLTextAreaElement).value).toBe("New remote text"),
  );
  expect(editor.closest("article")?.getAttribute("style")).toContain(
    "translate(20px, 20px)",
  );
});

test("a late save acknowledgement cannot overwrite a newer local draft", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  vi.stubGlobal("innerWidth", 1024);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("crypto", { randomUUID: () => "late-ack-op" });
  let resolveSave!: (response: Response) => void;
  const saveResponse = new Promise<Response>((resolve) => {
    resolveSave = resolve;
  });
  let saves = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/session")
        return new Response(JSON.stringify({ boardId: "board", csrf: "csrf" }));
      if (path === "/api/boards/board")
        return new Response(
          JSON.stringify({
            stickies: [
              {
                id: "note",
                text: "Initial",
                x: 10,
                y: 20,
                version: 1,
                color: "yellow",
              },
            ],
          }),
        );
      if (
        path === "/api/boards/board/stickies/note" &&
        init?.method === "PATCH"
      ) {
        saves += 1;
        if (saves === 1) return saveResponse;
        return new Response(
          JSON.stringify({
            id: "note",
            text: "Newer unsaved draft",
            x: 10,
            y: 20,
            version: 3,
            color: "yellow",
          }),
        );
      }
      return new Response("{}", { status: 404 });
    }),
  );
  // @ts-expect-error Vite test query isolates the module's singleton root.
  await import("../../../src/web/main.js?late-text-ack");
  const editor = await screen.findByRole("textbox", {
    name: /Sticky note Initial/,
  });
  fireEvent.change(editor, { target: { value: "First save" } });
  fireEvent.blur(editor);
  fireEvent.change(editor, { target: { value: "Newer unsaved draft" } });
  resolveSave(
    new Response(
      JSON.stringify({
        id: "note",
        text: "First save",
        x: 10,
        y: 20,
        version: 2,
        color: "yellow",
      }),
    ),
  );
  await waitFor(() =>
    expect((editor as HTMLTextAreaElement).value).toBe("Newer unsaved draft"),
  );
  await waitFor(() => expect(saves).toBe(2));
  await screen.findByText("Saved version 3");
});

test("a late colour acknowledgement cannot overwrite a newer local colour", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  vi.stubGlobal("innerWidth", 1024);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("crypto", { randomUUID: () => "late-colour-op" });
  let resolveBlue!: (response: Response) => void;
  const blueResponse = new Promise<Response>((resolve) => {
    resolveBlue = resolve;
  });
  let mutations = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/session")
        return new Response(JSON.stringify({ boardId: "board", csrf: "csrf" }));
      if (path === "/api/boards/board")
        return new Response(
          JSON.stringify({
            stickies: [
              {
                id: "note",
                text: "Initial",
                x: 10,
                y: 20,
                version: 1,
                color: "yellow",
              },
            ],
          }),
        );
      if (
        path === "/api/boards/board/stickies/note" &&
        init?.method === "PATCH"
      ) {
        mutations += 1;
        if (mutations === 1) return blueResponse;
        return new Response(
          JSON.stringify({
            id: "note",
            text: "Initial",
            x: 10,
            y: 20,
            version: 3,
            color: "green",
          }),
        );
      }
      return new Response("{}", { status: 404 });
    }),
  );
  // @ts-expect-error Vite test query isolates the module's singleton root.
  await import("../../../src/web/main.js?late-colour-ack");
  const editor = await screen.findByRole("textbox", {
    name: /Sticky note Initial/,
  });
  fireEvent.pointerDown(editor);
  fireEvent.click(screen.getByRole("button", { name: "Choose sticky color" }));
  fireEvent.click(screen.getByRole("button", { name: "Blue sticky color" }));
  fireEvent.click(screen.getByRole("button", { name: "Green sticky color" }));
  resolveBlue(
    new Response(
      JSON.stringify({
        id: "note",
        text: "Initial",
        x: 10,
        y: 20,
        version: 2,
        color: "blue",
      }),
    ),
  );
  await waitFor(() =>
    expect(editor.closest("article")?.className).toContain("sticky-green"),
  );
});

test("restores invitation inventory and CSRF, then uses canonical IDs for add, send, and revoke", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const requests: Array<{ path: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = String(input);
      requests.push({ path, init });
      if (path === "/api/session")
        return new Response(
          JSON.stringify({
            csrf: "restored-csrf",
            boardId: "board",
            teamId: "team",
            role: "administrator",
            deliveryAvailable: true,
            members: [
              {
                id: "admin",
                email: "admin@example.test",
                role: "administrator",
              },
            ],
            invitations: [
              {
                invitationId: "existing-invitation",
                email: "existing@example.test",
                role: "member",
                lifecycleStatus: "pending",
                deliveryStatus: "unsent",
                invitationUrl:
                  "http://127.0.0.1:4412/invitations/accept#token=existing",
              },
            ],
          }),
        );
      if (path === "/api/boards/board")
        return new Response(
          JSON.stringify({ id: "board", name: "Team board", stickies: [] }),
        );
      if (path === "/api/teams/team/invitations")
        return new Response(
          JSON.stringify({
            invitationId: "new-invitation",
            email: "new@example.test",
            role: "member",
            lifecycleStatus: "pending",
            deliveryStatus: "unsent",
            invitationUrl: "http://127.0.0.1:4412/invitations/accept#token=new",
          }),
          { status: 201 },
        );
      if (path === "/api/invitations/new-invitation/delivery-attempts")
        return new Response(JSON.stringify({ deliveryStatus: "sent" }));
      if (path === "/api/invitations/new-invitation/revoke")
        return new Response(null, { status: 204 });
      return new Response("{}", {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const invitationModule = "../../../src/web/main.js?invitation-restore";
  await import(invitationModule);
  await screen.findByText("existing@example.test");
  fireEvent.click(screen.getByRole("button", { name: "Invite a member" }));
  const composer = screen.getByRole("dialog", { name: "Invite to Team board" });
  expect(composer.tagName).toBe("DIALOG");
  expect(composer).toHaveProperty("open", true);
  const recipientForm = screen.getByRole("form", {
    name: "Add invitation recipient",
  });
  expect(recipientForm).toBe(composer.querySelector("form"));
  fireEvent.change(screen.getByTestId("invite-email"), {
    target: { value: "new@example.test" },
  });
  fireEvent.submit(screen.getByTestId("invite-submit").closest("form")!);
  expect(await screen.findAllByText("new@example.test")).toHaveLength(2);
  expect(requests.some(({ path }) => path.endsWith("delivery-attempts"))).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
  await waitFor(() =>
    expect(
      requests.some(
        ({ path }) =>
          path === "/api/invitations/new-invitation/delivery-attempts",
      ),
    ).toBe(true),
  );
  const send = requests.find(({ path }) => path.endsWith("delivery-attempts"));
  expect(send?.init?.headers).toMatchObject({
    "x-csrf-token": "restored-csrf",
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Revoke new@example.test" }),
  );
  await waitFor(() =>
    expect(
      requests.some(
        ({ path }) => path === "/api/invitations/new-invitation/revoke",
      ),
    ).toBe(true),
  );
});
