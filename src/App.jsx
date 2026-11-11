import { BrowserRouter, Routes, Route } from 'react-router-dom';
import RouteExperience from "./components/RouteExperience";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";
import Home from "./pages/Home";
import About from "./pages/About";
import Services from "./pages/Services";
import Appointment from "./pages/Appointment";
import Contact from "./pages/Contact";
import MechanicDashboard from "./pages/MechanicDashboard";
import ManageAppointment from "./pages/ManageAppointment";
import ServiceCatalogProvider from "./components/ServiceCatalogProvider";

function App() {
  return (
    <BrowserRouter>
      <ServiceCatalogProvider>
      <RouteExperience />
      <Navbar />
      <div id="main-content" className="route-content" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
          <Route path="/services" element={<Services />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/appointment" element={<Appointment />} />
          <Route path="/mechanic" element={<MechanicDashboard />} />
          <Route path="/manage-appointment" element={<ManageAppointment />} />
        </Routes>
      </div>
      <Footer />
      </ServiceCatalogProvider>
    </BrowserRouter>
  );
}

export default App;
