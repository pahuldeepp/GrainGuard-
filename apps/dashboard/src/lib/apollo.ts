import { ApolloClient, InMemoryCache, HttpLink } from '@apollo/client';


const client = new ApolloClient({
    link: new HttpLink({
        uri: 'http://localhost:4000',
    }),
    cache: new InMemoryCache(),

    defaultOptions: {
        watchQuery: {
            pollInterval: 2000,
        },
    },
});

export default client;
