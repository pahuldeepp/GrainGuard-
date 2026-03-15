import { useNavigate } from "react-router-dom";

export function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
      <div className="text-7xl font-bold text-gray-200 mb-2">404</div>
      <h2 className="text-xl font-semibold text-gray-900 mb-2">Page not found</h2>
      <p className="text-sm text-gray-500 mb-8 max-w-sm">
        The page you're looking for doesn't exist or was moved.
      </p>
      <button
        onClick={() => navigate("/")}
        className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition-colors"
      >
        Back to Devices
      </button>
    </div>
  );
}