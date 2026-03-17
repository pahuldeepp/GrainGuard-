import {
  ApolloClient,
  InMemoryCache,
  HttpLink,
  ApolloLink,
  Observable,
  split,
} from "@apollo/client";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import { createClient } from "graphql-ws";
import { getMainDefinition } from "@apollo/client/utilities";
import { getAccessTokenSilently } from "./auth0";

/**
 * Base URL (Gateway / BFF)
 */
const BFF_URL =
  import.meta.env.VITE_BFF_URL || "http://localhost:8086/graphql";

/**
 * Build WS URL safely
 */
const wsUrlObj = new URL(BFF_URL);
wsUrlObj.protocol = wsUrlObj.protocol === "https:" ? "wss:" : "ws:";
const WS_URL = wsUrlObj.toString();

/**
 * Auth Link — inject Auth0 token
 */
const authLink = new ApolloLink((operation, forward) => {
  return new Observable((observer) => {
    (async () => {
      try {
        const token = await getAccessTokenSilently({
          authorizationParams: {
            audience: import.meta.env.VITE_AUTH0_AUDIENCE,
          },
        });

        operation.setContext(({ headers = {} }) => ({
          headers: {
            ...headers,
            authorization: token ? `Bearer ${token}` : "",
          },
        }));
      } catch {
        // silently continue without token
      }

      forward(operation).subscribe(observer);
    })();
  });
});

/**
 * HTTP Link
 */
const httpLink = new HttpLink({
  uri: BFF_URL,
});

/**
 * WebSocket Link (Subscriptions)
 */
const wsLink = new GraphQLWsLink(
  createClient({
    url: WS_URL,
    retryAttempts: Infinity,
    shouldRetry: () => true,
    connectionParams: async () => {
      try {
        const token = await getAccessTokenSilently({
          authorizationParams: {
            audience: import.meta.env.VITE_AUTH0_AUDIENCE,
          },
        });
        return { authorization: token ? `Bearer ${token}` : "" };
      } catch {
        return {};
      }
    },
  })
);

/**
 * Split traffic — subscriptions vs queries/mutations
 */
const splitLink = split(
  ({ query }) => {
    const definition = getMainDefinition(query);
    return (
      definition.kind === "OperationDefinition" &&
      definition.operation === "subscription"
    );
  },
  wsLink,
  ApolloLink.from([authLink, httpLink])
);

/**
 * Apollo Client
 */
const client = new ApolloClient({
  link: splitLink,
  cache: new InMemoryCache(),
});

export default client;