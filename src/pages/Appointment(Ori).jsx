import { useNavigate } from "react-router-dom";

function Appointment(){
    const navigate = useNavigate();

    return(
        <>
            <h1>Request an Appointment</h1>

            <form onSubmit={""}>
                <label>Name: <input type="text" /></label><br/><br/>
                <label>Email: <input type="text" /></label><br/><br/>
                <label>Phone: <input type="text" /></label><br/><br/>
                <label>Vehicle: <input type="text" /></label><br/><br/>
                <label>Services Needed: <input type="text" /></label><br/><br/>
                <label>Preferred Date: <input type="text" /></label><br/><br/>
                <label>Preferred Time: <input type="text" /></label><br/><br/>
                <label>Additional Info: <input type="text" /></label><br/><br/>
                <button onClick={""}>Request Appointment</button>
            </form>

                   

        </>
    );
    
}

export default Appointment;
