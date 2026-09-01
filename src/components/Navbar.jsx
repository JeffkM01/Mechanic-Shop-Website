import { Link } from 'react-router-dom';
import "../styles/Navbar.css"

function Navbar(){
    return(
        <>
        <nav className='nav-container'>
            <div className='nav-card'>
                <Link to="/">Home</Link>
                <Link to="/about">About</Link> 
                <Link to="/services">Services</Link>
                <Link to="/contact">Contact</Link>
                <Link to="/appointment">Appointment</Link>
            </div>
            
        </nav>
        </>
    )
}


export default Navbar