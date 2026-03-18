import type { Meta, StoryObj } from "@storybook/react";
import { ErrorBoundary } from "../shared/components/ErrorBoundary";

const meta: Meta<typeof ErrorBoundary> = {
  title: "Shared/ErrorBoundary",
  component: ErrorBoundary,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"],
};

export default meta;

const BrokenComponent = () => { throw new Error("Test error"); };

export const WithError: StoryObj = {
  render: () => <ErrorBoundary><BrokenComponent /></ErrorBoundary>,
};

export const WithChildren: StoryObj = {
  render: () => (
    <ErrorBoundary>
      <div className="p-8 text-center text-green-600">✅ Component rendered successfully</div>
    </ErrorBoundary>
  ),
};
