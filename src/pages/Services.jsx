import "../styles/Services.css"
import { useNavigate } from "react-router-dom";

function Services(){
    const navigate = useNavigate();

    const services = [
        {
            name: "Oil Change",
            description: "Regular oil and filter changes to keep your engine running smoothly."
        },
        {
            name: "Air Filter Change",
            description: "Replace dirty air filters to help your engine breathe better and perform efficiently"
        },
        {
            name: "Brake Repairs",
            description: "Reliable brake inspections and repairs to help keep you safe on the road."
        },
         {
            name: "AC & Heating Repair",
            description: "Keep your vehicle comfortable with dependable heating and air conditioning repairs."
        },
         {
            name: "Engine Diagnostics",
            description: "Identify engine problems quickly using diagnostic testing and inspection."
        }
    ];

    return (
        <>
            <h1>Services</h1>

            <div className="service-container">
                {services.map((service) => 
                    <div className="service-card" key={service.name}>
                        <h2>{service.name}</h2>
                        <p>{service.description}</p>
                        <button onClick={() => navigate("/appointment")}>Appointment</button>
                    </div>)}
            </div>
        </>

);
}

export default Services;
