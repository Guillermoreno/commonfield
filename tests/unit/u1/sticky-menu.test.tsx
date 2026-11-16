// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { StickyMenu } from "../../../src/web/sticky-menu.js";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
function menu(anchor = { left: 1000, top: 1000 }, right = 320) {
  document.body.innerHTML = "<main></main>";
  vi.stubGlobal("innerHeight", 390);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 224,
    height: 247,
    left: 0,
    top: 0,
    right: 224,
    bottom: 247,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const onClose = vi.fn(),
    onEdit = vi.fn(),
    onMove = vi.fn(),
    onColor = vi.fn();
  render(
    <StickyMenu
      anchor={anchor}
      right={right}
      color="yellow"
      onClose={onClose}
      onEdit={onEdit}
      onMove={onMove}
      onColor={onColor}
    />,
    { container: document.querySelector("main")! },
  );
  return { onClose, onEdit, onMove, onColor };
}
test("measured menu clamps right and bottom and keeps native menu semantics", () => {
  const actions = menu();
  const element = screen.getByRole("menu");
  expect(element.tabIndex).toBe(-1);
  expect(
    screen.getByRole("group", { name: "Note colour" }).tagName,
  ).toBe("FIELDSET");
  expect(element.style.left).toBe("88px");
  expect(element.style.top).toBe("135px");
  const edit = screen.getByRole("menuitem", { name: "Edit note" });
  expect(document.activeElement).toBe(edit);
  fireEvent.keyDown(edit, { key: "ArrowUp" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitemradio", { name: "Purple sticky color" }),
  );
  fireEvent.keyDown(element, { key: "Home" });
  expect(document.activeElement).toBe(edit);
  fireEvent.keyDown(element, { key: "End" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitemradio", { name: "Purple sticky color" }),
  );
  fireEvent.keyDown(element, { key: "ArrowRight" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitemradio", { name: "Yellow sticky color" }),
  );
  fireEvent.keyDown(element, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitemradio", { name: "Purple sticky color" }),
  );
  fireEvent.keyDown(element, { key: "x" });
  fireEvent.keyDown(element, { key: "Tab" });
  expect(actions.onClose).toHaveBeenCalledWith(false);
  fireEvent.click(edit);
  fireEvent.click(screen.getByRole("menuitem", { name: "Move note" }));
  expect(actions.onEdit).toHaveBeenCalledOnce();
  expect(actions.onMove).toHaveBeenCalledOnce();
});
test("menu clamps negative coordinates and distinguishes outside dismissal from Escape focus restore", () => {
  const actions = menu({ left: -900, top: -900 });
  const element = screen.getByRole("menu");
  expect(element.style.left).toBe("8px");
  expect(element.style.top).toBe("8px");
  fireEvent.pointerDown(element);
  expect(actions.onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  expect(actions.onClose).toHaveBeenCalledWith(false);
  fireEvent.keyDown(element, { key: "Escape" });
  expect(actions.onClose).toHaveBeenCalledWith(true);
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: "Green sticky color" }),
  );
  expect(actions.onColor).toHaveBeenCalledWith("green");
  expect(
    screen
      .getByRole("menuitemradio", { name: "Yellow sticky color" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});
test("menu clamps to the visual viewport and excludes destructive actions", () => {
  vi.stubGlobal("visualViewport", {
    offsetLeft: 120,
    offsetTop: 20,
    width: 260,
    height: 350,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  menu({ left: 900, top: 20 }, 500);
  const element = screen.getByRole("menu");
  expect(element.style.left).toBe("148px");
  expect(element.style.top).toBe("28px");
  expect(screen.queryByText(/duplicate/i)).toBeNull();
  expect(screen.queryByText(/delete/i)).toBeNull();
});
test("rerenders keep menu focus while dismissal uses the current callback", () => {
  document.body.innerHTML = "<main></main>";
  vi.stubGlobal("innerHeight", 900);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 224,
    height: 247,
    left: 0,
    top: 0,
    right: 224,
    bottom: 247,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const firstClose = vi.fn();
  const currentClose = vi.fn();
  const props = {
    anchor: { left: 40, top: 40 },
    right: 800,
    color: "yellow" as const,
    onEdit: vi.fn(),
    onMove: vi.fn(),
    onColor: vi.fn(),
  };
  const view = render(<StickyMenu {...props} onClose={firstClose} />, {
    container: document.querySelector("main")!,
  });
  const edit = screen.getByRole("menuitem", { name: "Edit note" });
  const move = screen.getByRole("menuitem", { name: "Move note" });
  expect(document.activeElement).toBe(edit);
  fireEvent.keyDown(edit, { key: "ArrowDown" });
  expect(document.activeElement).toBe(move);

  view.rerender(<StickyMenu {...props} onClose={currentClose} />);
  expect(document.activeElement).toBe(move);
  fireEvent.pointerDown(document.body);
  expect(firstClose).not.toHaveBeenCalled();
  expect(currentClose).toHaveBeenCalledWith(false);
  fireEvent.keyDown(move, { key: "Escape" });
  expect(currentClose).toHaveBeenLastCalledWith(true);
});
