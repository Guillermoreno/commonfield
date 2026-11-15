import { describe, expect, it } from "vitest";
import { invitationAddIntent } from "../../../src/web/invitation-composer-policy.js";

describe("invitation composer keyboard policy", () => {
  it("adds only from the email field outside IME composition", () => {
    expect(
      invitationAddIntent({ key: "Enter", field: "email", composing: false }),
    ).toBe(true);
    expect(
      invitationAddIntent({ key: "Enter", field: "email", composing: true }),
    ).toBe(false);
    expect(
      invitationAddIntent({ key: "Enter", field: "role", composing: false }),
    ).toBe(false);
    expect(
      invitationAddIntent({ key: "Space", field: "email", composing: false }),
    ).toBe(false);
  });
});
