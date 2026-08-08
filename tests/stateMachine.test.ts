import { describe, it, expect } from "vitest";
import { canTransition, DISPUTABLE_STATES, TERMINAL_STATES, ACTIVE_STATES } from "../src/lib/stateMachine.js";
import type { DealStatus } from "@prisma/client";

// These tests are pure logic — no database needed.

describe("State Machine", () => {
  describe("dispute allowed states", () => {
    it("dispute allowed from FUNDED, IN_PROGRESS, DELIVERED, RELEASE_PENDING", () => {
      for (const state of ["FUNDED", "IN_PROGRESS", "DELIVERED", "RELEASE_PENDING"] as const) {
        expect(DISPUTABLE_STATES.has(state)).toBe(true);
      }
    });

    it("dispute NOT allowed from CREATED, JOINED, AWAITING_DEPOSIT, COMPLETED, CANCELLED, REFUNDED", () => {
      for (const state of ["CREATED", "JOINED", "AWAITING_DEPOSIT", "COMPLETED", "CANCELLED", "REFUNDED", "DISPUTED", "UNDER_REVIEW", "RELEASED"] as const) {
        expect(DISPUTABLE_STATES.has(state)).toBe(false);
      }
    });
  });

  describe("terminal states block all transitions", () => {
    for (const state of [...TERMINAL_STATES] as DealStatus[]) {
      it(`${state} should block all outgoing transitions`, () => {
        expect(canTransition(state, "FUNDED", "BUYER")).toBeNull();
        expect(canTransition(state, "DISPUTED", "SELLER")).toBeNull();
        expect(canTransition(state, "JOINED", "SELLER")).toBeNull();
        expect(canTransition(state, "CANCELLED", "BUYER")).toBeNull();
        expect(canTransition(state, "RELEASE_PENDING", "BUYER")).toBeNull();
      });
    }
  });

  describe("happy path transitions", () => {
    const happyPath: Array<[DealStatus, DealStatus, "BUYER" | "SELLER" | "SYSTEM" | "ADMIN"]> = [
      ["CREATED", "JOINED", "SELLER"],
      ["JOINED", "AWAITING_DEPOSIT", "SYSTEM"],
      ["AWAITING_DEPOSIT", "FUNDED", "SYSTEM"],
      ["FUNDED", "IN_PROGRESS", "SYSTEM"],
      ["IN_PROGRESS", "DELIVERED", "SELLER"],
      ["DELIVERED", "RELEASE_PENDING", "BUYER"],
      ["RELEASE_PENDING", "RELEASED", "SYSTEM"],
      ["RELEASED", "COMPLETED", "SYSTEM"],
    ];

    for (const [from, to, by] of happyPath) {
      it(`${from} -> ${to} by ${by}`, () => {
        expect(canTransition(from, to, by)).not.toBeNull();
      });
    }
  });

  describe("invalid transitions are blocked", () => {
    const invalids: Array<[DealStatus, DealStatus, "BUYER" | "SELLER" | "SYSTEM" | "ADMIN"]> = [
      ["CREATED", "FUNDED", "SYSTEM"],      // can't skip JOINED
      ["JOINED", "DELIVERED", "SELLER"],     // can't skip funding
      ["AWAITING_DEPOSIT", "DISPUTED", "BUYER"], // no funds to dispute
      ["FUNDED", "CANCELLED", "BUYER"],     // can't cancel after funding
      ["FUNDED", "CANCELLED", "SELLER"],    // can't cancel after funding
      ["COMPLETED", "DISPUTED", "BUYER"],    // already done
      ["CANCELLED", "JOINED", "SELLER"],    // terminal
      ["REFUNDED", "RELEASED", "ADMIN"],    // already refunded
    ];

    for (const [from, to, by] of invalids) {
      it(`${from} -> ${to} by ${by} should be blocked`, () => {
        expect(canTransition(from, to, by)).toBeNull();
      });
    }
  });

  describe("dispute transitions", () => {
    it("BUYER can dispute from FUNDED, IN_PROGRESS, DELIVERED, RELEASE_PENDING", () => {
      expect(canTransition("FUNDED", "DISPUTED", "BUYER")).not.toBeNull();
      expect(canTransition("IN_PROGRESS", "DISPUTED", "BUYER")).not.toBeNull();
      expect(canTransition("DELIVERED", "DISPUTED", "BUYER")).not.toBeNull();
      expect(canTransition("RELEASE_PENDING", "DISPUTED", "BUYER")).not.toBeNull();
    });

    it("SELLER can dispute from FUNDED, IN_PROGRESS, RELEASE_PENDING (not DELIVERED)", () => {
      expect(canTransition("FUNDED", "DISPUTED", "SELLER")).not.toBeNull();
      expect(canTransition("IN_PROGRESS", "DISPUTED", "SELLER")).not.toBeNull();
      expect(canTransition("RELEASE_PENDING", "DISPUTED", "SELLER")).not.toBeNull();
    });

    it("ADMIN resolves to UNDER_REVIEW -> RELEASED or REFUNDED", () => {
      expect(canTransition("DISPUTED", "UNDER_REVIEW", "ADMIN")).not.toBeNull();
      expect(canTransition("UNDER_REVIEW", "RELEASED", "ADMIN")).not.toBeNull();
      expect(canTransition("UNDER_REVIEW", "REFUNDED", "ADMIN")).not.toBeNull();
    });

    it("REFUNDED can complete", () => {
      expect(canTransition("REFUNDED", "COMPLETED", "SYSTEM")).not.toBeNull();
    });
  });

  describe("cancel transitions (pre-funded only)", () => {
    it("can cancel from CREATED, JOINED, AWAITING_DEPOSIT", () => {
      expect(canTransition("CREATED", "CANCELLED", "BUYER")).not.toBeNull();
      expect(canTransition("JOINED", "CANCELLED", "BUYER")).not.toBeNull();
      expect(canTransition("JOINED", "CANCELLED", "SELLER")).not.toBeNull();
      expect(canTransition("AWAITING_DEPOSIT", "CANCELLED", "BUYER")).not.toBeNull();
      expect(canTransition("AWAITING_DEPOSIT", "CANCELLED", "SELLER")).not.toBeNull();
    });

    it("cannot cancel from FUNDED onwards", () => {
      for (const state of ["FUNDED", "IN_PROGRESS", "DELIVERED", "RELEASE_PENDING", "DISPUTED", "UNDER_REVIEW", "RELEASED", "COMPLETED", "REFUNDED"] as const) {
        expect(canTransition(state, "CANCELLED", "BUYER")).toBeNull();
        expect(canTransition(state, "CANCELLED", "SELLER")).toBeNull();
      }
    });
  });

  describe("active states set", () => {
    it("includes all non-terminal states", () => {
      for (const state of ACTIVE_STATES) {
        expect(TERMINAL_STATES.has(state)).toBe(false);
      }
    });

    it("terminal states are not active", () => {
      for (const state of TERMINAL_STATES) {
        expect(ACTIVE_STATES.has(state)).toBe(false);
      }
    });
  });

  describe("seller can deliver from FUNDED directly", () => {
    it("FUNDED -> DELIVERED by SELLER is valid", () => {
      expect(canTransition("FUNDED", "DELIVERED", "SELLER")).not.toBeNull();
    });
  });
});
