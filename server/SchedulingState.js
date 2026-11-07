import mongoose from "mongoose";

const reservationSchema = new mongoose.Schema({
  appointmentId: { type: mongoose.Schema.Types.ObjectId, required: true },
  startAt: { type: Date, required: true },
  endAt: { type: Date, required: true },
  occupiedUntil: { type: Date, required: true },
  durationMinutes: { type: Number, required: true },
  bufferMinutes: { type: Number, required: true },
  timezone: { type: String, required: true },
  state: { type: String, enum: ["pending", "confirmed"], required: true },
  holdExpiresAt: Date,
  confirmationSource: { type: String, enum: ["manual", "automatic"] },
  settingsRevision: Number,
}, { _id: false });

// A single shop document makes reservation, capacity, daily automatic limits,
// and configuration changes atomic even on standalone MongoDB. Customer data
// remains in Appointment; this coordination document contains no contact data.
export const schedulingStateSchema = new mongoose.Schema({
  _id: { type: String, default: "shop" },
  revision: { type: Number, required: true, default: 0 },
  settingsRevision: { type: Number, required: true, default: 0 },
  settings: { type: mongoose.Schema.Types.Mixed, required: true },
  reservations: { type: [reservationSchema], default: [] },
  automaticCounts: { type: [{ _id: false, date: String, count: Number }], default: [] },
}, { timestamps: true, versionKey: false });

export default mongoose.model("SchedulingState", schedulingStateSchema);
