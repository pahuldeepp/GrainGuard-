import type { Meta, StoryObj } from "@storybook/react";
import { TelemetryBadge } from "../features/telemetry/components/TelemetryBadge";

const meta: Meta<typeof TelemetryBadge> = {
  title: "Telemetry/TelemetryBadge",
  component: TelemetryBadge,
  parameters: { layout: "centered" },
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof TelemetryBadge>;

export const Normal: Story = { args: { value: 22.5, unit: "°C", high: 40 } };
export const Warning: Story = { args: { value: 34.0, unit: "°C", high: 40 } };
export const Critical: Story = { args: { value: 45.0, unit: "°C", high: 40 } };
export const NoData: Story = { args: { value: null, unit: "°C", high: 40 } };
export const Humidity: Story = { args: { value: 65.0, unit: "%", high: 90 } };
