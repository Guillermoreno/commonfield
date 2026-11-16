// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Root } from "react-dom/client";
import { readFileSync } from "node:fs";

const mountedRoots: Root[] = [];

class Socket {
  static latest: Socket;
  onmessage?: (event: MessageEvent) => void;
  constructor() {
    Socket.latest = this;
  }
  close() {}
}
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}
afterEach(async () => {
  for (const root of mountedRoots.splice(0)) root.unmount();
  cleanup();
  await new Promise<void>((r) => setImmediate(r));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
async function board(width = 1280, height = width === 844 ? 390 : 900, recipients = 0) {
  vi.resetModules();
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("innerHeight", height);
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal("WebSocket", Socket);
  document.body.innerHTML = '<div id="root"></div>';
  const mutations: Record<string, unknown>[] = [];
  let invitationsAdded = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/session")
        return Response.json({
          boardId: "board",
          teamId: "team",
          csrf: "csrf",
          role: "administrator",
          invitations: Array.from({ length: recipients }, (_, index) => ({
            invitationId: `invitation-${index}`,
            email: `reserved-${index}@example.invalid`,
            role: "member",
            lifecycle: "pending",
            invitationUrl: `http://localhost/invitations/accept#token=${index}`,
          })),
        });
      if (init?.method === "PATCH") {
        const value = JSON.parse(String(init.body));
        mutations.push(value);
        return Response.json({ ...value, id: "one", version: 2 });
      }
      if (url === "/api/teams/team/invitations" && init?.method === "POST") {
        invitationsAdded += 1;
        const value = JSON.parse(String(init.body));
        return Response.json({
          invitationId: `invitation-${invitationsAdded}`,
          email: value.email,
          role: value.role,
          lifecycle: "pending",
          invitationUrl: `http://localhost/invitations/accept#token=${invitationsAdded}`,
        });
      }
      return Response.json({
        stickies: [
          {
            id: "one",
            text: "First note",
            x: 40,
            y: 50,
            color: "yellow",
            version: 1,
          },
          {
            id: "two",
            text: "Other note",
            x: 300,
            y: 50,
            color: "pink",
            version: 1,
          },
        ],
      });
    }),
  );
  await act(async () => {
    mountedRoots.push((await import("../../../src/web/main.js")).appRoot);
  });
  await screen.findByLabelText("Sticky note First note");
  return mutations;
}
test("desktop invitation drawer is nonmodal and does not contain keyboard focus", async () => {
  await board();
  fireEvent.click(screen.getByRole("button", { name: "Invite a member" }));
  const panel = screen.getByRole("dialog", { name: "Invite to Team board" });
  expect(panel.getAttribute("aria-modal")).toBe("false");
  expect(
    document
      .querySelector(".board-shell")
      ?.classList.contains("has-invitation-drawer"),
  ).toBe(true);
  const close = within(panel).getByRole("button", { name: "Back to board" });
  close.focus();
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Escape" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Invite a member" }),
    ),
  );
});
test("a stale close restoration cannot steal focus from a reopened menu", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  await board();
  const text = screen.getByLabelText("Sticky note First note");
  fireEvent.contextMenu(text, { clientX: 50, clientY: 60 });
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: "Blue sticky color" }),
  );
  const kebab = screen.getByRole("button", {
    name: "Sticky actions First note",
  });
  fireEvent.click(kebab);
  const edit = screen.getByRole("menuitem", { name: "Edit note" });
  const move = screen.getByRole("menuitem", { name: "Move note" });
  expect(document.activeElement).toBe(edit);
  act(() => {
    for (const callback of frames.splice(0)) callback(0);
  });
  expect(document.activeElement).toBe(edit);
  fireEvent.keyDown(edit, { key: "ArrowDown" });
  expect(document.activeElement).toBe(move);
});
test.each([390, 844])(
  "phone invitation screen contains focus and makes the board inert (%i)",
  async (width) => {
    await board(width);
    fireEvent.click(screen.getByRole("button", { name: "Invite a member" }));
    const panel = screen.getByRole("dialog", { name: "Invite to Team board" });
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByTestId("canvas").hasAttribute("inert")).toBe(true);
    const close = within(panel).getByRole("button", { name: "Back to board" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      within(panel).getByRole("button", {
        name: "Manage members and invitations",
      }),
    );
  },
);
test("short phone composer scrolls its populated body while header and footer stay pinned", async () => {
  vi.stubGlobal("visualViewport", {
    height: 315,
    width: 320,
    offsetTop: 0,
    offsetLeft: 0,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  await board(320, 900);
  fireEvent.click(screen.getByRole("button", { name: "Invite a member" }));
  const panel = screen.getByRole("dialog", { name: "Invite to Team board" });
  const form = within(panel).getByRole("form", {
    name: "Add invitation recipient",
  });
  const body = form.querySelector<HTMLElement>(".composer-scroll")!;
  const header = form.querySelector<HTMLElement>(".composer-header")!;
  const footer = form.querySelector<HTMLElement>(".composer-footer")!;
  expect(panel.classList.contains("is-short-viewport")).toBe(true);
  for (let index = 0; index < 8; index += 1) {
    fireEvent.change(screen.getByTestId("invite-email"), {
      target: { value: `reserved-${index}@example.invalid` },
    });
    fireEvent.submit(form);
    await within(body).findAllByText(`reserved-${index}@example.invalid`);
  }
  expect(body.previousElementSibling).toBe(header);
  expect(body.nextElementSibling).toBe(footer);
  expect(body.querySelectorAll(".composer-recipient")).toHaveLength(8);
  expect(within(body).getAllByRole("button", { name: "Copy" })).toHaveLength(8);
  const css = readFileSync("src/web/style.css", "utf8");
  expect(css).toMatch(/\.composer-recipients\s*\{[^}]*flex:\s*1 1 auto;[^}]*overflow:\s*auto;/s);
  expect(css).toMatch(/\.is-short-viewport \.composer-scroll\s*\{[^}]*overflow-y:\s*auto;/s);
  expect(css).toMatch(/\.is-short-viewport \.composer-recipients\s*\{[^}]*flex:\s*none;[^}]*overflow:\s*visible;/s);
  expect(css).toMatch(
    /\.invitation-composer-form\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/s,
  );
  expect(css).toMatch(
    /\.is-short-viewport \.composer-footer \.composer-transport-hint,[\s\S]*?\.is-short-viewport \.composer-footer \.composer-enter-hint,[\s\S]*?\.is-short-viewport \.composer-footer \.composer-management-access\s*\{[^}]*display:\s*none;/s,
  );
});
test("normal phone height keeps the recipient list as the isolated scroller", async () => {
  let resize: (() => void) | undefined;
  const viewport = {
    height: 900,
    width: 320,
    offsetTop: 0,
    offsetLeft: 0,
    addEventListener: vi.fn((type: string, callback: () => void) => {
      if (type === "resize") resize = callback;
    }),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("visualViewport", viewport);
  await board(320, 900);
  fireEvent.click(screen.getByRole("button", { name: "Invite a member" }));
  const panel = screen.getByRole("dialog", { name: "Invite to Team board" });
  expect(panel.classList.contains("is-short-viewport")).toBe(false);
  viewport.height = 315;
  act(() => resize?.());
  expect(panel.classList.contains("is-short-viewport")).toBe(true);
  viewport.height = 900;
  act(() => resize?.());
  expect(panel.classList.contains("is-short-viewport")).toBe(false);
});
test("phone native focus waits for tap resolution and a drag never opens the editor", async () => {
  await board(320, 900);
  const text = screen.getByLabelText("Sticky note First note");
  const canvas = screen.getByTestId("canvas");
  fireEvent.pointerDown(text, { button: 0, pointerId: 4, clientX: 60, clientY: 70 });
  text.focus();
  expect(screen.queryByRole("dialog", { name: "Mobile sticky editor" })).toBeNull();
  fireEvent.pointerMove(canvas, { pointerId: 4, clientX: 90, clientY: 100 });
  fireEvent.pointerUp(canvas, { pointerId: 4 });
  fireEvent.click(text);
  expect(screen.queryByRole("dialog", { name: "Mobile sticky editor" })).toBeNull();
  fireEvent.click(text);
  expect(
    screen.getByRole("dialog", { name: "Mobile sticky editor" }),
  ).toBeTruthy();
});
test("press move on note text waits for threshold, commits on release and suppresses editing", async () => {
  const mutations = await board();
  const text = screen.getByLabelText("Sticky note First note");
  fireEvent.pointerDown(text, { button: 0, clientX: 60, clientY: 70 });
  text.focus();
  fireEvent.pointerMove(screen.getByTestId("canvas"), {
    clientX: 62,
    clientY: 71,
  });
  expect(text.closest("article")?.style.transform).toBe(
    "translate(40px, 50px)",
  );
  fireEvent.pointerMove(screen.getByTestId("canvas"), {
    clientX: 90,
    clientY: 100,
  });
  expect(text.closest("article")?.style.transform).toBe(
    "translate(70px, 80px)",
  );
  expect(mutations).toHaveLength(0);
  fireEvent.pointerUp(screen.getByTestId("canvas"));
  fireEvent.click(text);
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0]).toMatchObject({
    x: 70,
    y: 80,
    operationKind: "position",
  });
  expect(document.activeElement).not.toBe(text);
  fireEvent.pointerDown(text, { button: 0, clientX: 90, clientY: 100 });
  text.focus();
  fireEvent.pointerMove(screen.getByTestId("canvas"), {
    clientX: 100,
    clientY: 100,
  });
  fireEvent.pointerUp(screen.getByTestId("canvas"));
  await waitFor(() => expect(mutations).toHaveLength(2));
  expect(mutations[1]).toMatchObject({
    x: 80,
    y: 80,
    operationKind: "position",
  });
});
test("four CSS pixels starts a drag", async () => {
  const mutations = await board();
  const text = screen.getByLabelText("Sticky note First note");
  fireEvent.pointerDown(text, {
    button: 0,
    pointerId: 7,
    clientX: 60,
    clientY: 70,
  });
  fireEvent.pointerMove(screen.getByTestId("canvas"), {
    pointerId: 7,
    clientX: 64,
    clientY: 70,
  });
  fireEvent.pointerUp(screen.getByTestId("canvas"), { pointerId: 7 });
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0]).toMatchObject({ x: 44, y: 50 });
});

