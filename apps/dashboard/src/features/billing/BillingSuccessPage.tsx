import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

export function BillingSuccessPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session_id");
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          navigate("/billing");
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [navigate]);

  return (
    <div className="max-w-lg mx-auto mt-20 text-center">
      <div className="text-6xl mb-6">✅</div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
        Subscription Activated!
      </h1>
      <p className="text-gray-600 dark:text-gray-400 mb-2">
        Your payment was successful and your subscription is now active.
      </p>
      {sessionId && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-6">
          Session: {sessionId.slice(0, 20)}...
        </p>
      )}
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-8">
        Redirecting to billing dashboard in {countdown}s...
      </p>
      <button
        onClick={() => navigate("/billing")}
        className="px-6 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
      >
        Go to Dashboard
      </button>
    </div>
  );
}
