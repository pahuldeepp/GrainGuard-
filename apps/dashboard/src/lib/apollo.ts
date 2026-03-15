import {
  ApolloClient,
  InMemoryCache,
  HttpLink,
  ApolloLink,
  Observable,
} from "@apollo/client";
import { getAccessTokenSilently } from "./auth0";

const authLink = new ApolloLink((operation, forward) => {
  return new Observable((observer) => {
    getAccessTokenSilently({
      authorizationParams: {
        audience: import.meta.env.VITE_AUTH0_AUDIENCE,
      },
    })
      .then((token) => {
        operation.setContext(({ headers = {} }) => ({
          headers: {
            ...headers,
            authorization: token ? `Bearer ${token}` : "",
          },
        }));
        forward(operation).subscribe(observer);
      })
      .catch(() => {
        forward(operation).subscribe(observer);
      });
  });
});

const httpLink = new HttpLink({
  uri: import.meta.env.VITE_BFF_URL || "http://localhost:4000",
});

const client = new ApolloClient({
  link: ApolloLink.from([authLink, httpLink]),
  cache: new InMemoryCache(),
});

export default client;