test("unrelated pointers cannot move or finish the active gesture", async () => {
  const mutations = await board();
  const canvas = screen.getByTestId("canvas");
  const text = screen.getByLabelText("Sticky note First note");
  fireEvent.pointerDown(text, {
    button: 0,
    pointerId: 11,
    clientX: 60,
    clientY: 70,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 12,
    clientX: 100,
    clientY: 110,
  });
  fireEvent.pointerUp(canvas, { pointerId: 12 });
  expect(text.closest("article")?.style.transform).toBe(
    "translate(40px, 50px)",
  );
  fireEvent.pointerMove(canvas, {
    pointerId: 11,
    clientX: 90,
    clientY: 100,
  });
  fireEvent.pointerUp(canvas, { pointerId: 11 });
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0]).toMatchObject({ x: 70, y: 80 });
});
test("pointer cancellation restores position without committing", async () => {
  const mutations = await board();
  const text = screen.getByLabelText("Sticky note First note");
  fireEvent.pointerDown(text, { button: 0, clientX: 60, clientY: 70 });
  fireEvent.pointerMove(screen.getByTestId("canvas"), {
    clientX: 90,
    clientY: 100,
  });
  fireEvent.pointerCancel(screen.getByTestId("canvas"));
  expect(text.closest("article")?.style.transform).toBe(
    "translate(40px, 50px)",
  );
  expect(mutations).toHaveLength(0);
});
test("right click and kebab share exact note menu, keyboard movement and durable colour", async () => {
  const mutations = await board();
  const text = screen.getByLabelText("Sticky note First note");
  const context = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 50,
    clientY: 60,
  });
  act(() => {
    text.dispatchEvent(context);
  });
  expect(context.defaultPrevented).toBe(true);
  const menu = screen.getByRole("menu", { name: "Sticky actions" });
  expect(menu.closest(".canvas-world")).toBeNull();
  expect(menu.closest("main")).not.toBeNull();
  expect(
    screen.queryByRole("button", { name: "Choose sticky color" }),
  ).toBeNull();
  fireEvent.click(
    within(menu).getByRole("menuitemradio", { name: "Blue sticky color" }),
  );
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0]).toMatchObject({ color: "blue", operationKind: "color" });
  const kebab = screen.getByRole("button", {
    name: "Sticky actions First note",
  });
  fireEvent.click(kebab);
  const edit = screen.getByRole("menuitem", { name: "Edit note" });
  await waitFor(() => expect(document.activeElement).toBe(edit));
  fireEvent.keyDown(edit, { key: "ArrowDown" });
  const move = screen.getByRole("menuitem", { name: "Move note" });
  expect(document.activeElement).toBe(move);
  fireEvent.click(move);
  fireEvent.keyDown(kebab, { key: "ArrowRight" });
  fireEvent.keyDown(kebab, { key: "Enter" });
  await waitFor(() => expect(mutations).toHaveLength(2));
  expect(mutations[1]).toMatchObject({ x: 50, operationKind: "position" });
  fireEvent.keyDown(kebab, { key: "F10", shiftKey: true });
  expect(screen.getByRole("menu")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(kebab));
});

