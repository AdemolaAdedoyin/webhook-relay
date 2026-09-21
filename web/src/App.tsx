import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Subscriptions from "./pages/Subscriptions";
import EventDetail from "./pages/EventDetail";
import EventLog from "./pages/EventLog";
import Overview from "./pages/Overview";
import Deliveries from "./pages/Deliveries";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<Overview />} />
        <Route path="/subscriptions" element={<Subscriptions />} />
        <Route path="/events" element={<EventLog />} />
        <Route path="/events/:id" element={<EventDetail />} />
        <Route path="/deliveries" element={<Deliveries />} />
      </Route>
    </Routes>
  );
}
