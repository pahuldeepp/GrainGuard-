import { ApolloProvider } from "@apollo/client/react";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import client from "./lib/apollo";
import { DevicesPage } from "./features/devices/components/DevicesPage";
import { DeviceDetailPage } from "./features/devices/components/DeviceDetailPage";

function App() {
  return (
    <ApolloProvider client={client}>
      <BrowserRouter>
        <div className="min-h-screen bg-gray-50">
          {/* Navbar */}
          <nav className="bg-white border-b border-gray-200 px-6 py-4">
            <div className="max-w-7xl mx-auto flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center">
                  <span className="text-white text-sm font-bold">G</span>
                </div>
                <span className="text-lg font-bold text-gray-900">GrainGuard</span>
              </div>
              <div className="flex gap-6 text-sm">
                <Link to="/" className="text-gray-600 hover:text-gray-900">Devices</Link>
              </div>
            </div>
          </nav>

          {/* Routes */}
          <Routes>
            <Route path="/" element={<DevicesPage />} />
            <Route path="/devices/:id" element={<DeviceDetailPage />} />
          </Routes>
        </div>
      </BrowserRouter>
    </ApolloProvider>
  );
}

export default App;