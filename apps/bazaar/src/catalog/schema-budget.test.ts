import { describe, it, expect } from "vitest";
import { budgetClientSchema, DEFAULT_SCHEMA_BUDGET } from "./schema-budget.js";

describe("budgetClientSchema", () => {
  it("accepts an absent schema (nothing to compile)", () => {
    expect(budgetClientSchema(undefined)).toEqual({ ok: true });
    expect(budgetClientSchema(null)).toEqual({ ok: true });
  });

  it("accepts a normal discovery schema", () => {
    const schema = {
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: { city: { type: "string", description: "The city to price a forecast for" } },
          required: ["city"],
        },
      },
    };
    expect(budgetClientSchema(schema)).toEqual({ ok: true });
  });

  it("refuses a catastrophic-backtracking `pattern` on its presence, without executing it", () => {
    const r = budgetClientSchema({ type: "string", pattern: "^(a+)+$" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("pattern");
  });

  it("refuses `patternProperties`", () => {
    const r = budgetClientSchema({ type: "object", patternProperties: { "^(a+)+$": { type: "string" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("patternProperties");
  });

  it("refuses an oversized schema", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 4000; i++) properties[`field_${i}`] = { type: "string", description: "x".repeat(16) };
    const r = budgetClientSchema({ type: "object", properties });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("byte");
  });

  it("refuses a schema nested past the depth limit", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < DEFAULT_SCHEMA_BUDGET.maxDepth + 4; i++) {
      deep = { type: "object", properties: { nested: deep } };
    }
    const r = budgetClientSchema(deep);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("deep");
  });
});
