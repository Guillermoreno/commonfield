import { describe, expect, it, vi } from "vitest";
import { GenerationDeliveryRegistry } from "../../../src/collaboration/generation-delivery.js";

describe("generation-aware delivery drain", () => {
  it("rejects non-advancing generations and ignores a loss report for another generation", () => {
    const registry = new GenerationDeliveryRegistry();
    registry.activate(3n);
    registry.lose(2n);
    expect(registry.currentGeneration()).toBe(3n);
    expect(() => registry.activate(2n)).toThrow("generation_must_advance");
  });
  it("acknowledges and broadcasts only while the committed generation remains current", () => {
    const registry = new GenerationDeliveryRegistry();
    registry.activate(4n);
    const send = vi.fn();
    const subscription = registry.subscribe(4n, send);
    expect(registry.deliver(4n, "committed", () => send("ack"))).toBe(true);
    expect(send).toHaveBeenCalledWith("ack");
    expect(subscription.active).toBe(true);
  });

  it("cancels unsent acknowledgement/broadcast and permanently invalidates stale subscriptions on loss", () => {
    const registry = new GenerationDeliveryRegistry();
    registry.activate(7n);
    const send = vi.fn();
    const stale = registry.subscribe(7n, send);
    registry.lose(7n);
    registry.activate(8n);
    expect(registry.deliver(7n, "stale", () => send("ack"))).toBe(false);
    expect(stale.active).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(registry.subscribe(7n, send).active).toBe(false);
  });

  it("unsubscribes an active delivery handle and ignores an unknown handle", () => {
    const registry = new GenerationDeliveryRegistry();
    registry.activate(9n);
    const send = vi.fn();
    const active = registry.subscribe(9n, send);
    registry.unsubscribe(active);
    expect(active.active).toBe(false);
    expect(registry.deliver(9n, "committed", vi.fn())).toBe(true);
    expect(send).not.toHaveBeenCalled();
    registry.unsubscribe({ generation: 9n, active: true });
  });
});
