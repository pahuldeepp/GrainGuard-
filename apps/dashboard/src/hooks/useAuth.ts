// review-sweep
import { useAuth0 } from "@auth0/auth0-react";

export function useAuth() {
  const {
    user,
    isAuthenticated,
    isLoading,
    loginWithRedirect,
    logout,
    getAccessTokenSilently,
  } = useAuth0();

  const signOut = () =>
    logout({ logoutParams: { returnTo: window.location.origin } });

  const getToken = () =>
    getAccessTokenSilently({
      authorizationParams: {
        audience: import.meta.env.VITE_AUTH0_AUDIENCE,
      },
    });

  return {
    user,
    isAuthenticated,
    isLoading,
    login: loginWithRedirect,
    signOut,
    getToken,
  };
}
