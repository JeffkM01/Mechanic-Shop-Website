import { useNavigate } from "react-router-dom";

function Home(){
    const navigate = useNavigate();

    return (
    <div>
        <h1>Home</h1><br/>
        <h2>Hero</h2><br/>
        <h2>Services</h2><br/>
        <h2>Why Choose Us</h2><br/>
        <h2>Make an Appointment: <button onClick={() => navigate("/appointment")}>Appointment</button></h2>
        
    </div>
    );
    
}

export default Home;
