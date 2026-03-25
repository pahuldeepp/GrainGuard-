import { useAuth0 } from "@auth0/auth0-react";

export function LoginPage() {
  const { loginWithRedirect, isLoading } = useAuth0();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center px-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-lg p-8 w-full max-w-md text-center">
        <div className="w-16 h-16 bg-green-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
          <span className="text-white text-2xl font-bold">G</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
          GrainGuard
        </h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm mb-8">
          IoT monitoring for modern agriculture
        </p>
        {isLoading ? (
          <div className="w-8 h-8 border-2 border-green-600 border-t-transparent rounded-full animate-spin mx-auto" />
        ) : (
          <>
            <button
              onClick={() => loginWithRedirect()}
              className="w-full px-6 py-3 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700 transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
            >
              Sign in
            </button>
            <button
              onClick={() =>
                loginWithRedirect({
                  authorizationParams: { screen_hint: "forgot_password" },
                })
              }
              className="mt-3 text-sm text-gray-500 dark:text-gray-400 hover:text-green-600 dark:hover:text-green-400 transition-colors"
            >
              Forgot password?
            </button>
          </>
        )}
        <p className="text-xs text-gray-400 dark:text-gray-600 mt-6">
          Secured by Auth0
        </p>
      </div>
    </div>
  );
}