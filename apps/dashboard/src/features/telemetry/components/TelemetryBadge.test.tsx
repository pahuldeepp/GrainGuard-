import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TelemetryBadge } from "./TelemetryBadge";

describe("TelemetryBadge", () => {
  it("renders No Data when value is null", () => {
    render(<TelemetryBadge value={null} unit="C" />);
    expect(screen.getByText("No Data")).toBeInTheDocument();
  });

  it("renders value with unit", () => {
    render(<TelemetryBadge value={22.5} unit="C" high={40} />);
    expect(screen.getByText("22.5 C")).toBeInTheDocument();
  });

  it("shows green color for normal value", () => {
    const { container } = render(<TelemetryBadge value={22.5} unit="C" high={40} />);
    expect(container.firstChild).toHaveClass("text-green-600");
  });

  it("shows yellow color for warning value", () => {
    // 80% of high=40 is 32 — so 33 is warning
    const { container } = render(<TelemetryBadge value={33} unit="C" high={40} />);
    expect(container.firstChild).toHaveClass("text-yellow-600");
  });

  it("shows red color for critical value", () => {
    const { container } = render(<TelemetryBadge value={45} unit="C" high={40} />);
    expect(container.firstChild).toHaveClass("text-red-600");
  });

  it("formats value to 1 decimal place", () => {
    render(<TelemetryBadge value={22.567} unit="C" high={40} />);
    expect(screen.getByText("22.6 C")).toBeInTheDocument();
  });

  it("handles humidity unit", () => {
    render(<TelemetryBadge value={65.0} unit="%" high={90} />);
    expect(screen.getByText("65.0 %")).toBeInTheDocument();
  });

  it("shows red when value exceeds high threshold", () => {
    const { container } = render(<TelemetryBadge value={91} unit="%" high={90} />);
    expect(container.firstChild).toHaveClass("text-red-600");
  });
});
