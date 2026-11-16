import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type StickyColor =
  | "yellow"
  | "pink"
  | "blue"
  | "green"
  | "orange"
  | "purple";
const colors: readonly StickyColor[] = [
  "yellow",
  "pink",
  "blue",
  "green",
  "orange",
  "purple",
];

type Props = Readonly<{
  anchor: { left: number; top: number };
  right: number;
  color: StickyColor;
  onClose: (restoreFocus: boolean) => void;
  onEdit: () => void;
  onMove: () => void;
  onColor: (color: StickyColor) => void;
}>;

/** A viewport-space menu: never inherit the canvas world's transform. */
export function StickyMenu({
  anchor,
  right,
  color,
  onClose,
  onEdit,
  onMove,
  onColor,
}: Props) {
  const bottomSheet =
    innerWidth <= 599 || (innerWidth <= 900 && innerHeight <= 500);
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [position, setPosition] = useState(anchor);
  useLayoutEffect(() => {
    const clamp = () => {
      const element = menu.current!;
      const rect = element.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const viewportRight = left + (viewport?.width ?? innerWidth);
      const usableRight = Math.min(right, viewportRight);
      setPosition({
        left: Math.max(
          left + 8,
          Math.min(anchor.left, usableRight - rect.width - 8),
        ),
        top: Math.max(
          top + 8,
          Math.min(
            anchor.top,
            top + (viewport?.height ?? innerHeight) - rect.height - 8,
          ),
        ),
      });
    };
    clamp();
    window.addEventListener("resize", clamp);
    window.visualViewport?.addEventListener("resize", clamp);
    window.visualViewport?.addEventListener("scroll", clamp);
    return () => {
      window.removeEventListener("resize", clamp);
      window.visualViewport?.removeEventListener("resize", clamp);
      window.visualViewport?.removeEventListener("scroll", clamp);
    };
  }, [anchor, right]);
  useLayoutEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  useLayoutEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !(event.target as Element).closest(".sticky-kebab")
      )
        close.current(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      event.stopPropagation();
      onClose(event.key === "Escape");
      return;
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    const active = items[index];
    const colorItems = items.filter(
      (item) => item.getAttribute("role") === "menuitemradio",
    );
    const colorIndex = colorItems.indexOf(active!);
    if (event.key === "ArrowRight" && colorIndex >= 0) {
      event.preventDefault();
      colorItems[(colorIndex + 1) % colorItems.length]?.focus();
      return;
    }
    if (event.key === "ArrowLeft" && colorIndex >= 0) {
      event.preventDefault();
      colorItems[
        (colorIndex - 1 + colorItems.length) % colorItems.length
      ]?.focus();
      return;
    }
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp")
      next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus();
  };
  return createPortal(
    <div
      ref={menu}
      role="menu"
      tabIndex={-1}
      aria-label="Sticky actions"
      className="sticky-menu"
      onKeyDown={keyDown}
      style={{ left: position.left, top: position.top }}
    >
      <button type="button" role="menuitem" tabIndex={-1} onClick={onEdit}>
        Edit note
      </button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={onMove}>
        Move note
      </button>
      <fieldset className="menu-colors">
        <legend className="sr-only">Note colour</legend>
        {colors.map((value) => (
          <button
            key={value}
            type="button"
            role="menuitemradio"
            aria-checked={color === value}
            tabIndex={-1}
            className={`menu-color swatch-${value}`}
            aria-label={`${value[0]!.toUpperCase()}${value.slice(1)} sticky color`}
            onClick={() => onColor(value)}
          >
            <span aria-hidden="true" />
            {value}
          </button>
        ))}
      </fieldset>
      {bottomSheet && (
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="sticky-menu-close"
          onClick={() => onClose(true)}
        >
          Close
        </button>
      )}
    </div>,
    document.querySelector("main")!,
  );
}
