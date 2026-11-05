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

function App() {
  return (
    <BrowserRouter>
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
        </Routes>
      </div>
      <Footer />
    </BrowserRouter>
  );
}

export default App;
