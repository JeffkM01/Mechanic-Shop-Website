import mongoose from "mongoose";
import { DECLINE_REASONS, DECLINE_EXPLANATION_MIN, DECLINE_MESSAGE_MAX } from "../shared/declineReasons.js";
import { CUSTOMER_CANCELLATION_REASONS, MECHANIC_CANCELLATION_REASONS, CANCELLATION_MESSAGE_MAX, CANCELLATION_EXPLANATION_MAX } from "../shared/cancellations.js";
import { managementSchema } from "./customerManagementSchema.js";

export const appointmentSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  phone: { type: String, required: true, trim: true, maxlength: 24 },
  vehicle: { type: String, required: true, trim: true, maxlength: 120 },
  service: { type: String, required: true, trim: true, maxlength: 50 },
  date: { type: String, required: true }, // YYYY-MM-DD, shop-local date
  time: { type: String, required: true }, // HH:MM, shop-local time
  notes: { type: String, default: "", maxlength: 1000 },
  status: { type: String, enum: ["pending", "confirmed", "declined", "cancelled"], default: "pending" },
  management: { type: managementSchema, select: false, default: undefined },
  cancellation: {
    type: new mongoose.Schema({
      by: { type: String, enum: ["customer", "mechanic"], required: true },
      category: { type: String, enum: [...CUSTOMER_CANCELLATION_REASONS, ...MECHANIC_CANCELLATION_REASONS].map(reason => reason.id), required: true },
      message: { type: String, maxlength: CANCELLATION_MESSAGE_MAX },
      explanation: { type: String, maxlength: CANCELLATION_EXPLANATION_MAX },
      cancelledAt: { type: Date, required: true },
      originalDate: { type: String, required: true, maxlength: 10 },
      originalTime: { type: String, required: true, maxlength: 5 },
      timezone: { type: String, required: true, maxlength: 100 },
    }, { _id: false }),
    default: undefined,
  },
  // Legacy declined records intentionally have no invented reason. New staff
  // declines persist this snapshot with terminal status and the queue flag.
  decline: {
    type: new mongoose.Schema({
      category: { type: String, enum: DECLINE_REASONS.map(reason => reason.id), required: true },
      explanation: { type: String, required: true, minlength: DECLINE_EXPLANATION_MIN, maxlength: DECLINE_MESSAGE_MAX },
      declinedAt: { type: Date, required: true },
      source: { type: String, enum: ["mechanic"], required: true },
    }, { _id: false }),
    default: undefined,
  },
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
    requestCustomer: { type: String, enum: ["pending", "sent", "suppressed"], default: "pending" },
    requestMechanic: { type: String, enum: ["pending", "sent"], default: "pending" },
    decisionCustomer: { type: String, enum: ["not-applicable", "pending", "sent", "suppressed"], default: "not-applicable" },
    cancellationCustomer: { type: String, enum: ["not-applicable", "pending", "sent"], default: "not-applicable" },
    cancellationMechanic: { type: String, enum: ["not-applicable", "pending", "sent"], default: "not-applicable" },
  },
}, { timestamps: true });

appointmentSchema.index({ status: 1, date: 1 });
appointmentSchema.index({ "scheduling.startAt": 1, status: 1 });

export default mongoose.model("Appointment", appointmentSchema);