test.each(["Enter", " "])(
  "keyboard Move commits once only when placed with %s",
  async (placeKey) => {
    const mutations = await board();
    const kebab = screen.getByRole("button", {
      name: "Sticky actions First note",
    });
    fireEvent.click(kebab);
    fireEvent.click(screen.getByRole("menuitem", { name: "Move note" }));
    fireEvent.keyDown(kebab, { key: "ArrowRight" });
    fireEvent.keyDown(kebab, { key: "ArrowDown", shiftKey: true });
    expect(mutations).toHaveLength(0);
    fireEvent.keyDown(kebab, { key: placeKey, code: placeKey === " " ? "Space" : "Enter" });
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toMatchObject({ x: 50, y: 51, operationKind: "position" });
    expect(screen.queryByRole("menu")).toBeNull();
  },
);
test("M on a focused note enters provisional keyboard move without stealing typed text", async () => {
  const mutations = await board();
  const kebab = screen.getByRole("button", { name: "Sticky actions First note" });
  kebab.focus();
  fireEvent.keyDown(kebab, { key: "m" });
  fireEvent.keyDown(kebab, { key: "ArrowRight" });
  expect(screen.getByLabelText("Sticky note First note").closest("article")?.style.transform).toBe("translate(50px, 50px)");
  expect(mutations).toHaveLength(0);
  fireEvent.keyDown(kebab, { key: "Escape" });
  const textarea = screen.getByLabelText("Sticky note First note");
  fireEvent.keyDown(textarea, { key: "m" });
  fireEvent.keyDown(textarea, { key: "ArrowRight" });
  expect(textarea.closest("article")?.style.transform).toBe("translate(40px, 50px)");
  expect(mutations).toHaveLength(0);
});

