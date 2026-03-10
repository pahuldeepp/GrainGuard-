import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { typeDefs } from "./schema";
import { resolvers } from "./resolvers";

// ApolloServer ties together:
// - typeDefs (what can be queried)
// - resolvers (how to fetch the data)
const server = new ApolloServer({ typeDefs, resolvers });

const PORT = parseInt(process.env.PORT || "4000");

startStandaloneServer(server, {
  listen: { port: PORT },
}).then(({ url }) => {
  console.log(`BFF GraphQL server running at ${url}`);
});
