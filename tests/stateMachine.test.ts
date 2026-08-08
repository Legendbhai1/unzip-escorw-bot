// State machine tests are now in financial.test.ts alongside all other integration tests.
// This file is kept for backward compatibility but all tests are consolidated.

import { describe, it, expect } from "vitest";
import { canTransition, DISPUTABLE_STATES, TERMINAL_STATES, ACTIVE_STATES } from "../src/lib/stateMachine.js";
import type { DealStatus } from "@prisma/client";

// These are pure logic tests — no database needed.
// They verify the state machine handles AWAITING_FUNDING (not AWAITING_DEPOSIT).

describe("State Machine (pure logic)", () => {
  it("AWAITING_FUNDING is in ACTIVE_STATES", () => {
    expect(ACTIVE_STATES.has("AWAITING_FUNDING")).toBe(true);
  });

  it("AWAITING_DEPOSIT is NOT a valid state anymore", () => {
    expect(canTransition("CREATED", "AWAITING_DEPOSIT" as any, "SYSTEM")).toBeNull();
    expect(ACTIVE_STATES.has("AWAITING_DEPOSIT" as any)).toBe(false);
  });

  it("EXPIRED is a terminal state", () => {
    expect(TERMINAL_STATES.has("EXPIRED")).toBe(true);
  });

  it("RELEASE_PENDING -> COMPLETED (not RELEASED) for normal flow", () => {
    expect(canTransition("RELEASE_PENDING", "COMPLETED", "SYSTEM")).not.toBeNull();
  });

  it("RELEASE_PENDING -> DISPUTED is valid", () => {
    expect(canTransition("RELEASE_PENDING", "DISPUTED", "BUYER")).not.toBeNull();
    expect(canTransition("RELEASE_PENDING", "DISPUTED", "SELLER")).not.toBeNull();
  });
});