test("keyboard Move Escape restores its origin without persistence", async () => {
  const mutations = await board();
  const kebab = screen.getByRole("button", {
    name: "Sticky actions First note",
  });
  fireEvent.click(kebab);
  fireEvent.click(screen.getByRole("menuitem", { name: "Move note" }));
  fireEvent.keyDown(kebab, { key: "ArrowRight" });
  expect(
    screen.getByLabelText("Sticky note First note").closest("article")?.style
      .transform,
  ).toBe("translate(50px, 50px)");
  fireEvent.keyDown(kebab, { key: "Escape" });
  expect(
    screen.getByLabelText("Sticky note First note").closest("article")?.style
      .transform,
  ).toBe("translate(40px, 50px)");
  expect(mutations).toHaveLength(0);
});

test("Down opens the kebab menu and Escape restores the exact textarea invoker", async () => {
  await board();
  const kebab = screen.getByRole("button", {
    name: "Sticky actions First note",
  });
  kebab.focus();
  fireEvent.keyDown(kebab, { key: "ArrowDown" });
  expect(screen.getByRole("menu")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(kebab));

  const text = screen.getByLabelText("Sticky note First note");
  text.focus();
  fireEvent.keyDown(text, { key: "F10", shiftKey: true });
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(text));
});

test("remote text during a drag cannot reset its local position intent", async () => {
  const mutations = await board();
  const text = screen.getByLabelText("Sticky note First note");
  fireEvent.pointerDown(text, { button: 0, clientX: 60, clientY: 70 });
  fireEvent.pointerMove(screen.getByTestId("canvas"), {
    clientX: 90,
    clientY: 100,
  });
  act(() =>
    Socket.latest.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "sticky.committed",
          sticky: {
            id: "one",
            text: "Remote text",
            x: 40,
            y: 50,
            color: "yellow",
            version: 2,
          },
        }),
      }),
    ),
  );
  expect(text.closest("article")?.style.transform).toBe(
    "translate(70px, 80px)",
  );
  expect((text as HTMLTextAreaElement).value).toBe("Remote text");
  fireEvent.pointerUp(screen.getByTestId("canvas"));
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0]).toMatchObject({
    x: 70,
    y: 80,
    text: "Remote text",
    operationKind: "position",
  });
  await waitFor(() =>
    expect(text.closest("article")?.style.transform).toBe(
      "translate(70px, 80px)",
    ),
  );
});

