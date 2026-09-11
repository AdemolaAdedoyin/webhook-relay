import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Subscriptions from "./pages/Subscriptions";
import EventLog from "./pages/EventLog";
import Deliveries from "./pages/Deliveries";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/subscriptions" replace />} />
        <Route path="/subscriptions" element={<Subscriptions />} />
        <Route path="/events" element={<EventLog />} />
        <Route path="/deliveries" element={<Deliveries />} />
      </Route>
    </Routes>
  );
}
