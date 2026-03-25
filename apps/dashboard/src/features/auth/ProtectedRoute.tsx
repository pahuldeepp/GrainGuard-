import { useAuth0 } from "@auth0/auth0-react";
import { LoginPage } from "./components/LoginPage";

interface Props {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: Props) {
  const { isAuthenticated, isLoading, error } = useAuth0();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-green-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  // Surface any Auth0 error so we can diagnose callback failures
  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 w-full max-w-md text-center">
          <p className="text-red-600 font-semibold mb-2">Auth0 Error</p>
          <p className="text-sm text-gray-700 font-mono break-all">{error.message}</p>
          <button
            onClick={() => window.location.replace("/")}
            className="mt-6 px-4 py-2 bg-green-600 text-white rounded-lg text-sm"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return <>{children}</>;
}
