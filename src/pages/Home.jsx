import { useNavigate } from "react-router-dom";

function Home(){
    const navigate = useNavigate();

    return (
    <div>
        <h1>Welcome to Ed's Auto Shop</h1>
        <p>At Ed's Auto Repair, we provide reliable and affordable automotive services. From routine maintenance to complex repairs, we've got you covered.</p><br/>
        <h2>Services</h2><br/>
        <h2>Why Choose Us</h2><br/>
        <h2>Make an Appointment: <button onClick={() => navigate("/appointment")}>Appointment</button></h2>
        
    </div>
    );
    
}

export default Home;
