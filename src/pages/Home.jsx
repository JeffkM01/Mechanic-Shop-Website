import { useNavigate, Link } from "react-router-dom";
import "../styles/Home.css"
import "../styles/Services.css"

function Home(){
    const navigate = useNavigate();
    const services = ["Oil Change", "Air Filter Change", "Brake Repairs", "AC & Heating Repair", "Engine Diagnostics"]

    return (
    <div className="home-container">
        <h1>Welcome to Ed's Auto Shop</h1>
        <p>At Ed's Auto Repair, we provide reliable and affordable automotive services. From routine maintenance to complex repairs, we've got you covered.</p><br/>
        <h1>Services</h1>
        <ul>
            {services.map((service) => <li>{service}</li>)}
        </ul>


        <div className="service-button">
            <Link to="/services">See All Services</Link>
        </div>
        
        <h2>Why Choose Us</h2>
        <p>
            <h2>Experienced Service:</h2><br/>
            Our experienced technicians are committed to providing reliable repairs and quality service for your vehicle.
            
            <h2>Honest & Transparent</h2><br/> 
            We believe in clear communication and straightforward recommendations, so you know what your vehicle needs before work begins.

            <h2>Quality Work:</h2><br/>
            We take pride in doing the job right and helping keep your vehicle safe, reliable, and ready for the road.

            <h2>Customer Focused:</h2><br/>
            Your satisfaction matters to us. We work hard to provide friendly service and make every visit as easy as possible.
        </p>

        <h2>Make an Appointment: <button onClick={() => navigate("/appointment")}>Appointment</button></h2>
        
    </div>
    );
    
}

export default Home;
