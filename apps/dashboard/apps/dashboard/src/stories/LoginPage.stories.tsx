import type { Meta, StoryObj } from "@storybook/react";
import { Auth0Provider } from "@auth0/auth0-react";

const meta: Meta = {
  title: "Auth/LoginPage",
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <Auth0Provider
        domain="dev-0saa2rbtwuf2j0e8.us.auth0.com"
        clientId="X0mumhKyMZkbO7CM8f2YyghCWMaA9zeU"
        authorizationParams={{ redirect_uri: window.location.origin }}
      >
        <Story />
      </Auth0Provider>
    ),
  ],
};

export default meta;

export const Default: StoryObj = {
  render: () => {
    // Render login page UI directly without Auth0 hook
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 w-full max-w-md text-center">
          <div className="w-16 h-16 bg-green-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <span className="text-white text-2xl font-bold">G</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">GrainGuard</h1>
          <p className="text-gray-500 text-sm mb-8">
            IoT monitoring for modern agriculture
          </p>
          <button className="w-full px-6 py-3 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700 transition-colors">
            Sign in
          </button>
          <p className="text-xs text-gray-400 mt-6">Secured by Auth0</p>
        </div>
      </div>
    );
  },
};
