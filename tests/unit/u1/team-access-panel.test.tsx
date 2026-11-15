// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamAccessPanel } from "../../../src/web/team-access-panel.js";

it("distinguishes capture and SMTP history without relabeling unknown attempts", () => {
  render(
    <TeamAccessPanel
      members={[]}
      invitations={[
        {
          ...invitations[0]!,
          id: "capture",
          delivery: "sent",
          transport: "local_capture",
        },
        { ...invitations[0]!, id: "smtp", delivery: "sent", transport: "smtp" },
        { ...invitations[0]!, id: "unknown", delivery: "sent" },
      ]}
      deliveryTransport="smtp"
      onSend={vi.fn()}
      onCopy={vi.fn()}
      onRevoke={vi.fn()}
    />,
  );
  expect(screen.getByText("Captured locally (not emailed)")).toBeTruthy();
  expect(screen.getByText("SMTP accepted (not inbox confirmed)")).toBeTruthy();
  expect(
    screen.getByText("Transport accepted (historical transport unknown)"),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "SMTP delivery enabled; acceptance does not confirm inbox delivery.",
    ),
  ).toBeTruthy();
});

afterEach(() => cleanup());

const members = [
  {
    id: "member-1",
    email: "admin@example.test",
    role: "administrator" as const,
  },
  { id: "member-2", email: "member@example.test", role: "member" as const },
];
const invitations = [
  {
    id: "inv-1",
    email: "queued@example.test",
    role: "member" as const,
    lifecycle: "pending" as const,
    delivery: "not_requested" as const,
    url: "http://127.0.0.1:4412/invitations/accept#token=a",
  },
  {
    id: "inv-2",
    email: "failed@example.test",
    role: "administrator" as const,
    lifecycle: "pending" as const,
    delivery: "failed" as const,
    url: "http://127.0.0.1:4412/invitations/accept#token=b",
  },
  {
    id: "inv-3",
    email: "uncertain@example.test",
    role: "member" as const,
    lifecycle: "pending" as const,
    delivery: "uncertain" as const,
    url: "http://127.0.0.1:4412/invitations/accept#token=c",
  },
];

describe("responsive members and invitations panel", () => {
  it("renders compact member and invitation rows with complete links", () => {
    const { container } = render(
      <TeamAccessPanel
        members={members}
        invitations={invitations}
        onSend={vi.fn()}
        onRevoke={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(container.firstElementChild?.className).toContain(
      "team-access-panel",
    );
    expect(screen.getByText("admin@example.test")).toBeTruthy();
    expect(screen.getByText("queued@example.test")).toBeTruthy();
    expect(screen.getByDisplayValue(invitations[0]!.url)).toBeTruthy();
  });

  it("exposes Send, Retry, and warned uncertain resend actions", () => {
    const onSend = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <TeamAccessPanel
        members={members}
        invitations={invitations}
        onSend={onSend}
        onRevoke={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Send queued@example.test" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry failed@example.test" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Resend uncertain@example.test" }),
    );
    expect(onSend.mock.calls).toEqual([
      ["inv-1", false],
      ["inv-2", false],
      ["inv-3", true],
    ]);
  });

  it("supports copy and revoke per pending invitation", () => {
    const onCopy = vi.fn();
    const onRevoke = vi.fn();
    render(
      <TeamAccessPanel
        members={members}
        invitations={invitations}
        onSend={vi.fn()}
        onRevoke={onRevoke}
        onCopy={onCopy}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Copy link for queued@example.test" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke queued@example.test" }),
    );
    expect(onCopy).toHaveBeenCalledWith(invitations[0]!.url);
    expect(onRevoke).toHaveBeenCalledWith("inv-1");
  });

  it("exposes pending state, prevents duplicate delivery, and reports a failed request", async () => {
    let rejectAttempt!: (reason: Error) => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectAttempt = reject;
        }),
    );
    render(
      <TeamAccessPanel
        members={members}
        invitations={invitations.slice(0, 1)}
        onSend={onSend}
        onRevoke={vi.fn()}
        onCopy={vi.fn()}
      />,
    );

    const send = screen.getByRole("button", {
      name: "Send queued@example.test",
    });
    fireEvent.click(send);
    expect(
      (
        screen.getByRole("button", {
          name: "Sending queued@example.test",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Sending queued@example.test" }),
    );
    expect(onSend).toHaveBeenCalledTimes(1);

    rejectAttempt(new Error("delivery temporarily unavailable"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "delivery temporarily unavailable",
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Send queued@example.test",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });

  it("reports revoke progress and leaves the row actionable after failure", async () => {
    const onRevoke = vi.fn(async () => {
      throw new Error("revoke rejected");
    });
    render(
      <TeamAccessPanel
        members={members}
        invitations={invitations.slice(0, 1)}
        onSend={vi.fn()}
        onRevoke={onRevoke}
        onCopy={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke queued@example.test" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "revoke rejected",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Revoke queued@example.test",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("disables delivery with a clear configuration reason while preserving copy", () => {
    const onCopy = vi.fn();
    render(
      <TeamAccessPanel
        members={members}
        invitations={invitations.slice(0, 1)}
        deliveryAvailable={false}
        deliveryUnavailableReason="Local SMTP is not configured"
        onSend={vi.fn()}
        onRevoke={vi.fn()}
        onCopy={onCopy}
      />,
    );
    const send = screen.getByRole("button", {
      name: "Send queued@example.test",
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByText("Local SMTP is not configured")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Copy link for queued@example.test" }),
    );
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it("keeps earlier invitations visible without inventing a redisclosable link", () => {
    render(
      <TeamAccessPanel
        members={members}
        invitations={[{ ...invitations[0]!, url: "" }]}
        onSend={vi.fn()}
        onRevoke={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Link unavailable for this earlier invitation"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copy link/ })).toBeNull();
  });
});
