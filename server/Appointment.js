import mongoose from "mongoose";

const appointmentSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  phone: { type: String, required: true, trim: true, maxlength: 24 },
  vehicle: { type: String, required: true, trim: true, maxlength: 120 },
  service: { type: String, required: true, trim: true, maxlength: 50 },
  date: { type: String, required: true }, // YYYY-MM-DD, shop-local date
  time: { type: String, required: true }, // HH:MM, shop-local time
  notes: { type: String, default: "", maxlength: 1000 },
  status: { type: String, enum: ["pending", "confirmed", "declined"], default: "pending" },
}, { timestamps: true });

export default mongoose.model("Appointment", appointmentSchema);
