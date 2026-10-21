import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { Tabs } from "../../src/ui/Tabs.tsx";

function TabsHarness(): ReactElement {
  const [selected, setSelected] = useState<"a" | "b" | "c">("a");
  return (
    <Tabs
      label="Code"
      idPrefix="t"
      selected={selected}
      onSelect={setSelected}
      items={[
        { id: "a", label: "SDK" },
        { id: "b", label: "CLI" },
        { id: "c", label: "MCP" },
      ]}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("tabs", () => {
  it("moves with the arrow keys, Home and End, keeping one tab in the tab order", () => {
    render(<TabsHarness />);
    const list = screen.getByRole("tablist", { name: "Code" });
    const selected = (): string | undefined =>
      screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent ??
      undefined;
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(selected()).toBe("CLI");
    fireEvent.keyDown(list, { key: "End" });
    expect(selected()).toBe("MCP");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(selected()).toBe("SDK");
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(selected()).toBe("MCP");
    fireEvent.keyDown(list, { key: "Home" });
    expect(selected()).toBe("SDK");
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.getAllByRole("tab")[0]?.getAttribute("aria-controls")).toBe("t-panel");
  });
});
