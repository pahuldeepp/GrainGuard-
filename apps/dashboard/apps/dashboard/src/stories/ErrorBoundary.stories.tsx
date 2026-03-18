import type { Meta, StoryObj } from "@storybook/react";
import { ErrorBoundary } from "../shared/components/ErrorBoundary";

const meta: Meta<typeof ErrorBoundary> = {
  title: "Shared/ErrorBoundary",
  component: ErrorBoundary,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof ErrorBoundary>;

const BrokenComponent = () => {
  throw new Error("Something went wrong in this component");
};

export const WithError: Story = {
  render: () => (
    <ErrorBoundary>
      <BrokenComponent />
    </ErrorBoundary>
  ),
};

export const WithChildren: Story = {
  render: () => (
    <ErrorBoundary>
      <div className="p-8 text-center text-green-600 font-medium">
        ✅ Component rendered successfully
      </div>
    </ErrorBoundary>
  ),
};

export const WithCustomFallback: Story = {
  render: () => (
    <ErrorBoundary fallback={<div className="p-8 text-red-500">Custom error UI</div>}>
      <BrokenComponent />
    </ErrorBoundary>
  ),
};