test("dirty text survives remote text while a simultaneous drag is cancelled", async () => {
  const mutations = await board();
  const text = screen.getByLabelText(
    "Sticky note First note",
  ) as HTMLTextAreaElement;
  text.focus();
  fireEvent.change(text, { target: { value: "Local dirty draft" } });
  fireEvent.blur(text);
  fireEvent.pointerDown(text, { button: 0, clientX: 60, clientY: 70 });
  fireEvent.pointerMove(screen.getByTestId("canvas"), {
    clientX: 90,
    clientY: 100,
  });
  act(() =>
    Socket.latest.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "sticky.committed",
          sticky: {
            id: "one",
            text: "Remote competing text",
            x: 40,
            y: 50,
            color: "yellow",
            version: 2,
          },
        }),
      }),
    ),
  );
  fireEvent.pointerCancel(screen.getByTestId("canvas"));
  expect(text.value).toBe("Local dirty draft");
  expect(text.closest("article")?.style.transform).toBe(
    "translate(40px, 50px)",
  );
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0]).toMatchObject({
    text: "Local dirty draft",
    operationKind: "text",
  });
});
test("a position conflict retains local position and truthful failure status", async () => {
  await board();
  const text = screen.getByLabelText("Sticky note First note");
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", originalFetch); // App intentionally captures fetch on mount.
  vi.mocked(originalFetch).mockImplementation(async () =>
    Response.json(
      {
        code: "version_conflict",
        canonical: {
          id: "one",
          text: "Remote text",
          x: 40,
          y: 50,
          version: 2,
          color: "yellow",
        },
      },
      { status: 409 },
    ),
  );
  fireEvent.pointerDown(text, { button: 0, clientX: 60, clientY: 70 });
  fireEvent.pointerMove(screen.getByTestId("canvas"), {
    clientX: 90,
    clientY: 100,
  });
  fireEvent.pointerUp(screen.getByTestId("canvas"));
  await screen.findByText("Conflict: your draft is preserved.");
  expect(text.closest("article")?.style.transform).toBe(
    "translate(70px, 80px)",
  );
  expect(screen.queryByText(/Saved version/)).toBeNull();
});

test("secondary press on a phone note cannot focus it before the context menu", async () => {
  await board(390);
  const text = screen.getByLabelText("Sticky note First note");
  expect(
    fireEvent.pointerDown(text, { button: 2, clientX: 60, clientY: 70 }),
  ).toBe(false);
  expect(
    screen.queryByRole("dialog", { name: "Mobile sticky editor" }),
  ).toBeNull();
  fireEvent.contextMenu(text);
  expect(screen.getByRole("menu", { name: "Sticky actions" })).toBeTruthy();
});

test("zoomed drag quantizes its position to the durable quarter-unit protocol", async () => {
  const mutations = await board();
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  const text = screen.getByLabelText("Sticky note First note");
  fireEvent.pointerDown(text, { button: 0, clientX: 60, clientY: 70 });
  fireEvent.pointerMove(screen.getByTestId("canvas"), {
    clientX: 90,
    clientY: 100,
  });
  fireEvent.pointerUp(screen.getByTestId("canvas"));
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0]).toMatchObject({
    x: 67.25,
    y: 77.25,
    operationKind: "position",
  });
});

test("selected notes use action blue while keyboard focus keeps focus blue", () => {
  const css = readFileSync("src/web/style.css", "utf8");
  expect(css).toMatch(
    /\.sticky-frame\[aria-current="true"\]\s*\{[^}]*outline:\s*2px solid var\(--brand-action\);/s,
  );
  expect(css).toMatch(
    /button:focus-visible,[\s\S]*?textarea:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\);/s,
  );
});
