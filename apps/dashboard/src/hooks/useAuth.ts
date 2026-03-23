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

  const roles: string[] =
    (user?.["https://grainguard/roles"] as string[]) ?? [];
  const isAdmin = roles.includes("admin");

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
    isAdmin,
    login: loginWithRedirect,
    signOut,
    getToken,
  };
}

