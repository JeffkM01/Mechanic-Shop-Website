import mongoose from "mongoose";

export const appointmentSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  phone: { type: String, required: true, trim: true, maxlength: 24 },
  vehicle: { type: String, required: true, trim: true, maxlength: 120 },
  service: { type: String, required: true, trim: true, maxlength: 50 },
  date: { type: String, required: true }, // YYYY-MM-DD, shop-local date
  time: { type: String, required: true }, // HH:MM, shop-local time
  notes: { type: String, default: "", maxlength: 1000 },
  status: { type: String, enum: ["pending", "confirmed", "declined"], default: "pending" },
  // Optional snapshots preserve old records and their original service labels.
  scheduling: {
    type: new mongoose.Schema({
      startAt: Date,
      endAt: Date,
      occupiedUntil: Date,
      durationMinutes: Number,
      bufferMinutes: Number,
      timezone: String,
      holdExpiresAt: Date,
      settingsRevision: Number,
      confirmedAt: Date,
      confirmationSource: { type: String, enum: ["manual", "automatic"] },
    }, { _id: false }),
    default: undefined,
  },
  // Queue flags are stored with the appointment so email failures cannot undo the booking.
  // Old Phase 2/3 records have no flags and are not sent old "request received" emails.
  notificationState: {
    requestCustomer: { type: String, enum: ["pending", "sent"], default: "pending" },
    requestMechanic: { type: String, enum: ["pending", "sent"], default: "pending" },
    decisionCustomer: { type: String, enum: ["not-applicable", "pending", "sent"], default: "not-applicable" },
  },
}, { timestamps: true });

appointmentSchema.index({ status: 1, date: 1 });
appointmentSchema.index({ "scheduling.startAt": 1, status: 1 });

export default mongoose.model("Appointment", appointmentSchema);
